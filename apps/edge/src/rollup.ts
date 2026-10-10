import { and, eq, sql } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { statsHourly, statsMinute, type StatsTopEntry } from "@resolvezero/db/schema";
import type { QueryLogRow } from "./batcher";

export const MAX_TOP_DOMAINS = 200;
export const MAX_TOP_CLIENTS = 50;
export const MAX_TOP_DEVICES = 50;
export const MAX_TOP_BLOCKED = 100;

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
 * Updates the stats_hourly rollups for a batch of flushed query-log rows.
 * Called on every batcher flush → /stats stays near-real-time.
 *
 * Concurrency note: read-modify-write per (profile, hour) bucket assumes a
 * single edge writer per DB — acceptable for MVP (one machine per region,
 * one region writes to a given... actually: machines of DIFFERENT regions
 * share the DB. A race between two regions flushes the same bucket could
 * drop counter increments. MVP trade-off: counters drift slightly, maps
 * converge on next flush; revisit with SELECT ... FOR UPDATE or SQL-side
 * merge when hosted scale demands it.
 */
export async function updateStatsHourly(rows: QueryLogRow[]): Promise<void> {
  if (rows.length === 0) return;

  const buckets = aggregate(rows);
  await Promise.all(
    [...buckets.values()].map((agg) => applyBucket(agg)),
  );
}

/**
 * Full rollup pass per batcher flush: minute rows (totals-only counters,
 * SQL-additive upsert) + hourly rows (top-lists, read-merge-write).
 */
export async function updateRollups(rows: QueryLogRow[]): Promise<void> {
  await Promise.all([updateStatsHourly(rows), updateStatsMinute(rows)]);
}

/** UTC minute truncation. Pure — unit-tested. */
export function minuteFloor(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

/**
 * Minute rollups: counters only, so a plain additive upsert is
 * race-safe across multiple edge writers (unlike the hour maps).
 */
export async function updateStatsMinute(rows: QueryLogRow[]): Promise<void> {
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
    await db
      .insert(statsMinute)
      .values({ profileId: b.profileId, minute: b.minute, totalQueries: b.total, blocked: b.blocked })
      .onConflictDoUpdate({
        target: [statsMinute.profileId, statsMinute.minute],
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

/** UTC hour truncation. Pure — unit-tested. */
export function hourFloor(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000);
}

type TopEntry = StatsTopEntry;

/** Converts a count map into a sorted, capped entry list. Pure — unit-tested. */
export function toTopEntries(
  map: Map<string, number>,
  cap: number,
  keyName: "domain" | "clientIp" | "device",
): TopEntry[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k, count]) =>
      keyName === "domain" ? { domain: k, count } : keyName === "clientIp" ? { clientIp: k, count } : { device: k, count },
    );
}

/** Adds counts from `entries` into map `a`. Pure — unit-tested. */
export function mergeTopEntries(a: Map<string, number>, entries: StatsTopEntry[], keyName: "domain" | "clientIp" | "device"): void {
  for (const e of entries ?? []) {
    const k = keyName === "domain" ? e.domain : keyName === "device" ? e.device : e.clientIp;
    if (typeof k === "string") incr(a, k, e.count);
  }
}

async function applyBucket(agg: BucketAgg): Promise<void> {
  const existing = await db
    .select()
    .from(statsHourly)
    .where(and(eq(statsHourly.profileId, agg.profileId), eq(statsHourly.hour, agg.hour)))
    .limit(1);

const prev = existing[0] ?? {
  totalQueries: 0,
  blocked: 0,
  rttSumMs: 0,
  rttCount: 0,
  topDomains: [] as StatsTopEntry[],
  topBlocked: [] as StatsTopEntry[],
  topClients: [] as StatsTopEntry[],
  topDevices: [] as StatsTopEntry[],
};

  const domains = new Map<string, number>();
  const clients = new Map<string, number>();
  const devices = new Map<string, number>();
  const blockedDomains = new Map<string, number>();
  mergeTopEntries(domains, prev.topDomains, "domain");
  mergeTopEntries(clients, prev.topClients, "clientIp");
  mergeTopEntries(devices, prev.topDevices ?? [], "device");
  mergeTopEntries(blockedDomains, prev.topBlocked, "domain");
  for (const [k, v] of agg.domains) incr(domains, k, v);
  for (const [k, v] of agg.clients) incr(clients, k, v);
  for (const [k, v] of agg.devices) incr(devices, k, v);
  for (const [k, v] of agg.blockedDomains) incr(blockedDomains, k, v);

  const values = {
    profileId: agg.profileId,
    hour: agg.hour,
    totalQueries: prev.totalQueries + agg.total,
    blocked: prev.blocked + agg.blocked,
    rttSumMs: prev.rttSumMs + agg.rttSumMs,
    rttCount: prev.rttCount + agg.rttCount,
    topDomains: toTopEntries(domains, MAX_TOP_DOMAINS, "domain"),
    topBlocked: toTopEntries(blockedDomains, MAX_TOP_BLOCKED, "domain"),
    topClients: toTopEntries(clients, MAX_TOP_CLIENTS, "clientIp"),
    topDevices: toTopEntries(devices, MAX_TOP_DEVICES, "device"),
  };

  await db
    .insert(statsHourly)
    .values(values)
    .onConflictDoUpdate({
      target: [statsHourly.profileId, statsHourly.hour],
      set: {
        totalQueries: values.totalQueries,
        blocked: values.blocked,
        rttSumMs: values.rttSumMs,
        rttCount: values.rttCount,
        topDomains: values.topDomains,
        topBlocked: values.topBlocked,
        topClients: values.topClients,
        topDevices: values.topDevices,
      },
    });
}

function incr(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
