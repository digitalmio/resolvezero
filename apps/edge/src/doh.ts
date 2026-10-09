import { Hono } from "hono";
import { decode } from "dns-packet";
import {
  RESPONSE,
  SINKHOLE_TTL,
  decodeQuestion,
  sinkholeResponse,
  servfailResponse,
  wireEncode,
  zoneAnswer,
} from "./wire";
import type { RuleAction } from "./ruleStore";
import type { RuleStore, ZoneAnswer } from "./ruleStore";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import type { ZoneRecordType } from "@resolvezero/shared";

export interface QueryLogEntry {
  profileId: string;
  domain: string;
  action: RuleAction | "forward" | "override"; // 'override' = served from local zone
  rttMs: number | null;
  clientIp: string | null;
}

export interface Upstream {
  resolveWire(wire: Uint8Array, upstreamUrl?: string): Promise<{ wire: Uint8Array; rttMs: number }>;
}

export interface DohAppDeps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
  /** Optional Prometheus recorder (wired by index.ts when metrics are on). */
  recorder?: Recorder;
}

export function createDohApp(deps: DohAppDeps) {
  const app = new Hono().basePath("/v1");

  app.on(["GET", "POST"], ":profileId/:token?", async (c) => {
    // ---- Profile auth (RFC-style silent failures) ----
    const profileId = c.req.param("profileId");
    const token = c.req.param("token") as string | undefined;

    if (!deps.store.hasProfile(profileId, token)) {
      return c.body(null, 404); // silent — never authenticate the attacker
    }
    // ---- Extract wire-format query (RFC 8484) ----
    let queryWire: Uint8Array | undefined;
    try {
      if (c.req.method === "GET") {
        const dns = c.req.query("dns");
        if (dns) queryWire = base64urlDecode(dns);
      } else if (c.req.header("content-type") === "application/dns-message") {
        queryWire = new Uint8Array(await c.req.arrayBuffer());
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
      });
      deps.recorder?.recordQuery("forward");
      return c.body(zoneAnswer(question, zone), 200, {
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
      });
      deps.recorder?.recordQuery("block");
      return c.body(sinkholeResponse(question), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${SINKHOLE_TTL}`,
      });
    }

    // ---- DNS response LRU cache ----
    const cached = deps.dnsCache.get(queryWire);
    if (cached) {
      deps.recorder?.recordQuery("forward");
      return c.body(cached, 200, { "content-type": "application/dns-message" });
    }

    // ---- Forward upstream over DoH (per-profile upstream choice) ----
    let rttMs: number;
    let responseWire: Uint8Array;
    try {
      const result = await deps.upstream.resolveWire(
        queryWire,
        deps.store.profileUpstream(profileId) ?? undefined,
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
      });
      deps.recorder?.recordQuery("forward");
      return c.body(servfailResponse(question), 200, {
        "content-type": "application/dns-message",
      });
    }

    deps.dnsCache.set(responseWire);
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs,
      clientIp: clientAddr,
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
