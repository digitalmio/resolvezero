import { Hono } from "hono";
import {
  AUTHORITATIVE_ANSWER,
  RECURSION_AVAILABLE,
  RECURSION_DESIRED,
  decode,
  encode,
  type Question,
} from "dns-packet";
import type { RuleAction } from "./ruleStore";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";

const RESPONSE = 0x8000; // QR header bit (dns-packet exposes named flags only)
const SINKHOLE_TTL = 300; // 5 min is plenty for filtering churn

export interface QueryLogEntry {
  profileId: string;
  domain: string;
  action: RuleAction | "forward"; // 'forward' = allowed & sent upstream
  rttMs: number | null;
  clientIp: string | null;
}

export interface Upstream {
  resolveWire(wire: Uint8Array): Promise<{ wire: Uint8Array; rttMs: number }>;
}

export interface DohAppDeps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
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

    // ---- Rule check (exact + longest-suffix wildcard, O(domain depth)) ----
    if (deps.store.resolve(profileId, question.name) === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: clientAddr,
      });
      return c.body(sinkhole(question), 200, {
        "content-type": "application/dns-message",
        "cache-control": `max-age=${SINKHOLE_TTL}`,
      });
    }

    // ---- DNS response LRU cache ----
    const cached = deps.dnsCache.get(queryWire);
    if (cached) {
      return c.body(cached, 200, { "content-type": "application/dns-message" });
    }

    // ---- Forward upstream over DoH ----
    let rttMs: number;
    let responseWire: Uint8Array;
    try {
      const result = await deps.upstream.resolveWire(queryWire);
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
      return c.body(encodeServfail(question), 200, {
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

    return c.body(responseWire, 200, {
      "content-type": "application/dns-message",
    });
  });

  return app;
}

// ---- Wire helpers ----

function decodeQuestion(wire: Uint8Array): { id: number; name: string; type: string } {
  const packet = decode(Buffer.from(wire));
  const q = packet.questions![0] as Question | undefined;
  if (!q) throw new Error("no question section");
  return {
    id: wire[0]! << 8 | wire[1]!,
    name: String(q.name),
    type: String(q.type),
  };
}

function sinkhole(question: { id: number; name: string; type: string }): Uint8Array {
  // A -> 0.0.0.0, AAAA -> ::, other qtypes -> empty NOERROR
  const answers =
    question.type === "A"
      ? [{ name: question.name, type: "A" as const, class: "IN" as const, ttl: SINKHOLE_TTL, data: "0.0.0.0" }]
      : question.type === "AAAA"
        ? [{ name: question.name, type: "AAAA" as const, class: "IN" as const, ttl: SINKHOLE_TTL, data: "::" }]
        : [];

  return new Uint8Array(
    encode({
      id: question.id,
      type: "response",
      flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE,
      questions: [{ name: question.name, type: question.type }] as never,
      answers,
    } as never),
  );
}

function encodeServfail(question: { id: number; name: string; type: string }): Uint8Array {
  return new Uint8Array(
    encode({
      id: question.id,
      type: "response",
      flags: RESPONSE | RECURSION_DESIRED | RECURSION_AVAILABLE | 0x0002, // RCODE 2 = SERVFAIL
      questions: [{ name: question.name, type: question.type }] as never,
    }),
  );
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
