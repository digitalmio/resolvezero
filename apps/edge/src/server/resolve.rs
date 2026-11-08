use super::helpers::{ensure_lists, match_probe_nonce, record, record_type_name, upstream_label};
use super::{AppState, QueryContext};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::{dns, metrics::Metrics};
use hickory_proto::rr::RecordType;
use rz_core::fingerprint::Action;
use tracing::warn;

/// Removes the single-flight entry when the request future is dropped, so a
/// DoH timeout or client disconnect cannot leak the map.
struct InflightGuard<'a> {
    map: &'a Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    key: String,
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            // Keep the entry while other waiters hold the same gate; the last
            // one (map + local `gate`) removes it.
            if map
                .get(&self.key)
                .is_none_or(|gate| Arc::strong_count(gate) <= 2)
            {
                map.remove(&self.key);
            }
        }
    }
}

pub(super) async fn resolve_wire(
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

    if let Some(probe_domain) = &state.cfg.probe_domain {
        if let Some(nonce) = match_probe_nonce(&question.name, probe_domain) {
            let db = state.db.clone();
            let region = state.cfg.region.clone();
            let transport = context.transport.to_string();
            tokio::spawn(async move {
                let _ = db.record_probe(&nonce, &region, &transport).await;
            });
            return Some(dns::nxdomain_response(&question));
        }
    }

    if state.cfg.lazy_lists {
        ensure_lists(state, profile).await;
    }

    let type_name = record_type_name(question.qtype);
    let (zone, nodata, custom, remote, block, selector, safe_search) = {
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
            meta.safe_search,
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

    if safe_search.any() {
        if let Some(target) = dns::safe_search_target(&safe_search, &question.name) {
            record(
                state,
                &question,
                profile,
                context,
                "override",
                Some("safesearch"),
                None,
                None,
                None,
            );
            Metrics::inc(&state.metrics.forwarded);
            return Some(dns::cname_response(&question, target, 600));
        }
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
    let key = dns::cache_key(&question, &url, profile);
    if let Some((bytes, age, ttl)) = state.cache.get(&key) {
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
        return Some(
            dns::normalize_for_client(&bytes, &question, age, ttl)
                .unwrap_or_else(|| bytes.as_ref().to_vec()),
        );
    }
    Metrics::inc(&state.metrics.cache_misses);

    // Single-flight: coalesce identical cache misses. The first request does
    // the upstream call; waiters re-check the cache and share the result.
    let gate = {
        let mut map = state.inflight.lock().expect("inflight");
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let gate_guard = gate.lock().await;
    let _inflight = InflightGuard {
        map: &state.inflight,
        key: key.clone(),
    };
    if let Some((bytes, age, ttl)) = state.cache.get(&key) {
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
        drop(gate_guard);
        return Some(
            dns::normalize_for_client(&bytes, &question, age, ttl)
                .unwrap_or_else(|| bytes.as_ref().to_vec()),
        );
    }

    let started = Instant::now();
    let result = match state.upstream.resolve(wire, selector.as_deref()).await {
        Ok(response) => {
            let rtt = started.elapsed().as_millis() as i64;
            // Normalize before returning and caching: no OPT/ECS replay.
            let ttl = dns::cache_ttl(&response);
            let wire_ttl = if ttl.is_zero() {
                Duration::from_secs(30)
            } else {
                ttl
            };
            let normalized =
                dns::normalize_for_client(&response, &question, Duration::ZERO, wire_ttl)
                    .unwrap_or(response);
            if !ttl.is_zero() {
                state.cache.put(key.clone(), normalized.clone(), ttl);
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
    };
    drop(gate_guard);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inflight_guard_removes_the_entry_on_drop() {
        let map = Mutex::new(HashMap::new());
        map.lock()
            .unwrap()
            .insert("k".into(), Arc::new(tokio::sync::Mutex::new(())));
        {
            let _guard = InflightGuard {
                map: &map,
                key: "k".into(),
            };
            assert!(map.lock().unwrap().contains_key("k"));
        }
        assert!(map.lock().unwrap().is_empty());
    }
}
