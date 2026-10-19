import { Hono } from "hono";
import { Counter, Gauge, Histogram, collectDefaultMetrics, register, type Registry } from "prom-client";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";

let cpuUsageLast = process.cpuUsage();
let wallLast = Bun.nanoseconds();

/** Slices process CPU% since the last observation. Pure — unit-tested. */
export function cpuPercent(
  current: { user: number; system: number },
  wallNs: number,
  lastCpu: { user: number; system: number },
  lastWallNs: number,
): number {
  const wallMs = (wallNs - lastWallNs) / 1e6;
  if (wallMs <= 0) return 0;
  const userMs = (current.user - lastCpu.user) / 1000; // µs → ms
  const sysMs = (current.system - lastCpu.system) / 1000;
  return Number((((userMs + sysMs) / wallMs) * 100).toFixed(2));
}

export interface Recorder {
  recordQuery(action: "block" | "forward"): void;
  recordRtt(ms: number): void;
  /** Dropped packets (unauthorized source, malformed) — never counted as queries. */
  recordDrop(reason: string): void;
}

/**
 * /healthz (deep-readiness ping) + /metrics (Prometheus scrape).
 *
 * rz_cpu_percent is the scaling signal: Fly's proxy meters HTTP but not
 * UDP datagrams, so CPU% (sampled in-process) is the honest load proxy —
 * wire this metric to fly-autoscaler when multi-machine scaling is wanted
 * (readme §7). Gauges for rule/cache sizes ship in the same registry.
 */
let defaultMetricsCollected = false;

export function createHealthApp(deps: {
  store?: RuleStore;
  dnsCache?: DnsCache;
  registry?: Registry;
}) {
  const app = new Hono().basePath("/");
  const registry = deps.registry ?? register;

  if (!deps.registry && !defaultMetricsCollected) {
    // once per process: prom-client throws on duplicate default registrations
    collectDefaultMetrics({ register });
    defaultMetricsCollected = true;
  }

  const cpu = new Gauge({
    name: "rz_cpu_percent",
    help: "Process CPU % since last scrape",
    registers: [registry],
  });
  const queries = new Counter({
    name: "rz_queries_total",
    help: "Domain resolution outcomes",
    labelNames: ["action"] as const,
    registers: [registry],
  });
  const rtt = new Histogram({
    name: "rz_query_rtt_ms",
    help: "Upstream RTT ms (forwarded queries)",
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
    registers: [registry],
  });
  const dropped = new Counter({
    name: "rz_dropped_total",
    help: "Packets dropped before policy evaluation",
    labelNames: ["reason"] as const,
    registers: [registry],
  });

  if (deps.store) {
    new Gauge({
      name: "rz_rules",
      help: "In-memory rule count",
      registers: [registry],
      collect() { this.set(deps.store!.stats.rules); },
    });
  }
  if (deps.dnsCache) {
    new Gauge({
      name: "rz_dns_cache_entries",
      help: "DNS response LRU entries",
      registers: [registry],
      collect() { this.set(deps.dnsCache!.stats.entries); },
    });
  }
  if (deps.store) {
    // remote blocklist catalog state (GRAFANA: rz_remote_list_*)
    new Gauge({
      name: "rz_remote_list_tables",
      help: "Shared remote blocklist tables registered in this machine's catalog",
      registers: [registry],
      collect() { this.set(deps.store!.stats.remoteListTables); },
    });
    new Gauge({
      name: "rz_remote_list_rules",
      help: "Remote blocklist rules across the catalog (all lists hosted locally)",
      registers: [registry],
      collect() { this.set(deps.store!.remoteBlocklistEntryCount); },
    });
  }

  const recorder: Recorder = {
    recordQuery: (action) =>
      queries.inc({ action: action === "block" ? "block" : "forward" }),
    recordRtt: (ms) => rtt.observe(ms),
    recordDrop: (reason) => dropped.inc({ reason }),
  };

  app.get("healthz", (c) => c.body(null, 204));

  app.get("metrics", async (c) => {
    // Optional bearer gate: hosted deployments should set METRICS_TOKEN so
    // the public edge hostname doesn't expose profile/action cardinality.
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const header = c.req.header("authorization");
      const supplied = c.req.query("token") ?? (header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined);
      if (supplied !== metricsToken) return c.body(null, 401);
    }
    try {
      const cpuNow = process.cpuUsage();
      const wallNow = Bun.nanoseconds();
      cpu.set(cpuPercent(cpuNow, wallNow, cpuUsageLast, wallLast));
      cpuUsageLast = cpuNow;
      wallLast = wallNow;
    } catch {
      // scrape failures must never 500 the endpoint
    }
    return c.body(await registry.metrics(), 200, {
      "content-type": registry.contentType,
    });
  });

  return { app, recorder };
}
