
use super::*;

#[test]
fn blocks_private_ranges() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(is_private_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(!is_private_ip(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn blocks_more_reserved_ranges() {
    for ip in [
        "198.18.0.1",
        "192.0.2.1",
        "240.0.0.1",
        "255.255.255.255",
        "fd12:3456::1",
        "::ffff:10.0.0.1",
    ] {
        assert!(is_private_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["93.184.216.34", "2001:4860:4860::8888"] {
        assert!(!is_private_ip(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn rejects_http_and_credentials() {
    let fetcher = SafeFetcher::new(1024, true);
    assert!(fetcher.validate("http://example.com/list.txt").is_err());
    assert!(fetcher
        .validate("https://user:pass@example.com/list.txt")
        .is_err());
    assert!(fetcher.validate("https://example.com/list.txt").is_ok());
}

#[test]
fn redacts_query_tokens() {
    assert_eq!(
        redact_url("https://example.com/list.txt?token=secret"),
        "https://example.com/list.txt"
    );
}
