//! Query logging: Postgres rollups + gzipped S3 archive.
//!
//! Each edge machine writes its own `stats_*` rows. The rollup is flushed once
//! a minute and never reads a stats row back: counters are additive and top
//! lists are merged by `stats_merge_top()` inside Postgres. The S3 archive is
//! independent and flushes every 30 s, so the query log is not delayed by the
//! stats interval.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::Config;
use crate::metrics::Metrics;
use rz_db::Db;

mod archive;
mod rollup;
mod util;

use archive::Archive;
use rollup::apply_rollups;

/// Emergency flush; the normal cadence is `FLUSH_EVERY`.
const BATCH_SIZE: usize = 50_000;
const FLUSH_EVERY: Duration = Duration::from_secs(60);
const ARCHIVE_EVERY: Duration = Duration::from_secs(30);
const MAX_PENDING: usize = 50_000;

#[derive(Clone, Debug)]
pub struct QueryEvent {
    pub at: i64,
    pub at_ms: i64,
    pub profile: String,
    pub domain: String,
    pub action: &'static str,
    pub reason: Option<&'static str>,
    pub list_id: Option<String>,
    pub transport: &'static str,
    pub upstream: Option<String>,
    pub client_ip: Option<String>,
    pub device: Option<String>,
    pub rtt_ms: Option<i64>,
}

#[allow(clippy::large_enum_variant)] // boxing every query event would allocate on the hot path
enum LogMessage {
    Event(QueryEvent),
    Shutdown(tokio::sync::oneshot::Sender<()>),
}

pub struct QueryLogger {
    tx: mpsc::Sender<LogMessage>,
    metrics: Arc<Metrics>,
}

impl QueryLogger {
    pub fn log(&self, event: QueryEvent) {
        if self.tx.try_send(LogMessage::Event(event)).is_err() {
            Metrics::inc(&self.metrics.log_dropped);
        }
    }

    /// Flush pending stats/archive rows before process exit. SIGTERM callers
    /// await this; a 10 s cap keeps a wedged S3/database from blocking shutdown.
    pub async fn shutdown(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.tx.send(LogMessage::Shutdown(tx)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), rx).await;
        }
    }
}

/// Spawn the flush task. The channel is bounded; DNS never blocks on it.
pub fn start(db: Db, cfg: Arc<Config>, metrics: Arc<Metrics>) -> QueryLogger {
    let (tx, mut rx) = mpsc::channel::<LogMessage>(20_000);
    let logger_metrics = metrics.clone();
    let machine = machine_id();
    tokio::spawn(async move {
        let mut archive = Archive::new(&cfg, metrics.clone());
        let mut batch: Vec<QueryEvent> = Vec::new();
        let mut pending: VecDeque<QueryEvent> = VecDeque::new();
        let mut flush_tick = tokio::time::interval(FLUSH_EVERY);
        let mut archive_tick = tokio::time::interval(ARCHIVE_EVERY);

        loop {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some(LogMessage::Event(event)) => {
                        // Archive immediately so the log page is not tied to
                        // the stats flush interval.
                        archive.add(&event);
                        batch.push(event);
                        if batch.len() >= BATCH_SIZE {
                            flush(&db, &machine, &mut batch, &mut pending, &metrics).await;
                        }
                    }
                    Some(LogMessage::Shutdown(done)) => {
                        flush(&db, &machine, &mut batch, &mut pending, &metrics).await;
                        archive.flush_all(now()).await;
                        let _ = done.send(());
                        break;
                    }
                    None => break,
                },
                _ = flush_tick.tick() => {
                    flush(&db, &machine, &mut batch, &mut pending, &metrics).await;
                }
                _ = archive_tick.tick() => {
                    archive.flush_completed(now()).await;
                }
            }
        }

        flush(&db, &machine, &mut batch, &mut pending, &metrics).await;
        if !pending.is_empty() {
            warn!(
                rows = pending.len(),
                "query-log rows still pending at shutdown"
            );
        }
        archive.flush_all(now()).await;
        info!("query logger stopped");
    });

    QueryLogger {
        tx,
        metrics: logger_metrics,
    }
}

async fn flush(
    db: &Db,
    machine: &str,
    batch: &mut Vec<QueryEvent>,
    pending: &mut VecDeque<QueryEvent>,
    metrics: &Metrics,
) {
    if batch.is_empty() && pending.is_empty() {
        return;
    }
    pending.extend(batch.drain(..));
    while pending.len() > MAX_PENDING {
        pending.pop_front();
    }
    match apply_rollups(db, machine, pending.make_contiguous()).await {
        Ok(()) => pending.clear(),
        Err(err) => {
            warn!(%err, rows = pending.len(), "query rollup failed; will retry");
            Metrics::inc(&metrics.rollup_errors);
        }
    }
}

fn machine_id() -> String {
    std::env::var("FLY_MACHINE_ID")
        .or_else(|_| std::env::var("FLY_ALLOC_ID"))
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".into())
        .chars()
        .take(32)
        .collect()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
