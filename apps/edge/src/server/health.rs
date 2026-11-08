use super::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

pub(super) async fn healthz() -> StatusCode {
    StatusCode::NO_CONTENT
}

pub(super) async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let ready = state.ready.load(Ordering::Relaxed);
    let blocklist_ok = state.blocklist_ok.load(Ordering::Relaxed);
    let failed = state.blocklist_failed.load(Ordering::Relaxed);
    let error = state
        .blocklist_error
        .lock()
        .expect("blocklist error")
        .clone();
    let last_sync = state.last_sync_at.load(Ordering::Relaxed);
    let last_sync_age = if last_sync == 0 {
        None
    } else {
        Some((now_seconds() - last_sync).max(0) * 1000)
    };
    let last_poll = state.last_config_poll_at.load(Ordering::Relaxed);
    let config_poll_age = if last_poll == 0 {
        None
    } else {
        Some((now_seconds() - last_poll).max(0) * 1000)
    };
    // Lazy mode intentionally starts with an empty catalog; readiness means the
    // config snapshot and subscription metadata loaded, not that every list is
    // resident. Eager mode keeps the old catalog gate.
    let subscriptions_loaded = state.subscriptions_loaded.load(Ordering::Relaxed);
    let ok = ready && subscriptions_loaded;
    let body = serde_json::json!({
        "ok": ok,
        "region": state.cfg.region,
        "rulesLoaded": subscriptions_loaded,
        "blocklistsLoaded": blocklist_ok,
        "subscriptionsLoaded": subscriptions_loaded,
        "dns53Bound": state.dns53_bound.load(Ordering::Relaxed),
        "blocklistOk": blocklist_ok,
        "blocklistError": error.is_some(),
        "failedBlocklists": failed,
        "blocklistLastSyncAgeMs": last_sync_age,
        "configPollAgeMs": config_poll_age,
        "configPollError": state.config_poll_error.load(Ordering::Relaxed),
        "lazyLists": state.cfg.lazy_lists,
        "artifactOnly": state.cfg.artifact_only,
        "remoteLists": store.remote_rules(),
        "remoteListTables": store.catalog.len(),
        "artifactLists": store.artifact_lists(),
        "rawLists": store.raw_lists(),
        "pendingLists": store.pending_lists(),
        "profiles": store.profiles.len(),
        "rssMb": crate::metrics::rss_bytes() / 1024 / 1024,
        "memoryLimitMb": memory_limit_mb(),
    });
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, axum::Json(body)).into_response()
}

fn memory_limit_mb() -> u64 {
    std::env::var("FLY_VM_MEMORY_MB")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1024)
}

pub(super) async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let cache = &state.cache;
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(
            &store,
            cache,
            state.blocklist_failed.load(Ordering::Relaxed),
        ),
    )
        .into_response()
}

pub(super) fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
