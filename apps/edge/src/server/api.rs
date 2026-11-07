use super::http::{authorized, caller_ip, query_param, token_from, with_cors};
use super::AppState;
use std::net::IpAddr;
use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

pub(super) async fn handle_whoami(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(ip) = caller_ip(&headers) else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "caller IP unavailable").into_response(),
            &headers,
        );
    };
    if ip.parse::<IpAddr>().is_err() {
        return with_cors(
            (StatusCode::BAD_REQUEST, "invalid caller IP").into_response(),
            &headers,
        );
    }
    let key = format!("{ip}:{profile}");
    if !state.admin_rate.allow(&key) {
        return with_cors(StatusCode::TOO_MANY_REQUESTS.into_response(), &headers);
    }
    let linked = state.store.read().await.authorize_ip(&ip) == Some(&profile);
    with_cors(
        axum::Json(serde_json::json!({
            "ip": ip,
            "profileId": profile,
            "linked": linked,
        }))
        .into_response(),
        &headers,
    )
}

pub(super) async fn handle_update_ip(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let explicit = query_param(&uri, "ip");
    if explicit.is_some() && std::env::var("ALLOW_EXPLICIT_IP_LINK").as_deref() != Ok("1") {
        return with_cors(
            (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": "explicit IP linking is disabled" })),
            )
                .into_response(),
            &headers,
        );
    }
    let Some(raw) = explicit.or_else(|| caller_ip(&headers)) else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "caller IP unavailable").into_response(),
            &headers,
        );
    };
    let Ok(ip) = raw.trim_matches(['[', ']']).parse::<IpAddr>() else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "invalid IP").into_response(),
            &headers,
        );
    };
    let key = format!("{ip}:{profile}");
    if !state.admin_rate.allow(&key) {
        return with_cors(StatusCode::TOO_MANY_REQUESTS.into_response(), &headers);
    }
    match state.db.link_source_ip(&profile, &ip.to_string()).await {
        Ok(true) => with_cors(
            axum::Json(
                serde_json::json!({ "ok": true, "ip": ip.to_string(), "profileId": profile }),
            )
            .into_response(),
            &headers,
        ),
        Ok(false) => with_cors(
            (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({ "error": "IP is linked to another profile" })),
            )
                .into_response(),
            &headers,
        ),
        Err(_) => with_cors(StatusCode::INTERNAL_SERVER_ERROR.into_response(), &headers),
    }
}
