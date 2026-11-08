//! resolvezero-compiler worker: keep E2 artifacts fresh and compile new lists.
//!
//! Runs on a dedicated Fly machine. Every poll it looks for enabled list URLs
//! that have no artifact or whose artifact is older than the refresh interval,
//! compiles them with the same parser as the edge, uploads content-addressed
//! blobs, updates `profile_blocklists.artifact_hash`, and bumps the blocklist
//! watermark once per cycle if anything changed.
//!
//! New user URLs have `artifact_hash = NULL`, so they are picked up on the next
//! poll (10 s) rather than waiting for the 6-hour refresh.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rz_core::artifact::{sha256_hex, Artifact, ArtifactMeta, S3Config};
use rz_core::fingerprint::FingerprintTable;
use rz_core::netguard::{redact_url, SafeFetcher};
use rz_core::parse::{parse_list, ListFormat};
use rz_db::{CycleStatus, Db};
use tracing::{error, info, warn};

struct Config {
    interval: Duration,
    poll: Duration,
    heartbeat: Duration,
    max_bytes: usize,
    force_once: bool,
}

impl Config {
    fn from_env() -> Self {
        let num = |key: &str, default: u64| {
            std::env::var(key)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(default)
        };
        Self {
            interval: Duration::from_secs(num("COMPILE_INTERVAL_SECONDS", 6 * 3600).max(60)),
            poll: Duration::from_secs(num("COMPILE_POLL_SECONDS", 10).max(5)),
            heartbeat: Duration::from_secs(num("COMPILER_HEARTBEAT_SECONDS", 15).max(5)),
            max_bytes: num("BLOCKLIST_MAX_LIST_BYTES", 30 * 1024 * 1024) as usize,
            force_once: std::env::var("FORCE_COMPILE").as_deref() == Ok("1"),
        }
    }
}

#[tokio::main]
async fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let database_url = match std::env::var("DATABASE_URL") {
        Ok(value) => value,
        Err(_) => {
            eprintln!("DATABASE_URL is not set");
            std::process::exit(1);
        }
    };
    let db = match Db::connect(&database_url).await {
        Ok(db) => db,
        Err(err) => {
            eprintln!("database connect failed: {err}");
            std::process::exit(1);
        }
    };
    let s3 = match S3Config::from_env() {
        Some(s3) => s3,
        None => {
            eprintln!("S3_ENDPOINT/S3_BUCKET/S3_* are required");
            std::process::exit(1);
        }
    };
    let config = Config::from_env();
    let fetcher = SafeFetcher::new(config.max_bytes, true);
    let instance = instance_id();
    let mut force = config.force_once;
    let mut pending_bump = false;

    let heartbeat_db = db.clone();
    let heartbeat_instance = instance.clone();
    let heartbeat_every = config.heartbeat;
    tokio::spawn(async move {
        loop {
            if let Err(err) = heartbeat_db.heartbeat(&heartbeat_instance).await {
                error!(%err, "compiler heartbeat failed");
            }
            tokio::time::sleep(heartbeat_every).await;
        }
    });

    info!(
        instance = %instance,
        interval_secs = config.interval.as_secs(),
        poll_secs = config.poll.as_secs(),
        heartbeat_secs = config.heartbeat.as_secs(),
        "artifact compiler started"
    );

    loop {
        match cycle(&db, &s3, &fetcher, &config, force).await {
            Ok(mut status) => {
                pending_bump |= status.changed > 0;
                if pending_bump {
                    match db.bump_blocklist_version().await {
                        Ok(()) => {
                            pending_bump = false;
                            info!("blocklist_version bumped");
                        }
                        Err(err) => {
                            error!(%err, "blocklist_version bump failed; will retry");
                            status.error = Some(format!("blocklist_version bump failed: {err}"));
                        }
                    }
                }
                if let Err(err) = db.record_cycle(&instance, &status).await {
                    error!(%err, "compiler cycle status write failed");
                }
            }
            Err(err) => {
                error!(%err, "compile cycle failed");
                if let Err(write_err) = db.record_cycle_error(&instance, &err).await {
                    error!(%write_err, "compiler error status write failed");
                }
            }
        }
        force = false;
        tokio::time::sleep(config.poll).await;
    }
}

fn instance_id() -> String {
    std::env::var("FLY_MACHINE_ID")
        .or_else(|_| std::env::var("FLY_ALLOC_ID"))
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".into())
        .chars()
        .take(64)
        .collect()
}

async fn cycle(
    db: &Db,
    s3: &S3Config,
    fetcher: &SafeFetcher,
    config: &Config,
    force: bool,
) -> Result<CycleStatus, String> {
    let targets = db.compile_targets().await.map_err(|err| err.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let interval = config.interval.as_secs() as i64;
    let mut status = CycleStatus {
        total: targets.len() as i32,
        ..Default::default()
    };

    for target in targets {
        let stale = force
            || target.artifact_hash.is_none()
            || target
                .compiled_at
                .map(|compiled| now - compiled >= interval)
                .unwrap_or(true);
        if !stale {
            continue;
        }
        status.stale += 1;

        match compile_one(db, s3, fetcher, &target.url, &target.format).await {
            Ok((hash, rules, changed)) => {
                db.set_blocklist_artifact(&target.url, &hash, rules)
                    .await
                    .map_err(|err| err.to_string())?;
                status.compiled += 1;
                if changed {
                    status.changed += 1;
                }
                info!(
                    url = %redact_url(&target.url),
                    rules,
                    changed,
                    hash = &hash[..12],
                    "artifact ready"
                );
            }
            Err(err) => {
                status.failed += 1;
                if status.error.is_none() {
                    status.error = Some(format!(
                        "{}: {}",
                        redact_url(&target.url),
                        err.chars().take(160).collect::<String>()
                    ));
                }
                warn!(url = %redact_url(&target.url), %err, "compile failed");
                let error = format!("error: {}", err.chars().take(42).collect::<String>());
                let _ = db
                    .write_blocklist_status(&target.url, &error, 0, None)
                    .await;
            }
        }
    }

    let (oldest, missing) = db
        .artifact_freshness()
        .await
        .map_err(|err| err.to_string())?;
    status.oldest_compiled_at = oldest;
    status.missing_artifacts = missing;
    status.blocklist_version = db
        .versions()
        .await
        .map_err(|err| err.to_string())?
        .blocklist;
    Ok(status)
}

async fn compile_one(
    db: &Db,
    s3: &S3Config,
    fetcher: &SafeFetcher,
    url: &str,
    format: &str,
) -> Result<(String, i32, bool), String> {
    let text = String::from_utf8_lossy(&fetcher.get(url).await?).to_string();
    let parsed = parse_list(&text, ListFormat::parse(format));
    let table = FingerprintTable::build(&parsed.blocks, &parsed.allows);
    let artifact = Artifact::from_table(table);
    let bytes = artifact.encode();
    let hash = sha256_hex(&bytes);
    let meta = ArtifactMeta::for_artifact(hash.clone(), url.to_string(), &artifact, bytes.len());

    let changed = !db
        .artifact_exists(&hash)
        .await
        .map_err(|err| err.to_string())?;
    if changed {
        s3.put(&s3.key(&hash), &bytes, "application/octet-stream")
            .await?;
        s3.put(
            &format!("{}/{}.json", s3.prefix.trim_matches('/'), hash),
            meta.to_json().as_bytes(),
            "application/json",
        )
        .await?;
        db.record_artifact(
            &hash,
            url,
            bytes.len() as i32,
            artifact.allow.len() as i32,
            artifact.block.len() as i32,
        )
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok((hash, artifact.rules() as i32, changed))
}
