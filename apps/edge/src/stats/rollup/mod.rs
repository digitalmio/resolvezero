use std::collections::HashMap;

use sqlx::{Postgres, Row, Transaction};

use rz_db::Db;

use super::util::floor;
use super::QueryEvent;

mod device;
mod hourly;

use device::{apply_device_hour_bucket, apply_device_minutes};
use hourly::apply_hour_bucket;

pub(super) const MAX_TOP_DOMAINS: usize = 200;
pub(super) const MAX_TOP_BLOCKED: usize = 100;
pub(super) const MAX_TOP_CLIENTS: usize = 50;
pub(super) const MAX_TOP_DEVICES: usize = 50;
pub(super) const MAX_DEVICE_TOP: usize = 50;

#[derive(Default)]
pub(super) struct HourBucket {
    profile: String,
    hour: i64,
    total: i64,
    blocked: i64,
    rtt_sum: i64,
    rtt_count: i64,
    domains: HashMap<String, i64>,
    blocked_domains: HashMap<String, i64>,
    clients: HashMap<String, i64>,
    devices: HashMap<String, i64>,
}

#[derive(Default)]
pub(super) struct MinuteBucket {
    profile: String,
    minute: i64,
    total: i64,
    blocked: i64,
}

#[derive(Default)]
pub(super) struct DeviceHourBucket {
    profile: String,
    device: String,
    hour: i64,
    total: i64,
    blocked: i64,
    rtt_sum: i64,
    rtt_count: i64,
    domains: HashMap<String, i64>,
    blocked_domains: HashMap<String, i64>,
}

pub(super) async fn apply_rollups(db: &Db, rows: &[QueryEvent]) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = {
        let mut set = std::collections::HashSet::new();
        rows.iter()
            .filter(|row| set.insert(row.profile.clone()))
            .map(|row| row.profile.clone())
            .collect()
    };
    let known: std::collections::HashSet<String> =
        sqlx::query("select id from profiles where id = any($1)")
            .bind(&ids)
            .fetch_all(db.pool())
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("id"))
            .collect();
    let valid: Vec<&QueryEvent> = rows
        .iter()
        .filter(|row| known.contains(&row.profile))
        .collect();
    if valid.is_empty() {
        return Ok(());
    }

    let mut hour_buckets: HashMap<(String, i64), HourBucket> = HashMap::new();
    let mut minute_buckets: HashMap<(String, i64), MinuteBucket> = HashMap::new();
    let mut device_hours: HashMap<(String, String, i64), DeviceHourBucket> = HashMap::new();

    for event in valid.iter() {
        let hour = floor(event.at, 3_600);
        let minute = floor(event.at, 60);
        let bucket = hour_buckets
            .entry((event.profile.clone(), hour))
            .or_insert_with(|| HourBucket {
                profile: event.profile.clone(),
                hour,
                ..Default::default()
            });
        bucket.total += 1;
        if event.action == "block" {
            bucket.blocked += 1;
            *bucket
                .blocked_domains
                .entry(event.domain.clone())
                .or_insert(0) += 1;
        }
        if let Some(rtt) = event.rtt_ms {
            bucket.rtt_sum += rtt;
            bucket.rtt_count += 1;
        }
        *bucket.domains.entry(event.domain.clone()).or_insert(0) += 1;
        if let Some(client) = &event.client_ip {
            *bucket.clients.entry(client.clone()).or_insert(0) += 1;
        }
        if let Some(device) = &event.device {
            *bucket.devices.entry(device.clone()).or_insert(0) += 1;
        }

        let minute_bucket = minute_buckets
            .entry((event.profile.clone(), minute))
            .or_insert_with(|| MinuteBucket {
                profile: event.profile.clone(),
                minute,
                ..Default::default()
            });
        minute_bucket.total += 1;
        if event.action == "block" {
            minute_bucket.blocked += 1;
        }

        if let Some(device) = &event.device {
            let bucket = device_hours
                .entry((event.profile.clone(), device.clone(), hour))
                .or_insert_with(|| DeviceHourBucket {
                    profile: event.profile.clone(),
                    device: device.clone(),
                    hour,
                    ..Default::default()
                });
            bucket.total += 1;
            if event.action == "block" {
                bucket.blocked += 1;
                *bucket
                    .blocked_domains
                    .entry(event.domain.clone())
                    .or_insert(0) += 1;
            }
            if let Some(rtt) = event.rtt_ms {
                bucket.rtt_sum += rtt;
                bucket.rtt_count += 1;
            }
            *bucket.domains.entry(event.domain.clone()).or_insert(0) += 1;
        }
    }

    let mut tx = db.pool().begin().await?;
    for bucket in hour_buckets.values() {
        apply_hour_bucket(&mut tx, bucket).await?;
    }
    for bucket in minute_buckets.values() {
        apply_minute_bucket(&mut tx, bucket).await?;
    }
    for bucket in device_hours.values() {
        apply_device_hour_bucket(&mut tx, bucket).await?;
    }
    apply_device_minutes(&mut tx, &valid).await?;
    tx.commit().await
}

async fn apply_minute_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &MinuteBucket,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into stats_minute (profile_id, minute, total_queries, blocked)
         values ($1, to_timestamp($2), $3, $4)
         on conflict (profile_id, minute) do update set
           total_queries = stats_minute.total_queries + excluded.total_queries,
           blocked = stats_minute.blocked + excluded.blocked",
    )
    .bind(&bucket.profile)
    .bind(bucket.minute)
    .bind(bucket.total as i32)
    .bind(bucket.blocked as i32)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
