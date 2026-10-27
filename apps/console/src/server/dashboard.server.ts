import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  dnsProbes,
  edgeConfigState,
  profileBlocklists,
  profileRules,
  profileSourceIps,
  profileZones,
  profiles,
  statsHourly,
  type StatsTopEntry,
} from "@resolvezero/db/schema";

import "./env.server";

import type { LocalDnsZone } from "../lib/zone";

export interface Viewer {
  name: string;
  image: string | null;
  email: string | null;
}

export interface EdgeHealth {
  ok: boolean;
  region: string | null;
  rulesLoaded: boolean;
  blocklistsLoaded: boolean;
  dns53Bound: boolean;
  configPollAgeMs: number | null;
  failedBlocklists: number;
}

export interface OverviewData {
  profileId: string;
  profileName: string;
  generatedAt: string;
  configVersion: number;
  blocklistVersion: number;
  ruleCount: number;
  zoneCount: number;
  viewer: Viewer;
  edge: EdgeHealth;
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

const HOUR = 3_600_000;

export interface RulesData {
  profileId: string;
  profileName: string;
  configVersion: number;
  rules: { domain: string; action: string; scope: string; source: string; updated: string }[];
  counts: { block: number; allow: number; zones: number; lists: number };
}

export interface LocalDnsData {
  profileId: string;
  profileName: string;
  zones: LocalDnsZone[];
}

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

async function loadEdgeHealth(): Promise<EdgeHealth> {
  const edge = (process.env.EDGE_URL ?? "https://resolvezero-edge.fly.dev").replace(/\/+$/, "");
  try {
    const res = await fetch(`${edge}/readyz`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: body.ok === true,
      region: typeof body.region === "string" ? body.region : null,
      rulesLoaded: body.rulesLoaded === true,
      blocklistsLoaded: body.blocklistsLoaded === true,
      dns53Bound: body.dns53Bound === true,
      configPollAgeMs: typeof body.configPollAgeMs === "number" ? body.configPollAgeMs : null,
      failedBlocklists: typeof body.failedBlocklists === "number" ? body.failedBlocklists : 0,
    };
  } catch {
    return {
      ok: false,
      region: null,
      rulesLoaded: false,
      blocklistsLoaded: false,
      dns53Bound: false,
      configPollAgeMs: null,
      failedBlocklists: 0,
    };
  }
}

/**
 * Resolve the profile this session is allowed to see. Every query below is
 * scoped by the owning user id; there is no global "latest profile" fallback.
 */
async function findProfile(ownerUserId: string): Promise<{ id: string; name: string }> {
  const owned = await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt));

  if (owned.length === 0) {
    throw new Error("No DNS profile is linked to this account.");
  }

  const configuredProfile = process.env.DASHBOARD_PROFILE_ID;
  if (configuredProfile) {
    const configured = owned.find((profile) => profile.id === configuredProfile);
    if (configured) return configured;
  }

  // Prefer the owned profile with the most recent rollup so the dashboard
  // follows the profile that is actually serving queries.
  const latest = await db
    .select({ profileId: statsHourly.profileId })
    .from(statsHourly)
    .innerJoin(profiles, eq(statsHourly.profileId, profiles.id))
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(desc(statsHourly.hour))
    .limit(1);
  if (latest[0]) {
    const active = owned.find((profile) => profile.id === latest[0]!.profileId);
    if (active) return active;
  }

  return owned[0]!;
}

export async function loadOverview(ownerUserId: string, viewer: Viewer): Promise<OverviewData> {
  const now = new Date();
  // Align the query and the plotted series to the same floored hour. Filtering
  // from `now - 24h` while plotting from the floored hour made the first
  // bucket look like a real zero even when it had queries.
  const start = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  const end = Math.floor(now.getTime() / HOUR) * HOUR;
  const profile = await findProfile(ownerUserId);

  const [rows, configRows, rules, zones, edge] = await Promise.all([
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

function merge(map: Map<string, number>, entries: StatsTopEntry[] | null): void {
  for (const entry of entries ?? []) {
    const key = entry.domain ?? entry.device ?? entry.clientIp;
    if (key) map.set(key, (map.get(key) ?? 0) + (entry.count || 0));
  }
}

function top(map: Map<string, number>, limit: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export interface BlocklistsData {
  profileId: string;
  profileName: string;
  lists: {
    id: string;
    url: string;
    format: string;
    enabled: boolean;
    entries: number;
    lastSyncedAt: string | null;
    lastStatus: string | null;
  }[];
}

export async function loadBlocklists(ownerUserId: string): Promise<BlocklistsData> {
  const profile = await findProfile(ownerUserId);
  const lists = await db
    .select({
      id: profileBlocklists.id,
      url: profileBlocklists.url,
      format: profileBlocklists.format,
      enabled: profileBlocklists.enabled,
      entries: profileBlocklists.entryCount,
      lastSyncedAt: profileBlocklists.lastSyncedAt,
      lastStatus: profileBlocklists.lastStatus,
    })
    .from(profileBlocklists)
    .where(eq(profileBlocklists.profileId, profile.id))
    .orderBy(asc(profileBlocklists.url));

  return {
    profileId: profile.id,
    profileName: profile.name,
    lists: lists.map((list) => ({
      ...list,
      lastSyncedAt: list.lastSyncedAt ? list.lastSyncedAt.toISOString() : null,
    })),
  };
}

export interface AnalyticsData {
  profileId: string;
  profileName: string;
  total30d: number;
  blocked30d: number;
  series: {
    "24h": { label: string; total: number; blocked: number }[];
    "7d": { label: string; total: number; blocked: number }[];
    "30d": { label: string; total: number; blocked: number }[];
  };
  topBlocked: { domain: string; count: number }[];
  topDomains: { domain: string; count: number }[];
}

export async function loadAnalytics(ownerUserId: string): Promise<AnalyticsData> {
  const profile = await findProfile(ownerUserId);
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 24 * HOUR);
  const rows = await db
    .select({
      hour: statsHourly.hour,
      total: statsHourly.totalQueries,
      blocked: statsHourly.blocked,
      topDomains: statsHourly.topDomains,
      topBlocked: statsHourly.topBlocked,
    })
    .from(statsHourly)
    .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, since)))
    .orderBy(asc(statsHourly.hour));

  const dayMap = new Map<string, { total: number; blocked: number }>();
  const hourMap = new Map<number, { total: number; blocked: number }>();
  const domains = new Map<string, number>();
  const blockedDomains = new Map<string, number>();
  let total30d = 0;
  let blocked30d = 0;

  for (const row of rows) {
    total30d += row.total;
    blocked30d += row.blocked;
    merge(domains, row.topDomains);
    merge(blockedDomains, row.topBlocked);
    const day = row.hour.toISOString().slice(0, 10);
    const d = dayMap.get(day) ?? { total: 0, blocked: 0 };
    d.total += row.total;
    d.blocked += row.blocked;
    dayMap.set(day, d);
    const h = Math.floor(row.hour.getTime() / HOUR) * HOUR;
    const hv = hourMap.get(h) ?? { total: 0, blocked: 0 };
    hv.total += row.total;
    hv.blocked += row.blocked;
    hourMap.set(h, hv);
  }

  const hourSeries: AnalyticsData["series"]["24h"] = [];
  const hourStart = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  for (let t = hourStart; t <= Math.floor(now.getTime() / HOUR) * HOUR; t += HOUR) {
    const v = hourMap.get(t) ?? { total: 0, blocked: 0 };
    hourSeries.push({ label: new Date(t).toISOString().slice(11, 16), ...v });
  }

  const days = (count: number) => {
    const out: AnalyticsData["series"]["7d"] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ label: key.slice(5), ...(dayMap.get(key) ?? { total: 0, blocked: 0 }) });
    }
    return out;
  };

  return {
    profileId: profile.id,
    profileName: profile.name,
    total30d,
    blocked30d,
    series: { "24h": hourSeries, "7d": days(7), "30d": days(30) },
    topBlocked: top(blockedDomains, 8).map(([domain, count]) => ({ domain, count })),
    topDomains: top(domains, 8).map(([domain, count]) => ({ domain, count })),
  };
}

export interface SettingsData {
  profileId: string;
  profileName: string;
  hasDohToken: boolean;
  upstream: string | null;
  upstreamUrl: string | null;
  logQueries: boolean;
  logRetentionDays: number;
  createdAt: string;
  sourceIps: string[];
  counts: { rules: number; zones: number; lists: number };
}

export async function loadSettings(ownerUserId: string): Promise<SettingsData> {
  const profile = await findProfile(ownerUserId);
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

export interface CachePurgeResult {
  ok: boolean;
  name: string;
  type: string | null;
}

/** Queue an edge-cache purge. Upstream resolver caches remain TTL-bound. */
export async function purgeCache(
  ownerUserId: string,
  domain: string,
  type?: string,
): Promise<CachePurgeResult> {
  const profile = await findProfile(ownerUserId);
  const token = await db
    .select({ token: profiles.dohToken })
    .from(profiles)
    .where(eq(profiles.id, profile.id))
    .limit(1)
    .then((rows) => rows[0]?.token);
  if (!token) throw new Error("profile has no DoH token; cannot purge cache");

  const edge = (process.env.EDGE_URL ?? "https://resolvezero-edge.fly.dev").replace(/\/+$/, "");
  const res = await fetch(`${edge}/v1/${encodeURIComponent(profile.id)}/cache/purge`, {
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

export interface DnsProbeStatus {
  seen: boolean;
  seenAt: string | null;
  region: string | null;
}

/**
 * Did this browser's probe query reach the edge? The edge only writes these
 * rows after profile/source-IP authentication, so this is not a public
 * resolver checker. The nonce carries the profile id as a prefix, which lets
 * us reject a session trying to poll another tenant's canary.
 */
export async function loadDnsProbe(ownerUserId: string, nonce: string): Promise<DnsProbeStatus> {
  const owned = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId));
  const allowed = owned.some((profile) => nonce.startsWith(profile.id.replace(/-/g, "")));
  if (!allowed) {
    return { seen: false, seenAt: null, region: null };
  }

  const rows = await db
    .select({
      seenAt: dnsProbes.seenAt,
      region: dnsProbes.region,
    })
    .from(dnsProbes)
    .where(eq(dnsProbes.nonce, nonce))
    .limit(1);
  const row = rows[0];
  return {
    seen: Boolean(row),
    seenAt: row?.seenAt.toISOString() ?? null,
    region: row?.region ?? null,
  };
}

export interface LogEntry {
  time: string;
  domain: string;
  action: string;
  clientIp: string | null;
  rttMs: number | null;
  reason: string | null;
  listId: string | null;
  listLabel: string | null;
  region: string | null;
  transport: string | null;
  upstream: string | null;
}

export async function loadLogs(ownerUserId: string): Promise<{ profileId: string; profileName: string; entries: LogEntry[] }> {
  const profile = await findProfile(ownerUserId);
  const [token, lists] = await Promise.all([
    db
      .select({ token: profiles.dohToken })
      .from(profiles)
      .where(eq(profiles.id, profile.id))
      .limit(1)
      .then((rows) => rows[0]?.token),
    db
      .select({ id: profileBlocklists.id, url: profileBlocklists.url })
      .from(profileBlocklists)
      .where(eq(profileBlocklists.profileId, profile.id)),
  ]);
  if (!token) throw new Error("profile has no DoH token; cannot read logs");

  const listLabels = new Map(lists.map((list) => [list.id, safeListLabel(list.url)]));
  const edge = (process.env.EDGE_URL ?? "https://resolvezero-edge.fly.dev").replace(/\/+$/, "");
  const res = await fetch(`${edge}/v1/${encodeURIComponent(profile.id)}/logs?limit=100&format=jsonl&order=desc`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`edge logs returned HTTP ${res.status}`);
  const text = await res.text();
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.warning) continue;
      const listId = row.listId == null ? null : String(row.listId);
      entries.push({
        time: String(row.time ?? ""),
        domain: String(row.domain ?? ""),
        action: String(row.action ?? ""),
        clientIp: row.clientIp == null ? null : String(row.clientIp),
        rttMs: row.rttMs == null ? null : Number(row.rttMs),
        reason: row.reason == null ? null : String(row.reason),
        listId,
        listLabel: listId ? (listLabels.get(listId) ?? "Removed list") : null,
        region: row.region == null ? null : String(row.region),
        transport: row.transport == null ? null : String(row.transport),
        upstream: row.upstream == null ? null : String(row.upstream),
      });
    } catch {
      // ignore malformed/archive warning lines
    }
  }
  return { profileId: profile.id, profileName: profile.name, entries };
}

/** Display-safe list label — strips query/hash so tokenized URLs never reach the UI. */
function safeListLabel(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    const label = `${url.hostname}${path}`;
    return label.length > 64 ? `${label.slice(0, 61)}…` : label;
  } catch {
    return "Custom list";
  }
}
