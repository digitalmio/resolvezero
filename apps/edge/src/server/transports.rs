use super::resolve::resolve_wire;
use super::{AppState, QueryContext};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::warn;

use crate::config::UnknownSource;
use crate::dns;
use crate::metrics::Metrics;

pub(super) struct ConnGuard {
    map: Arc<Mutex<HashMap<String, usize>>>,
    key: String,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut map = self.map.lock().expect("connection sources");
        if let Some(count) = map.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

pub(super) fn acquire_conn(
    map: &Arc<Mutex<HashMap<String, usize>>>,
    key: String,
    cap: usize,
) -> Option<ConnGuard> {
    let mut sources = map.lock().expect("connection sources");
    let count = sources.entry(key.clone()).or_insert(0);
    if *count >= cap {
        return None;
    }
    *count += 1;
    Some(ConnGuard {
        map: map.clone(),
        key,
    })
}

/// `<label>.dot.resolvezero.com` -> `label`.
pub(super) async fn tcp_loop(listener: TcpListener, state: Arc<AppState>) {
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

    let _source_guard = acquire_conn(
        &state.conn_sources,
        format!("tcp:{source}"),
        state.cfg.tcp_max_per_source,
    );
    if _source_guard.is_none() {
        return Ok(());
    }
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
        return super::dot::parse_proxy_v2(&fixed, &payload).and_then(|(source, _)| source);
    }
    None
}
