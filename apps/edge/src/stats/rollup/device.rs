use std::collections::HashMap;

use sqlx::{Postgres, Transaction};

use super::super::util::{floor, top_json};
use super::super::QueryEvent;
use super::{DeviceHourBucket, MAX_DEVICE_TOP};

pub(super) async fn apply_device_minutes(
    tx: &mut Transaction<'_, Postgres>,
    machine: &str,
    rows: &[&QueryEvent],
) -> Result<(), sqlx::Error> {
    let mut buckets: HashMap<(String, String, i64), (i64, i64)> = HashMap::new();
    for event in rows {
        let Some(device) = &event.device else {
            continue;
        };
        let minute = floor(event.at, 60);
        let entry = buckets
            .entry((event.profile.clone(), device.clone(), minute))
            .or_insert((0, 0));
        entry.0 += 1;
        if event.action == "block" {
            entry.1 += 1;
        }
    }
    for ((profile, device, minute), (total, blocked)) in buckets {
        sqlx::query(
            "insert into stats_minute_device
               (profile_id, device, minute, machine, total_queries, blocked)
             values ($1, $2, to_timestamp($3), $4, $5, $6)
             on conflict (profile_id, device, minute, machine) do update set
               total_queries = stats_minute_device.total_queries + excluded.total_queries,
               blocked = stats_minute_device.blocked + excluded.blocked",
        )
        .bind(profile)
        .bind(device)
        .bind(minute)
        .bind(machine)
        .bind(total as i32)
        .bind(blocked as i32)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn apply_device_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    machine: &str,
    bucket: &DeviceHourBucket,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into stats_hourly_device
           (profile_id, device, hour, machine, total_queries, blocked,
            rtt_sum_ms, rtt_count, top_domains, top_blocked)
         values ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8,
                 $9::jsonb, $10::jsonb)
         on conflict (profile_id, device, hour, machine) do update set
           total_queries = stats_hourly_device.total_queries + excluded.total_queries,
           blocked = stats_hourly_device.blocked + excluded.blocked,
           rtt_sum_ms = stats_hourly_device.rtt_sum_ms + excluded.rtt_sum_ms,
           rtt_count = stats_hourly_device.rtt_count + excluded.rtt_count,
           top_domains = stats_merge_top(stats_hourly_device.top_domains, excluded.top_domains, 'domain', $11),
           top_blocked = stats_merge_top(stats_hourly_device.top_blocked, excluded.top_blocked, 'domain', $12)",
    )
    .bind(&bucket.profile)
    .bind(&bucket.device)
    .bind(bucket.hour)
    .bind(machine)
    .bind(bucket.total as i32)
    .bind(bucket.blocked as i32)
    .bind(bucket.rtt_sum)
    .bind(bucket.rtt_count as i32)
    .bind(top_json(&bucket.domains, "domain", MAX_DEVICE_TOP))
    .bind(top_json(
        &bucket.blocked_domains,
        "domain",
        MAX_DEVICE_TOP,
    ))
    .bind(MAX_DEVICE_TOP as i32)
    .bind(MAX_DEVICE_TOP as i32)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
