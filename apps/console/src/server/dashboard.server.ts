import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  profileBlocklists,
  profileRules,
  profileZones,
  profiles,
  statsHourly,
  type StatsTopEntry,
} from "@resolvezero/db/schema";

export interface OverviewData {
  profileId: string;
  profileName: string;
  generatedAt: string;
  totalQueries: number;
  blocked: number;
  blockRatio: number;
  avgRttMs: number | null;
  activeDevices: number;
  series: { bucket: string; total: number; blocked: number }[];
  topBlocked: { domain: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  topDevices: { device: string; count: number }[];
  topClients: { clientIp: string; count: number }[];
}

// Local dev convenience: pnpm may run from the repo root or apps/console,
// while the shared secrets live in the repo-root .env. Production env vars
// are untouched.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.DASHBOARD_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
    resolve(here, "../../../../.env"),
    resolve(here, "../../../../../.env"),
  ].filter((path): path is string => Boolean(path));

  for (const envFile of candidates) {
    if (!existsSync(envFile)) continue;
    try {
      process.loadEnvFile(envFile);
      if (process.env.DATABASE_URL) break;
    } catch {
      // try the next candidate; a malformed file will surface as a query error
    }
  }
}

const HOUR = 3_600_000;

export interface RulesData {
  profileId: string;
  profileName: string;
  rules: { domain: string; action: string; scope: string; source: string; updated: string }[];
  counts: { block: number; allow: number; zones: number; lists: number };
}

export async function loadRules(): Promise<RulesData> {
  const profile = await findProfile();
  const [rules, zones, lists] = await Promise.all([
    db
      .select({ domain: profileRules.domain, action: profileRules.action })
      .from(profileRules)
      .where(eq(profileRules.profileId, profile.id))
      .orderBy(asc(profileRules.domain)),
    db
      .select({
        domain: profileZones.domain,
        recordType: profileZones.recordType,
        values: profileZones.values,
      })
      .from(profileZones)
      .where(eq(profileZones.profileId, profile.id))
      .orderBy(asc(profileZones.domain)),
    db
      .select({ url: profileBlocklists.url, format: profileBlocklists.format })
      .from(profileBlocklists)
      .where(eq(profileBlocklists.profileId, profile.id)),
  ]);

  const rows = [
    ...rules.map((r) => ({
      domain: r.domain,
      action: r.action,
      scope: "Custom",
      source: "Explicit rule",
      updated: "live",
    })),
    ...zones.map((z) => ({
      domain: z.domain,
      action: "zone",
      scope: "Zone record",
      source: `${z.recordType} · ${z.values.join(", ")}`,
      updated: "live",
    })),
    ...lists.map((l) => ({
      domain: l.url,
      action: "list",
      scope: "Blocklist",
      source: l.format.toUpperCase(),
      updated: "live",
    })),
  ];
  const counts = {
    block: rules.filter((r) => r.action === "block").length,
    allow: rules.filter((r) => r.action === "allow").length,
    zones: zones.length,
    lists: lists.length,
  };
  return { profileId: profile.id, profileName: profile.name, rules: rows, counts };
}

async function findProfile(): Promise<{ id: string; name: string }> {
  const configuredProfile = process.env.DASHBOARD_PROFILE_ID;
  if (configuredProfile) {
    const configured = await db
      .select({ id: profiles.id, name: profiles.name })
      .from(profiles)
      .where(eq(profiles.id, configuredProfile))
      .limit(1);
    if (configured[0]) return configured[0];
  }

  // Prefer the profile with the most recent rollup. Picking an arbitrary
  // "first profile" makes the dashboard look empty when a different profile
  // is the one actually sending queries.
  const latest = await db
    .select({ profileId: statsHourly.profileId })
    .from(statsHourly)
    .orderBy(desc(statsHourly.hour))
    .limit(1);
  if (latest[0]) {
    const active = await db
      .select({ id: profiles.id, name: profiles.name })
      .from(profiles)
      .where(eq(profiles.id, latest[0].profileId))
      .limit(1);
    if (active[0]) return active[0];
  }

  const fallback = await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .limit(1);
  const profile = fallback[0];
  if (!profile) throw new Error("no profile found");
  return profile;
}

export async function loadOverview(): Promise<OverviewData> {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * HOUR);
  const profile = await findProfile();

  const rows = await db
    .select({
      hour: statsHourly.hour,
      totalQueries: statsHourly.totalQueries,
      blocked: statsHourly.blocked,
      rttSumMs: statsHourly.rttSumMs,
      rttCount: statsHourly.rttCount,
      topDomains: statsHourly.topDomains,
      topBlocked: statsHourly.topBlocked,
      topDevices: statsHourly.topDevices,
      topClients: statsHourly.topClients,
    })
    .from(statsHourly)
    .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, since)))
    .orderBy(asc(statsHourly.hour));

  let totalQueries = 0;
  let blocked = 0;
  let rttSumMs = 0;
  let rttCount = 0;
  const domainCounts = new Map<string, number>();
  const blockedCounts = new Map<string, number>();
  const deviceCounts = new Map<string, number>();
  const clientCounts = new Map<string, number>();

  for (const row of rows) {
    totalQueries += row.totalQueries;
    blocked += row.blocked;
    rttSumMs += row.rttSumMs;
    rttCount += row.rttCount;
    merge(domainCounts, row.topDomains);
    merge(blockedCounts, row.topBlocked);
    merge(deviceCounts, row.topDevices);
    merge(clientCounts, row.topClients as StatsTopEntry[]);
  }

  const start = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  const end = Math.floor(now.getTime() / HOUR) * HOUR;
  const byHour = new Map<number, { total: number; blocked: number }>();
  for (const row of rows) {
    const key = Math.floor(row.hour.getTime() / HOUR) * HOUR;
    const current = byHour.get(key) ?? { total: 0, blocked: 0 };
    current.total += row.totalQueries;
    current.blocked += row.blocked;
    byHour.set(key, current);
  }
  const series: OverviewData["series"] = [];
  for (let t = start; t <= end; t += HOUR) {
    const point = byHour.get(t) ?? { total: 0, blocked: 0 };
    series.push({ bucket: new Date(t).toISOString(), ...point });
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    generatedAt: new Date().toISOString(),
    totalQueries,
    blocked,
    blockRatio: totalQueries > 0 ? Number((blocked / totalQueries).toFixed(4)) : 0,
    avgRttMs: rttCount > 0 ? Math.round(rttSumMs / rttCount) : null,
    activeDevices: deviceCounts.size,
    series,
    topBlocked: top(blockedCounts, 5).map(([domain, count]) => ({ domain, count })),
    topDomains: top(domainCounts, 5).map(([domain, count]) => ({ domain, count })),
    topDevices: top(deviceCounts, 6).map(([device, count]) => ({ device, count })),
    topClients: top(clientCounts, 6).map(([clientIp, count]) => ({ clientIp, count })),
  };
}

function merge(map: Map<string, number>, entries: StatsTopEntry[] | null): void {
  for (const entry of entries ?? []) {
    const key = entry.domain ?? entry.device ?? entry.clientIp;
    if (key) map.set(key, (map.get(key) ?? 0) + (entry.count || 0));
  }
}

function top(map: Map<string, number>, limit: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
