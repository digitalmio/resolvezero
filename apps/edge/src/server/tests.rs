use super::dot::{dot_label, parse_proxy_v2, PROXY_V2_MAGIC, TLV_AUTHORITY};
use super::helpers::{match_probe_nonce, record_type_name, upstream_label};
use super::http::{caller_ip, query_param, token_from, DOH_ROUTE};
use super::purge::{valid_device, valid_purge_domain, valid_purge_type};
use super::transports::acquire_conn;
use axum::http::{header, HeaderMap, HeaderValue, Uri};
use hickory_proto::rr::RecordType;
use std::collections::HashMap;
use std::net::Ipv6Addr;
use std::sync::{Arc, Mutex};

fn proxy_fixed(family: u8, payload_len: u16) -> [u8; 16] {
    let mut fixed = [0u8; 16];
    fixed[..12].copy_from_slice(&PROXY_V2_MAGIC);
    fixed[12] = 0x21; // version 2, PROXY command
    fixed[13] = (family << 4) | 0x01; // STREAM protocol
    fixed[14..16].copy_from_slice(&payload_len.to_be_bytes());
    fixed
}

#[test]
fn parses_proxy_v2_ipv4_and_ipv6_sources() {
    let mut payload = [0u8; 12];
    payload[..4].copy_from_slice(&[192, 0, 2, 1]);
    payload[4..8].copy_from_slice(&[198, 51, 100, 2]);
    payload[8..10].copy_from_slice(&1234u16.to_be_bytes());
    payload[10..12].copy_from_slice(&80u16.to_be_bytes());
    assert_eq!(
        parse_proxy_v2(&proxy_fixed(1, 12), &payload),
        Some((Some("192.0.2.1".into()), None))
    );

    let mut payload = [0u8; 36];
    payload[..16].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
    assert_eq!(
        parse_proxy_v2(&proxy_fixed(2, 36), &payload),
        Some((Some("::1".into()), None))
    );
}

#[test]
fn parses_proxy_v2_authority_tlv() {
    let mut payload = vec![TLV_AUTHORITY, 0, 15];
    payload.extend_from_slice(b"Profile.Example");
    let mut fixed = proxy_fixed(0, payload.len() as u16);
    fixed[13] = 0;
    assert_eq!(
        parse_proxy_v2(&fixed, &payload),
        Some((None, Some("profile.example".into())))
    );

    let mut payload = vec![0u8; 12];
    payload[..4].copy_from_slice(&[192, 0, 2, 1]);
    payload.extend_from_slice(&[TLV_AUTHORITY, 0, 4]);
    payload.extend_from_slice(b"auth");
    assert_eq!(
        parse_proxy_v2(&proxy_fixed(1, payload.len() as u16), &payload),
        Some((Some("192.0.2.1".into()), Some("auth".into())))
    );
}

#[test]
fn rejects_bad_proxy_v2_headers() {
    let payload = [0u8; 12];
    let mut wrong_magic = proxy_fixed(1, 12);
    wrong_magic[0] = 0;
    assert_eq!(parse_proxy_v2(&wrong_magic, &payload), None);
    assert_eq!(parse_proxy_v2(&proxy_fixed(1, 20), &payload), None);
}

#[test]
fn matches_probe_nonces() {
    assert_eq!(
        match_probe_nonce(
            "abc123def456abc123.probe.resolvezero.com",
            "probe.resolvezero.com"
        ),
        Some("abc123def456abc123".into())
    );
    assert_eq!(
        match_probe_nonce("a.b.probe.resolvezero.com", "probe.resolvezero.com"),
        None
    );
    assert_eq!(
        match_probe_nonce("short.probe.resolvezero.com", "probe.resolvezero.com"),
        None
    );
}

#[test]
fn doh_route_is_valid() {
    let _ = axum::Router::<()>::new().route(
        DOH_ROUTE,
        axum::routing::get(|| async { axum::http::StatusCode::NO_CONTENT }),
    );
}

#[test]
fn maps_dot_hostnames() {
    assert_eq!(
        dot_label("abc123.dot.resolvezero.com.", ".dot.resolvezero.com"),
        Some("abc123".into())
    );
    assert_eq!(
        dot_label("ABC123.DOT.RESOLVEZERO.COM", ".dot.resolvezero.com"),
        Some("abc123".into())
    );
    assert_eq!(dot_label("abc.dot.other.com", ".dot.resolvezero.com"), None);
    assert_eq!(
        dot_label("a.b.dot.resolvezero.com", ".dot.resolvezero.com"),
        None
    );
    assert_eq!(
        dot_label("-bad.dot.resolvezero.com", ".dot.resolvezero.com"),
        None
    );
}

#[test]
fn maps_upstream_labels() {
    assert_eq!(upstream_label(None), "edge-default");
    assert_eq!(upstream_label(Some("cloudflare")), "cloudflare");
    assert_eq!(upstream_label(Some("google")), "google");
    assert_eq!(upstream_label(Some("quad9")), "quad9");
    assert_eq!(
        upstream_label(Some("https://dns.example/dns-query")),
        "custom"
    );
    assert_eq!(upstream_label(Some("unexpected")), "edge-default");
}

#[test]
fn validates_probe_nonces() {
    assert_eq!(
        match_probe_nonce(
            "ABC123DEF456ABC123.probe.resolvezero.com.",
            "probe.resolvezero.com"
        ),
        Some("abc123def456abc123".into())
    );
    assert_eq!(
        match_probe_nonce(
            "abc-123-def-456-abc.probe.resolvezero.com",
            "probe.resolvezero.com"
        ),
        None
    );
    assert_eq!(
        match_probe_nonce("probe.resolvezero.com", "probe.resolvezero.com"),
        None
    );
    assert_eq!(
        match_probe_nonce(
            "abc123def456abc123.other.resolvezero.com",
            "probe.resolvezero.com"
        ),
        None
    );
}

#[test]
fn validates_purge_inputs() {
    assert_eq!(
        valid_purge_domain(" Ads.Example.COM. ").as_deref(),
        Some("ads.example.com")
    );
    assert_eq!(
        valid_purge_domain("_dmarc.example.com").as_deref(),
        Some("_dmarc.example.com")
    );
    assert_eq!(valid_purge_domain("bad..example"), None);
    assert_eq!(valid_purge_domain("-bad.example"), None);
    assert_eq!(valid_purge_domain("bad-.example"), None);
    assert_eq!(valid_purge_domain(""), None);
    assert_eq!(valid_purge_type(" a ").as_deref(), Some("A"));
    assert_eq!(valid_purge_type("https").as_deref(), Some("HTTPS"));
    assert_eq!(valid_purge_type("NOPE"), None);
}

#[test]
fn validates_devices() {
    assert!(valid_device("iphone-13"));
    assert!(valid_device("a_b"));
    assert!(!valid_device(""));
    assert!(!valid_device("has space"));
    assert!(!valid_device("has/slash"));
    assert!(!valid_device(&"a".repeat(33)));
}

#[test]
fn maps_record_type_names() {
    assert_eq!(record_type_name(RecordType::A), "A");
    assert_eq!(record_type_name(RecordType::AAAA), "AAAA");
    assert_eq!(record_type_name(RecordType::CNAME), "CNAME");
    assert_eq!(record_type_name(RecordType::TXT), "TXT");
    assert_eq!(record_type_name(RecordType::MX), "OTHER");
}

#[test]
fn token_prefers_query_and_reads_bearer() {
    let uri = Uri::from_static("https://edge.test/v1/home?token=from-query");
    assert_eq!(query_param(&uri, "token").as_deref(), Some("from-query"));
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer from-header"),
    );
    assert_eq!(token_from(&headers, &uri).as_deref(), Some("from-query"));

    let plain = Uri::from_static("https://edge.test/v1/home");
    assert_eq!(token_from(&headers, &plain).as_deref(), Some("from-header"));
    headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer "));
    assert_eq!(token_from(&headers, &plain), None);
}

#[test]
fn prefers_fly_client_ip() {
    let mut headers = HeaderMap::new();
    headers.insert("fly-client-ip", HeaderValue::from_static("203.0.113.9"));
    headers.insert(
        "x-forwarded-for",
        HeaderValue::from_static("198.51.100.7, 10.0.0.1"),
    );
    assert_eq!(caller_ip(&headers).as_deref(), Some("203.0.113.9"));
}

#[test]
fn connection_caps_release_on_drop() {
    let map = Arc::new(Mutex::new(HashMap::new()));
    let first = acquire_conn(&map, "203.0.113.9".into(), 2).expect("first");
    let second = acquire_conn(&map, "203.0.113.9".into(), 2).expect("second");
    assert!(acquire_conn(&map, "203.0.113.9".into(), 2).is_none());
    assert_eq!(map.lock().expect("caps").get("203.0.113.9"), Some(&2));

    drop(first);
    assert!(acquire_conn(&map, "203.0.113.9".into(), 2).is_some());
    drop(second);
    assert!(map.lock().expect("caps").is_empty());
}
