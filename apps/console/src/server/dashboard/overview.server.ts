import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  edgeConfigState,
  profileRules,
  profileZones,
  statsHourly,
  type StatsTopEntry,
} from "@resolvezero/db/schema";

import { merge, top } from "./aggregate";
import { loadEdgeHealth } from "./edge.server";
import { findProfile, ownedProfiles } from "./profile.server";
import { HOUR, type OverviewData, type Viewer } from "./types";

export async function loadOverview(ownerUserId: string, viewer: Viewer, profileId?: string): Promise<OverviewData> {
  const now = new Date();
  // Align the query and the plotted series to the same floored hour. Filtering
  // from `now - 24h` while plotting from the floored hour made the first
  // bucket look like a real zero even when it had queries.
  const start = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  const end = Math.floor(now.getTime() / HOUR) * HOUR;
  const profile = await findProfile(ownerUserId, profileId);

  const [rows, configRows, rules, zones, edge, profiles] = await Promise.all([
    db
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
      .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, new Date(start))))
      .orderBy(asc(statsHourly.hour)),
    db
      .select({ configVersion: edgeConfigState.configVersion, blocklistVersion: edgeConfigState.blocklistVersion })
      .from(edgeConfigState)
      .where(eq(edgeConfigState.id, true))
      .limit(1),
    db
      .select({ domain: profileRules.domain })
      .from(profileRules)
      .where(eq(profileRules.profileId, profile.id)),
    db
      .select({ domain: profileZones.domain })
      .from(profileZones)
      .where(eq(profileZones.profileId, profile.id)),
    loadEdgeHealth(),
    ownedProfiles(ownerUserId),
  ]);

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
    profiles,
    generatedAt: new Date().toISOString(),
    configVersion: configRows[0]?.configVersion ?? 0,
    blocklistVersion: configRows[0]?.blocklistVersion ?? 0,
    ruleCount: rules.length,
    zoneCount: zones.length,
    viewer,
    edge,
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
