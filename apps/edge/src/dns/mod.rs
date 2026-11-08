use hickory_proto::op::{Message, MessageType, OpCode};
use hickory_proto::rr::{DNSClass, RecordType};

use rz_core::artifact::sha256_hex;

#[derive(Clone, Debug)]
pub struct Question {
    pub id: u16,
    pub name: String,
    pub qtype: RecordType,
    pub qclass: DNSClass,
    /// Hash of the EDNS OPT payload (ECS/DO/cookies). Part of the cache key so
    /// an answer tailored to one client subnet is not served to another.
    pub opt_key: String,
    pub query: Message,
}

pub fn parse_query(wire: &[u8]) -> Option<Question> {
    let message = Message::from_vec(wire).ok()?;
    // Only standard queries with exactly one question are accepted. This also
    // bounds response encoding: we echo exactly one question, never the whole
    // attacker-supplied question section.
    if message.metadata.message_type != MessageType::Query {
        return None;
    }
    if message.metadata.op_code != OpCode::Query {
        return None;
    }
    if message.queries.len() != 1 {
        return None;
    }
    let query = message.queries.first()?.clone();
    let name = query
        .name()
        .to_string()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    let opt_key = message
        .edns
        .as_ref()
        .map(|edns| {
            let mut only_opt = Message::new(0, MessageType::Query, OpCode::Query);
            only_opt.edns = Some(edns.clone());
            sha256_hex(&only_opt.to_vec().unwrap_or_default())
        })
        .unwrap_or_else(|| "none".into());
    Some(Question {
        id: message.metadata.id,
        name,
        qtype: query.query_type(),
        qclass: query.query_class(),
        opt_key,
        query: message,
    })
}

fn base_response(question: &Question) -> Message {
    let mut response = Message::new(
        question.id,
        MessageType::Response,
        question.query.metadata.op_code,
    );
    response.metadata.recursion_desired = question.query.metadata.recursion_desired;
    response.metadata.recursion_available = true;
    if let Some(query) = question.query.queries.first() {
        response.add_query(query.clone());
    }
    response
}

mod cache;
mod response;
#[cfg(test)]
mod tests;

pub use cache::{cache_key, cache_ttl, normalize_for_client, validate_upstream};
pub use response::{
    cname_response, empty_response, nxdomain_response, refused_response, safe_search_target,
    servfail_response, sinkhole_response, truncated_response, zone_response,
};
