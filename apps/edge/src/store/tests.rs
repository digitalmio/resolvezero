use rz_db::{BlockedServiceRow, ProfileRow, RuleRow, ZoneRow};

#[cfg(test)]
use super::*;

fn profile(id: &str, token: Option<&str>) -> ProfileRow {
    ProfileRow {
        id: id.to_string(),
        dot_id: None,
        doh_token: token.map(str::to_string),
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

fn rule(profile_id: &str, domain: &str, action: Action) -> RuleRow {
    RuleRow {
        profile_id: profile_id.to_string(),
        domain: domain.to_string(),
        action,
    }
}

fn zone(profile_id: &str, domain: &str, record_type: &str) -> ZoneRow {
    ZoneRow {
        profile_id: profile_id.to_string(),
        domain: domain.to_string(),
        record_type: record_type.to_string(),
        values: vec!["192.0.2.10".to_string()],
        ttl: 60,
    }
}

#[test]
fn auth_requires_the_configured_token() {
    let mut store = RuleStore::default();
    store.replace_config(
        vec![profile("home", Some("secret"))],
        vec![],
        vec![],
        vec![],
        vec![],
    );
    assert!(store.has_profile("home", Some("secret")));
    assert!(!store.has_profile("home", Some("wrong")));
    assert!(!store.has_profile("home", None));
    assert!(!store.has_profile("missing", Some("secret")));
}

#[test]
fn custom_rules_match_subtrees() {
    let mut store = RuleStore::default();
    store.replace_config(
        vec![profile("home", None)],
        vec![rule("home", "corp.example.com", Action::Block)],
        vec![],
        vec![],
        vec![],
    );
    assert_eq!(
        store.resolve_custom("home", "a.corp.example.com"),
        Some(Action::Block)
    );
    assert_eq!(store.resolve_custom("home", "example.com"), None);
}

#[test]
fn zones_match_exact_and_wildcard() {
    let mut store = RuleStore::default();
    store.replace_config(
        vec![profile("home", None)],
        vec![],
        vec![],
        vec![
            zone("home", "nas.lan", "A"),
            zone("home", "*.home.lan", "A"),
        ],
        vec![],
    );
    assert!(store.zone_lookup("home", "nas.lan", "A").is_some());
    assert!(store.zone_lookup("home", "tv.home.lan", "A").is_some());
    assert!(store.zone_lookup("home", "home.lan", "A").is_none());
}

#[test]
fn blocked_services_expand_but_explicit_rules_win() {
    let mut store = RuleStore::default();
    store.replace_config(
        vec![profile("home", None)],
        vec![rule("home", "youtube.com", Action::Allow)],
        vec![],
        vec![],
        vec![
            BlockedServiceRow {
                profile_id: "home".into(),
                service: "youtube".into(),
            },
            BlockedServiceRow {
                profile_id: "home".into(),
                service: "tiktok".into(),
            },
        ],
    );
    assert_eq!(
        store.resolve_custom("home", "youtube.com"),
        Some(Action::Allow)
    );
    assert_eq!(
        store.resolve_custom("home", "www.youtube.com"),
        Some(Action::Allow)
    );
    assert_eq!(
        store.resolve_custom("home", "tiktok.com"),
        Some(Action::Block)
    );
}

#[test]
fn lazy_markers_reset_when_subscriptions_change() {
    let mut store = RuleStore::default();
    store.replace_config(vec![profile("home", None)], vec![], vec![], vec![], vec![]);
    store.wire_subscriptions("home", vec![Subscription::raw("list", None)]);
    store.mark_profile_loaded("home", 0);
    assert!(store.is_profile_loaded("home", std::time::Duration::from_secs(60)));

    // Same subscription: keep the marker (no needless reload).
    store.wire_subscriptions("home", vec![Subscription::raw("list", None)]);
    assert!(store.is_profile_loaded("home", std::time::Duration::from_secs(60)));

    // New artifact hash: force a reload on the next query.
    store.wire_subscriptions(
        "home",
        vec![Subscription {
            url: "list".into(),
            list_id: None,
            format: "hosts".into(),
            artifact_hash: Some("abc".into()),
        }],
    );
    assert!(!store.is_profile_loaded("home", std::time::Duration::from_secs(60)));
}

#[test]
fn failed_lazy_load_retries_after_backoff() {
    let mut store = RuleStore::default();
    store.mark_profile_loaded("home", 2);
    let retry = std::time::Duration::from_secs(60);
    assert!(store.is_profile_loaded("home", retry));
    store.clear_loaded();
    assert!(!store.is_profile_loaded("home", retry));
}

#[test]
fn pending_lists_tracks_unloaded_subscriptions() {
    use rz_core::fingerprint::FingerprintTable;
    let mut store = RuleStore::default();
    store.wire_subscriptions(
        "home",
        vec![Subscription {
            url: "list".into(),
            list_id: None,
            format: "hosts".into(),
            artifact_hash: Some("abc".into()),
        }],
    );
    assert_eq!(store.pending_lists(), 1);
    store.upsert_list(
        "list",
        Some("abc"),
        ListSource::Artifact,
        FingerprintTable::build(&HashSet::from(["ads.example".to_string()]), &HashSet::new()),
    );
    assert_eq!(store.pending_lists(), 0);
}

#[test]
fn prune_catalog_drops_unreferenced_tables_and_bookkeeping() {
    use rz_core::fingerprint::FingerprintTable;
    let mut store = RuleStore::default();
    store.upsert_list(
        "keep",
        Some("a"),
        ListSource::Artifact,
        FingerprintTable::build(&HashSet::from(["a.example".to_string()]), &HashSet::new()),
    );
    store.upsert_list(
        "drop",
        None,
        ListSource::Raw,
        FingerprintTable::build(&HashSet::from(["b.example".to_string()]), &HashSet::new()),
    );
    store.wire_subscriptions("home", vec![Subscription::raw("keep", None)]);

    store.prune_catalog();
    assert_eq!(store.catalog.len(), 1);
    assert!(store.catalog.contains_key("keep"));
    assert_eq!(store.artifact_lists(), 1);
    assert_eq!(store.raw_lists(), 0);
    assert!(!store.catalog_hashes.contains_key("drop"));
    assert!(!store.list_sources.contains_key("drop"));
}

#[test]
fn remote_attribution_reports_the_matching_list_id() {
    use rz_core::fingerprint::FingerprintTable;
    let mut store = RuleStore::default();
    store.upsert_list(
        "list",
        None,
        ListSource::Raw,
        FingerprintTable::build(&HashSet::from(["ads.example".to_string()]), &HashSet::new()),
    );
    store.wire_subscriptions(
        "home",
        vec![Subscription {
            url: "list".into(),
            list_id: Some("list-id".into()),
            format: "hosts".into(),
            artifact_hash: None,
        }],
    );
    assert_eq!(
        store.resolve_remote_detailed("home", "ads.example"),
        Some((Action::Block, Some("list-id".into())))
    );
}

#[test]
fn remote_allow_wins_across_lists() {
    use rz_core::fingerprint::FingerprintTable;
    let mut store = RuleStore::default();
    store.replace_config(vec![profile("home", None)], vec![], vec![], vec![], vec![]);
    let block: HashSet<String> = ["ads.example".to_string()].into_iter().collect();
    let allow: HashSet<String> = ["good.ads.example".to_string()].into_iter().collect();
    store.upsert_list(
        "block",
        None,
        ListSource::Raw,
        FingerprintTable::build(&block, &HashSet::new()),
    );
    store.upsert_list(
        "allow",
        None,
        ListSource::Raw,
        FingerprintTable::build(&HashSet::new(), &allow),
    );
    store.wire_subscriptions(
        "home",
        vec![
            Subscription::raw("block", None),
            Subscription::raw("allow", None),
        ],
    );
    assert_eq!(
        store.resolve_remote("home", "good.ads.example"),
        Some(Action::Allow)
    );
    assert_eq!(
        store.resolve_remote("home", "ads.example"),
        Some(Action::Block)
    );
}
