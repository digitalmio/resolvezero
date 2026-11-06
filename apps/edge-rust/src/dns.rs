use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;
use std::time::Duration;

use hickory_proto::op::{Message, MessageType, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA, CNAME, TXT};
use hickory_proto::rr::{DNSClass, Name, RData, Record, RecordType};

use crate::store::{BlockAnswer, BlockMode, ZoneEntry};

#[derive(Clone, Debug)]
pub struct Question {
    pub id: u16,
    pub name: String,
    pub qtype: RecordType,
    pub qclass: DNSClass,
    pub query: Message,
}

pub fn parse_query(wire: &[u8]) -> Option<Question> {
    let message = Message::from_vec(wire).ok()?;
    let query = message.queries().first()?.clone();
    let name = query
        .name()
        .to_string()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    Some(Question {
        id: message.id(),
        name,
        qtype: query.query_type(),
        qclass: query.query_class(),
        query: message,
    })
}

fn base_response(question: &Question) -> Message {
    let mut response = Message::new();
    response.set_id(question.id);
    response.set_message_type(MessageType::Response);
    response.set_op_code(question.query.op_code());
    response.set_recursion_desired(question.query.recursion_desired());
    response.set_recursion_available(true);
    for query in question.query.queries() {
        response.add_query(query.clone());
    }
    response
}

pub fn sinkhole_response(question: &Question, answer: &BlockAnswer) -> Vec<u8> {
    match answer.mode {
        BlockMode::Nxdomain => nxdomain_response(question),
        BlockMode::Refused => refused_response(question),
        _ => {
            let mut response = base_response(question);
            response.set_authoritative(true);
            let name = question.query.queries()[0].name().clone();
            match question.qtype {
                RecordType::A => {
                    let ip = answer
                        .ipv4
                        .as_deref()
                        .and_then(|value| Ipv4Addr::from_str(value).ok())
                        .unwrap_or(Ipv4Addr::UNSPECIFIED);
                    response.add_answer(Record::from_rdata(name, answer.ttl, RData::A(A(ip))));
                }
                RecordType::AAAA => {
                    let ip = answer
                        .ipv6
                        .as_deref()
                        .and_then(|value| Ipv6Addr::from_str(value).ok())
                        .unwrap_or(Ipv6Addr::UNSPECIFIED);
                    response.add_answer(Record::from_rdata(
                        name,
                        answer.ttl,
                        RData::AAAA(AAAA(ip)),
                    ));
                }
                _ => {}
            }
            response.to_vec().unwrap_or_default()
        }
    }
}

pub fn nxdomain_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.set_response_code(ResponseCode::NXDomain);
    response.to_vec().unwrap_or_default()
}

pub fn refused_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.set_response_code(ResponseCode::Refused);
    response.to_vec().unwrap_or_default()
}

pub fn servfail_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.set_response_code(ResponseCode::ServFail);
    response.to_vec().unwrap_or_default()
}

pub fn empty_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.set_authoritative(true);
    response.to_vec().unwrap_or_default()
}

/// Encode a zone entry for the question's name. `record_type` is the stored
/// type, which may be CNAME even when the question asked for A/AAAA.
pub fn zone_response(question: &Question, entry: &ZoneEntry, record_type: &str) -> Vec<u8> {
    let mut response = base_response(question);
    response.set_authoritative(true);
    let owner = question.query.queries()[0].name().clone();

    for value in &entry.values {
        let rdata = match record_type {
            "A" => value.parse::<Ipv4Addr>().ok().map(|ip| RData::A(A(ip))),
            "AAAA" => value
                .parse::<Ipv6Addr>()
                .ok()
                .map(|ip| RData::AAAA(AAAA(ip))),
            "CNAME" => Name::from_str(value)
                .ok()
                .map(|name| RData::CNAME(CNAME(name))),
            "TXT" => Some(RData::TXT(TXT::new(vec![value.clone()]))),
            _ => None,
        };
        if let Some(rdata) = rdata {
            response.add_answer(Record::from_rdata(owner.clone(), entry.ttl, rdata));
        }
    }

    response.to_vec().unwrap_or_default()
}

/// Cache key: question + DNSSEC intent + upstream (same isolation as the TS
/// cache, which stores a separate entry per upstream).
pub fn cache_key(question: &Question, upstream: &str) -> String {
    let do_bit = question
        .query
        .extensions()
        .as_ref()
        .is_some_and(|edns| edns.dnssec_ok());
    format!(
        "{}|{:?}|{:?}|{}|{}|{}",
        question.name,
        question.qtype,
        question.qclass,
        do_bit,
        question.query.checking_disabled(),
        upstream
    )
}

/// TTL to hold a response: min TTL across answers/authorities for positive
/// answers, SOA minimum (or 60s) for negative, capped like the TS cache.
pub fn cache_ttl(wire: &[u8]) -> Duration {
    let Ok(response) = Message::from_vec(wire) else {
        return Duration::ZERO;
    };
    let negative =
        response.response_code() == ResponseCode::NXDomain || response.answers().is_empty();
    let mut ttl = u32::MAX;
    for record in response.answers().iter().chain(response.name_servers()) {
        ttl = ttl.min(record.ttl());
    }
    if negative {
        let soa_min = response
            .name_servers()
            .iter()
            .find_map(|record| match record.data() {
                Some(RData::SOA(soa)) => Some(soa.minimum()),
                _ => None,
            });
        let seconds = soa_min.unwrap_or(60).clamp(1, 60);
        return Duration::from_secs(seconds as u64);
    }
    if ttl == u32::MAX {
        return Duration::ZERO;
    }
    Duration::from_secs(ttl.clamp(1, 300) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::Query;

    fn query(name: &str, qtype: RecordType) -> Vec<u8> {
        let mut message = Message::new();
        message.set_id(0x1234);
        message.set_message_type(MessageType::Query);
        message.set_recursion_desired(true);
        message.add_query(Query::query(Name::from_str(name).unwrap(), qtype));
        message.to_vec().unwrap()
    }

    #[test]
    fn parses_canonical_question() {
        let question = parse_query(&query("Example.COM.", RecordType::A)).unwrap();
        assert_eq!(question.name, "example.com");
        assert_eq!(question.qtype, RecordType::A);
    }

    #[test]
    fn sinkholes_a_and_aaaa() {
        let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
        let wire = sinkhole_response(&q, &BlockAnswer::default());
        let response = Message::from_vec(&wire).unwrap();
        assert_eq!(response.response_code(), ResponseCode::NoError);
        assert_eq!(response.answers().len(), 1);
        assert_eq!(
            response.answers()[0].data(),
            Some(&RData::A(A(Ipv4Addr::UNSPECIFIED)))
        );
    }

    #[test]
    fn block_modes_change_the_rcode() {
        let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
        let nx = Message::from_vec(&nxdomain_response(&q)).unwrap();
        assert_eq!(nx.response_code(), ResponseCode::NXDomain);
        let refused = Message::from_vec(&refused_response(&q)).unwrap();
        assert_eq!(refused.response_code(), ResponseCode::Refused);
    }

    #[test]
    fn zone_encodes_a_and_txt() {
        let q = parse_query(&query("nas.lan.", RecordType::A)).unwrap();
        let entry = ZoneEntry {
            values: vec!["192.0.2.10".into()],
            ttl: 60,
        };
        let response = Message::from_vec(&zone_response(&q, &entry, "A")).unwrap();
        assert_eq!(response.answers().len(), 1);
        assert_eq!(response.answers()[0].ttl(), 60);

        let q = parse_query(&query("note.lan.", RecordType::TXT)).unwrap();
        let entry = ZoneEntry {
            values: vec!["hello".into()],
            ttl: 60,
        };
        let response = Message::from_vec(&zone_response(&q, &entry, "TXT")).unwrap();
        assert_eq!(response.answers().len(), 1);
    }

    #[test]
    fn negative_ttl_is_capped() {
        let q = parse_query(&query("missing.example.", RecordType::A)).unwrap();
        let wire = nxdomain_response(&q);
        let ttl = cache_ttl(&wire);
        assert!(ttl <= Duration::from_secs(60) && ttl >= Duration::from_secs(1));
    }
}
