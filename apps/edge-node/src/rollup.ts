import { inArray, sql } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profiles, statsHourly, statsMinute } from "@resolvezero/db/schema";
import type { QueryLogRow } from "./batcher";
import { applyDeviceRollups } from "./deviceRollup";
import {
  MAX_TOP_BLOCKED,
  MAX_TOP_CLIENTS,
  MAX_TOP_DEVICES,
  MAX_TOP_DOMAINS,
  hourFloor,
  incr,
  machineId,
  minuteFloor,
  toTopEntries,
  type Tx,
} from "./rollupShared";

// Re-exported so existing imports/tests keep one entry point.
export {
  MAX_TOP_BLOCKED,
  MAX_TOP_CLIENTS,
  MAX_TOP_DEVICES,
  MAX_TOP_DOMAINS,
  hourFloor,
  minuteFloor,
  toTopEntries,
} from "./rollupShared";

/** Rows older than this in stats_minute are pruned by the daily job. */
export const MINUTE_RETENTION_HOURS = 6;

interface BucketAgg {
  profileId: string;
  hour: Date;
  total: number;
  blocked: number;
  rttSumMs: number;
  rttCount: number;
  domains: Map<string, number>;
  clients: Map<string, number>;
  devices: Map<string, number>;
  blockedDomains: Map<string, number>;
}

/**
 * Every machine writes its own hourly rows. The upsert adds counters and
 * merges the top lists with `stats_merge_top()` inside Postgres, so the edge
 * never selects the row back (that read was the PlanetScale egress driver).
 */
async function applyHourly(rows: QueryLogRow[], machine: string, tx: Tx): Promise<void> {
  if (rows.length === 0) return;
  for (const agg of aggregate(rows).values()) {
    await applyBucket(agg, machine, tx);
  }
}

/**
 * Apply one batched flush atomically.
 *
 * Rows for profiles that no longer exist are dropped instead of failing the
 * batch: a stale buffer entry (rename/delete) used to wedge the queue and the
 * batcher replayed the batch forever, inflating stats and the archive.
 */
export async function updateRollups(rows: QueryLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const machine = machineId();

  await db.transaction(async (tx) => {
    const ids = [...new Set(rows.map((row) => row.profileId))];
    const known = new Set(
      (
        await tx.select({ id: profiles.id }).from(profiles).where(inArray(profiles.id, ids))
      ).map((row) => row.id),
    );
    const valid = selectRunnableRows(rows, known);
    if (valid.length === 0) return;

    await applyHourly(valid, machine, tx);
    await applyMinutes(valid, machine, tx);
    await applyDeviceRollups(valid, machine, tx);
  });
}

/** Drop rows whose profile no longer exists (rename/delete leaves stale buffers). */
export function selectRunnableRows(rows: QueryLogRow[], knownProfileIds: Set<string>): QueryLogRow[] {
  return rows.filter((row) => knownProfileIds.has(row.profileId));
}

/** Minute rollups: counters only, plain additive upsert per machine. */
async function applyMinutes(rows: QueryLogRow[], machine: string, tx: Tx): Promise<void> {
  if (rows.length === 0) return;

  const buckets = new Map<string, { profileId: string; minute: Date; total: number; blocked: number }>();
  for (const row of rows) {
    const minute = minuteFloor(row.loggedAt);
    const key = `${row.profileId}|${minute.toISOString()}`;
    let b = buckets.get(key);
    if (!b) {
      b = { profileId: row.profileId, minute, total: 0, blocked: 0 };
      buckets.set(key, b);
    }
    b.total++;
    if (row.action === "block") b.blocked++;
  }

  for (const b of buckets.values()) {
    await tx
      .insert(statsMinute)
      .values({
        profileId: b.profileId,
        minute: b.minute,
        machine,
        totalQueries: b.total,
        blocked: b.blocked,
      })
      .onConflictDoUpdate({
        target: [statsMinute.profileId, statsMinute.minute, statsMinute.machine],
        set: {
          totalQueries: sql`${statsMinute.totalQueries} + excluded.total_queries`,
          blocked: sql`${statsMinute.blocked} + excluded.blocked`,
        },
      });
  }
}

/** Groups rows into per-(profile, hour) aggregates. Pure — unit-tested. */
export function aggregate(rows: QueryLogRow[]): Map<string, BucketAgg> {
  const buckets = new Map<string, BucketAgg>();
  for (const row of rows) {
    const hour = hourFloor(row.loggedAt);
    const key = `${row.profileId}|${hour.toISOString()}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        profileId: row.profileId,
        hour,
        total: 0,
        blocked: 0,
        rttSumMs: 0,
        rttCount: 0,
        domains: new Map(),
        clients: new Map(),
        devices: new Map(),
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
    if (row.clientIp) incr(agg.clients, row.clientIp);
    if (row.device) incr(agg.devices, row.device);
    incr(agg.domains, row.domain);
  }
  return buckets;
}

async function applyBucket(agg: BucketAgg, machine: string, tx: Tx): Promise<void> {
  const values = {
    profileId: agg.profileId,
    hour: agg.hour,
    machine,
    totalQueries: agg.total,
    blocked: agg.blocked,
    rttSumMs: agg.rttSumMs,
    rttCount: agg.rttCount,
    topDomains: toTopEntries(agg.domains, MAX_TOP_DOMAINS, "domain"),
    topBlocked: toTopEntries(agg.blockedDomains, MAX_TOP_BLOCKED, "domain"),
    topClients: toTopEntries(agg.clients, MAX_TOP_CLIENTS, "clientIp"),
    topDevices: toTopEntries(agg.devices, MAX_TOP_DEVICES, "device"),
  };

  await tx
    .insert(statsHourly)
    .values(values)
    .onConflictDoUpdate({
      target: [statsHourly.profileId, statsHourly.hour, statsHourly.machine],
      set: {
        totalQueries: sql`${statsHourly.totalQueries} + excluded.total_queries`,
        blocked: sql`${statsHourly.blocked} + excluded.blocked`,
        rttSumMs: sql`${statsHourly.rttSumMs} + excluded.rtt_sum_ms`,
        rttCount: sql`${statsHourly.rttCount} + excluded.rtt_count`,
        topDomains: sql`stats_merge_top(${statsHourly.topDomains}, excluded.top_domains, 'domain', ${MAX_TOP_DOMAINS})`,
        topBlocked: sql`stats_merge_top(${statsHourly.topBlocked}, excluded.top_blocked, 'domain', ${MAX_TOP_BLOCKED})`,
        topClients: sql`stats_merge_top(${statsHourly.topClients}, excluded.top_clients, 'clientIp', ${MAX_TOP_CLIENTS})`,
        topDevices: sql`stats_merge_top(${statsHourly.topDevices}, excluded.top_devices, 'device', ${MAX_TOP_DEVICES})`,
      },
    });
}
