import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { statsHourly, statsMinute } from "@resolvezero/db/schema";

import { overviewRange, type OverviewRangeKey } from "../../lib/overview-range";
import { findProfile } from "./profile.server";

export interface QueryVolumeData {
  profileId: string;
  profileName: string;
  range: OverviewRangeKey;
  series: { bucket: string; total: number; blocked: number }[];
}

/** Chart-only series loader; dashboard KPIs stay on their fixed 24h window. */
export async function loadQueryVolume(
  ownerUserId: string,
  range: OverviewRangeKey,
  profileId?: string,
): Promise<QueryVolumeData> {
  const cfg = overviewRange(range);
  const now = Date.now();
  const start = Math.floor((now - cfg.ms) / cfg.bucketMs) * cfg.bucketMs;
  const end = Math.floor(now / cfg.bucketMs) * cfg.bucketMs;
  const profile = await findProfile(ownerUserId, profileId);

  const rows = cfg.source === "minute"
    ? await db
        .select({
          at: statsMinute.minute,
          total: statsMinute.totalQueries,
          blocked: statsMinute.blocked,
        })
        .from(statsMinute)
        .where(and(eq(statsMinute.profileId, profile.id), gte(statsMinute.minute, new Date(start))))
        .orderBy(asc(statsMinute.minute))
    : await db
        .select({
          at: statsHourly.hour,
          total: statsHourly.totalQueries,
          blocked: statsHourly.blocked,
        })
        .from(statsHourly)
        .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, new Date(start))))
        .orderBy(asc(statsHourly.hour));

  const byBucket = new Map<number, { total: number; blocked: number }>();
  for (const row of rows) {
    const key = Math.floor(row.at.getTime() / cfg.bucketMs) * cfg.bucketMs;
    const current = byBucket.get(key) ?? { total: 0, blocked: 0 };
    current.total += row.total;
    current.blocked += row.blocked;
    byBucket.set(key, current);
  }

  const series: QueryVolumeData["series"] = [];
  for (let t = start; t <= end; t += cfg.bucketMs) {
    const point = byBucket.get(t) ?? { total: 0, blocked: 0 };
    series.push({ bucket: new Date(t).toISOString(), ...point });
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    range,
    series,
  };
}
