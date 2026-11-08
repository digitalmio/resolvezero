//! Lazy-loading tests, kept beside the loader to stay under the file ceiling.

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
            FingerprintTable::build(&HashSet::from(["ads.example".to_string()]), &HashSet::new()),
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

#[tokio::test]
async fn artifact_only_skips_raw_pending_list() {
    let mut cfg = Config::for_test();
    cfg.artifact_only = true;
    let db = Db::lazy_for_test();
    let store = Arc::new(RwLock::new(RuleStore::default()));
    store
        .write()
        .await
        .replace_config(vec![profile("home")], vec![], vec![], vec![], vec![]);
    store.write().await.wire_subscriptions(
        "home",
        vec![Subscription {
            url: "https://lists/new.txt".into(),
            list_id: None,
            format: "hosts".into(),
            artifact_hash: None,
        }],
    );
    let gate = Mutex::new(());

    let report = ensure_profile_loaded(&db, &store, &cfg, "home", &gate)
        .await
        .expect("pending artifact is not an error");
    assert_eq!(report.loaded, 0);
    assert_eq!(report.failed, 0);
    assert_eq!(report.pending, 1);
}
