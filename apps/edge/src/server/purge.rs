use std::sync::Arc;

use axum::body::Bytes;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use flate2::read::GzDecoder;
use std::io::Read;

use rz_core::artifact::S3Config;

use super::http::{authorized, caller_ip, query_param, token_from};
use super::AppState;

pub(super) fn valid_purge_domain(value: &str) -> Option<String> {
    let domain = value
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_string();
    if domain.is_empty() || domain.len() > 253 || domain.contains("..") {
        return None;
    }
    let ok = domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    ok.then_some(domain)
}

pub(super) fn valid_purge_type(value: &str) -> Option<String> {
    const TYPES: [&str; 11] = [
        "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "SRV", "CAA", "HTTPS", "SVCB",
    ];
    let value = value.trim().to_ascii_uppercase();
    if value.is_empty() {
        return None;
    }
    TYPES.contains(&value.as_str()).then_some(value)
}

pub(super) async fn handle_purge(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let caller = caller_ip(&headers).unwrap_or_else(|| "unknown".into());
    if !state.purge_rate.allow(&format!("{caller}:{profile}")) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let mut name = query_param(&uri, "name").unwrap_or_default();
    let mut record_type = query_param(&uri, "type").unwrap_or_default();
    if name.is_empty() && !body.is_empty() {
        if body.len() > 4096 {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        name = value
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        record_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
    }
    let Some(domain) = valid_purge_domain(&name) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let record_type = valid_purge_type(&record_type);
    match state
        .db
        .insert_purge(&profile, &domain, record_type.as_deref())
        .await
    {
        Ok(()) => axum::Json(serde_json::json!({
            "ok": true,
            "domain": domain,
            "type": record_type,
        }))
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(super) async fn handle_logs(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let caller = caller_ip(&headers).unwrap_or_else(|| "unknown".into());
    if !state.admin_rate.allow(&format!("logs:{caller}:{profile}")) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Some(s3) = S3Config::from_env() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "error": "raw log archive not configured" })),
        )
            .into_response();
    };
    let prefix = std::env::var("S3_LOG_PREFIX").unwrap_or_else(|_| "logs".into());
    let date = query_param(&uri, "date")
        .filter(|value| value.len() == 10 && value.chars().all(|c| c.is_ascii_digit() || c == '-'));
    let mut object_prefix = format!("{prefix}/{profile}/");
    if let Some(date) = &date {
        object_prefix.push_str(date);
        object_prefix.push('/');
    }

    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..50 {
        match s3.list(&object_prefix, token.as_deref()).await {
            Ok((page, next)) => {
                keys.extend(page);
                token = next;
                if token.is_none() {
                    break;
                }
            }
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    keys.sort();
    const MAX_OBJECTS: usize = 200;
    let capped = keys.len() > MAX_OBJECTS;
    if capped {
        keys = keys.split_off(keys.len() - MAX_OBJECTS);
    }
    let newest_first = query_param(&uri, "order").as_deref() == Some("desc");
    if newest_first {
        keys.reverse();
    }
    let limit = query_param(&uri, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(100)
        .min(10_000);

    let mut out = String::new();
    if capped {
        out.push_str("{\"warning\":\"truncated at 200 objects\"}\n");
    }
    let mut emitted = 0usize;
    for key in keys {
        if emitted >= limit {
            break;
        }
        let Ok(bytes) = s3.get_key(&key).await else {
            continue;
        };
        if bytes.len() > 8 * 1024 * 1024 {
            continue;
        }
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut text = String::new();
        if decoder.read_to_string(&mut text).is_err() {
            continue;
        }
        let mut lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        if newest_first {
            lines.reverse();
        }
        for line in lines {
            out.push_str(line);
            out.push('\n');
            emitted += 1;
            if emitted >= limit {
                break;
            }
        }
    }

    let disposition = format!(
        "attachment; filename=\"rz-logs-{profile}{}.jsonl\"",
        date.map(|date| format!("-{date}")).unwrap_or_default()
    );
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
        ],
        out,
    )
        .into_response()
}

pub(super) fn valid_device(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
