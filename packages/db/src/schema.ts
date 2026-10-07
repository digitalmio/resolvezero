import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
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

// Optional UDP ingress whitelist per profile (routers / legacy devices)
export const profileSourceIps = pgTable("profile_source_ips", {
  ipAddress: inet("ip_address").primaryKey(),
  profileId: uuid("profile_id")
    .notNull()
    .references(() => profiles.id),
})

// Full query log (NextDNS-style analytics). Retention per profile.
export const queryLog = pgTable(
  "query_log",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id),
    domain: varchar("domain", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(), // 'block' | 'forward'
    clientIp: inet("client_ip"),
    rttMs: smallint("rtt_ms"),
    loggedAt: timestamp("logged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("query_log_logged_at_idx").on(t.loggedAt)],
);

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
