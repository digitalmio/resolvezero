//! Query logging: Postgres rollups + gzipped S3 archive.
//!
//! Mirrors the Node pipeline: a bounded in-memory batcher writes
//! `stats_minute` / `stats_hourly` (+ per-device variants) and appends each
//! event to a one-minute S3 window. DNS never waits on either sink.

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

const BATCH_SIZE: usize = 500;
const FLUSH_EVERY: Duration = Duration::from_secs(1);
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
    tokio::spawn(async move {
        let mut archive = Archive::new(&cfg, metrics.clone());
        let mut batch: Vec<QueryEvent> = Vec::new();
        let mut pending: Vec<QueryEvent> = Vec::new();
        let mut flush_tick = tokio::time::interval(FLUSH_EVERY);
        let mut archive_tick = tokio::time::interval(ARCHIVE_EVERY);

        loop {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some(LogMessage::Event(event)) => {
                        batch.push(event);
                        if batch.len() >= BATCH_SIZE {
                            flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                        }
                    }
                    Some(LogMessage::Shutdown(done)) => {
                        flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                        archive.flush_all(now()).await;
                        let _ = done.send(());
                        break;
                    }
                    None => break,
                },
                _ = flush_tick.tick() => {
                    flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                }
                _ = archive_tick.tick() => {
                    archive.flush_completed(now()).await;
                }
            }
        }

        flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
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
    archive: &mut Archive,
    batch: &mut Vec<QueryEvent>,
    pending: &mut Vec<QueryEvent>,
    metrics: &Metrics,
) {
    if batch.is_empty() && pending.is_empty() {
        return;
    }
    pending.append(batch);
    while pending.len() > MAX_PENDING {
        pending.remove(0);
    }
    match apply_rollups(db, pending).await {
        Ok(()) => {
            for event in pending.iter() {
                archive.add(event);
            }
            pending.clear();
        }
        Err(err) => {
            warn!(%err, rows = pending.len(), "query rollup failed; will retry");
            Metrics::inc(&metrics.rollup_errors);
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
