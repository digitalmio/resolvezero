import type { LocalDnsZone } from "../../lib/zone";

export const HOUR = 3_600_000;

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
  profiles: { id: string; name: string }[];
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

export interface RulesData {
  profileId: string;
  profileName: string;
  configVersion: number;
  rules: { domain: string; action: string; scope: string; source: string; updated: string; enabled: boolean }[];
  counts: { block: number; allow: number; lists: number };
}

export interface LocalDnsData {
  profileId: string;
  profileName: string;
  zones: LocalDnsZone[];
}

export interface BlocklistsData {
  profileId: string;
  profileName: string;
  lists: {
    id: string;
    url: string;
    format: string;
    /** What the edge saw in the payload when `format` is `auto`. */
    detectedFormat: string | null;
    enabled: boolean;
    entries: number;
    lastSyncedAt: string | null;
    lastStatus: string | null;
  }[];
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

export interface CachePurgeResult {
  ok: boolean;
  name: string;
  type: string | null;
}

export interface DnsProbeStatus {
  seen: boolean;
  seenAt: string | null;
  region: string | null;
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
