use super::{AppState, QueryContext};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use hickory_proto::rr::RecordType;

use crate::dns;
use crate::lazy;
use crate::stats::QueryEvent;
use tracing::{info, warn};

#[allow(clippy::too_many_arguments)] // one call site per decision; a struct hides the shape
pub(super) fn record(
    state: &AppState,
    question: &dns::Question,
    profile: &str,
    context: &QueryContext,
    action: &'static str,
    reason: Option<&'static str>,
    list_id: Option<String>,
    upstream: Option<String>,
    rtt_ms: Option<i64>,
) {
    if !context.log_enabled {
        return;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    state.logger.log(QueryEvent {
        at: now_ms / 1000,
        at_ms: now_ms,
        profile: profile.to_string(),
        domain: question.name.clone(),
        action,
        reason,
        list_id,
        transport: context.transport,
        upstream,
        client_ip: context.client_ip.clone(),
        device: context.device.clone(),
        rtt_ms,
    });
}

pub(super) fn upstream_label(selector: Option<&str>) -> String {
    match selector {
        Some("cloudflare") => "cloudflare".into(),
        Some("google") => "google".into(),
        Some("quad9") => "quad9".into(),
        Some(url) if url.starts_with("http") => "custom".into(),
        _ => "edge-default".into(),
    }
}

pub(super) fn match_probe_nonce(name: &str, probe_domain: &str) -> Option<String> {
    let lower = name.trim_end_matches('.').to_ascii_lowercase();
    let suffix = format!(".{}", probe_domain.to_ascii_lowercase());
    let nonce = lower.strip_suffix(&suffix)?;
    if nonce.is_empty()
        || nonce.contains('.')
        || !(16..=64).contains(&nonce.len())
        || !nonce.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(nonce.to_string())
}

pub(super) fn record_type_name(record_type: RecordType) -> &'static str {
    match record_type {
        RecordType::A => "A",
        RecordType::AAAA => "AAAA",
        RecordType::CNAME => "CNAME",
        RecordType::TXT => "TXT",
        _ => "OTHER",
    }
}

pub(super) async fn ensure_lists(state: &AppState, profile: &str) {
    match lazy::ensure_profile_loaded(
        &state.db,
        &state.store,
        &state.cfg,
        profile,
        &state.list_gate,
    )
    .await
    {
        Ok(report) if report.changed => {
            state.cache.clear();
            state.blocklist_failed.store(0, Ordering::Relaxed);
            state.blocklist_ok.store(true, Ordering::Relaxed);
            *state.blocklist_error.lock().expect("blocklist error") = None;
            info!(
                profile,
                loaded = report.loaded,
                failed = report.failed,
                "lazy lists changed; dns cache flushed"
            );
        }
        Ok(report) if report.failed > 0 => {
            state
                .blocklist_failed
                .store(report.failed, Ordering::Relaxed);
            state.blocklist_ok.store(false, Ordering::Relaxed);
            *state.blocklist_error.lock().expect("blocklist error") =
                Some(format!("lazy list load failed for {profile}"));
            warn!(
                profile,
                loaded = report.loaded,
                failed = report.failed,
                "lazy list load incomplete; retrying"
            );
        }
        Ok(report) if report.loaded > 0 => {
            state.blocklist_failed.store(0, Ordering::Relaxed);
            state.blocklist_ok.store(true, Ordering::Relaxed);
            *state.blocklist_error.lock().expect("blocklist error") = None;
            info!(profile, loaded = report.loaded, "lazy lists ready");
        }
        Ok(report) if report.pending > 0 => {
            info!(
                profile,
                pending = report.pending,
                "artifacts pending; list filtering waits"
            );
        }
        Ok(_) => {}
        Err(err) => warn!(profile, %err, "lazy list load failed"),
    }
}
