use super::{AppState, QueryContext};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Resolve a linked source IP to a profile. Hosted profiles without a token
/// are refused so one transport cannot drift from the others.
pub(super) async fn source_profile(state: &AppState, ip: &str) -> Option<String> {
    let profile = state.store.read().await.authorize_ip(ip).cloned()?;
    if hosted_tokenless(state, &profile).await {
        return None;
    }
    note_source_ip(state, ip);
    Some(profile)
}

/// Keep a 30-day link alive without a DB write per query.
fn note_source_ip(state: &AppState, ip: &str) {
    const REFRESH: Duration = Duration::from_secs(24 * 3600);
    const MAX_TRACKED: usize = 4_096;
    let due = {
        let mut seen = state.seen_source_ips.lock().expect("source ip seen");
        if let Some(last) = seen.get_mut(ip) {
            if last.elapsed() < REFRESH {
                false
            } else {
                *last = Instant::now();
                true
            }
        } else if seen.len() < MAX_TRACKED {
            seen.insert(ip.to_string(), Instant::now());
            true
        } else {
            false
        }
    };
    if due {
        let db = state.db.clone();
        let ip = ip.to_string();
        tokio::spawn(async move {
            let _ = db.touch_source_ip(&ip).await;
        });
    }
}

/// Hosted mode refuses profiles that have no token; every transport must apply
/// the same rule so DoT cannot drift from DoH/TCP/UDP.
pub(super) async fn hosted_tokenless(state: &AppState, profile: &str) -> bool {
    state.cfg.hosted
        && !state.cfg.allow_tokenless
        && state
            .store
            .read()
            .await
            .profile_meta(profile)
            .is_some_and(|meta| meta.token.is_none())
}

/// Track failures per profile: one profile's successful load must not clear
/// another profile's failure from readiness.
fn set_blocklist_status(state: &AppState, profile: &str, failed: usize, pending: usize) {
    let count = {
        let mut set = state
            .blocklist_failed_profiles
            .lock()
            .expect("blocklist failed profiles");
        if failed + pending > 0 {
            set.insert(profile.to_string());
        } else {
            set.remove(profile);
        }
        set.len()
    };
    state.blocklist_failed.store(count, Ordering::Relaxed);
    state.blocklist_ok.store(count == 0, Ordering::Relaxed);
    *state.blocklist_error.lock().expect("blocklist error") = if count == 0 {
        None
    } else {
        Some(format!("list load failed for {count} profile(s)"))
    };
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
            set_blocklist_status(state, profile, report.failed, report.pending);
            info!(
                profile,
                loaded = report.loaded,
                failed = report.failed,
                "lazy lists changed; dns cache flushed"
            );
        }
        Ok(report) if report.failed > 0 => {
            set_blocklist_status(state, profile, report.failed, report.pending);
            warn!(
                profile,
                loaded = report.loaded,
                failed = report.failed,
                "lazy list load incomplete; retrying"
            );
        }
        Ok(report) if report.loaded > 0 => {
            set_blocklist_status(state, profile, report.failed, report.pending);
            info!(profile, loaded = report.loaded, "lazy lists ready");
        }
        Ok(report) if report.pending > 0 => {
            set_blocklist_status(state, profile, report.failed, report.pending);
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
