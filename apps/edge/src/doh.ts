import { Hono } from "hono";
import { decode } from "dns-packet";
import {
  RESPONSE,
  SINKHOLE_TTL,
  decodeQuestion,
  nxdomainResponse,
  sinkholeResponse,
  servfailResponse,
  wireEncode,
  zoneAnswer,
} from "./wire";
import { matchProbeNonce } from "./probe";
import type { RuleAction } from "./ruleStore";
import type { RuleStore, ZoneAnswer } from "./ruleStore";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import { localNameAnswer, type ZoneRecordType } from "@resolvezero/shared";
import { readBytesBounded } from "./body";

export interface QueryLogEntry {
  profileId: string;
  domain: string;
  action: RuleAction | "forward" | "override"; // 'override' = served from local zone
  rttMs: number | null;
  clientIp: string | null;
  /** Device tag from device-tagged DoH path (/v1/:p/:device) — null when absent. */
  device: string | null;
}

export interface Upstream {
  resolveWire(
    wire: Uint8Array,
    upstreamUrl?: string,
  ): Promise<{ wire: Uint8Array<ArrayBuffer>; rttMs: number }>;
}

export interface DohAppDeps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
  /** Lazily record a first-seen device slug (DB write-behind; edge keeps Map). */
  onNewDevice?(profileId: string, device: string): void;
  /** Optional Prometheus recorder (wired by index.ts when metrics are on). */
  recorder?: Recorder;
  /** Local suffixes for IP-encoded names (default: lan). */
  localDomains?: readonly string[];
  localTtl?: number;
  allowPublicIpEncoding?: boolean;
  /** Resolver-presence canary suffix; no public record should exist for it. */
  probeDomain?: string | null;
  /** Called for a valid probe lookup, after profile auth. */
  onProbeSeen?(nonce: string, transport: "doh" | "udp" | "tcp"): void;
}

/** Device tag charset: NextDNS-style url-safe short names. */
const DEVICE_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export function createDohApp(deps: DohAppDeps) {
  const app = new Hono().basePath("/v1");

  app.use("*", async (_c, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      deps.recorder?.recordDuration("doh", performance.now() - started);
    }
  });

  /** Refresh a cached entry before it expires (no client-visible latency). */
  const refresh = async (queryWire: Uint8Array, upstreamUrl?: string | null): Promise<void> => {
    const result = await deps.upstream.resolveWire(queryWire, upstreamUrl ?? undefined);
    deps.dnsCache.set(queryWire, result.wire, upstreamUrl);
    deps.recorder?.recordRtt(result.rttMs);
  };

  app.on(["GET", "POST"], ":profileId/:seg2?/:token?", async (c) => {
    // ---- Profile auth (RFC-style silent failures) ----
    // Path shapes (NextDNS-parity: device between profile and token):
    //   /v1/:id                  bare profile (token-free mode)
    //   /v1/:id/:token           bare profile + token
    //   /v1/:id/:device          token-free profile, device-tagged
    //   /v1/:id/:device/:token   tokened profile, device-tagged
    const profileId = c.req.param("profileId");
    const token = c.req.param("token") as string | undefined;
    const seg2 = c.req.param("seg2") as string | undefined;

    let device: string | null = null;
    let effectiveToken: string | undefined = token;
    if (seg2 !== undefined) {
      if (token !== undefined) {
        // 3 segments: seg2 = device, token = third
        if (!DEVICE_RE.test(seg2)) return c.body(null, 404);
        device = seg2;
      } else if (deps.store.hasToken(profileId)) {
        effectiveToken = seg2; // tokened profile, bare path
      } else if (DEVICE_RE.test(seg2)) {
        device = seg2; // token-free profile, device-tagged
      } else {
        return c.body(null, 404);
      }
    }

    if (!deps.store.hasProfile(profileId, effectiveToken)) {
      return c.body(null, 404); // silent — never authenticate the attacker
    }

    if (device !== null) {
      const isNew = deps.store.applyDeviceSeen(profileId, device);
      if (isNew) deps.onNewDevice?.(profileId, device);
    }
    // ---- Extract wire-format query (RFC 8484) ----
    let queryWire: Uint8Array | undefined;
    try {
      if (c.req.method === "GET") {
        const dns = c.req.query("dns");
        if (dns && dns.length > 4096) return c.body(null, 400);
        if (dns) queryWire = base64urlDecode(dns);
      } else if (c.req.header("content-type") === "application/dns-message") {
        const len = Number(c.req.header("content-length") ?? "0");
        if (len > 65535) return c.body(null, 400);
        queryWire = await readBytesBounded(c.req.raw.body, 65535, len);
        if (queryWire.length === 0) return c.body(null, 400);
      }
    } catch {
      return c.body(null, 400);
    }
    if (!queryWire?.length) {
      return c.body(null, 400);
    }

    let question: { id: number; name: string; type: string };
    try {
      question = decodeQuestion(queryWire);
    } catch {
      return c.body(null, 400);
    }

    const clientAddr = clientIp(c);

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
      });
      deps.recorder?.recordQuery("block");
      return c.body(sinkholeResponse(question), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${SINKHOLE_TTL}`,
      });
    }

    // ---- Remote blocklists (custom-URL subscriptions; @@ allows win first) ----
    if (!explicit && deps.store.resolveRemote(profileId, question.name) === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: clientAddr,
        device,
      });
      deps.recorder?.recordQuery("block");
      return c.body(sinkholeResponse(question), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${SINKHOLE_TTL}`,
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
      });
      deps.recorder?.recordQuery("forward");
      return c.body(local, 200, { "content-type": "application/dns-message" });
    }

    // ---- DNS response LRU cache (keyed by question + upstream) ----
    const upstreamUrl = deps.store.profileUpstream(profileId) ?? undefined;
    const cached = deps.dnsCache.get(queryWire, upstreamUrl, () => refresh(queryWire, upstreamUrl));
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
      });
      deps.recorder?.recordQuery("forward");
      return c.body(cached, 200, { "content-type": "application/dns-message" });
    }

    // ---- Forward upstream over DoH (per-profile upstream choice) ----
    deps.recorder?.recordCacheMiss("doh");
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
      });
      deps.recorder?.recordQuery("forward");
      return c.body(servfailResponse(question), 200, {
        "content-type": "application/dns-message",
      });
    }

    deps.dnsCache.set(queryWire, responseWire, upstreamUrl);
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs,
      clientIp: clientAddr,
      device,
    });
    deps.recorder?.recordQuery("forward");
    deps.recorder?.recordRtt(rttMs);

    return c.body(responseWire, 200, {
      "content-type": "application/dns-message",
    });
  });

  return app;
}

function clientIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return c.req.header("fly-client-ip") ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

function base64urlDecode(s: string): Uint8Array | undefined {
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(normalized, "base64");
    // reject non-canonical padding junk
    if (bytes.length === 0) return undefined;
    return new Uint8Array(bytes);
  } catch {
    return undefined;
  }
}
