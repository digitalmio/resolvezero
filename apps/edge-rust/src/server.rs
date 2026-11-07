use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use hickory_proto::rr::RecordType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::cache::DnsCache;
use crate::config::{Config, UnknownSource};
use crate::db::Db;
use crate::dns;
use crate::fingerprint::Action;
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
        sync_lock: tokio::sync::Mutex::new(()),
    });

    match lists::sync_once(&db, &store, &cache, &cfg).await {
        Ok(_) => info!("initial blocklist sync complete"),
        Err(err) => warn!(%err, "initial blocklist sync failed; serving explicit rules only"),
    }

    // Bind privileged ports before dropping privileges, like the Node edge.
    let udp = UdpSocket::bind(("0.0.0.0", cfg.dns_port))
        .await
        .map_err(|err| format!("udp {} bind failed: {err}", cfg.dns_port))?;
    let tcp = TcpListener::bind(("0.0.0.0", cfg.dns_port))
        .await
        .map_err(|err| format!("tcp {} bind failed: {err}", cfg.dns_port))?;
    let doh_listener = TcpListener::bind(("0.0.0.0", cfg.doh_port))
        .await
        .map_err(|err| format!("doh {} bind failed: {err}", cfg.doh_port))?;
    let metrics_listener = TcpListener::bind(("0.0.0.0", cfg.metrics_port))
        .await
        .map_err(|err| format!("metrics {} bind failed: {err}", cfg.metrics_port))?;

    if cfg.drop_privileges && unsafe { libc::geteuid() } == 0 {
        unsafe {
            libc::setgid(cfg.drop_gid);
            libc::setuid(cfg.drop_uid);
        }
        info!(uid = cfg.drop_uid, gid = cfg.drop_gid, "dropped privileges");
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
                    drop(guard);
                    last_config = versions.config;
                    info!(version = versions.config, "config snapshot loaded");
                }
                Err(err) => warn!(%err, "config snapshot failed"),
            }
        }

        if versions.blocklist != last_blocklist {
            last_blocklist = versions.blocklist;
            let _guard = state.sync_lock.lock().await;
            match lists::sync_once(&db, &state.store, &state.cache, &state.cfg).await {
                Ok(changed) => info!(changed, "blocklist sync complete"),
                Err(err) => warn!(%err, "blocklist sync failed"),
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
    if let Some(bytes) = state
        .cache
        .lock()
        .expect("cache lock")
        .get(&key, question.id)
    {
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
        return Some(bytes);
    }
    Metrics::inc(&state.metrics.cache_misses);

    let started = Instant::now();
    match state.upstream.resolve(wire, selector.as_deref()).await {
        Ok(response) => {
            let rtt = started.elapsed().as_millis() as i64;
            let ttl = dns::cache_ttl(&response);
            state
                .cache
                .lock()
                .expect("cache lock")
                .put(key, response.clone(), ttl);
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
            Some(response)
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
                let wire = buffer[..len].to_vec();
                let socket = socket.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    let profile = state
                        .store
                        .read()
                        .await
                        .authorize_ip(&peer.ip().to_string())
                        .cloned();
                    let response = match profile {
                        Some(profile) => {
                            let log_enabled = state.store.read().await.should_log(&profile);
                            let context = QueryContext {
                                client_ip: Some(peer.ip().to_string()),
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
                            let _ = socket.send_to(&bytes, peer).await;
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
                let state = state.clone();
                tokio::spawn(async move {
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
    let source = read_proxy_source(&mut stream)
        .await
        .unwrap_or_else(|| peer.ip().to_string());
    let profile = state.store.read().await.authorize_ip(&source).cloned();
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

    loop {
        let mut length = [0u8; 2];
        if stream.read_exact(&mut length).await.is_err() {
            return Ok(());
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut wire = vec![0u8; length];
        stream.read_exact(&mut wire).await?;

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

    let wire = if method == Method::GET {
        let Some(query) = uri.query() else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let value = query.split('&').find_map(|pair| pair.strip_prefix("dns="));
        let Some(value) = value else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value) {
            Ok(wire) => wire,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        }
    } else if method == Method::POST {
        body.to_vec()
    } else {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    };

    if wire.len() < 12 {
        return StatusCode::BAD_REQUEST.into_response();
    }

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
    let log_enabled = state.store.read().await.should_log(profile_id);
    let context = QueryContext {
        client_ip,
        device: device.map(str::to_string),
        transport: "doh",
        log_enabled,
    };

    match resolve_wire(&state, &wire, profile_id, &context).await {
        Some(response) => (
            [(header::CONTENT_TYPE, "application/dns-message")],
            response,
        )
            .into_response(),
        None => StatusCode::BAD_REQUEST.into_response(),
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
    let body = serde_json::json!({
        "ok": state.ready.load(Ordering::Relaxed),
        "region": state.cfg.region,
        "rulesLoaded": true,
        "blocklistsLoaded": true,
        "dns53Bound": true,
        "remoteLists": store.remote_rules(),
        "remoteListTables": store.catalog.len(),
        "artifactLists": store.artifact_lists,
        "rawLists": store.raw_lists,
        "profiles": store.profiles.len(),
        "rssMb": crate::metrics::rss_bytes() / 1024 / 1024,
        "memoryLimitMb": memory_limit_mb(),
    });
    (StatusCode::OK, axum::Json(body)).into_response()
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
        state.metrics.render(&store, &cache),
    )
        .into_response()
}
