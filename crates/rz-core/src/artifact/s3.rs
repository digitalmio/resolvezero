use std::fmt::Write as _;
use std::time::Duration;

use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use time::macros::format_description;
use time::OffsetDateTime;

use super::{hex, sha256_hex};

// ---- S3 GET (SigV4) ----

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
    client: reqwest::Client,
}

impl S3Config {
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("S3_ENDPOINT").ok()?;
        let allow_http = std::env::var("ALLOW_HTTP_S3").as_deref() == Ok("1");
        let local =
            endpoint.starts_with("http://localhost") || endpoint.starts_with("http://127.0.0.1");
        if !endpoint.starts_with("https://") && !(allow_http || local) {
            // Fail closed: SigV4 credentials must never travel in cleartext.
            return None;
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .ok()?;
        Some(Self {
            endpoint,
            region: std::env::var("S3_REGION").unwrap_or_else(|_| "auto".into()),
            bucket: std::env::var("S3_BUCKET").ok()?,
            access_key_id: std::env::var("S3_ACCESS_KEY_ID").ok()?,
            secret_access_key: std::env::var("S3_SECRET_ACCESS_KEY").ok()?,
            prefix: std::env::var("ARTIFACT_PREFIX").unwrap_or_else(|_| "artifacts".into()),
            client,
        })
    }

    pub fn key(&self, hash: &str) -> String {
        format!("{}/{}.bin", self.prefix.trim_matches('/'), hash)
    }

    pub async fn get(&self, hash: &str) -> Result<Vec<u8>, String> {
        self.get_key(&self.key(hash)).await
    }

    pub async fn get_key(&self, key: &str) -> Result<Vec<u8>, String> {
        const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
        let response = self.request("GET", key, "", b"", None).await?;
        if !response.status().is_success() {
            return Err(format!("artifact GET {} -> {}", key, response.status()));
        }
        if let Some(length) = response.content_length() {
            if length as usize > MAX_ARTIFACT_BYTES {
                return Err("artifact exceeds 64 MiB".into());
            }
        }
        let mut stream = response.bytes_stream();
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| err.to_string())?;
            if out.len() + chunk.len() > MAX_ARTIFACT_BYTES {
                return Err("artifact exceeds 64 MiB".into());
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }

    /// One page of S3 ListObjectsV2. Returns keys and the continuation token.
    pub async fn list(
        &self,
        prefix: &str,
        continuation: Option<&str>,
    ) -> Result<(Vec<String>, Option<String>), String> {
        let mut params: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1000".into()),
            ("prefix".into(), prefix.to_string()),
        ];
        if let Some(token) = continuation {
            params.push(("continuation-token".into(), token.to_string()));
        }
        params.sort_by(|a, b| a.0.cmp(&b.0));
        let query = params
            .iter()
            .map(|(key, value)| {
                format!("{}={}", encode_uri_segment(key), encode_uri_segment(value))
            })
            .collect::<Vec<_>>()
            .join("&");
        let response = self.request("GET", "", &query, b"", None).await?;
        if !response.status().is_success() {
            return Err(format!("S3 LIST -> {}", response.status()));
        }
        let body = response.bytes().await.map_err(|err| err.to_string())?;
        let text = String::from_utf8_lossy(&body);
        Ok((
            xml_values(&text, "Key"),
            xml_value(&text, "NextContinuationToken"),
        ))
    }

    /// PUT an object (used by the raw-log archive). Returns an error on any
    /// non-2xx response so the caller can queue a retry.
    pub async fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String> {
        let response = self
            .request("PUT", key, "", body, Some(content_type))
            .await?;
        if !response.status().is_success() {
            return Err(format!("S3 PUT {key} -> {}", response.status()));
        }
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        key: &str,
        query: &str,
        body: &[u8],
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let endpoint = self.endpoint.trim_end_matches('/');
        let host = endpoint
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(endpoint)
            .trim_end_matches('/');
        let canonical_uri = if key.is_empty() {
            format!("/{}", encode_uri_segment(&self.bucket))
        } else {
            format!(
                "/{}/{}",
                encode_uri_segment(&self.bucket),
                key.split('/')
                    .map(encode_uri_segment)
                    .collect::<Vec<_>>()
                    .join("/")
            )
        };
        let url = if query.is_empty() {
            format!("{endpoint}{canonical_uri}")
        } else {
            format!("{endpoint}{canonical_uri}?{query}")
        };

        let now = OffsetDateTime::now_utc();
        let amz_date = now
            .format(&format_description!(
                "[year][month][day]T[hour][minute][second]Z"
            ))
            .map_err(|err| err.to_string())?;
        let date = &amz_date[..8];
        let payload_hash = sha256_hex(body);

        let canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let signing_key = signing_key(&self.secret_access_key, date, &self.region);
        let signature = hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.access_key_id, scope, signed_headers, signature
        );

        let mut request = self
            .client
            .request(method.parse().map_err(|_| "invalid method")?, &url)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("authorization", authorization);
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        request
            .body(body.to_vec())
            .send()
            .await
            .map_err(|err| err.to_string())
    }
}

fn xml_value(text: &str, tag: &str) -> Option<String> {
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = text[start..].find(&format!("</{tag}>"))? + start;
    Some(xml_unescape(&text[start..end]))
}

fn xml_values(text: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(xml_unescape(&after[..end]));
        rest = &after[end + close.len()..];
    }
    out
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn encode_uri_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
