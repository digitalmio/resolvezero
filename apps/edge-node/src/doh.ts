import { Hono } from "hono";
import { decode } from "dns-packet";
import {
  RESPONSE,
  SAFE_SEARCH_TTL,
  decodeQuestion,
  noDataResponse,
  cnameResponse,
  blockedResponse,
  nxdomainResponse,
  servfailResponse,
  wireEncode,
  zoneAnswer,
} from "./wire";
import { matchProbeNonce } from "./probe";
import { safeSearchTarget } from "./safeSearch";
import type { RuleAction } from "./ruleStore";
import type { QueryLogEntry, DohAppDeps } from "./dohTypes";
import { clientIp, readDohWire, resolveDohIdentity } from "./dohAuth";
import { refreshDohCache } from "./dohCache";
import { localNameAnswer, type ZoneRecordType } from "@resolvezero/shared";
import { createRateLimiter, positiveInt, Semaphore } from "./limits";

const DOH_RATE_LIMIT_PER_MIN = positiveInt(process.env.DOH_RATE_LIMIT_PER_MIN, 6000);
const DOH_MAX_INFLIGHT = positiveInt(process.env.DOH_MAX_INFLIGHT, 512);
export function createDohApp(deps: DohAppDeps) {
  const app = new Hono().basePath("/v1");
  const rateLimit = createRateLimiter(DOH_RATE_LIMIT_PER_MIN, 60_000, 20_000);
  const upstreamSlots = new Semaphore(DOH_MAX_INFLIGHT);

  app.use("*", async (_c, next) => {
    const started = performance.now();
    try { await next(); } finally { deps.recorder?.recordDuration("doh", performance.now() - started); }
  });

  app.on(["GET", "POST"], ":profileId/:seg2?/:token?", async (c) => {
    // ---- Profile auth (RFC-style silent failures) ----
    const identity = resolveDohIdentity(
      deps.store,
      c.req.param("profileId"),
      c.req.param("token") as string | undefined,
      c.req.param("seg2") as string | undefined,
    );
    if (!identity) return c.body(null, 404);
    const { profileId, device, token: effectiveToken } = identity;
    if (!deps.store.hasProfile(profileId, effectiveToken)) {
      return c.body(null, 404);
    }

    if (device !== null) {
      const isNew = deps.store.applyDeviceSeen(profileId, device);
      const refresh = !isNew && deps.store.deviceRefreshDue(profileId, device, 3_600_000);
      if (isNew || refresh) deps.onNewDevice?.(profileId, device);
    }
    const queryWire = await readDohWire(c);
    if (!queryWire?.length) return c.body(null, 400);

    let question: { id: number; name: string; type: string };
    try {
      question = decodeQuestion(queryWire);
    } catch {
      return c.body(null, 400);
    }

    const clientAddr = clientIp(c);
    if (!rateLimit(clientAddr ?? "unknown")) {
      deps.recorder?.recordDrop("doh_rate_limited");
      return c.body(null, 429);
    }

    // ---- Resolver-presence canary ----
    // A random subdomain of PROBE_DOMAIN is only resolvable by this edge.
    // Record the nonce and answer NXDOMAIN; the console polls the DB for it.
    const probeNonce = matchProbeNonce(question.name, deps.probeDomain ?? null);
    if (probeNonce) {
      deps.onProbeSeen?.(probeNonce, "doh");
      return c.body(nxdomainResponse(question), 200, {
        "content-type": "application/dns-message",
        "cache-control": "no-store",
      });
    }

    // ---- Local zone overrides (split-horizon answers; user config wins) ----
    // Checked BEFORE policy: an explicitly authored override answers even
    // if the domain is on the blocklist (Pi-hole rewrite semantics).
    const zone = deps.store.resolveZone(
      profileId,
      question.name,
      question.type as ZoneRecordType,
    );
    if (zone) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "zone",
        transport: "doh",
      });
      deps.recorder?.recordQuery("forward");
      try {
        return c.body(zoneAnswer(question, zone), 200, {
          "content-type": "application/dns-message",
        });
      } catch {
        // Malformed zone values (e.g. an invalid A literal) must not 500 the
        // resolver — answer SERVFAIL and leave the query path alive.
        return c.body(servfailResponse(question), 200, {
          "content-type": "application/dns-message",
        });
      }
    }

    // ---- Local name exists but not for this type: local NODATA ----
    if (deps.store.hasZoneName(profileId, question.name)) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "zone",
        transport: "doh",
      });
      deps.recorder?.recordQuery("forward");
      return c.body(noDataResponse(question), 200, {
        "content-type": "application/dns-message",
      });
    }

    // ---- Rule check (explicit user rules beat remote lists) ----
    const explicit = deps.store.resolve(profileId, question.name);
    if (explicit === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "manual",
        transport: "doh",
      });
      deps.recorder?.recordQuery("block");
      const blocked = deps.store.blockAnswer(profileId);
      return c.body(blockedResponse(question, blocked), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${blocked.ttl}`,
      });
    }

    // ---- SafeSearch rewrites (CNAME to the provider's safe endpoint) ----
    const safeTarget = safeSearchTarget(deps.store.safeSearchSettings(profileId), question.name);
    if (safeTarget) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "safesearch",
        transport: "doh",
      });
      deps.recorder?.recordQuery("forward");
      return c.body(cnameResponse(question, safeTarget), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${SAFE_SEARCH_TTL}`,
      });
    }

    // ---- Remote blocklists (custom-URL subscriptions; @@ allows win first) ----
    await deps.ensureLists?.(profileId);
    const remote = explicit ? undefined : deps.store.resolveRemoteDetailed(profileId, question.name);
    if (remote?.action === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "blocklist",
        listId: remote.listId,
        transport: "doh",
      });
      deps.recorder?.recordQuery("block");
      const blocked = deps.store.blockAnswer(profileId);
      return c.body(blockedResponse(question, blocked), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${blocked.ttl}`,
      });
    }

    // ---- Synthetic local names (nip.io-style, scoped to .lan/.home.arpa) ----
    const local = localNameAnswer(queryWire, {
      localDomains: deps.localDomains ?? ["lan"],
      localTtl: deps.localTtl ?? 60,
      allowPublicIpEncoding: deps.allowPublicIpEncoding === true,
    });
    if (local) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: clientAddr,
        device,
        reason: "zone",
        transport: "doh",
      });
      deps.recorder?.recordQuery("forward");
      return c.body(local, 200, { "content-type": "application/dns-message" });
    }

    // ---- DNS response LRU cache (keyed by question + upstream) ----
    const upstreamUrl = deps.store.profileUpstream(profileId) ?? undefined;
    const upstream = deps.store.profileUpstreamLabel(profileId);
    const cached = deps.dnsCache.get(queryWire, upstreamUrl, () => refreshDohCache(deps, queryWire, upstreamUrl, profileId), profileId);
    if (cached) {
      // Cache hits are still queries the user asked for — log them so the
      // dashboard/rollups match the readme's "all queries are logged".
      deps.recorder?.recordCacheHit("doh");
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "forward",
        rttMs: null,
        clientIp: clientAddr,
        device,
        transport: "doh",
        upstream,
      });
      deps.recorder?.recordQuery("forward");
      return c.body(cached, 200, { "content-type": "application/dns-message" });
    }

    // ---- Forward upstream over DoH (per-profile upstream choice) ----
    deps.recorder?.recordCacheMiss("doh");
    if (!upstreamSlots.tryAcquire()) {
      deps.recorder?.recordDrop("doh_inflight_limit");
      return c.body(servfailResponse(question), 200, {
        "content-type": "application/dns-message",
      });
    }
    let rttMs: number;
    let responseWire: Uint8Array<ArrayBuffer>;
    try {
      const result = await deps.upstream.resolveWire(
        queryWire,
        upstreamUrl,
      );
      responseWire = result.wire;
      rttMs = result.rttMs;
    } catch {
      // Fail fast; the client stub resolver owns retransmission.
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "forward",
        rttMs: null,
        clientIp: clientAddr,
        device,
        transport: "doh",
        upstream,
      });
      deps.recorder?.recordQuery("forward");
      return c.body(servfailResponse(question), 200, {
        "content-type": "application/dns-message",
      });
    } finally {
      upstreamSlots.release();
    }

    const normalized = deps.dnsCache.set(queryWire, responseWire, upstreamUrl, profileId);
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs,
      clientIp: clientAddr,
      device,
      transport: "doh",
      upstream,
    });
    deps.recorder?.recordQuery("forward");
    deps.recorder?.recordRtt(rttMs);

    return c.body(responseWire, 200, {
      "content-type": "application/dns-message",
    });
  });

  return app;
}

export type { QueryLogEntry, QueryLogReason, Upstream, DohAppDeps } from "./dohTypes";
