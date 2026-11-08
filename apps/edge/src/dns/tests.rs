use super::*;
use crate::store::{BlockAnswer, SafeSearch, ZoneEntry};
use hickory_proto::op::{Query, ResponseCode};
use hickory_proto::rr::rdata::A;
use hickory_proto::rr::{Name, RData, Record};
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::Duration;

fn query(name: &str, qtype: RecordType) -> Vec<u8> {
    let mut message = Message::new(0x1234, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
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
fn rejects_responses_and_multi_question() {
    let mut response = Message::from_vec(&query("example.com.", RecordType::A)).unwrap();
    response.metadata.message_type = MessageType::Response;
    assert!(parse_query(&response.to_vec().unwrap()).is_none());

    let mut multi = Message::new(1, MessageType::Query, OpCode::Query);
    multi.add_query(Query::query(
        Name::from_str("a.example.").unwrap(),
        RecordType::A,
    ));
    multi.add_query(Query::query(
        Name::from_str("b.example.").unwrap(),
        RecordType::A,
    ));
    assert!(parse_query(&multi.to_vec().unwrap()).is_none());
}

#[test]
fn sinkholes_a_and_aaaa() {
    let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
    let wire = sinkhole_response(&q, &BlockAnswer::default());
    let response = Message::from_vec(&wire).unwrap();
    assert_eq!(response.metadata.response_code, ResponseCode::NoError);
    assert_eq!(response.answers.len(), 1);
    assert_eq!(response.answers[0].data, RData::A(A(Ipv4Addr::UNSPECIFIED)));
}

#[test]
fn block_modes_change_the_rcode() {
    let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
    let nx = Message::from_vec(&nxdomain_response(&q)).unwrap();
    assert_eq!(nx.metadata.response_code, ResponseCode::NXDomain);
    let refused = Message::from_vec(&refused_response(&q)).unwrap();
    assert_eq!(refused.metadata.response_code, ResponseCode::Refused);
}

#[test]
fn zone_encodes_a_and_txt() {
    let q = parse_query(&query("nas.lan.", RecordType::A)).unwrap();
    let entry = ZoneEntry {
        values: vec!["192.0.2.10".into()],
        ttl: 60,
    };
    let response = Message::from_vec(&zone_response(&q, &entry, "A")).unwrap();
    assert_eq!(response.answers.len(), 1);
    assert_eq!(response.answers[0].ttl, 60);

    let q = parse_query(&query("note.lan.", RecordType::TXT)).unwrap();
    let entry = ZoneEntry {
        values: vec!["hello".into()],
        ttl: 60,
    };
    let response = Message::from_vec(&zone_response(&q, &entry, "TXT")).unwrap();
    assert_eq!(response.answers.len(), 1);
}

#[test]
fn safesearch_matches_known_engines() {
    let settings = SafeSearch {
        google: true,
        ..Default::default()
    };
    assert_eq!(
        safe_search_target(&settings, "google.com"),
        Some("forcesafesearch.google.com")
    );
    assert_eq!(
        safe_search_target(&settings, "www.google.co.uk"),
        Some("forcesafesearch.google.com")
    );
    assert_eq!(safe_search_target(&settings, "youtube.com"), None);
    let youtube = SafeSearch {
        youtube: true,
        ..Default::default()
    };
    assert_eq!(
        safe_search_target(&youtube, "m.youtube.com"),
        Some("restrict.youtube.com")
    );
}

#[test]
fn error_responses_are_never_cached() {
    let q = parse_query(&query("missing.example.", RecordType::A)).unwrap();
    let mut response = Message::new(0x1234, MessageType::Response, OpCode::Query);
    response.add_query(q.query.queries[0].clone());
    response.metadata.response_code = ResponseCode::ServFail;
    assert_eq!(cache_ttl(&response.to_vec().unwrap()), Duration::ZERO);
    assert_eq!(cache_ttl(&nxdomain_response(&q)), Duration::from_secs(60));
}

#[test]
fn normalization_strips_opt_and_patches_question_case() {
    let q = parse_query(&query("MiXeD.Example.", RecordType::A)).unwrap();
    let mut response = Message::new(q.id, MessageType::Response, OpCode::Query);
    response.add_query(Query::query(
        Name::from_str("mixed.example.").unwrap(),
        RecordType::A,
    ));
    response.add_answer(Record::from_rdata(
        Name::from_str("mixed.example.").unwrap(),
        300,
        RData::A(A(Ipv4Addr::new(192, 0, 2, 1))),
    ));
    response.edns = Some(hickory_proto::op::Edns::new());
    let wire = response.to_vec().unwrap();
    let normalized = normalize_for_client(&wire, &q, Duration::from_secs(30)).unwrap();
    let parsed = Message::from_vec(&normalized).unwrap();
    assert!(parsed.edns.is_none());
    assert_eq!(parsed.answers[0].ttl, 270);
}
