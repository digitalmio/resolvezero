//! Integration test for the compiler heartbeat/status table.
//!
//! Runs only when DATABASE_URL is set. CI provides a disposable Postgres
//! service; the row is removed at the end.

use sqlx::Row;

use rz_db::{CycleStatus, Db};

#[tokio::test]
async fn compiler_status_roundtrip() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("skipping compiler_status_roundtrip: DATABASE_URL is not set");
        return;
    };
    let db = Db::connect(&url).await.expect("connect database");
    let instance = format!("integration-{}", std::process::id());

    db.heartbeat(&instance).await.expect("heartbeat");
    let status = CycleStatus {
        total: 4,
        stale: 1,
        compiled: 1,
        failed: 0,
        changed: 1,
        missing_artifacts: 0,
        oldest_compiled_at: Some(1_700_000_000),
        blocklist_version: 42,
        error: None,
    };
    db.record_cycle(&instance, &status)
        .await
        .expect("record cycle");

    let row = sqlx::query(
        "select lists_total, lists_stale, lists_compiled, lists_failed,
                lists_changed, missing_artifacts, blocklist_version,
                last_success_at is not null as has_success,
                last_refresh_at is not null as has_refresh, last_error
           from compiler_status where instance = $1",
    )
    .bind(&instance)
    .fetch_one(db.pool())
    .await
    .expect("read status");
    assert_eq!(row.get::<i32, _>("lists_total"), 4);
    assert_eq!(row.get::<i32, _>("lists_stale"), 1);
    assert_eq!(row.get::<i32, _>("lists_compiled"), 1);
    assert_eq!(row.get::<i32, _>("lists_failed"), 0);
    assert_eq!(row.get::<i32, _>("lists_changed"), 1);
    assert_eq!(row.get::<i32, _>("missing_artifacts"), 0);
    assert_eq!(row.get::<i32, _>("blocklist_version"), 42);
    assert!(row.get::<bool, _>("has_success"));
    assert!(row.get::<bool, _>("has_refresh"));
    assert!(row
        .try_get::<Option<String>, _>("last_error")
        .unwrap()
        .is_none());

    let failed = CycleStatus {
        failed: 2,
        error: Some("synthetic failure".into()),
        ..status
    };
    db.record_cycle(&instance, &failed)
        .await
        .expect("record failure");

    let profile_id = "itest001";
    sqlx::query("delete from profile_blocklists where profile_id = $1")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("clean old blocklists");
    sqlx::query("delete from profiles where id = $1")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("clean old profile");
    sqlx::query("insert into profiles (id, name) values ($1, 'integration')")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("insert profile");
    sqlx::query(
        "insert into profile_blocklists (profile_id, url, format, enabled, compiled_at)
         values ($1, 'https://example.invalid/list.txt', 'hosts', true, now())",
    )
    .bind(profile_id)
    .execute(db.pool())
    .await
    .expect("insert blocklist");

    let (oldest, missing) = db.artifact_freshness().await.expect("freshness");
    assert!(oldest.is_some());
    assert_eq!(missing, 1);
    sqlx::query("update profile_blocklists set artifact_hash = 'deadbeef' where profile_id = $1")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("set artifact hash");
    let (_, missing) = db.artifact_freshness().await.expect("freshness");
    assert_eq!(missing, 0);

    sqlx::query("delete from profile_blocklists where profile_id = $1")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("clean blocklist");
    sqlx::query("delete from profiles where id = $1")
        .bind(profile_id)
        .execute(db.pool())
        .await
        .expect("clean profile");
    sqlx::query("delete from compiler_status where instance = $1")
        .bind(&instance)
        .execute(db.pool())
        .await
        .expect("cleanup");
}
