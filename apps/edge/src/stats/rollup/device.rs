use std::collections::HashMap;

use sqlx::{Postgres, Row, Transaction};

use super::super::util::{floor, merge, merge_json, top_json};
use super::super::QueryEvent;
use super::{DeviceHourBucket, MAX_DEVICE_TOP};

pub(super) async fn apply_device_minutes(
    tx: &mut Transaction<'_, Postgres>,
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
            "insert into stats_minute_device (profile_id, device, minute, total_queries, blocked)
             values ($1, $2, to_timestamp($3), $4, $5)
             on conflict (profile_id, device, minute) do update set
               total_queries = stats_minute_device.total_queries + excluded.total_queries,
               blocked = stats_minute_device.blocked + excluded.blocked",
        )
        .bind(profile)
        .bind(device)
        .bind(minute)
        .bind(total as i32)
        .bind(blocked as i32)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn apply_device_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &DeviceHourBucket,
) -> Result<(), sqlx::Error> {
    let lock = format!(
        "device:{}:{}:{}",
        bucket.profile, bucket.device, bucket.hour
    );
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut **tx)
        .await?;

    let existing = sqlx::query(
        "select total_queries, blocked, rtt_sum_ms, rtt_count,
                top_domains::text as top_domains, top_blocked::text as top_blocked
           from stats_hourly_device
          where profile_id = $1 and device = $2 and hour = to_timestamp($3)
          for update",
    )
    .bind(&bucket.profile)
    .bind(&bucket.device)
    .bind(bucket.hour)
    .fetch_optional(&mut **tx)
    .await?;

    let mut domains = HashMap::new();
    let mut blocked_domains = HashMap::new();
    let (total, blocked, rtt_sum, rtt_count) = if let Some(row) = &existing {
        merge_json(
            &mut domains,
            row.try_get::<String, _>("top_domains")?,
            "domain",
        );
        merge_json(
            &mut blocked_domains,
            row.try_get::<String, _>("top_blocked")?,
            "domain",
        );
        (
            row.try_get::<i32, _>("total_queries")? as i64 + bucket.total,
            row.try_get::<i32, _>("blocked")? as i64 + bucket.blocked,
            row.try_get::<i64, _>("rtt_sum_ms")? + bucket.rtt_sum,
            row.try_get::<i32, _>("rtt_count")? as i64 + bucket.rtt_count,
        )
    } else {
        (
            bucket.total,
            bucket.blocked,
            bucket.rtt_sum,
            bucket.rtt_count,
        )
    };
    merge(&mut domains, &bucket.domains);
    merge(&mut blocked_domains, &bucket.blocked_domains);

    sqlx::query(
        "insert into stats_hourly_device
           (profile_id, device, hour, total_queries, blocked, rtt_sum_ms, rtt_count,
            top_domains, top_blocked)
         values ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         on conflict (profile_id, device, hour) do update set
           total_queries = excluded.total_queries,
           blocked = excluded.blocked,
           rtt_sum_ms = excluded.rtt_sum_ms,
           rtt_count = excluded.rtt_count,
           top_domains = excluded.top_domains,
           top_blocked = excluded.top_blocked",
    )
    .bind(&bucket.profile)
    .bind(&bucket.device)
    .bind(bucket.hour)
    .bind(total as i32)
    .bind(blocked as i32)
    .bind(rtt_sum)
    .bind(rtt_count as i32)
    .bind(top_json(&domains, "domain", MAX_DEVICE_TOP))
    .bind(top_json(&blocked_domains, "domain", MAX_DEVICE_TOP))
    .execute(&mut **tx)
    .await?;
    Ok(())
}
