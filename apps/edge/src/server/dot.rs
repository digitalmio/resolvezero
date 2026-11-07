use super::resolve::resolve_wire;
use super::transports::acquire_conn;
use super::{AppState, QueryContext};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::warn;

use crate::metrics::Metrics;

pub(super) const PROXY_V2_MAGIC: [u8; 12] = [
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];
pub(super) const TLV_AUTHORITY: u8 = 0x02;

pub(super) fn dot_label(hostname: &str, suffix: &str) -> Option<String> {
    let host = hostname.trim().to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    let label = host.strip_suffix(suffix)?;
    if label.is_empty()
        || label.contains('.')
        || label.len() > 32
        || label.starts_with('-')
        || label.ends_with('-')
        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(label.to_string())
}

pub(super) async fn read_proxy_v2_header(
    stream: &mut TcpStream,
) -> Option<(Option<String>, Option<String>)> {
    let mut fixed = [0u8; 16];
    stream.read_exact(&mut fixed).await.ok()?;
    let payload_len = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
    let mut payload = vec![0u8; payload_len];
    stream.read_exact(&mut payload).await.ok()?;
    parse_proxy_v2(&fixed, &payload)
}

/// Parse a PROXY v2 fixed header + payload. Kept pure so the transport tests
/// can cover IPv4, IPv6, TLVs, and truncation without sockets.
pub(super) fn parse_proxy_v2(
    fixed: &[u8; 16],
    payload: &[u8],
) -> Option<(Option<String>, Option<String>)> {
    if fixed[..12] != PROXY_V2_MAGIC {
        return None;
    }
    let payload_len = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
    if payload.len() < payload_len {
        return None;
    }
    let family = fixed[13] >> 4;
    let command = fixed[12] & 0x0f;
    let mut offset = 0usize;
    let mut source = None;
    if command == 1 {
        match family {
            1 if payload.len() >= 12 => {
                source =
                    Some(Ipv4Addr::new(payload[0], payload[1], payload[2], payload[3]).to_string());
                offset = 12;
            }
            2 if payload.len() >= 36 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&payload[0..16]);
                source = Some(Ipv6Addr::from(octets).to_string());
                offset = 36;
            }
            _ => {}
        }
    }
    let mut authority = None;
    while offset + 3 <= payload.len() {
        let kind = payload[offset];
        let length = u16::from_be_bytes([payload[offset + 1], payload[offset + 2]]) as usize;
        offset += 3;
        if offset + length > payload.len() {
            break;
        }
        if kind == TLV_AUTHORITY {
            authority =
                Some(String::from_utf8_lossy(&payload[offset..offset + length]).to_lowercase());
        }
        offset += length;
    }
    Some((source, authority))
}

pub(super) async fn dot_loop(listener: TcpListener, state: Arc<AppState>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let permit = match state.tcp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => continue,
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = handle_dot(stream, peer, state).await {
                        warn!(%err, %peer, "dot connection ended");
                    }
                });
            }
            Err(err) => {
                warn!(%err, "dot accept failed");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

async fn handle_dot(
    mut stream: TcpStream,
    _peer: SocketAddr,
    state: Arc<AppState>,
) -> std::io::Result<()> {
    let parsed = tokio::time::timeout(Duration::from_secs(5), read_proxy_v2_header(&mut stream))
        .await
        .ok()
        .flatten();
    let Some((source, authority)) = parsed else {
        return Ok(());
    };
    let Some(authority) = authority else {
        return Ok(());
    };
    let Some(label) = dot_label(&authority, &state.cfg.dot_suffix) else {
        return Ok(());
    };
    let source_key = source.clone().unwrap_or_else(|| _peer.ip().to_string());
    let _source_guard = acquire_conn(
        &state.conn_sources,
        format!("dot:{source_key}"),
        state.cfg.dot_max_per_source,
    );
    if _source_guard.is_none() {
        return Ok(());
    }
    let Some(profile_id) = state.store.read().await.authorize_dot_id(&label).cloned() else {
        return Ok(());
    };
    let log_enabled = state.store.read().await.should_log(&profile_id);
    let context = QueryContext {
        client_ip: source,
        device: None,
        transport: "dot",
        log_enabled,
    };
    let deadline = Instant::now() + state.cfg.dot_lifetime;

    loop {
        if Instant::now() >= deadline {
            return Ok(());
        }
        let mut length = [0u8; 2];
        match tokio::time::timeout(state.cfg.dot_idle_timeout, stream.read_exact(&mut length)).await
        {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut wire = vec![0u8; length];
        match tokio::time::timeout(state.cfg.dot_idle_timeout, stream.read_exact(&mut wire)).await {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        match resolve_wire(&state, &wire, &profile_id, &context).await {
            Some(bytes) if bytes.len() <= 65_535 => {
                let len = (bytes.len() as u16).to_be_bytes();
                stream.write_all(&len).await?;
                stream.write_all(&bytes).await?;
            }
            Some(_) => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
            None => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
        }
    }
}
