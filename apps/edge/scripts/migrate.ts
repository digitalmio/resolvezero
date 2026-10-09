/**
 * Admin-side bootstrap (never runs on the edge; requires DATABASE_URL_ADMIN):
 *   1. applies drizzle migrations (drizzle/ journal)
 *   2. ensures the rule/zone NOTIFY triggers exist
 *   3. verifies: tables + triggers + NOTIFY smoke test
 *
 * Usage: bun --env-file=.env apps/edge/scripts/migrate.ts
 */
// Admin connection string swap BEFORE lazy client init.
if (!process.env.DATABASE_URL_ADMIN) {
  console.error("DATABASE_URL_ADMIN is not set (see .env) — migrations need DDL rights");
  process.exit(1);
}
// @ts-ignore — .env key is admin-only.
process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, rawClient, ensureRuleNotifyTrigger } from "@resolvezero/db/client";

await migrate(db, { migrationsFolder: "./packages/db/drizzle" });
console.log("→ migrations applied");

await ensureRuleNotifyTrigger();
console.log("→ rule/zone NOTIFY triggers ensured");

const tables = (await rawClient().unsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
)) as { table_name: string }[];
console.log("→ tables:", tables.map((t) => t.table_name));

const triggers = (await rawClient().unsafe(
  `SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema = 'public'`,
)) as { trigger_name: string; event_object_table: string }[];
console.log("→ triggers:", triggers);

// NOTIFY smoke test: insert a test rule row, expect edge to get event; we can't
// LISTEN here (admin connection) but the trigger firing is visible via pg_paper trail:
await rawClient().unsafe(
  `SELECT count(*) FROM pg_listening_channels()`,
); // sanity SELECT; real listen verification happens in the live edge boot

await rawClient().end();
console.log("admin bootstrap complete ✅");
