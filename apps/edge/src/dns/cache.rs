use std::time::Duration;

use hickory_proto::op::{Message, MessageType, ResponseCode};
use hickory_proto::rr::RData;

use super::Question;

/// Cache key: question + DNSSEC intent + full EDNS options + upstream.
pub fn cache_key(question: &Question, upstream: &str) -> String {
    format!(
        "{}|{:?}|{:?}|{}|{}|{}",
        question.name,
        question.qtype,
        question.qclass,
        question.query.metadata.checking_disabled,
        question.opt_key,
        upstream
    )
}

/// TTL to hold a response. Only NOERROR/NXDOMAIN are cacheable; everything
/// else (SERVFAIL/REFUSED/FORMERR/BADVERS) must never pin a broken answer for
/// other clients.
pub fn cache_ttl(wire: &[u8]) -> Duration {
    let Ok(response) = Message::from_vec(wire) else {
        return Duration::ZERO;
    };
    let rcode = response.metadata.response_code;
    if rcode != ResponseCode::NoError && rcode != ResponseCode::NXDomain {
        return Duration::ZERO;
    }
    let negative = rcode == ResponseCode::NXDomain || response.answers.is_empty();
    let mut ttl = u32::MAX;
    for record in response.answers.iter().chain(response.authorities.iter()) {
        ttl = ttl.min(record.ttl);
    }
    if negative {
        let soa_min = response
            .authorities
            .iter()
            .find_map(|record| match &record.data {
                RData::SOA(soa) => Some(soa.minimum),
                _ => None,
            });
        return Duration::from_secs(soa_min.unwrap_or(60).clamp(1, 60) as u64);
    }
    if ttl == u32::MAX {
        return Duration::ZERO;
    }
    Duration::from_secs(ttl.clamp(1, 300) as u64)
}

/// Validate an upstream response before it is returned or cached.
pub fn validate_upstream(query: &Question, wire: &[u8]) -> Result<(), String> {
    if wire.len() > 65_535 {
        return Err("upstream response exceeds 64 KiB".into());
    }
    let response = Message::from_vec(wire).map_err(|err| format!("upstream parse: {err}"))?;
    if response.metadata.message_type != MessageType::Response {
        return Err("upstream response is not a response".into());
    }
    if response.metadata.id != query.id {
        return Err("upstream response id mismatch".into());
    }
    let Some(answer) = response.queries.first() else {
        return Err("upstream response has no question".into());
    };
    let name = answer
        .name()
        .to_string()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if name != query.name
        || answer.query_type() != query.qtype
        || answer.query_class() != query.qclass
    {
        return Err("upstream response question mismatch".into());
    }
    Ok(())
}

/// Cache-normalize a response: strip OPT (ECS/cookies must not be replayed),
/// rewrite the question to the requested case, count TTLs down, and patch ID.
pub fn normalize_for_client(
    wire: &[u8],
    question: &Question,
    elapsed: Duration,
) -> Option<Vec<u8>> {
    let mut response = Message::from_vec(wire).ok()?;
    response.edns = None;
    response.metadata.id = question.id;
    if let (Some(original), Some(cached)) =
        (question.query.queries.first(), response.queries.first_mut())
    {
        *cached = original.clone();
    }
    let elapsed_secs = elapsed.as_secs().min(u32::MAX as u64) as u32;
    for record in response
        .answers
        .iter_mut()
        .chain(response.authorities.iter_mut())
        .chain(response.additionals.iter_mut())
    {
        record.ttl = record.ttl.saturating_sub(elapsed_secs).max(1);
    }
    response.to_vec().ok()
}
