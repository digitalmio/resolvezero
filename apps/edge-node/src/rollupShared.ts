import { sql } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import type { StatsTopEntry } from "@resolvezero/db/schema";

/** Fly machine id (or host fallback), bounded to the schema's varchar(32). */
export function machineId(): string {
  const value =
    process.env.FLY_MACHINE_ID ??
    process.env.FLY_ALLOC_ID ??
    process.env.HOSTNAME ??
    "local";
  return value.slice(0, 32);
}

/** Drizzle transaction handle (db.transaction callback argument). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Row caps for the jsonb top-lists on `stats_hourly`. */
export const MAX_TOP_DOMAINS = 200;
export const MAX_TOP_CLIENTS = 50;
export const MAX_TOP_DEVICES = 50;
export const MAX_TOP_BLOCKED = 100;

/**
 * Row caps for per-device top-lists. Smaller than the profile caps because
 * they multiply by devices × hours.
 */
export const MAX_DEVICE_TOP_DOMAINS = 50;
export const MAX_DEVICE_TOP_BLOCKED = 50;

type TopEntry = StatsTopEntry;

/** UTC hour truncation. Pure — unit-tested. */
export function hourFloor(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000);
}

/** UTC minute truncation. Pure — unit-tested. */
export function minuteFloor(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

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

export function incr(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}
