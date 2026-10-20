import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { db } from "@resolvezero/db/client";
import { profileDevices } from "@resolvezero/db/schema";
import { startPruneLoop } from "@resolvezero/db";
import { dropPrivileges } from "@resolvezero/shared";
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
import { createDns53Service, type Dns53Handle } from "./dns53";
import { S3ArchiveSink, createS3ClientFromEnv } from "./sinks/s3";

const PORT = Number(process.env.PORT ?? 8080);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
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

const s3Client = createS3ClientFromEnv();
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

// Only the primary region owns one-off DDL/prune; every POP runs the sync loop.
const isPrimaryRegion =
  !process.env.FLY_REGION || process.env.FLY_REGION === (process.env.PRIMARY_REGION ?? "fra");

if (isPrimaryRegion && process.env.PRUNE_ENABLED !== "0") {
  // NOTIFY triggers are created by the migrate job (admin role); the edge's
  // app role intentionally has no DDL rights.
  // Daily retention pruning of stats_hourly (readme §3 C).
  startPruneLoop(24);
} else {
  log.info({ region: process.env.FLY_REGION }, "skipping primary-only prune job");
}

const readiness = {
  rulesLoaded: false,
  blocklistsLoaded: false,
  dns53Bound: false,
};

// Remote custom-URL blocklists: initial fetch before binding 53, then
// NOTIFY-driven re-sync + interval refresh.
const blocklists = startBlocklistSync({ store, dnsCache });

const ruleSync = await startRuleSync(store, () => {
  void blocklists.syncNow();
});
readiness.rulesLoaded = true;

try {
  await blocklists.initialSync();
} catch (err) {
  log.error({ err }, "initial blocklist sync failed; serving with explicit rules only");
}
readiness.blocklistsLoaded = true;

const { app: healthApp, metricsApp, recorder } = createHealthApp({
  store,
  dnsCache,
  // Metrics are served on a separate private port (Fly [metrics] scrapes it);
  // never expose them on the public 8080 app.
  exposeMetrics: false,
  readiness: () => {
    const rs = ruleSync.status();
    const bs = blocklists.status();
    return {
      ok: readiness.rulesLoaded && readiness.blocklistsLoaded && readiness.dns53Bound,
      details: {
        region: process.env.FLY_REGION ?? "local",
        rulesLoaded: readiness.rulesLoaded,
        blocklistsLoaded: readiness.blocklistsLoaded,
        dns53Bound: readiness.dns53Bound,
        remoteLists: store.remoteBlocklistEntryCount,
        remoteListTables: store.stats.remoteListTables,
        profiles: store.stats.profiles,
        configPollAgeMs: rs.lastPollAt == null ? null : Date.now() - rs.lastPollAt,
        configPollError: rs.lastPollError,
        blocklistLastSyncAt: bs.lastSyncAt,
        blocklistError: bs.lastError,
        failedBlocklists: bs.failedUrls,
      },
    };
  },
});

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
let dns53Handle: Dns53Handle | null = null;
if (process.env.DNS53_ENABLED !== "0") {
  dns53Handle = await createDns53Service({
    store,
    dnsCache,
    upstream: { resolveWire },
    logQuery: function (entry) {
      if (store.shouldLog(entry.profileId)) batcher.add(entry);
    },
    recorder,
  });
  if (!dns53Handle) {
    log.error("port-53 DNS ingress not started (bind failed)");
    // On Fly (or any deployment that explicitly requires it), silence is
    // dangerous: DoH would keep working while every router/UDP client loses
    // DNS. Crash loudly instead so the health check/rollout fails.
    if (process.env.FLY_REGION || process.env.DNS53_REQUIRED === "1") {
      log.error("DNS53_REQUIRED: refusing to run without port 53 — exiting");
      process.exit(1);
    }
  }
}
readiness.dns53Bound = process.env.DNS53_ENABLED === "0" || dns53Handle !== null;

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});

// Metrics on a private port; Fly's [metrics] scraper reaches it over 6PN.
let metricsServer: ReturnType<typeof serve> | undefined;
try {
  metricsServer = serve({
    port: METRICS_PORT,
    hostname: "0.0.0.0",
    fetch: metricsApp.fetch,
  });
  log.info({ port: METRICS_PORT }, "metrics listening (private)");
} catch (err) {
  log.error({ err, port: METRICS_PORT }, "metrics server failed to bind");
}

// Ports are bound (8080 + 53); become unprivileged before serving traffic.
try {
  const dropped = dropPrivileges({
    onDrop: (uid, gid) => log.info({ uid, gid }, "dropped root privileges after binding ports"),
  });
  if (!dropped) {
    log.info({ uid: process.getuid?.(), gid: process.getgid?.() }, "running without privilege drop");
  }
} catch (err) {
  log.error({ err }, "privilege drop failed");
  if (process.env.FLY_REGION || process.env.DROP_PRIVILEGES === "1") process.exit(1);
}

// Drain: stop intake first, then flush archives before exit (rollups survive via retry).
process.on("SIGTERM", () => {
  log.info("SIGTERM — draining");
  void (async () => {
    try {
      // Stop intake first so no new DNS/HTTP work lands while we flush.
      server.close();
      metricsServer?.close();
      await dns53Handle?.stop();
      ruleSync.stop();
      blocklists.stop();
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
  `resolvezero edge listening on :${PORT}`,
);

