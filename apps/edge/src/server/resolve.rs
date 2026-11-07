use super::helpers::{match_probe_nonce, record, record_type_name, upstream_label};
use super::{AppState, QueryContext};
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};

use crate::{dns, lazy, metrics::Metrics};
use hickory_proto::rr::RecordType;
use rz_core::fingerprint::Action;
use tracing::{info, warn};

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
        match lazy::ensure_profile_loaded(
            &state.db,
            &state.store,
            &state.cfg,
            profile,
            &state.list_gate,
        )
        .await
        {
            Ok(report) if report.changed => {
                state.cache.lock().expect("cache lock").clear();
                state.blocklist_failed.store(0, Ordering::Relaxed);
                state.blocklist_ok.store(true, Ordering::Relaxed);
                *state.blocklist_error.lock().expect("blocklist error") = None;
                info!(
                    profile,
                    loaded = report.loaded,
                    failed = report.failed,
                    "lazy lists changed; dns cache flushed"
                );
            }
            Ok(report) if report.failed > 0 => {
                state
                    .blocklist_failed
                    .store(report.failed, Ordering::Relaxed);
                state.blocklist_ok.store(false, Ordering::Relaxed);
                *state.blocklist_error.lock().expect("blocklist error") =
                    Some(format!("lazy list load failed for {profile}"));
                warn!(
                    profile,
                    loaded = report.loaded,
                    failed = report.failed,
                    "lazy list load incomplete; retrying"
                );
            }
            Ok(report) if report.loaded > 0 => {
                state.blocklist_failed.store(0, Ordering::Relaxed);
                state.blocklist_ok.store(true, Ordering::Relaxed);
                *state.blocklist_error.lock().expect("blocklist error") = None;
                info!(profile, loaded = report.loaded, "lazy lists ready");
            }
            Ok(_) => {}
            Err(err) => warn!(profile, %err, "lazy list load failed"),
        }
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

    // Single-flight: coalesce identical cache misses. The first request does
    // the upstream call; waiters re-check the cache and share the result.
    let gate = {
        let mut map = state.inflight.lock().expect("inflight");
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let guard = gate.lock().await;
    if let Some((bytes, age)) = state.cache.lock().expect("cache lock").get(&key) {
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
        drop(guard);
        let mut map = state.inflight.lock().expect("inflight");
        if Arc::strong_count(&gate) <= 2 {
            map.remove(&key);
        }
        return Some(dns::normalize_for_client(&bytes, &question, age).unwrap_or(bytes));
    }

    let started = Instant::now();
    let result = match state.upstream.resolve(wire, selector.as_deref()).await {
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
                    .put(key.clone(), normalized.clone(), ttl);
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
    drop(guard);
    {
        let mut map = state.inflight.lock().expect("inflight");
        if Arc::strong_count(&gate) <= 2 {
            map.remove(&key);
        }
    }
    result
}
