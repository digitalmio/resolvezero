import { and, asc, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  edgeConfigState,
  profileBlocklists,
  profileRules,
  profileZones,
} from "@resolvezero/db/schema";

import type { LocalDnsZone } from "../../lib/zone";
import { findProfile } from "./profile.server";
import type { LocalDnsData, RulesData } from "./types";

export async function loadRules(ownerUserId: string): Promise<RulesData> {
  const profile = await findProfile(ownerUserId);
  const [rules, zones, lists, configRows] = await Promise.all([
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
    db
      .select({ configVersion: edgeConfigState.configVersion })
      .from(edgeConfigState)
      .where(eq(edgeConfigState.id, true))
      .limit(1),
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
  return { profileId: profile.id, profileName: profile.name, configVersion: configRows[0]?.configVersion ?? 0, rules: rows, counts };
}

export async function loadLocalDns(ownerUserId: string): Promise<LocalDnsData> {
  const profile = await findProfile(ownerUserId);
  const rows = await db
    .select({
      domain: profileZones.domain,
      recordType: profileZones.recordType,
      values: profileZones.values,
      ttl: profileZones.ttl,
    })
    .from(profileZones)
    .where(eq(profileZones.profileId, profile.id))
    .orderBy(asc(profileZones.domain), asc(profileZones.recordType));

  return {
    profileId: profile.id,
    profileName: profile.name,
    zones: rows.map((row) => ({
      domain: row.domain,
      recordType: row.recordType as LocalDnsZone["recordType"],
      values: row.values ?? [],
      ttl: row.ttl,
    })),
  };
}

export async function upsertLocalDnsZone(ownerUserId: string, zone: LocalDnsZone): Promise<LocalDnsZone> {
  const profile = await findProfile(ownerUserId);
  await db
    .insert(profileZones)
    .values({
      profileId: profile.id,
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values,
      ttl: zone.ttl,
    })
    .onConflictDoUpdate({
      target: [profileZones.profileId, profileZones.domain, profileZones.recordType],
      set: { values: zone.values, ttl: zone.ttl },
    });
  return zone;
}

export async function removeLocalDnsZone(
  ownerUserId: string,
  domain: string,
  recordType: LocalDnsZone["recordType"],
): Promise<{ ok: true }> {
  const profile = await findProfile(ownerUserId);
  await db
    .delete(profileZones)
    .where(
      and(
        eq(profileZones.profileId, profile.id),
        eq(profileZones.domain, domain),
        eq(profileZones.recordType, recordType),
      ),
    );
  return { ok: true };
}
