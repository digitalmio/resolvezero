use sqlx::{Postgres, Transaction};

use super::super::util::top_json;
use super::{
    HourBucket, MAX_TOP_BLOCKED, MAX_TOP_CLIENTS, MAX_TOP_DEVICES, MAX_TOP_DOMAINS,
};

/// Upsert this machine's hourly delta. `stats_merge_top()` merges the top
/// lists inside Postgres, so the edge never selects the row it just wrote.
pub(super) async fn apply_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    machine: &str,
    bucket: &HourBucket,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into stats_hourly
           (profile_id, hour, machine, total_queries, blocked, rtt_sum_ms,
            rtt_count, top_domains, top_blocked, top_clients, top_devices)
         values ($1, to_timestamp($2), $3, $4, $5, $6, $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
         on conflict (profile_id, hour, machine) do update set
           total_queries = stats_hourly.total_queries + excluded.total_queries,
           blocked = stats_hourly.blocked + excluded.blocked,
           rtt_sum_ms = stats_hourly.rtt_sum_ms + excluded.rtt_sum_ms,
           rtt_count = stats_hourly.rtt_count + excluded.rtt_count,
           top_domains = stats_merge_top(stats_hourly.top_domains, excluded.top_domains, 'domain', $12),
           top_blocked = stats_merge_top(stats_hourly.top_blocked, excluded.top_blocked, 'domain', $13),
           top_clients = stats_merge_top(stats_hourly.top_clients, excluded.top_clients, 'clientIp', $14),
           top_devices = stats_merge_top(stats_hourly.top_devices, excluded.top_devices, 'device', $15)",
    )
    .bind(&bucket.profile)
    .bind(bucket.hour)
    .bind(machine)
    .bind(bucket.total as i32)
    .bind(bucket.blocked as i32)
    .bind(bucket.rtt_sum)
    .bind(bucket.rtt_count as i32)
    .bind(top_json(&bucket.domains, "domain", MAX_TOP_DOMAINS))
    .bind(top_json(
        &bucket.blocked_domains,
        "domain",
        MAX_TOP_BLOCKED,
    ))
    .bind(top_json(&bucket.clients, "clientIp", MAX_TOP_CLIENTS))
    .bind(top_json(&bucket.devices, "device", MAX_TOP_DEVICES))
    .bind(MAX_TOP_DOMAINS as i32)
    .bind(MAX_TOP_BLOCKED as i32)
    .bind(MAX_TOP_CLIENTS as i32)
    .bind(MAX_TOP_DEVICES as i32)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
