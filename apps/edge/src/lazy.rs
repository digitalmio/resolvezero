//! On-demand blocklist loading.
//!
//! The edge starts with zero list tables. The first query for a profile pulls
//! only that profile's content-addressed artifacts from E2, verifies them, and
//! installs the tables in the shared catalog. Other PoPs and idle profiles stay
//! small, so the same machine shape works in every region.

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

use crate::config::Config;
use crate::lists;
use crate::store::RuleStore;
use rz_core::artifact::S3Config;
use rz_core::netguard::{redact_url, SafeFetcher};
use rz_db::Db;

#[derive(Clone, Copy, Debug, Default)]
pub struct LoadReport {
    pub loaded: usize,
    pub failed: usize,
    pub pending: usize,
    pub changed: bool,
}

/// Load the lists subscribed by `profile_id` if they are not in the catalog
/// yet. Idempotent and single-flight: concurrent first queries for the same
/// profile wait on `gate` and only the first one performs the fetches.
pub async fn ensure_profile_loaded(
    db: &Db,
    store: &Arc<RwLock<RuleStore>>,
    cfg: &Config,
    profile_id: &str,
    gate: &Mutex<()>,
) -> Result<LoadReport, String> {
    {
        let guard = store.read().await;
        if guard.is_profile_loaded(profile_id, cfg.list_retry) {
            return Ok(LoadReport::default());
        }
        if !guard.profiles.contains_key(profile_id) {
            return Ok(LoadReport::default());
        }
    }

    let _gate = gate.lock().await;

    let subscriptions = {
        let guard = store.read().await;
        if guard.is_profile_loaded(profile_id, cfg.list_retry) {
            return Ok(LoadReport::default());
        }
        guard
            .subscriptions
            .get(profile_id)
            .cloned()
            .unwrap_or_default()
    };
    if subscriptions.is_empty() {
        store.write().await.mark_profile_loaded(profile_id, 0);
        return Ok(LoadReport::default());
    }

    let s3 = S3Config::from_env();
    let fetcher = SafeFetcher::new(cfg.max_list_bytes, false);
    let deadline = Instant::now() + cfg.list_cycle_deadline;
    let mut report = LoadReport::default();
    let mut seen = std::collections::HashSet::new();
    let mut profile_entries = {
        let guard = store.read().await;
        let mut urls = std::collections::HashSet::new();
        subscriptions
            .iter()
            .filter(|sub| urls.insert(sub.url.as_str()))
            .filter_map(|sub| guard.catalog.get(&sub.url).map(|table| table.entries))
            .sum::<usize>()
    };

    for subscription in subscriptions {
        if !seen.insert(subscription.url.clone()) {
            continue;
        }
        if store.read().await.list_up_to_date(&subscription) {
            continue;
        }
        if Instant::now() >= deadline {
            warn!(
                profile_id,
                url = %redact_url(&subscription.url),
                "lazy list deadline reached; retrying later"
            );
            report.failed += 1;
            continue;
        }

        if cfg.artifact_only && subscription.artifact_hash.is_none() {
            report.pending += 1;
            info!(
                profile_id,
                url = %redact_url(&subscription.url),
                "artifact pending; skipping raw list"
            );
            continue;
        }

        match lists::load_table(
            &fetcher,
            s3.as_ref(),
            &subscription.url,
            &subscription.format,
            subscription.artifact_hash.as_deref(),
            !cfg.artifact_only,
        )
        .await
        {
            Ok((table, source)) => {
                let entries = table.entries;
                if profile_entries + entries > cfg.max_entries_per_profile {
                    warn!(
                        profile_id,
                        url = %redact_url(&subscription.url),
                        entries,
                        profile_entries,
                        cap = cfg.max_entries_per_profile,
                        "per-profile rule budget exceeded; lazy list skipped"
                    );
                    report.failed += 1;
                    continue;
                }
                let total = store.read().await.remote_rules();
                if total + entries > cfg.max_total_entries {
                    warn!(
                        profile_id,
                        url = %redact_url(&subscription.url),
                        entries,
                        total,
                        cap = cfg.max_total_entries,
                        "global rule budget exceeded; lazy list skipped"
                    );
                    report.failed += 1;
                    continue;
                }
                profile_entries += entries;
                let changed = store.write().await.upsert_list(
                    &subscription.url,
                    subscription.artifact_hash.as_deref(),
                    source,
                    table,
                );
                report.loaded += 1;
                report.changed |= changed;
                info!(
                    profile_id,
                    url = %redact_url(&subscription.url),
                    entries,
                    ?source,
                    "lazy list loaded"
                );
                let _ = db
                    .write_blocklist_status(
                        &subscription.url,
                        "ok",
                        entries as i32,
                        Some(&subscription.format),
                    )
                    .await;
            }
            Err(err) => {
                report.failed += 1;
                warn!(
                    profile_id,
                    url = %redact_url(&subscription.url),
                    %err,
                    "lazy list load failed"
                );
                let status = format!("error: {}", err.chars().take(42).collect::<String>());
                let _ = db
                    .write_blocklist_status(&subscription.url, &status, 0, None)
                    .await;
            }
        }
    }

    store
        .write()
        .await
        .mark_profile_loaded(profile_id, report.failed.saturating_add(report.pending));
    Ok(report)
}

#[cfg(test)]
mod tests;
