use std::sync::Arc;
use std::time::Duration;

use tokio::net::UdpSocket;
use tracing::warn;

use crate::config::UnknownSource;
use crate::dns;
use crate::metrics::Metrics;

use super::helpers::source_profile;
use super::resolve::resolve_wire;
use super::{AppState, QueryContext};

pub(super) async fn udp_loop(socket: Arc<UdpSocket>, state: Arc<AppState>) {
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
                    let profile = source_profile(&state, &source).await;
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
