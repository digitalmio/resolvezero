import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  dohToken: varchar("doh_token", { length: 255 }).unique(),
  logQueries: boolean("log_queries").notNull().default(true),
  logRetentionDays: integer("log_retention_days").notNull().default(30),
  /** Upstream resolver selector: 'cloudflare' | 'google' | 'quad9' | ... (null = edge default) */
  upstream: varchar("upstream", { length: 50 }),
  /** Custom upstream DoH URL — wins over `upstream` preset when set (self-hosters). */
  upstreamUrl: varchar("upstream_url", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Flat domain rules, expanded for fast edge lookups.
// Suffix semantics: stored "corp.example.com" matches "*.corp.example.com".
export const profileRules = pgTable(
  "profile_rules",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    domain: varchar("domain", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(), // 'block' | 'allow'
  },
  (t) => [primaryKey({ columns: [t.profileId, t.domain] })],
);

/**
 * Custom DNS zone records served locally from the edge cache (split-horizon
 * DNS rewrites, LAN names, overrides). Exact-match by default; entries whose
 * domain starts with "*." use suffix-wildcard semantics.
 * Order: zone override → policy (block/allow) → cache → upstream.
 */
export const profileZones = pgTable(
  "profile_zones",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    domain: varchar("domain", { length: 255 }).notNull(), // 'nas.lan' or '*.home.example.com'
    recordType: varchar("record_type", { length: 10 }).notNull(), // 'A' | 'AAAA' | 'CNAME' | 'TXT'
    // One value per row entry; multiple rows round-robin-ish (all returned).
    values: jsonb("values").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ttl: integer("ttl").notNull().default(300),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.domain, t.recordType] })],
);

/**
 * Devices seen per profile (lazy-created on first device-tagged DoH query).
 * The edge inserts on first sight; the dashboard later reads/renames.
 * slug stays the raw client-provided tag (≤64 chars, url-safe charset).
 */
export const profileDevices = pgTable(
  "profile_devices",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    slug: varchar("slug", { length: 64 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.slug] })],
);

// Optional UDP ingress whitelist per profile (routers / legacy devices)
export const profileSourceIps = pgTable("profile_source_ips", {
  ipAddress: inet("ip_address").primaryKey(),
  profileId: uuid("profile_id")
    .notNull()
    .references(() => profiles.id),
})

/** Shape of entries inside the top_* jsonb lists. */
export interface StatsTopEntry {
  domain?: string;
  clientIp?: string;
  device?: string;
  count: number;
}

/**
 * Hourly stats rollups — the ONLY query-log-derived data in Postgres.
 * Raw logs live in S3-compatible storage (readme §3 C); PG holds bounded
 * aggregate rows so /stats stays near-real-time and PG stays tiny.
 *
 * Bounded per row: top 200 domains / top 50 clients / top 100 blocked
 * (excess trimmed in app code by the rollup writer).
 */
export const statsHourly = pgTable(
  "stats_hourly",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    /** Start of the aggregated hour (UTC). */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
    /** Sum of upstream RTT over forwarded queries (ms) + count for mean. */
    rttSumMs: bigint("rtt_sum_ms", { mode: "number" }).notNull().default(0),
    rttCount: integer("rtt_count").notNull().default(0),
    /** Sorted desc, capped at 200 */
    topDomains: jsonb("top_domains").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 100 */
    topBlocked: jsonb("top_blocked").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 50 */
    topClients: jsonb("top_clients").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 50 — device slugs from device-tagged DoH paths */
    topDevices: jsonb("top_devices").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    // one row per profile per hour — the rollup writer upserts on this
    primaryKey({ columns: [t.profileId, t.hour] }),
  ],
);

/**
 * Minute-level stats for short-range charts (~NextDNS "30m/6h" views).
 * Totals only (no top-lists — hourly rolls own those). Hard-bounded:
 * rows older than MINUTE_RETENTION_HOURS are pruned by the daily job.
 */
export const statsMinute = pgTable(
  "stats_minute",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    /** Start of the aggregated minute (UTC). */
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.minute] }),
  ],
);

/**
 * Remote blocklist subscriptions per profile (custom-URL blocklists).
 * PG stores ONLY urls + sync metadata; the parsed domain sets live in edge
 * memory (same as profile_rules). Each edge fetches lists independently —
 * a BLOCKLIST NOTIFY kicks them into a re-sync.
 *
 * format: 'hosts' (0.0.0.0 d, Pi-hole/KADhosts) | 'domains' (plain list)
 *         | 'abp' (||d^ blocks + @@||d^ exceptions)
 */
export const profileBlocklists = pgTable(
  "profile_blocklists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    url: varchar("url", { length: 1024 }).notNull(),
    format: varchar("format", { length: 16 }).notNull().default("hosts"),
    enabled: boolean("enabled").notNull().default(true),
    /** Write-back from the edge sync loop. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastStatus: varchar("last_status", { length: 50 }), // 'ok' | 'error: ...'
    entryCount: integer("entry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("profile_blocklists_profile_idx").on(t.profileId)],
);

/** Unique-managed list URL change events (drive edge re-syncs). */
export const BLOCKLIST_NOTIFY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION notify_blocklist_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('blocklist_updates', JSONB_BUILD_OBJECT(
        'op',        TG_OP,
        'profile_id', COALESCE(NEW.profile_id, OLD.profile_id),
        'id',        COALESCE(NEW.id, OLD.id)
    )::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blocklist_update_trigger ON profile_blocklists;
DROP TRIGGER IF EXISTS blocklist_update_cols_trigger ON profile_blocklists;
-- STATUS WRITE-BACKS (last_synced_at/last_status/entry_count updates) MUST
-- NOT NOTIFY: the edge sync writes status after every fetch and the NOTIFY
-- would re-trigger the sync forever. Update-notify only on subscription
-- columns (url/format/enabled/profile).
CREATE TRIGGER blocklist_update_trigger
AFTER INSERT OR DELETE ON profile_blocklists
FOR EACH ROW EXECUTE FUNCTION notify_blocklist_change();
CREATE TRIGGER blocklist_update_cols_trigger
AFTER UPDATE OF url, format, enabled, profile_id ON profile_blocklists
FOR EACH ROW EXECUTE FUNCTION notify_blocklist_change();
`;

// Fires a NOTIFY('profile_updates', <json>) on every rule row change.
// NEW is NULL on DELETE and OLD is NULL on INSERT: use TG_OP to pick the row.
export const RULE_NOTIFY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION notify_rule_change()
RETURNS TRIGGER AS $$
DECLARE
    payload JSONB;
BEGIN
    payload := JSONB_BUILD_OBJECT(
        'op', TG_OP,
        'profile_id', COALESCE(NEW.profile_id, OLD.profile_id),
        'domain',     COALESCE(NEW.domain,     OLD.domain),
        'action',     NEW.action
    );
    PERFORM pg_notify('profile_updates', payload::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rule_update_trigger ON profile_rules;
CREATE TRIGGER rule_update_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_rules
FOR EACH ROW EXECUTE FUNCTION notify_rule_change();
`;

// Fires a NOTIFY('zone_updates', <json>) on every zone row change
// (same payload shape; 'action' carries the record type + values snapshot).
export const ZONE_NOTIFY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION notify_zone_change()
RETURNS TRIGGER AS $$
DECLARE
    payload JSONB;
BEGIN
    payload := JSONB_BUILD_OBJECT(
        'op', TG_OP,
        'profile_id',  COALESCE(NEW.profile_id, OLD.profile_id),
        'domain',      COALESCE(NEW.domain,     OLD.domain),
        'record_type', COALESCE(NEW.record_type, OLD.record_type),
        'values',      COALESCE(NEW.values,     OLD.values),
        'ttl',         COALESCE(NEW.ttl,        OLD.ttl)
    );
    PERFORM pg_notify('zone_updates', payload::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zone_update_trigger ON profile_zones;
CREATE TRIGGER zone_update_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_zones
FOR EACH ROW EXECUTE FUNCTION notify_zone_change();
`;

// Fires a NOTIFY('ip_updates', <json>) on whitelist changes so the edge's
// authorizedSourceIps map stays live (update-ip endpoint uses this).
export const IP_NOTIFY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION notify_ip_change()
RETURNS TRIGGER AS $$
DECLARE
    payload JSONB;
BEGIN
    payload := JSONB_BUILD_OBJECT(
        'op', TG_OP,
        'ip_address', COALESCE(NEW.ip_address, OLD.ip_address),
        'profile_id', COALESCE(NEW.profile_id, OLD.profile_id)
    );
    PERFORM pg_notify('ip_updates', payload::text);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_update_trigger ON profile_source_ips;
CREATE TRIGGER ip_update_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_source_ips
FOR EACH ROW EXECUTE FUNCTION notify_ip_change();
`;
