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
    let fetcher = SafeFetcher::new(cfg.max_list_bytes, true);
    let deadline = Instant::now() + cfg.list_cycle_deadline;
    let mut report = LoadReport::default();
    let mut seen = std::collections::HashSet::new();

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

        match lists::load_table(
            &fetcher,
            s3.as_ref(),
            &subscription.url,
            &subscription.format,
            subscription.artifact_hash.as_deref(),
        )
        .await
        {
            Ok((table, source)) => {
                let entries = table.entries;
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
        .mark_profile_loaded(profile_id, report.failed);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ListSource, Subscription};
    use rz_core::fingerprint::FingerprintTable;
    use rz_db::ProfileRow;
    use std::collections::HashSet;

    fn profile(id: &str) -> ProfileRow {
        ProfileRow {
            id: id.to_string(),
            dot_id: None,
            doh_token: None,
            log_queries: true,
            safe_search: None,
            upstream: None,
            upstream_url: None,
            block_mode: None,
            block_ipv4: None,
            block_ipv6: None,
            block_ttl: None,
        }
    }

    #[tokio::test]
    async fn unknown_profile_is_not_marked_loaded() {
        let cfg = Config::for_test();
        let db = Db::lazy_for_test();
        let store = Arc::new(RwLock::new(RuleStore::default()));
        let gate = Mutex::new(());

        let report = ensure_profile_loaded(&db, &store, &cfg, "missing", &gate)
            .await
            .expect("unknown profile is a no-op");
        assert_eq!(report.loaded, 0);
        assert!(!store
            .read()
            .await
            .is_profile_loaded("missing", cfg.list_retry));
    }

    #[tokio::test]
    async fn profile_without_lists_is_marked_loaded() {
        let cfg = Config::for_test();
        let db = Db::lazy_for_test();
        let store = Arc::new(RwLock::new(RuleStore::default()));
        store
            .write()
            .await
            .replace_config(vec![profile("home")], vec![], vec![], vec![], vec![]);
        let gate = Mutex::new(());

        let report = ensure_profile_loaded(&db, &store, &cfg, "home", &gate)
            .await
            .expect("no lists is a no-op");
        assert_eq!(report.loaded, 0);
        assert!(store.read().await.is_profile_loaded("home", cfg.list_retry));
    }

    #[tokio::test]
    async fn resident_artifact_is_not_fetched_again() {
        let cfg = Config::for_test();
        let db = Db::lazy_for_test();
        let store = Arc::new(RwLock::new(RuleStore::default()));
        let subscription = Subscription {
            url: "https://lists/a.txt".into(),
            list_id: None,
            format: "hosts".into(),
            artifact_hash: Some("aaa".into()),
        };
        {
            let mut guard = store.write().await;
            guard.replace_config(vec![profile("home")], vec![], vec![], vec![], vec![]);
            guard.wire_subscriptions("home", vec![subscription.clone()]);
            guard.upsert_list(
                &subscription.url,
                subscription.artifact_hash.as_deref(),
                ListSource::Artifact,
                FingerprintTable::build(
                    &HashSet::from(["ads.example".to_string()]),
                    &HashSet::new(),
                ),
            );
        }
        let gate = Mutex::new(());

        let report = ensure_profile_loaded(&db, &store, &cfg, "home", &gate)
            .await
            .expect("resident table is skipped");
        assert_eq!(report.loaded, 0);
        assert_eq!(report.failed, 0);
        assert!(store.read().await.is_profile_loaded("home", cfg.list_retry));
    }
}
