import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// max: 1 — this client shares a single pooled connection for queries.
// The pg-listen socket in the edge app MUST be a separate dedicated
// postgres connection (LISTEN does not work through PgBouncer in
// transaction pooling mode; see readme.md §2).
const client = postgres(connectionString, { max: 1 });

export const db = drizzle(client, { schema });
export { schema };

/**
 * Creates the rule_update_trigger if missing / updates it to the latest
 * definition. Run this at boot (after db:push or db:migrate) — drizzle-kit
 * does not manage trigger SQL.
 */
export async function ensureRuleNotifyTrigger(): Promise<void> {
  await client.unsafe((await import("./schema")).RULE_NOTIFY_TRIGGER_SQL);
}
