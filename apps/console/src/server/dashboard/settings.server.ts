import { eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  profileBlocklists,
  profileRules,
  profileSourceIps,
  profileZones,
  profiles,
} from "@resolvezero/db/schema";

import { edgeBaseUrl } from "./edge.server";
import { findProfile } from "./profile.server";
import type { CachePurgeResult, SettingsData } from "./types";

export async function loadSettings(ownerUserId: string, profileId?: string): Promise<SettingsData> {
  const profile = await findProfile(ownerUserId, profileId);
  const [full, sourceIps, rules, zones, lists] = await Promise.all([
    db
      .select({
        dohToken: profiles.dohToken,
        upstream: profiles.upstream,
        upstreamUrl: profiles.upstreamUrl,
        logQueries: profiles.logQueries,
        logRetentionDays: profiles.logRetentionDays,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .where(eq(profiles.id, profile.id))
      .limit(1),
    db.select({ ip: profileSourceIps.ipAddress }).from(profileSourceIps).where(eq(profileSourceIps.profileId, profile.id)),
    db.select({ domain: profileRules.domain }).from(profileRules).where(eq(profileRules.profileId, profile.id)),
    db.select({ domain: profileZones.domain }).from(profileZones).where(eq(profileZones.profileId, profile.id)),
    db.select({ id: profileBlocklists.id }).from(profileBlocklists).where(eq(profileBlocklists.profileId, profile.id)),
  ]);
  const p = full[0];
  if (!p) throw new Error("profile disappeared");
  return {
    profileId: profile.id,
    profileName: profile.name,
    hasDohToken: Boolean(p.dohToken),
    upstream: p.upstream,
    upstreamUrl: p.upstreamUrl,
    logQueries: p.logQueries,
    logRetentionDays: p.logRetentionDays,
    createdAt: p.createdAt.toISOString(),
    sourceIps: sourceIps.map((row) => row.ip),
    counts: { rules: rules.length, zones: zones.length, lists: lists.length },
  };
}

/** Queue an edge-cache purge. Upstream resolver caches remain TTL-bound. */
export async function purgeCache(
  ownerUserId: string,
  domain: string,
  type?: string,
  profileId?: string,
): Promise<CachePurgeResult> {
  const profile = await findProfile(ownerUserId, profileId);
  const token = await db
    .select({ token: profiles.dohToken })
    .from(profiles)
    .where(eq(profiles.id, profile.id))
    .limit(1)
    .then((rows) => rows[0]?.token);
  if (!token) throw new Error("profile has no DoH token; cannot purge cache");

  const res = await fetch(`${edgeBaseUrl()}/v1/${encodeURIComponent(profile.id)}/cache/purge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: domain, ...(type ? { type } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { name?: string; type?: string | null; error?: string };
  if (!res.ok) throw new Error(body.error ?? `edge returned HTTP ${res.status}`);
  return { ok: true, name: body.name ?? domain, type: body.type ?? null };
}
