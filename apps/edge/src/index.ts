import { ensureRuleNotifyTrigger } from "@resolvezero/db/client";
import { DnsCache } from "./dnsCache";
import { createDohApp, type QueryLogEntry } from "./doh";
import { RuleStore } from "./ruleStore";
import { startRuleSync } from "./ruleSync";
import { resolveWire } from "./upstream";

const PORT = Number(process.env.PORT ?? 8080);
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const store = new RuleStore();
const dnsCache = new DnsCache();

// MVP placeholder batcher (readme §6.5): console-only.
// The real one buffers queries then bulk-INSERTs into query_log,
// async off the hot path.
function logQuery(entry: QueryLogEntry): void {
  console.log("[query]", JSON.stringify(entry));
}

await ensureRuleNotifyTrigger().catch((err: unknown) => {
  // Non-fatal: trigger may already exist and DB may be briefly unreachable.
  console.warn("ensureRuleNotifyTrigger failed at boot:", err);
});

await startRuleSync(store);

const app = createDohApp({
  store,
  dnsCache,
  upstream: { resolveWire },
  logQuery,
});

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`resolvezero edge listening on :${server.port}`, {
  ...store.stats,
  dnsCache: dnsCache.stats,
});
