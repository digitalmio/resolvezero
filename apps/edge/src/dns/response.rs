use hickory_proto::op::ResponseCode;
use hickory_proto::rr::rdata::{A, AAAA, CNAME, TXT};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use super::{base_response, Question};
use crate::store::{BlockAnswer, BlockMode, SafeSearch, ZoneEntry};

pub fn sinkhole_response(question: &Question, answer: &BlockAnswer) -> Vec<u8> {
    match answer.mode {
        BlockMode::Nxdomain => nxdomain_response(question),
        BlockMode::Refused => refused_response(question),
        _ => {
            let mut response = base_response(question);
            response.metadata.authoritative = true;
            let name = question
                .query
                .queries
                .first()
                .map(|query| query.name().clone())
                .unwrap_or_else(Name::root);
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
    response.metadata.response_code = ResponseCode::NXDomain;
    response.to_vec().unwrap_or_default()
}

pub fn refused_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.response_code = ResponseCode::Refused;
    response.to_vec().unwrap_or_default()
}

pub fn servfail_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.response_code = ResponseCode::ServFail;
    response.to_vec().unwrap_or_default()
}

pub fn truncated_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.truncation = true;
    response.to_vec().unwrap_or_default()
}

pub fn empty_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    response.to_vec().unwrap_or_default()
}

/// Encode a zone entry for the question's name. `record_type` is the stored
/// type, which may be CNAME even when the question asked for A/AAAA.
pub fn zone_response(question: &Question, entry: &ZoneEntry, record_type: &str) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    let owner = match question.query.queries.first() {
        Some(query) => query.name().clone(),
        None => Name::root(),
    };

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

const GOOGLE_TLDS: [&str; 40] = [
    "com", "co.uk", "de", "fr", "es", "it", "nl", "pl", "be", "ch", "at", "se", "no", "dk", "fi",
    "ie", "pt", "cz", "sk", "hu", "ro", "bg", "gr", "tr", "ru", "ua", "ca", "com.au", "co.nz",
    "co.jp", "co.kr", "co.in", "com.br", "com.mx", "com.ar", "co.za", "com.sg", "com.hk", "com.tw",
    "ae",
];

/// Exact-match SafeSearch rewrite; a wildcard would rewrite search assets too.
pub fn safe_search_target(settings: &SafeSearch, name: &str) -> Option<&'static str> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if settings.google
        && GOOGLE_TLDS
            .iter()
            .any(|tld| name == format!("google.{tld}") || name == format!("www.google.{tld}"))
    {
        return Some("forcesafesearch.google.com");
    }
    if settings.bing && matches!(name.as_str(), "bing.com" | "www.bing.com") {
        return Some("strict.bing.com");
    }
    if settings.duckduckgo
        && matches!(
            name.as_str(),
            "duckduckgo.com"
                | "www.duckduckgo.com"
                | "start.duckduckgo.com"
                | "html.duckduckgo.com"
                | "lite.duckduckgo.com"
        )
    {
        return Some("safe.duckduckgo.com");
    }
    if settings.youtube
        && matches!(
            name.as_str(),
            "youtube.com" | "www.youtube.com" | "m.youtube.com"
        )
    {
        return Some("restrict.youtube.com");
    }
    None
}

/// CNAME rewrite used by SafeSearch (provider addresses rotate).
pub fn cname_response(question: &Question, target: &str, ttl: u32) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    let owner = question
        .query
        .queries
        .first()
        .map(|query| query.name().clone())
        .unwrap_or_else(Name::root);
    if let Ok(target) = Name::from_str(target) {
        response.add_answer(Record::from_rdata(owner, ttl, RData::CNAME(CNAME(target))));
    }
    response.to_vec().unwrap_or_default()
}
