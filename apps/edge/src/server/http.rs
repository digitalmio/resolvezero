use super::api::{handle_update_ip, handle_whoami};
use super::purge::{handle_logs, handle_purge, valid_device};
use super::resolve::resolve_wire;
use super::{AppState, QueryContext};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;

pub(super) const DOH_ROUTE: &str = "/v1/{*rest}";

pub(super) async fn doh_handler(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let client_ip = headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(|value| value.trim().to_string())
        });
    let client_key = client_ip.clone().unwrap_or_else(|| "unknown".into());
    if !state.doh_rate.allow(&client_key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let _permit = match state.doh_gate.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
    };

    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() || parts.len() > 3 {
        return StatusCode::NOT_FOUND.into_response();
    }
    match (
        method.as_str(),
        parts.get(1).copied(),
        parts.get(2).copied(),
    ) {
        ("GET", Some("logs"), None) if parts.len() == 2 => {
            return handle_logs(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("GET", Some("whoami"), None) if parts.len() == 2 => {
            return handle_whoami(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("POST", Some("update-ip"), None) if parts.len() == 2 => {
            return handle_update_ip(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("POST", Some("cache"), Some("purge")) if parts.len() == 3 => {
            return handle_purge(state.clone(), parts[0].to_string(), headers, uri, body).await;
        }
        ("OPTIONS", Some("whoami" | "update-ip"), _) => {
            return cors_preflight(headers).await;
        }
        _ => {}
    }
    let profile_id = parts[0];

    let (device, token) = match (parts.get(1), parts.get(2)) {
        (Some(seg), Some(token)) => {
            if !valid_device(seg) {
                return StatusCode::NOT_FOUND.into_response();
            }
            (Some(*seg), Some(*token))
        }
        (Some(seg), None) => {
            let has_token = state
                .store
                .read()
                .await
                .profile_meta(profile_id)
                .is_some_and(|meta| meta.has_token());
            if has_token {
                (None, Some(*seg))
            } else if valid_device(seg) {
                (Some(*seg), None)
            } else {
                return StatusCode::NOT_FOUND.into_response();
            }
        }
        (None, _) => (None, None),
    };
    if !state.store.read().await.has_profile(profile_id, token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if state.cfg.hosted {
        let tokenless = state
            .store
            .read()
            .await
            .profile_meta(profile_id)
            .is_some_and(|meta| meta.token.is_none());
        if tokenless {
            return StatusCode::NOT_FOUND.into_response();
        }
    }

    let wire = if method == Method::GET {
        let Some(query) = uri.query() else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let value = query.split('&').find_map(|pair| pair.strip_prefix("dns="));
        let Some(value) = value else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value) {
            Ok(wire) if wire.len() <= state.cfg.max_doh_get => wire,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        }
    } else if method == Method::POST {
        if let Some(content_type) = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
        {
            if !content_type.starts_with("application/dns-message") {
                return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
            }
        }
        if body.len() > state.cfg.max_doh_body {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        body.to_vec()
    } else {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    };

    if wire.len() < 12 {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let log_enabled = state.store.read().await.should_log(profile_id);
    let context = QueryContext {
        client_ip,
        device: device.map(str::to_string),
        transport: "doh",
        log_enabled,
    };

    if let Some(device) = &context.device {
        let key = (profile_id.to_string(), device.clone());
        let is_new = {
            let mut seen = state.seen_devices.lock().expect("device seen");
            seen.insert(key)
        };
        if is_new {
            let db = state.db.clone();
            let profile = profile_id.to_string();
            let device = device.clone();
            tokio::spawn(async move {
                let _ = db.touch_device(&profile, &device).await;
            });
        }
    }

    match tokio::time::timeout(
        state.cfg.doh_timeout,
        resolve_wire(&state, &wire, profile_id, &context),
    )
    .await
    {
        Ok(Some(response)) => (
            [
                (header::CONTENT_TYPE, "application/dns-message"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            response,
        )
            .into_response(),
        Ok(None) => StatusCode::BAD_REQUEST.into_response(),
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    }
}

pub(super) fn token_from(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(token) = query_param(uri, "token") {
        return Some(token);
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn query_param(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            Some(value.to_string())
        } else {
            None
        }
    })
}

pub(super) fn caller_ip(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    if std::env::var("ALLOW_UNTRUSTED_IP_HEADERS").as_deref() == Ok("1") {
        return headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    None
}

pub(super) async fn authorized(state: &AppState, profile: &str, token: Option<String>) -> bool {
    let store = state.store.read().await;
    if !store.has_profile(profile, token.as_deref()) {
        return false;
    }
    !(state.cfg.hosted
        && store
            .profile_meta(profile)
            .is_some_and(|meta| meta.token.is_none()))
}

fn console_origin(headers: &HeaderMap) -> Option<String> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    let allowed = std::env::var("CONSOLE_ORIGINS").unwrap_or_else(|_| {
        "https://my.resolvezero.com,http://localhost:3000,http://localhost:3100".into()
    });
    allowed
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == origin)
        .then(|| origin.to_string())
}

pub(super) fn with_cors(mut response: Response, headers: &HeaderMap) -> Response {
    if let Some(origin) = console_origin(headers) {
        if let Ok(value) = origin.parse() {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        response
            .headers_mut()
            .insert(header::VARY, "Origin".parse().expect("static header"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET,POST,OPTIONS".parse().expect("static header"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization,content-type".parse().expect("static header"),
        );
    }
    response
}

async fn cors_preflight(headers: HeaderMap) -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response(), &headers)
}
