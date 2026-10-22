import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profiles, statsHourly, type StatsTopEntry } from "@resolvezero/db/schema";

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
}

const HOUR = 3_600_000;

export const getOverview = createServerFn({ method: "GET" }).handler(async (): Promise<OverviewData> => {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * HOUR);
  const configuredProfile = process.env.DASHBOARD_PROFILE_ID;

  const profileRows = await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(configuredProfile ? eq(profiles.id, configuredProfile) : undefined)
    .limit(1);
  const profile = profileRows[0];
  if (!profile) throw new Error("no profile found");

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

  for (const row of rows) {
    totalQueries += row.totalQueries;
    blocked += row.blocked;
    rttSumMs += row.rttSumMs;
    rttCount += row.rttCount;
    merge(domainCounts, row.topDomains);
    merge(blockedCounts, row.topBlocked);
    merge(deviceCounts, row.topDevices);
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
  };
});

function merge(map: Map<string, number>, entries: StatsTopEntry[] | null): void {
  for (const entry of entries ?? []) {
    const key = entry.domain ?? entry.device ?? entry.clientIp;
    if (key) map.set(key, (map.get(key) ?? 0) + (entry.count || 0));
  }
}

function top(map: Map<string, number>, limit: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}
