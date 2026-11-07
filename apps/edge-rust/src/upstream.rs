use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE};

/// DoH upstream client. One instance is shared across all queries (the
/// underlying reqwest pool keeps HTTP/2 connections warm).
#[derive(Clone)]
pub struct Upstream {
    /// HTTP/1.1 pool: Cloudflare/Google are materially faster over h1 in
    /// reqwest than over h2 for this small-body workload (measured 1.1k vs
    /// 170 qps at 32 concurrent cold misses).
    h1: reqwest::Client,
    /// HTTP/2 client for upstreams that require it (Quad9 returns 505 on h1).
    h2: reqwest::Client,
    default_url: String,
}

impl Upstream {
    pub fn new(default_url: String) -> Result<Self, String> {
        let h1 = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(64)
            .http1_only()
            .build()
            .map_err(|err| err.to_string())?;
        let h2 = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(64)
            .http2_adaptive_window(true)
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            h1,
            h2,
            default_url,
        })
    }

    fn client_for(&self, selector: Option<&str>, url: &str) -> &reqwest::Client {
        let needs_h2 = selector == Some("quad9") || url.contains("dns.quad9.net");
        if needs_h2 {
            &self.h2
        } else {
            &self.h1
        }
    }

    /// Preset selector or a custom DoH URL wins over the edge default.
    pub fn url_for(&self, selector: Option<&str>) -> String {
        match selector {
            Some("cloudflare") => "https://cloudflare-dns.com/dns-query".to_string(),
            Some("google") => "https://dns.google/dns-query".to_string(),
            Some("quad9") => "https://dns.quad9.net/dns-query".to_string(),
            Some(url) if url.starts_with("https://") || url.starts_with("http://") => {
                url.to_string()
            }
            _ => self.default_url.clone(),
        }
    }

    pub async fn resolve(&self, wire: &[u8], selector: Option<&str>) -> Result<Vec<u8>, String> {
        let url = self.url_for(selector);
        let response = self
            .client_for(selector, &url)
            .post(&url)
            .header(CONTENT_TYPE, "application/dns-message")
            .header(ACCEPT, "application/dns-message")
            .body(wire.to_vec())
            .send()
            .await
            .map_err(|err| err.to_string())?;
        tracing::debug!(version = ?response.version(), status = %response.status(), "upstream response");
        if !response.status().is_success() {
            return Err(format!("upstream returned HTTP {}", response.status()));
        }
        let bytes = response.bytes().await.map_err(|err| err.to_string())?;
        if bytes.len() < 12 {
            return Err("upstream returned an invalid DNS response".to_string());
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_precedence() {
        let upstream = Upstream::new("https://default.example/dns-query".into()).unwrap();
        assert_eq!(
            upstream.url_for(Some("google")),
            "https://dns.google/dns-query"
        );
        assert_eq!(
            upstream.url_for(Some("https://custom.example/dns-query")),
            "https://custom.example/dns-query"
        );
        assert_eq!(upstream.url_for(None), "https://default.example/dns-query");
    }
}
