
use super::*;
use rz_db::BlocklistRow;

fn row(profile: &str, url: &str, hash: Option<&str>) -> BlocklistRow {
    BlocklistRow {
        id: format!("{profile}-{url}"),
        profile_id: profile.to_string(),
        url: url.to_string(),
        format: "hosts".to_string(),
        artifact_hash: hash.map(str::to_string),
    }
}

#[test]
fn dedupes_urls_and_preserves_artifact_metadata() {
    let plan = build_subscriptions(
        vec![
            row("home", "https://lists/a.txt", Some("aaa")),
            row("home", "https://lists/a.txt", Some("aaa")),
            row("home", "https://lists/b.txt", None),
        ],
        16,
        16,
    );
    let subs = plan.by_profile.get("home").expect("home plan");
    assert_eq!(subs.len(), 2);
    assert_eq!(subs[0].url, "https://lists/a.txt");
    assert_eq!(subs[0].format, "hosts");
    assert_eq!(subs[0].artifact_hash.as_deref(), Some("aaa"));
    assert_eq!(subs[1].artifact_hash, None);
    assert_eq!(plan.failed, 0);
}

#[test]
fn unique_cap_skips_rows_but_keeps_profiles_configured() {
    let plan = build_subscriptions(
        vec![
            row("home", "https://lists/a.txt", None),
            row("phone", "https://lists/b.txt", None),
        ],
        1,
        16,
    );
    assert!(plan.configured.contains("home"));
    assert!(plan.configured.contains("phone"));
    assert_eq!(plan.by_profile["home"].len(), 1);
    assert!(plan.by_profile["phone"].is_empty());
    assert_eq!(plan.failed, 1);
}

#[test]
fn per_profile_cap_truncates_after_dedupe() {
    let plan = build_subscriptions(
        vec![
            row("home", "https://lists/a.txt", None),
            row("home", "https://lists/b.txt", None),
            row("home", "https://lists/c.txt", None),
        ],
        16,
        2,
    );
    assert_eq!(plan.by_profile["home"].len(), 2);
}
