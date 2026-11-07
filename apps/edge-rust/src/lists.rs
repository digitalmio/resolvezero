use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::artifact::{sha256_hex, Artifact, S3Config};
use crate::cache::DnsCache;
use crate::config::Config;
use crate::db::Db;
use crate::fingerprint::FingerprintTable;
use crate::netguard::{redact_url, SafeFetcher};
use crate::parse::{parse_list, ListFormat};
use crate::store::{ListSource, RuleStore, Subscription};

#[derive(Clone, Copy, Debug, Default)]
pub struct SyncReport {
    pub changed: bool,
    pub failed: usize,
}

/// Point the store at the current blocklist subscriptions without fetching any
/// list bodies. With lazy loading this is the only blocklist work done at
/// startup and on a watermark change; artifacts arrive on first use.
pub async fn sync_metadata(
    db: &Db,
    store: &Arc<RwLock<RuleStore>>,
    cfg: &Config,
) -> Result<SyncReport, String> {
    let rows = db.blocklists().await.map_err(|err| err.to_string())?;
    let mut unique: HashSet<String> = HashSet::new();
    let mut by_profile: HashMap<String, Vec<Subscription>> = HashMap::new();
    let mut configured: HashSet<String> = HashSet::new();
    let mut failed = 0usize;

    for row in rows {
        configured.insert(row.profile_id.clone());
        let subscriptions = by_profile.entry(row.profile_id.clone()).or_default();
        if !unique.contains(&row.url) {
            if unique.len() >= cfg.max_unique_lists {
                warn!(
                    url = %redact_url(&row.url),
                    cap = cfg.max_unique_lists,
                    "unique-list cap reached; list skipped"
                );
                failed += 1;
                continue;
            }
            unique.insert(row.url.clone());
        }
        subscriptions.push(Subscription {
            url: row.url,
            list_id: Some(row.id),
            format: row.format,
            artifact_hash: row.artifact_hash,
        });
    }

    let mut guard = store.write().await;
    for (profile_id, mut subscriptions) in by_profile {
        let mut seen = HashSet::new();
        subscriptions.retain(|sub| seen.insert(sub.url.clone()));
        if subscriptions.len() > cfg.max_lists_per_profile {
            warn!(
                profile_id,
                cap = cfg.max_lists_per_profile,
                "per-profile list cap reached"
            );
            subscriptions.truncate(cfg.max_lists_per_profile);
        }
        guard.wire_subscriptions(&profile_id, subscriptions);
    }
    let stale: Vec<String> = guard
        .subscriptions
        .keys()
        .filter(|profile_id| !configured.contains(*profile_id))
        .cloned()
        .collect();
    for profile_id in stale {
        guard.wire_subscriptions(&profile_id, Vec::new());
    }
    guard.prune_catalog();

    Ok(SyncReport {
        changed: false,
        failed,
    })
}

/// Eager mode (`EAGER_BLOCKLISTS=1`): fetch + parse every enabled list before
/// the edge starts serving. Kept for small self-hosted setups that prefer a
/// cold-start cost over first-query latency.
pub async fn sync_once(
    db: &Db,
    store: &Arc<RwLock<RuleStore>>,
    cache: &Arc<Mutex<DnsCache>>,
    cfg: &Config,
) -> Result<SyncReport, String> {
    let rows = db.blocklists().await.map_err(|err| err.to_string())?;

    struct UniqueList {
        format: String,
        artifact_hash: Option<String>,
    }
    let mut unique: HashMap<String, UniqueList> = HashMap::new();
    let mut by_profile: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let entry = unique.entry(row.url.clone()).or_insert(UniqueList {
            format: row.format.clone(),
            artifact_hash: row.artifact_hash.clone(),
        });
        if entry.artifact_hash.is_none() {
            entry.artifact_hash = row.artifact_hash;
        }
        by_profile
            .entry(row.profile_id.clone())
            .or_default()
            .push((row.url, row.id));
    }
    let s3 = S3Config::from_env();
    let fetcher = SafeFetcher::new(cfg.max_list_bytes, true);

    let mut changed = false;
    let mut failed = 0usize;
    let mut total = 0usize;
    let deadline = Instant::now() + cfg.list_cycle_deadline;
    let mut fetched: Vec<(String, Option<String>, ListSource, FingerprintTable)> = Vec::new();

    // Sequential on purpose: a 500k-rule parse is the memory high-water mark,
    // and parallel parses multiplied the transient enough to OOM 256 MB VMs.
    for (index, (url, list)) in unique.iter().enumerate() {
        if index >= cfg.max_unique_lists {
            warn!(url = %redact_url(url), cap = cfg.max_unique_lists, "unique-list cap reached; list skipped");
            failed += 1;
            continue;
        }
        if Instant::now() >= deadline {
            warn!(url = %redact_url(url), "blocklist cycle deadline reached; list skipped");
            failed += 1;
            continue;
        }
        let (table, source) = match load_table(
            &fetcher,
            s3.as_ref(),
            url,
            &list.format,
            list.artifact_hash.as_deref(),
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!(url = %redact_url(url), %err, "list load failed; keeping previous table");
                failed += 1;
                let status = format!("error: {}", err.chars().take(42).collect::<String>());
                let _ = db.write_blocklist_status(url, &status, 0, None).await;
                continue;
            }
        };

        if total + table.entries > cfg.max_total_entries {
            warn!(
                url,
                entries = table.entries,
                total,
                cap = cfg.max_total_entries,
                "global rule budget exceeded; list skipped"
            );
            failed += 1;
            continue;
        }
        total += table.entries;
        info!(url = %redact_url(url), entries = table.entries, "list loaded");
        let _ = db
            .write_blocklist_status(url, "ok", table.entries as i32, Some(&list.format))
            .await;
        fetched.push((url.clone(), list.artifact_hash.clone(), source, table));
    }

    if !fetched.is_empty() {
        let mut guard = store.write().await;
        for (url, hash, source, table) in fetched {
            changed |= guard.upsert_list(&url, hash.as_deref(), source, table);
        }
    }

    let catalog_urls: HashSet<String> = {
        let guard = store.read().await;
        guard.catalog.keys().cloned().collect()
    };

    let mut guard = store.write().await;
    for (profile_id, rows) in &by_profile {
        let mut seen = HashSet::new();
        let mut subscriptions = Vec::new();
        for (url, list_id) in rows {
            if !catalog_urls.contains(url) || !seen.insert(url.clone()) {
                continue;
            }
            if subscriptions.len() >= cfg.max_lists_per_profile {
                warn!(profile_id, "per-profile list cap reached");
                break;
            }
            let meta = unique.get(url).expect("unique list");
            subscriptions.push(Subscription {
                url: url.clone(),
                list_id: Some(list_id.clone()),
                format: meta.format.clone(),
                artifact_hash: meta.artifact_hash.clone(),
            });
        }
        guard.wire_subscriptions(profile_id, subscriptions);
    }
    let stale: Vec<String> = guard
        .subscriptions
        .keys()
        .filter(|profile_id| !by_profile.contains_key(*profile_id))
        .cloned()
        .collect();
    for profile_id in stale {
        guard.wire_subscriptions(&profile_id, Vec::new());
    }
    guard.prune_catalog();
    drop(guard);

    if changed {
        cache.lock().expect("cache lock").clear();
        info!("blocklist state changed; dns cache flushed");
    }
    Ok(SyncReport { changed, failed })
}

/// Load one list into a fingerprint table, preferring the content-addressed
/// artifact and falling back to raw text when it is missing or corrupt.
pub(crate) async fn load_table(
    fetcher: &SafeFetcher,
    s3: Option<&S3Config>,
    url: &str,
    format: &str,
    artifact_hash: Option<&str>,
) -> Result<(FingerprintTable, ListSource), String> {
    if let (Some(s3), Some(hash)) = (s3, artifact_hash) {
        match load_artifact(s3, hash).await {
            Ok(table) => return Ok((table, ListSource::Artifact)),
            Err(err) => {
                warn!(url = %redact_url(url), %err, "artifact load failed; falling back to text")
            }
        }
    }

    let text = fetch_text(fetcher, url).await?;
    let list_format = ListFormat::parse(format);
    // Parsing is CPU-bound (~0.2 s per 500k rules). Keep it off the async
    // workers so DNS queries keep flowing while a list is loaded.
    let table = tokio::task::spawn_blocking(move || {
        let parsed = parse_list(&text, list_format);
        FingerprintTable::build(&parsed.blocks, &parsed.allows)
    })
    .await
    .map_err(|err| format!("list parse task failed: {err}"))?;
    Ok((table, ListSource::Raw))
}

async fn fetch_text(fetcher: &SafeFetcher, url: &str) -> Result<String, String> {
    let bytes = fetcher.get(url).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

async fn load_artifact(s3: &S3Config, hash: &str) -> Result<FingerprintTable, String> {
    let bytes = s3.get(hash).await?;
    let actual = sha256_hex(&bytes);
    if actual != hash {
        return Err(format!("artifact hash mismatch ({actual})"));
    }
    Ok(Artifact::decode(&bytes)?.into_table())
}
