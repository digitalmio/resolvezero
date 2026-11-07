use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use hickory_proto::rr::RecordType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{RwLock, Semaphore};
use tracing::{error, info, warn};

use crate::cache::DnsCache;
use crate::config::{Config, UnknownSource};
use crate::db::Db;
use crate::dns;
use crate::fingerprint::Action;
use crate::limits::FixedWindow;
use crate::lists;
use crate::metrics::Metrics;
use crate::stats::{self, QueryEvent, QueryLogger};
use crate::store::RuleStore;
use crate::upstream::Upstream;

pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Arc<RwLock<RuleStore>>,
    pub cache: Arc<Mutex<DnsCache>>,
    pub upstream: Arc<Upstream>,
    pub metrics: Arc<Metrics>,
    pub logger: Arc<QueryLogger>,
    pub ready: AtomicBool,
    pub blocklist_ok: AtomicBool,
    pub blocklist_failed: AtomicUsize,
    pub blocklist_error: Mutex<Option<String>>,
    pub last_sync_at: AtomicI64,
    doh_rate: FixedWindow,
    udp_rate: FixedWindow,
    doh_gate: Semaphore,
    udp_gate: Arc<Semaphore>,
    tcp_gate: Arc<Semaphore>,
    sync_lock: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug)]
struct QueryContext {
    client_ip: Option<String>,
    device: Option<String>,
    transport: &'static str,
    log_enabled: bool,
}

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

    let cache = Arc::new(Mutex::new(DnsCache::default()));
    let metrics = Arc::new(Metrics::default());
    let logger = Arc::new(stats::start(db.clone(), cfg.clone(), metrics.clone()));
    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        store: store.clone(),
        cache: cache.clone(),
        upstream: Arc::new(Upstream::new(cfg.default_upstream())?),
        metrics,
        logger,
        ready: AtomicBool::new(false),
        blocklist_ok: AtomicBool::new(false),
        blocklist_failed: AtomicUsize::new(0),
        blocklist_error: Mutex::new(None),
        last_sync_at: AtomicI64::new(0),
        doh_rate: FixedWindow::new(cfg.doh_rate_limit_per_min, Duration::from_secs(60)),
        udp_rate: FixedWindow::new(cfg.udp_rate_limit_per_min, Duration::from_secs(60)),
        doh_gate: Semaphore::new(cfg.doh_max_inflight.max(1)),
        udp_gate: Arc::new(Semaphore::new(cfg.udp_max_inflight.max(1))),
        tcp_gate: Arc::new(Semaphore::new(cfg.tcp_max_connections.max(1))),
        sync_lock: tokio::sync::Mutex::new(()),
    });

    match lists::sync_once(&db, &store, &cache, &cfg).await {
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
                "initial blocklist sync complete"
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

    let doh_app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/*rest", get(doh_handler).post(doh_handler))
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

async fn initial_snapshot(db: &Db) -> Result<(crate::db::Versions, crate::db::Snapshot), String> {
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

async fn poll_loop(db: Db, state: Arc<AppState>, mut last_config: i32, mut last_blocklist: i32) {
    let mut last_sync = Instant::now();
    let mut next_retry = Instant::now();
    loop {
        tokio::time::sleep(state.cfg.poll_interval).await;
        let versions = match db.versions().await {
            Ok(versions) => versions,
            Err(err) => {
                warn!(%err, "config poll failed");
                continue;
            }
        };

        if versions.config != last_config {
            match db.snapshot().await {
                Ok(snapshot) => {
                    let mut guard = state.store.write().await;
                    guard.replace_config(
                        snapshot.profiles,
                        snapshot.rules,
                        snapshot.ips,
                        snapshot.zones,
                    );
                    if state.cfg.hosted {
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
                    info!(version = versions.config, "config snapshot loaded");
                }
                Err(err) => warn!(%err, "config snapshot failed"),
            }
        }

        let due =
            versions.blocklist != last_blocklist || last_sync.elapsed() >= state.cfg.list_interval;
        if due && Instant::now() >= next_retry {
            let _guard = state.sync_lock.lock().await;
            match lists::sync_once(&db, &state.store, &state.cache, &state.cfg).await {
                Ok(report) => {
                    last_blocklist = versions.blocklist;
                    last_sync = Instant::now();
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

async fn resolve_wire(
    state: &AppState,
    wire: &[u8],
    profile: &str,
    context: &QueryContext,
) -> Option<Vec<u8>> {
    let question = match dns::parse_query(wire) {
        Some(question) => question,
        None => {
            Metrics::inc(&state.metrics.drops);
            return None;
        }
    };
    Metrics::inc(&state.metrics.queries);

    let type_name = record_type_name(question.qtype);
    let (zone, nodata, custom, remote, block, selector) = {
        let store = state.store.read().await;
        let meta = match store.profile_meta(profile) {
            Some(meta) => meta,
            None => return None,
        };
        let mut zone = None;
        if let Some(entry) = store.zone_lookup(profile, &question.name, type_name) {
            zone = Some((entry, type_name.to_string()));
        } else if question.qtype != RecordType::CNAME {
            if let Some(entry) = store.zone_lookup(profile, &question.name, "CNAME") {
                zone = Some((entry, "CNAME".to_string()));
            }
        }
        let nodata = zone.is_none() && store.has_zone_name(profile, &question.name);
        let custom = store.resolve_custom(profile, &question.name);
        let remote = if custom == Some(Action::Allow) {
            None
        } else {
            store.resolve_remote_detailed(profile, &question.name)
        };
        (
            zone,
            nodata,
            custom,
            remote,
            meta.block.clone(),
            meta.upstream_selector().map(str::to_string),
        )
    };

    if let Some((entry, record_type)) = zone {
        record(
            state,
            &question,
            profile,
            context,
            "override",
            Some("zone"),
            None,
            None,
            None,
        );
        return Some(dns::zone_response(&question, &entry, &record_type));
    }
    if nodata {
        record(
            state,
            &question,
            profile,
            context,
            "override",
            Some("zone"),
            None,
            None,
            None,
        );
        return Some(dns::empty_response(&question));
    }

    let (decision, reason, list_id) = match (custom, remote) {
        (Some(Action::Block), _) => (Some(Action::Block), Some("manual"), None),
        (Some(Action::Allow), _) => (Some(Action::Allow), Some("manual"), None),
        (None, Some((action, list_id))) => (Some(action), Some("blocklist"), list_id),
        _ => (None, None, None),
    };

    if decision == Some(Action::Block) {
        Metrics::inc(&state.metrics.blocked);
        record(
            state, &question, profile, context, "block", reason, list_id, None, None,
        );
        return Some(dns::sinkhole_response(&question, &block));
    }

    let mut prelogged = false;
    if decision == Some(Action::Allow) {
        record(
            state, &question, profile, context, "allow", reason, list_id, None, None,
        );
        prelogged = true;
    }

    let label = upstream_label(selector.as_deref());
    let url = state.upstream.url_for(selector.as_deref());
    let key = dns::cache_key(&question, &url);
    if let Some((bytes, age)) = state.cache.lock().expect("cache lock").get(&key) {
        Metrics::inc(&state.metrics.cache_hits);
        if !prelogged {
            record(
                state,
                &question,
                profile,
                context,
                "forward",
                None,
                None,
                Some(label.clone()),
                None,
            );
        }
        // Strip OPT, rewrite the question case, count TTLs down, patch id.
        return Some(dns::normalize_for_client(&bytes, &question, age).unwrap_or(bytes));
    }
    Metrics::inc(&state.metrics.cache_misses);

    let started = Instant::now();
    match state.upstream.resolve(wire, selector.as_deref()).await {
        Ok(response) => {
            let rtt = started.elapsed().as_millis() as i64;
            // Normalize before returning and caching: no OPT/ECS replay.
            let normalized =
                dns::normalize_for_client(&response, &question, Duration::ZERO).unwrap_or(response);
            let ttl = dns::cache_ttl(&normalized);
            if !ttl.is_zero() {
                state
                    .cache
                    .lock()
                    .expect("cache lock")
                    .put(key, normalized.clone(), ttl);
            }
            Metrics::inc(&state.metrics.forwarded);
            if !prelogged {
                record(
                    state,
                    &question,
                    profile,
                    context,
                    "forward",
                    None,
                    None,
                    Some(label),
                    Some(rtt),
                );
            }
            Some(normalized)
        }
        Err(err) => {
            warn!(%err, "upstream failed");
            Metrics::inc(&state.metrics.servfail);
            if !prelogged {
                record(
                    state,
                    &question,
                    profile,
                    context,
                    "forward",
                    None,
                    None,
                    Some(label),
                    None,
                );
            }
            Some(dns::servfail_response(&question))
        }
    }
}

#[allow(clippy::too_many_arguments)] // one call site per decision; a struct hides the shape
fn record(
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
    state.logger.log(QueryEvent {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
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

fn upstream_label(selector: Option<&str>) -> String {
    match selector {
        Some("cloudflare") => "cloudflare".into(),
        Some("google") => "google".into(),
        Some("quad9") => "quad9".into(),
        Some(url) if url.starts_with("http") => "custom".into(),
        _ => "edge-default".into(),
    }
}

fn record_type_name(record_type: RecordType) -> &'static str {
    match record_type {
        RecordType::A => "A",
        RecordType::AAAA => "AAAA",
        RecordType::CNAME => "CNAME",
        RecordType::TXT => "TXT",
        _ => "OTHER",
    }
}

async fn udp_loop(socket: Arc<UdpSocket>, state: Arc<AppState>) {
    let mut buffer = [0u8; 4096];
    loop {
        match socket.recv_from(&mut buffer).await {
            Ok((len, peer)) => {
                let source = peer.ip().to_string();
                if !state.udp_rate.allow(&source) {
                    if state.cfg.unknown_source == UnknownSource::Refused {
                        if let Some(question) = dns::parse_query(&buffer[..len]) {
                            let _ = socket
                                .send_to(&dns::refused_response(&question), peer)
                                .await;
                        }
                    }
                    Metrics::inc(&state.metrics.drops);
                    continue;
                }
                let permit = match state.udp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        Metrics::inc(&state.metrics.drops);
                        continue;
                    }
                };
                let wire = buffer[..len].to_vec();
                let socket = socket.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let profile = state.store.read().await.authorize_ip(&source).cloned();
                    let profile = match profile {
                        Some(profile) => {
                            let tokenless = state.cfg.hosted
                                && state
                                    .store
                                    .read()
                                    .await
                                    .profile_meta(&profile)
                                    .is_some_and(|meta| meta.token.is_none());
                            if tokenless {
                                None
                            } else {
                                Some(profile)
                            }
                        }
                        None => None,
                    };
                    let response = match profile {
                        Some(profile) => {
                            let log_enabled = state.store.read().await.should_log(&profile);
                            let context = QueryContext {
                                client_ip: Some(source),
                                device: None,
                                transport: "udp",
                                log_enabled,
                            };
                            resolve_wire(&state, &wire, &profile, &context).await
                        }
                        None => {
                            if state.cfg.unknown_source == UnknownSource::Refused {
                                dns::parse_query(&wire).map(|q| dns::refused_response(&q))
                            } else {
                                None
                            }
                        }
                    };
                    match response {
                        Some(bytes) => {
                            // UDP clients advertise their buffer via EDNS; never
                            // send a datagram they cannot receive. Signal TC so
                            // they retry over TCP instead.
                            let max_payload = dns::parse_query(&wire)
                                .map(|q| {
                                    q.query
                                        .edns
                                        .as_ref()
                                        .map(|edns| edns.max_payload())
                                        .unwrap_or(512)
                                        .clamp(512, 4096)
                                })
                                .unwrap_or(512);
                            let out = if bytes.len() > max_payload as usize {
                                dns::parse_query(&wire)
                                    .map(|q| dns::truncated_response(&q))
                                    .unwrap_or(bytes)
                            } else {
                                bytes
                            };
                            if let Err(err) = socket.send_to(&out, peer).await {
                                warn!(%err, %peer, "udp send failed");
                            }
                        }
                        None => Metrics::inc(&state.metrics.drops),
                    }
                });
            }
            Err(err) => {
                warn!(%err, "udp recv failed");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}

async fn tcp_loop(listener: TcpListener, state: Arc<AppState>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let permit = match state.tcp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        Metrics::inc(&state.metrics.drops);
                        continue;
                    }
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = handle_tcp(stream, peer, state).await {
                        warn!(%err, %peer, "tcp connection ended");
                    }
                });
            }
            Err(err) => {
                warn!(%err, "tcp accept failed");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

async fn handle_tcp(
    mut stream: TcpStream,
    peer: SocketAddr,
    state: Arc<AppState>,
) -> std::io::Result<()> {
    let source =
        match tokio::time::timeout(Duration::from_secs(5), read_proxy_source(&mut stream)).await {
            Ok(Some(source)) => source,
            _ => peer.ip().to_string(),
        };

    let profile = state.store.read().await.authorize_ip(&source).cloned();
    let profile = match profile {
        Some(profile) => {
            let tokenless = state.cfg.hosted
                && state
                    .store
                    .read()
                    .await
                    .profile_meta(&profile)
                    .is_some_and(|meta| meta.token.is_none());
            if tokenless {
                None
            } else {
                Some(profile)
            }
        }
        None => None,
    };
    let log_enabled = match &profile {
        Some(profile) => state.store.read().await.should_log(profile),
        None => false,
    };
    let context = QueryContext {
        client_ip: Some(source.clone()),
        device: None,
        transport: "tcp",
        log_enabled,
    };
    let deadline = Instant::now() + state.cfg.tcp_lifetime;

    loop {
        if Instant::now() >= deadline {
            return Ok(());
        }
        let mut length = [0u8; 2];
        match tokio::time::timeout(state.cfg.tcp_idle_timeout, stream.read_exact(&mut length)).await
        {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut wire = vec![0u8; length];
        match tokio::time::timeout(state.cfg.tcp_idle_timeout, stream.read_exact(&mut wire)).await {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }

        let response = match &profile {
            Some(profile) => resolve_wire(&state, &wire, profile, &context).await,
            None => {
                if state.cfg.unknown_source == UnknownSource::Refused {
                    dns::parse_query(&wire).map(|q| dns::refused_response(&q))
                } else {
                    None
                }
            }
        };
        match response {
            Some(bytes) => {
                if bytes.len() > 65_535 {
                    Metrics::inc(&state.metrics.drops);
                    if let Some(question) = dns::parse_query(&wire) {
                        let fallback = dns::servfail_response(&question);
                        let len = (fallback.len() as u16).to_be_bytes();
                        stream.write_all(&len).await?;
                        stream.write_all(&fallback).await?;
                    }
                    continue;
                }
                let len = (bytes.len() as u16).to_be_bytes();
                stream.write_all(&len).await?;
                stream.write_all(&bytes).await?;
            }
            None => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
        }
    }
}

/// Fly's TCP ingress prepends PROXY v1 (port 53) or v2 (DoT). Return the real
/// client IP; leave the stream untouched when no header is present.
async fn read_proxy_source(stream: &mut TcpStream) -> Option<String> {
    let mut head = [0u8; 12];
    let peeked = stream.peek(&mut head).await.ok()?;
    if peeked >= 6 && &head[..6] == b"PROXY " {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            stream.read_exact(&mut byte).await.ok()?;
            line.push(byte[0]);
            if byte[0] == b'\n' || line.len() > 108 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&line);
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.len() >= 3 && (parts[1] == "TCP4" || parts[1] == "TCP6") {
            return Some(parts[2].to_string());
        }
        return None;
    }
    if peeked >= 12 && &head[..12] == b"\r\n\r\n\0\r\nQUIT\n" {
        let mut fixed = [0u8; 16];
        stream.read_exact(&mut fixed).await.ok()?;
        let len = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload).await.ok()?;
        let family = fixed[13] >> 4;
        match family {
            1 if payload.len() >= 12 => {
                return Some(
                    Ipv4Addr::new(payload[0], payload[1], payload[2], payload[3]).to_string(),
                );
            }
            2 if payload.len() >= 36 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&payload[0..16]);
                return Some(Ipv6Addr::from(octets).to_string());
            }
            _ => {}
        }
    }
    None
}

async fn doh_handler(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let client_ip = headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(|value| value.trim().to_string())
        });
    let client_key = client_ip.clone().unwrap_or_else(|| "unknown".into());
    if !state.doh_rate.allow(&client_key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let _permit = match state.doh_gate.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
    };

    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() || parts.len() > 3 {
        return StatusCode::NOT_FOUND.into_response();
    }
    let profile_id = parts[0];

    let (device, token) = match (parts.get(1), parts.get(2)) {
        (Some(seg), Some(token)) => {
            if !valid_device(seg) {
                return StatusCode::NOT_FOUND.into_response();
            }
            (Some(*seg), Some(*token))
        }
        (Some(seg), None) => {
            let has_token = state
                .store
                .read()
                .await
                .profile_meta(profile_id)
                .is_some_and(|meta| meta.has_token());
            if has_token {
                (None, Some(*seg))
            } else if valid_device(seg) {
                (Some(*seg), None)
            } else {
                return StatusCode::NOT_FOUND.into_response();
            }
        }
        (None, _) => (None, None),
    };
    if !state.store.read().await.has_profile(profile_id, token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if state.cfg.hosted {
        let tokenless = state
            .store
            .read()
            .await
            .profile_meta(profile_id)
            .is_some_and(|meta| meta.token.is_none());
        if tokenless {
            return StatusCode::NOT_FOUND.into_response();
        }
    }

    let wire = if method == Method::GET {
        let Some(query) = uri.query() else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let value = query.split('&').find_map(|pair| pair.strip_prefix("dns="));
        let Some(value) = value else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value) {
            Ok(wire) if wire.len() <= state.cfg.max_doh_get => wire,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        }
    } else if method == Method::POST {
        if let Some(content_type) = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
        {
            if !content_type.starts_with("application/dns-message") {
                return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
            }
        }
        if body.len() > state.cfg.max_doh_body {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        body.to_vec()
    } else {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    };

    if wire.len() < 12 {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let log_enabled = state.store.read().await.should_log(profile_id);
    let context = QueryContext {
        client_ip,
        device: device.map(str::to_string),
        transport: "doh",
        log_enabled,
    };

    match tokio::time::timeout(
        state.cfg.doh_timeout,
        resolve_wire(&state, &wire, profile_id, &context),
    )
    .await
    {
        Ok(Some(response)) => (
            [
                (header::CONTENT_TYPE, "application/dns-message"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            response,
        )
            .into_response(),
        Ok(None) => StatusCode::BAD_REQUEST.into_response(),
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    }
}

fn valid_device(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn healthz() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let ready = state.ready.load(Ordering::Relaxed);
    let blocklist_ok = state.blocklist_ok.load(Ordering::Relaxed);
    let failed = state.blocklist_failed.load(Ordering::Relaxed);
    let error = state
        .blocklist_error
        .lock()
        .expect("blocklist error")
        .clone();
    let last_sync = state.last_sync_at.load(Ordering::Relaxed);
    let last_sync_age = if last_sync == 0 {
        None
    } else {
        Some((now_seconds() - last_sync).max(0) * 1000)
    };
    let ok = ready && blocklist_ok;
    let body = serde_json::json!({
        "ok": ok,
        "region": state.cfg.region,
        "rulesLoaded": true,
        "blocklistsLoaded": blocklist_ok,
        "dns53Bound": true,
        "blocklistOk": blocklist_ok,
        "blocklistError": error.is_some(),
        "failedBlocklists": failed,
        "blocklistLastSyncAgeMs": last_sync_age,
        "remoteLists": store.remote_rules(),
        "remoteListTables": store.catalog.len(),
        "artifactLists": store.artifact_lists,
        "rawLists": store.raw_lists,
        "profiles": store.profiles.len(),
        "rssMb": crate::metrics::rss_bytes() / 1024 / 1024,
        "memoryLimitMb": memory_limit_mb(),
    });
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, axum::Json(body)).into_response()
}

fn memory_limit_mb() -> u64 {
    std::env::var("FLY_VM_MEMORY_MB")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1024)
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let cache = state.cache.lock().expect("cache lock");
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(
            &store,
            &cache,
            state.blocklist_failed.load(Ordering::Relaxed),
        ),
    )
        .into_response()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Drop root after binding privileged ports. Every step is checked: a silent
/// failure would leave the data plane running as root.
fn drop_privileges(gid: u32, uid: u32) -> Result<(), String> {
    unsafe {
        if libc::setgroups(0, std::ptr::null()) != 0 {
            return Err(format!(
                "setgroups failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setgid(gid) != 0 {
            return Err(format!(
                "setgid({gid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setuid(uid) != 0 {
            return Err(format!(
                "setuid({uid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        #[cfg(target_os = "linux")]
        {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(format!(
                    "PR_SET_NO_NEW_PRIVS failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    Ok(())
}
