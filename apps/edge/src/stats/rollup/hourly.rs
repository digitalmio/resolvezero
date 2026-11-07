use std::collections::HashMap;

use sqlx::{Postgres, Row, Transaction};

use super::super::util::{merge, merge_json, top_json};
use super::{HourBucket, MAX_TOP_BLOCKED, MAX_TOP_CLIENTS, MAX_TOP_DEVICES, MAX_TOP_DOMAINS};

pub(super) async fn apply_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &HourBucket,
) -> Result<(), sqlx::Error> {
    let lock = format!("{}:{}", bucket.profile, bucket.hour);
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut **tx)
        .await?;

    let existing = sqlx::query(
        "select total_queries, blocked, rtt_sum_ms, rtt_count,
                top_domains::text as top_domains, top_blocked::text as top_blocked,
                top_clients::text as top_clients, top_devices::text as top_devices
           from stats_hourly
          where profile_id = $1 and hour = to_timestamp($2)
          for update",
    )
    .bind(&bucket.profile)
    .bind(bucket.hour)
    .fetch_optional(&mut **tx)
    .await?;

    let (mut domains, mut blocked_domains, mut clients, mut devices) = (
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
    );
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
        merge_json(
            &mut clients,
            row.try_get::<String, _>("top_clients")?,
            "clientIp",
        );
        merge_json(
            &mut devices,
            row.try_get::<String, _>("top_devices")?,
            "device",
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
    merge(&mut clients, &bucket.clients);
    merge(&mut devices, &bucket.devices);

    sqlx::query(
        "insert into stats_hourly
           (profile_id, hour, total_queries, blocked, rtt_sum_ms, rtt_count,
            top_domains, top_blocked, top_clients, top_devices)
         values ($1, to_timestamp($2), $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
         on conflict (profile_id, hour) do update set
           total_queries = excluded.total_queries,
           blocked = excluded.blocked,
           rtt_sum_ms = excluded.rtt_sum_ms,
           rtt_count = excluded.rtt_count,
           top_domains = excluded.top_domains,
           top_blocked = excluded.top_blocked,
           top_clients = excluded.top_clients,
           top_devices = excluded.top_devices",
    )
    .bind(&bucket.profile)
    .bind(bucket.hour)
    .bind(total as i32)
    .bind(blocked as i32)
    .bind(rtt_sum)
    .bind(rtt_count as i32)
    .bind(top_json(&domains, "domain", MAX_TOP_DOMAINS))
    .bind(top_json(&blocked_domains, "domain", MAX_TOP_BLOCKED))
    .bind(top_json(&clients, "clientIp", MAX_TOP_CLIENTS))
    .bind(top_json(&devices, "device", MAX_TOP_DEVICES))
    .execute(&mut **tx)
    .await?;
    Ok(())
}
