use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::{RwLock, Semaphore};

use crate::cache::DnsCache;
use crate::config::Config;
use crate::limits::FixedWindow;
use crate::metrics::Metrics;
use crate::stats::QueryLogger;
use crate::store::RuleStore;
use crate::upstream::Upstream;
use rz_db::Db;

pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Arc<RwLock<RuleStore>>,
    pub cache: Arc<DnsCache>,
    pub upstream: Arc<Upstream>,
    pub metrics: Arc<Metrics>,
    pub logger: Arc<QueryLogger>,
    pub db: Db,
    pub ready: AtomicBool,
    /// True once the UDP and TCP:53 listeners were spawned successfully.
    pub dns53_bound: AtomicBool,
    pub seen_devices: Mutex<HashMap<String, HashMap<String, Instant>>>,
    /// Last time a linked source IP was seen, so DB touches stay hourly.
    pub seen_source_ips: Mutex<HashMap<String, Instant>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub blocklist_ok: AtomicBool,
    /// True after at least one successful metadata/catalog sync.
    pub subscriptions_loaded: AtomicBool,
    pub blocklist_failed: AtomicUsize,
    /// Profiles whose most recent list load failed; readiness stays red until
    /// every one of them recovers.
    pub blocklist_failed_profiles: Mutex<std::collections::HashSet<String>>,
    pub blocklist_error: Mutex<Option<String>>,
    pub last_sync_at: AtomicI64,
    pub last_config_poll_at: AtomicI64,
    pub config_poll_error: AtomicBool,
    pub purge_since: AtomicI64,
    doh_rate: FixedWindow,
    udp_rate: FixedWindow,
    doh_gate: Semaphore,
    udp_gate: Arc<Semaphore>,
    tcp_gate: Arc<Semaphore>,
    conn_sources: Arc<Mutex<HashMap<String, usize>>>,
    admin_rate: FixedWindow,
    purge_rate: FixedWindow,
    sync_lock: tokio::sync::Mutex<()>,
    /// Serializes first-query list loading so a cold PoP does not download the
    /// same artifacts many times in parallel.
    list_gate: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug)]
struct QueryContext {
    client_ip: Option<String>,
    device: Option<String>,
    transport: &'static str,
    log_enabled: bool,
}

mod api;
mod boot;
mod dot;
mod health;
mod helpers;
mod http;
mod poll;
mod privdrop;
mod purge;
mod resolve;
mod transports;
mod udp;

#[cfg(test)]
mod tests;

pub use boot::run;
