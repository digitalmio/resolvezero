import { Hono } from "hono";
import { ensureRuleNotifyTrigger, db } from "@resolvezero/db/client";
import { profileDevices } from "@resolvezero/db/schema";
import { startPruneLoop } from "@resolvezero/db";
import { QueryLogBatcher } from "./batcher";
import { createDohApp, type QueryLogEntry } from "./doh";
import { DnsCache } from "./dnsCache";
import { moduleLogger } from "./logger";
import { resolveWire } from "./upstream";
import { RuleStore } from "./ruleStore";
import { startRuleSync } from "./ruleSync";
import { updateRollups } from "./rollup";
import { createStatsApp } from "./stats";
import { createLogsApp } from "./logs";
import { createHealthApp } from "./metrics";
import { createAdminApp } from "./admin";
import { startBlocklistSync } from "./blocklists";
import { createDns53Service } from "./dns53";
import { S3ArchiveSink, type S3ClientLike } from "./sinks/s3";

const PORT = Number(process.env.PORT ?? 8080);
const LOG_PREFIX = process.env.S3_LOG_PREFIX ?? "logs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const log = moduleLogger("boot");
const logQueryLogger = moduleLogger("query");

const store = new RuleStore();
const dnsCache = new DnsCache();

// ---- Raw-log persistence: exactly one of two paths ----
// 1. QUERY_LOG_STDOUT=1        → pino lines (kind:"query") → Fly Log Shipper
//                               (Vector) can route them to the same key layout.
// 2. S3_BUCKET + creds set     → in-process S3ArchiveSink (15-min objects).
// 3. Neither                   → stats rollups only, raw logs not persisted.
const stdoutQueryLog = process.env.QUERY_LOG_STDOUT === "1";

function s3ClientFromEnv(): S3ClientLike | null {
  const { S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION } = process.env;
  if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  // Any S3-compatible provider (iDrive E2 / R2 / Tigris / AWS) via endpoint.
  return new Bun.S3Client({
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? "auto",
  }) as unknown as S3ClientLike;
}

const s3Client = s3ClientFromEnv();
const FLUSH_MINUTES = Number(process.env.S3_FLUSH_MINUTES ?? 15) || 15;
const archive = s3Client
  ? new S3ArchiveSink({ client: s3Client, prefix: LOG_PREFIX, flushMinutes: FLUSH_MINUTES })
  : null;

const batcher = new QueryLogBatcher({
  insert: async (rows) => {
    if (archive) archive.add(rows); // stage first: never lose raw events on rollup failure
    await updateRollups(rows); // minute + hourly rollups (throws → batcher retries)
  },
});
batcher.start();

if (!archive && !stdoutQueryLog) {
  log.warn("raw query logging disabled: set S3_* or QUERY_LOG_STDOUT=1 (stats still recorded)");
}

// Enqueue only when the profile hasn't opted out of logging.
function logQuery(entry: QueryLogEntry): void {
  if (!store.shouldLog(entry.profileId)) return;
  if (stdoutQueryLog) {
    // One line per event — the Log Shipper contract (kind:"query").
    logQueryLogger.info({
      kind: "query",
      time: new Date().toISOString() as string,
      profile: entry.profileId,
      domain: entry.domain,
      action: entry.action,
      rttMs: entry.rttMs,
      clientIp: entry.clientIp,
      region: process.env.FLY_REGION ?? "local",
    });
  }
  batcher.add(entry); // rollups always (still respected below opt-out)
}

await ensureRuleNotifyTrigger().catch((err) => {
  // Non-fatal: trigger may already exist and DB may be briefly unreachable.
  log.warn({ err }, "ensureRuleNotifyTrigger failed at boot");
});

// Remote custom-URL blocklists: boot fetch (delayed until snapshot lands)
// + NOTIFY-driven re-sync + interval refresh.
const blocklists = startBlocklistSync({ store, dnsCache });

await startRuleSync(store, () => {
  void blocklists.syncNow();
});

// Daily retention pruning of stats_hourly (readme §3 C).
startPruneLoop(24);

const { app: healthApp, recorder } = createHealthApp({ store, dnsCache });

const app = new Hono()
  .route("/", healthApp)
  .route("/", createAdminApp({ store, blocklists }))
  .route("/", createStatsApp({ store }))
  .route("/", createLogsApp({ store, client: s3Client, prefix: LOG_PREFIX }))
  .route("/", createDohApp(
    {
      store,
      dnsCache,
      upstream: { resolveWire },
      logQuery,
      recorder,
      onNewDevice(profileId, slug) {
        // lazy device registration — one insert per new (profile, device)
        void db
          .insert(profileDevices)
          .values({ profileId, slug })
          .onConflictDoUpdate({
            target: [profileDevices.profileId, profileDevices.slug],
            set: { lastSeenAt: new Date() },
          })
          .catch((err) => log.warn({ err, profileId, slug }, "device insert failed"));
      },
    }),
  );

// Port-53 ingress (Deco/router path) — UDP on fly-global-services. Skipped
// locally when the bind fails (no root); decided by DNS53_ENABLED=0.
if (process.env.DNS53_ENABLED !== "0") {
  const dns53 = await createDns53Service({
    store,
    dnsCache,
    upstream: { resolveWire },
    logQuery: function (entry) {
      if (store.shouldLog(entry.profileId)) batcher.add(entry);
    },
    recorder,
  });
  if (!dns53) {
    log.warn("port-53 DNS ingress not started (bind failed or disabled)");
  }
}

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

// Drain: stop intake first, then flush archives before exit (rollups survive via retry).
process.on("SIGTERM", () => {
  log.info("SIGTERM — draining");
  void (async () => {
    try {
      await batcher.stop();
      await archive?.flushAll();
      archive?.stop();
    } finally {
      process.exit(0);
    }
  })();
});

log.info(
  {
    ...store.stats,
    dnsCache: dnsCache.stats,
    remoteListEntries: store.remoteBlocklistEntryCount,
    rawLogs: archive ? "s3" : stdoutQueryLog ? "stdout" : "off",
  },
  `resolvezero edge listening on :${server.port}`,
);

