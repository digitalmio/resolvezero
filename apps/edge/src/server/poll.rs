use super::health::now_seconds;
use super::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing::{error, info, warn};

use crate::lists;
use rz_db::Db;

pub(super) async fn poll_loop(
    db: Db,
    state: Arc<AppState>,
    mut last_config: i32,
    mut last_blocklist: i32,
    initial_ok: bool,
) {
    let mut last_sync = if initial_ok {
        Instant::now()
    } else {
        Instant::now() - state.cfg.list_interval
    };
    let mut next_retry = Instant::now();
    let mut last_purge = Instant::now() - Duration::from_secs(60);
    // Reload hourly even without a version bump so expired IP links drop out.
    let mut last_refresh = Instant::now();
    loop {
        tokio::time::sleep(state.cfg.poll_interval).await;
        if last_purge.elapsed() >= Duration::from_secs(5) {
            last_purge = Instant::now();
            let since = state.purge_since.load(Ordering::Relaxed);
            if let Ok(purges) = db.pending_purges(since).await {
                if !purges.is_empty() {
                    for (profile, domain, record_type) in purges {
                        state.cache.purge(&profile, &domain, record_type.as_deref());
                    }
                }
                state.purge_since.store(now_seconds(), Ordering::Relaxed);
            }
        }
        let versions = match db.versions().await {
            Ok(versions) => {
                state
                    .last_config_poll_at
                    .store(now_seconds(), Ordering::Relaxed);
                state.config_poll_error.store(false, Ordering::Relaxed);
                versions
            }
            Err(err) => {
                state.config_poll_error.store(true, Ordering::Relaxed);
                warn!(%err, "config poll failed");
                continue;
            }
        };

        if versions.config != last_config || last_refresh.elapsed() >= Duration::from_secs(3600) {
            match db.snapshot().await {
                Ok(snapshot) => {
                    let mut guard = state.store.write().await;
                    guard.replace_config(
                        snapshot.profiles,
                        snapshot.rules,
                        snapshot.ips,
                        snapshot.zones,
                        snapshot.services,
                    );
                    if state.cfg.hosted && !state.cfg.allow_tokenless {
                        let tokenless = guard.tokenless_profiles();
                        if !tokenless.is_empty() {
                            error!(
                                ?tokenless,
                                "hosted edge loaded tokenless profiles; requests will be rejected"
                            );
                        }
                    }
                    drop(guard);
                    last_config = versions.config;
                    last_refresh = Instant::now();
                    state.config_poll_error.store(false, Ordering::Relaxed);
                    info!(version = versions.config, "config snapshot loaded");
                }
                Err(err) => {
                    state.config_poll_error.store(true, Ordering::Relaxed);
                    warn!(%err, "config snapshot failed")
                }
            }
        }

        let version_changed = versions.blocklist != last_blocklist;
        let due = version_changed || last_sync.elapsed() >= state.cfg.list_interval;
        if due && Instant::now() >= next_retry {
            let _guard = state.sync_lock.lock().await;
            // Serialize metadata changes with first-query loads. Otherwise a
            // load could finish with the old artifact hash after the marker was
            // cleared, and never reload until the next watermark.
            let _list_gate = if state.cfg.lazy_lists {
                Some(state.list_gate.lock().await)
            } else {
                None
            };
            if version_changed && state.cfg.lazy_lists {
                // New artifacts are immutable; drop the "loaded" markers so
                // each profile re-resolves its hashes on the next query.
                state.store.write().await.clear_loaded();
                state.cache.clear();
            }
            let result = if state.cfg.lazy_lists {
                lists::sync_metadata(&db, &state.store, &state.cfg).await
            } else {
                lists::sync_once(&db, &state.store, &state.cache, &state.cfg).await
            };
            match result {
                Ok(report) => {
                    last_blocklist = versions.blocklist;
                    last_sync = Instant::now();
                    state.subscriptions_loaded.store(true, Ordering::Relaxed);
                    state
                        .blocklist_ok
                        .store(report.failed == 0, Ordering::Relaxed);
                    state
                        .blocklist_failed
                        .store(report.failed, Ordering::Relaxed);
                    state.last_sync_at.store(now_seconds(), Ordering::Relaxed);
                    *state.blocklist_error.lock().expect("blocklist error") = None;
                    info!(
                        changed = report.changed,
                        failed = report.failed,
                        lazy = state.cfg.lazy_lists,
                        "blocklist sync complete"
                    );
                }
                Err(err) => {
                    state.blocklist_ok.store(false, Ordering::Relaxed);
                    *state.blocklist_error.lock().expect("blocklist error") = Some(err.clone());
                    next_retry = Instant::now() + Duration::from_secs(30);
                    warn!(%err, "blocklist sync failed; retrying");
                }
            }
        }
    }
}
