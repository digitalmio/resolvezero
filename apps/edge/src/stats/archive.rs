use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};
use time::macros::format_description;
use time::OffsetDateTime;
use tracing::warn;

use crate::config::Config;
use crate::metrics::Metrics;
use rz_core::artifact::S3Config;

use super::util::{floor, format_time};
use super::QueryEvent;

const ARCHIVE_WINDOW_SECONDS: i64 = 60;
const MAX_STAGED_LINES: usize = 200_000;

pub(super) struct Archive {
    s3: Option<S3Config>,
    metrics: Arc<Metrics>,
    prefix: String,
    instance: String,
    region: String,
    machine: String,
    staging: HashMap<(i64, String), Vec<String>>,
    staged_lines: usize,
    seq: u64,
}

impl Archive {
    pub(super) fn new(cfg: &Config, metrics: Arc<Metrics>) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let region = cfg.region.clone();
        let machine = std::env::var("FLY_MACHINE_ID")
            .or_else(|_| std::env::var("FLY_ALLOC_ID"))
            .unwrap_or_else(|_| "local".into());
        let instance = format!("{region}-{machine}-{nonce}")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        Self {
            s3: S3Config::from_env(),
            metrics,
            prefix: std::env::var("S3_LOG_PREFIX").unwrap_or_else(|_| "logs".into()),
            instance,
            region,
            machine,
            staging: HashMap::new(),
            staged_lines: 0,
            seq: 0,
        }
    }

    pub(super) fn add(&mut self, event: &QueryEvent) {
        if self.s3.is_none() {
            return;
        }
        if self.staged_lines >= MAX_STAGED_LINES {
            Metrics::inc(&self.metrics.log_dropped);
            return;
        }
        let window = floor(event.at, ARCHIVE_WINDOW_SECONDS);
        let line = self.line(event);
        self.staging
            .entry((window, event.profile.clone()))
            .or_default()
            .push(line);
        self.staged_lines += 1;
    }

    fn line(&self, event: &QueryEvent) -> String {
        let mut map = Map::new();
        map.insert("kind".into(), json!("query"));
        map.insert("time".into(), json!(format_time(event.at_ms)));
        map.insert("profile".into(), json!(event.profile));
        map.insert("domain".into(), json!(event.domain));
        map.insert("action".into(), json!(event.action));
        map.insert("rttMs".into(), json!(event.rtt_ms));
        map.insert("clientIp".into(), json!(event.client_ip));
        if let Some(device) = &event.device {
            map.insert("device".into(), json!(device));
        }
        if let Some(reason) = event.reason {
            map.insert("reason".into(), json!(reason));
        }
        if let Some(list_id) = &event.list_id {
            map.insert("listId".into(), json!(list_id));
        }
        map.insert("transport".into(), json!(event.transport));
        if let Some(upstream) = &event.upstream {
            map.insert("upstream".into(), json!(upstream));
        }
        map.insert("region".into(), json!(self.region));
        map.insert("machine".into(), json!(self.machine));
        Value::Object(map).to_string()
    }

    pub(super) async fn flush_completed(&mut self, now: i64) {
        let ready: Vec<(i64, String)> = self
            .staging
            .keys()
            .filter(|(window, _)| window + ARCHIVE_WINDOW_SECONDS <= now)
            .cloned()
            .collect();
        for key in ready {
            if let Some(lines) = self.staging.remove(&key) {
                self.staged_lines = self.staged_lines.saturating_sub(lines.len());
                self.put(key.0, &key.1, lines).await;
            }
        }
    }

    pub(super) async fn flush_all(&mut self, _now: i64) {
        let keys: Vec<(i64, String)> = self.staging.keys().cloned().collect();
        for key in keys {
            if let Some(lines) = self.staging.remove(&key) {
                self.staged_lines = self.staged_lines.saturating_sub(lines.len());
                self.put(key.0, &key.1, lines).await;
            }
        }
    }

    async fn put(&mut self, window: i64, profile: &str, lines: Vec<String>) {
        let Some(s3) = &self.s3 else {
            return;
        };
        if lines.is_empty() {
            return;
        }
        let Ok(stamp) = OffsetDateTime::from_unix_timestamp(window) else {
            return;
        };
        let day = stamp
            .format(&format_description!("[year]-[month]-[day]"))
            .unwrap_or_else(|_| "1970-01-01".into());
        let hhmm = stamp
            .format(&format_description!("[hour][minute]"))
            .unwrap_or_else(|_| "0000".into());
        let key = format!(
            "{}/{}/{}/{}.{}.{}.jsonl.gz",
            self.prefix.trim_matches('/'),
            profile,
            day,
            hhmm,
            self.instance,
            self.seq
        );
        self.seq += 1;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        if encoder.write_all(lines.join("\n").as_bytes()).is_err() {
            return;
        }
        let Ok(payload) = encoder.finish() else {
            return;
        };
        let mut last_error = None;
        for attempt in 0..3 {
            match s3.put(&key, &payload, "application/gzip").await {
                Ok(()) => return,
                Err(err) => {
                    last_error = Some(err);
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
                    }
                }
            }
        }
        if let Some(err) = last_error {
            warn!(%err, key, "raw-log upload failed after retries");
        }
        Metrics::inc(&self.metrics.log_dropped);
    }
}
