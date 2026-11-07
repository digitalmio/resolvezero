use super::dot::dot_loop;
use super::health::{healthz, metrics_handler, now_seconds, readyz};
use super::http::{doh_handler, DOH_ROUTE};
use super::poll::poll_loop;
use super::privdrop::drop_privileges;
use super::transports::tcp_loop;
use super::udp::udp_loop;
use super::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::Router;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{RwLock, Semaphore};
use tracing::{error, info, warn};

use crate::cache::DnsCache;
use crate::config::Config;
use crate::limits::FixedWindow;
use crate::lists;
use crate::metrics::Metrics;
use crate::stats::{self};
use crate::store::RuleStore;
use crate::upstream::Upstream;
use rz_db::Db;

pub async fn run(cfg: Config) -> Result<(), String> {
    let cfg = Arc::new(cfg);
    let db = Db::connect(&cfg.database_url)
        .await
        .map_err(|err| format!("database connect failed: {err}"))?;

    let (versions, snapshot) = initial_snapshot(&db).await?;

    let store = Arc::new(RwLock::new(RuleStore::default()));
    {
        let mut guard = store.write().await;
        guard.replace_config(
            snapshot.profiles,
            snapshot.rules,
            snapshot.ips,
            snapshot.zones,
            snapshot.services,
        );
    }

    if std::env::var("FLY_REGION").is_ok() && !cfg.allow_tokenless {
        let tokenless = store.read().await.tokenless_profiles();
        if !tokenless.is_empty() {
            return Err(format!(
                "hosted edge refuses token-free profiles: {tokenless:?}"
            ));
        }
    }

    let cache = Arc::new(DnsCache::default());
    let metrics = Arc::new(Metrics::default());
    let logger = Arc::new(stats::start(db.clone(), cfg.clone(), metrics.clone()));
    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        store: store.clone(),
        cache: cache.clone(),
        upstream: Arc::new(Upstream::new(cfg.default_upstream())?),
        metrics,
        logger,
        db: db.clone(),
        ready: AtomicBool::new(false),
        seen_devices: Mutex::new(HashSet::new()),
        inflight: Mutex::new(HashMap::new()),
        blocklist_ok: AtomicBool::new(false),
        blocklist_failed: AtomicUsize::new(0),
        blocklist_error: Mutex::new(None),
        last_sync_at: AtomicI64::new(0),
        last_config_poll_at: AtomicI64::new(now_seconds()),
        config_poll_error: AtomicBool::new(false),
        purge_since: AtomicI64::new(now_seconds() - 60),
        doh_rate: FixedWindow::new(cfg.doh_rate_limit_per_min, Duration::from_secs(60)),
        udp_rate: FixedWindow::new(cfg.udp_rate_limit_per_min, Duration::from_secs(60)),
        doh_gate: Semaphore::new(cfg.doh_max_inflight.max(1)),
        udp_gate: Arc::new(Semaphore::new(cfg.udp_max_inflight.max(1))),
        tcp_gate: Arc::new(Semaphore::new(cfg.tcp_max_connections.max(1))),
        conn_sources: Arc::new(Mutex::new(HashMap::new())),
        admin_rate: FixedWindow::new(60, Duration::from_secs(60)),
        purge_rate: FixedWindow::new(10, Duration::from_secs(60)),
        sync_lock: tokio::sync::Mutex::new(()),
        list_gate: tokio::sync::Mutex::new(()),
    });

    let initial = if cfg.lazy_lists {
        lists::sync_metadata(&db, &store, &cfg).await
    } else {
        lists::sync_once(&db, &store, &cache, &cfg).await
    };
    match initial {
        Ok(report) => {
            state
                .blocklist_ok
                .store(report.failed == 0, Ordering::Relaxed);
            state
                .blocklist_failed
                .store(report.failed, Ordering::Relaxed);
            state.last_sync_at.store(now_seconds(), Ordering::Relaxed);
            info!(
                changed = report.changed,
                failed = report.failed,
                lazy = cfg.lazy_lists,
                "initial blocklist metadata sync complete"
            );
        }
        Err(err) => {
            state.blocklist_ok.store(false, Ordering::Relaxed);
            *state.blocklist_error.lock().expect("blocklist error") = Some(err.clone());
            warn!(%err, "initial blocklist sync failed; serving explicit rules only");
        }
    }
    if cfg.hosted {
        let tokenless = state.store.read().await.tokenless_profiles();
        if !tokenless.is_empty() {
            error!(
                ?tokenless,
                "hosted edge loaded tokenless profiles; requests will be rejected"
            );
        }
    }

    // Bind privileged ports before dropping privileges, like the Node edge.
    let udp = UdpSocket::bind((cfg.udp_bind.as_str(), cfg.dns_port))
        .await
        .map_err(|err| format!("udp {}:{} bind failed: {err}", cfg.udp_bind, cfg.dns_port))?;
    let tcp = TcpListener::bind(("0.0.0.0", cfg.dns_port))
        .await
        .map_err(|err| format!("tcp {} bind failed: {err}", cfg.dns_port))?;
    let dot_listener = if cfg.dot_enabled {
        match TcpListener::bind(("0.0.0.0", cfg.dot_port)).await {
            Ok(listener) => Some(listener),
            Err(err) => {
                warn!(%err, port = cfg.dot_port, "dot listener unavailable");
                None
            }
        }
    } else {
        None
    };
    let doh_listener = TcpListener::bind(("0.0.0.0", cfg.doh_port))
        .await
        .map_err(|err| format!("doh {} bind failed: {err}", cfg.doh_port))?;
    let metrics_listener = TcpListener::bind(("0.0.0.0", cfg.metrics_port))
        .await
        .map_err(|err| format!("metrics {} bind failed: {err}", cfg.metrics_port))?;

    if unsafe { libc::geteuid() } == 0 {
        if cfg.drop_privileges {
            drop_privileges(cfg.drop_gid, cfg.drop_uid)?;
            info!(uid = cfg.drop_uid, gid = cfg.drop_gid, "dropped privileges");
        } else {
            warn!("running as root with DROP_PRIVILEGES=0");
        }
    }

    state.ready.store(true, Ordering::Relaxed);
    info!(
        region = %cfg.region,
        dns_port = cfg.dns_port,
        doh_port = cfg.doh_port,
        "edge ready"
    );

    tokio::spawn(udp_loop(Arc::new(udp), state.clone()));
    tokio::spawn(tcp_loop(tcp, state.clone()));
    if let Some(listener) = dot_listener {
        tokio::spawn(dot_loop(listener, state.clone()));
    }

    let doh_app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route(
            DOH_ROUTE,
            get(doh_handler).post(doh_handler).options(doh_handler),
        )
        .layer(DefaultBodyLimit::max(cfg.max_doh_body))
        .with_state(state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(doh_listener, doh_app).await {
            error!(%err, "doh server stopped");
        }
    });

    let metrics_app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(metrics_listener, metrics_app).await {
            error!(%err, "metrics server stopped");
        }
    });

    tokio::spawn(poll_loop(
        db,
        state.clone(),
        versions.config,
        versions.blocklist,
    ));

    wait_for_shutdown().await;
    state.logger.shutdown().await;
    info!("shutting down");
    Ok(())
}

async fn initial_snapshot(db: &Db) -> Result<(rz_db::Versions, rz_db::Snapshot), String> {
    let mut attempt = 0u32;
    loop {
        match async {
            let versions = db.versions().await?;
            let snapshot = db.snapshot().await?;
            Ok::<_, sqlx::Error>((versions, snapshot))
        }
        .await
        {
            Ok(value) => return Ok(value),
            Err(err) => {
                attempt += 1;
                if attempt >= 10 {
                    return Err(format!("initial snapshot failed: {err}"));
                }
                let delay = Duration::from_secs(2u64.pow(attempt.min(5)));
                warn!(%err, attempt, ?delay, "initial snapshot failed; retrying");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
