import { sql } from "drizzle-orm";
import { statsHourlyDevice, statsMinuteDevice } from "@resolvezero/db/schema";

import type { QueryLogRow } from "./batcher";
import {
  MAX_DEVICE_TOP_BLOCKED,
  MAX_DEVICE_TOP_DOMAINS,
  hourFloor,
  incr,
  minuteFloor,
  toTopEntries,
  type Tx,
} from "./rollupShared";

export interface DeviceBucketAgg {
  profileId: string;
  device: string;
  hour: Date;
  total: number;
  blocked: number;
  rttSumMs: number;
  rttCount: number;
  domains: Map<string, number>;
  blockedDomains: Map<string, number>;
}

/**
 * Groups rows into per-(profile, device, hour) aggregates. Rows without a
 * device tag are skipped: they belong to the profile totals only.
 * Pure — unit-tested.
 */
export function aggregateDevices(rows: QueryLogRow[]): Map<string, DeviceBucketAgg> {
  const buckets = new Map<string, DeviceBucketAgg>();
  for (const row of rows) {
    if (!row.device) continue;
    const hour = hourFloor(row.loggedAt);
    const key = `${row.profileId}|${row.device}|${hour.toISOString()}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        profileId: row.profileId,
        device: row.device,
        hour,
        total: 0,
        blocked: 0,
        rttSumMs: 0,
        rttCount: 0,
        domains: new Map(),
        blockedDomains: new Map(),
      };
      buckets.set(key, agg);
    }
    agg.total++;
    if (row.action === "block") {
      agg.blocked++;
      incr(agg.blockedDomains, row.domain);
    }
    if (row.rttMs !== null) {
      agg.rttSumMs += row.rttMs;
      agg.rttCount++;
    }
    incr(agg.domains, row.domain);
  }
  return buckets;
}

/**
 * Writes the per-device rollups for one flush inside the caller's transaction.
 * Per-machine rows and the SQL top-list merge mean no read-back and no lock.
 */
export async function applyDeviceRollups(rows: QueryLogRow[], machine: string, tx: Tx): Promise<void> {
  if (rows.length === 0) return;

  for (const agg of aggregateDevices(rows).values()) {
    await applyDeviceBucket(agg, machine, tx);
  }
  await applyDeviceMinutes(rows, machine, tx);
}

async function applyDeviceBucket(agg: DeviceBucketAgg, machine: string, tx: Tx): Promise<void> {
  const values = {
    profileId: agg.profileId,
    device: agg.device,
    hour: agg.hour,
    machine,
    totalQueries: agg.total,
    blocked: agg.blocked,
    rttSumMs: agg.rttSumMs,
    rttCount: agg.rttCount,
    topDomains: toTopEntries(agg.domains, MAX_DEVICE_TOP_DOMAINS, "domain"),
    topBlocked: toTopEntries(agg.blockedDomains, MAX_DEVICE_TOP_BLOCKED, "domain"),
  };

  await tx
    .insert(statsHourlyDevice)
    .values(values)
    .onConflictDoUpdate({
      target: [
        statsHourlyDevice.profileId,
        statsHourlyDevice.device,
        statsHourlyDevice.hour,
        statsHourlyDevice.machine,
      ],
      set: {
        totalQueries: sql`${statsHourlyDevice.totalQueries} + excluded.total_queries`,
        blocked: sql`${statsHourlyDevice.blocked} + excluded.blocked`,
        rttSumMs: sql`${statsHourlyDevice.rttSumMs} + excluded.rtt_sum_ms`,
        rttCount: sql`${statsHourlyDevice.rttCount} + excluded.rtt_count`,
        topDomains: sql`stats_merge_top(${statsHourlyDevice.topDomains}, excluded.top_domains, 'domain', ${MAX_DEVICE_TOP_DOMAINS})`,
        topBlocked: sql`stats_merge_top(${statsHourlyDevice.topBlocked}, excluded.top_blocked, 'domain', ${MAX_DEVICE_TOP_BLOCKED})`,
      },
    });
}

async function applyDeviceMinutes(rows: QueryLogRow[], machine: string, tx: Tx): Promise<void> {
  const buckets = new Map<
    string,
    { profileId: string; device: string; minute: Date; total: number; blocked: number }
  >();

  for (const row of rows) {
    if (!row.device) continue;
    const minute = minuteFloor(row.loggedAt);
    const key = `${row.profileId}|${row.device}|${minute.toISOString()}`;
    let b = buckets.get(key);
    if (!b) {
      b = { profileId: row.profileId, device: row.device, minute, total: 0, blocked: 0 };
      buckets.set(key, b);
    }
    b.total++;
    if (row.action === "block") b.blocked++;
  }

  for (const b of buckets.values()) {
    await tx
      .insert(statsMinuteDevice)
      .values({
        profileId: b.profileId,
        device: b.device,
        minute: b.minute,
        machine,
        totalQueries: b.total,
        blocked: b.blocked,
      })
      .onConflictDoUpdate({
        target: [
          statsMinuteDevice.profileId,
          statsMinuteDevice.device,
          statsMinuteDevice.minute,
          statsMinuteDevice.machine,
        ],
        set: {
          totalQueries: sql`${statsMinuteDevice.totalQueries} + excluded.total_queries`,
          blocked: sql`${statsMinuteDevice.blocked} + excluded.blocked`,
        },
      });
  }
}
