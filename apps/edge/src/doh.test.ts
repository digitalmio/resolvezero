import { describe, expect, test } from "bun:test";
import { decode, encode } from "dns-packet";
import { createDohApp, type QueryLogEntry, type Upstream } from "./doh";
import { DnsCache } from "./dnsCache";
import { RuleStore } from "./ruleStore";

// Build a wire-format question: queryId(payload bytes) for "example.com A"
function wireQuery(name: string, type = "A"): Uint8Array {
  return new Uint8Array(
    encode({
      id: 0x1234,
      type: "query",
      flags: 0x0100, // RD
      questions: [{ name, type }],
    } as never),
  );
}

const STORE_FIXTURE = () => {
  const store = new RuleStore();
  store.replaceAll(
    [{ profileId: "11111111-1111-1111-1111-111111111111", domain: "evil.com", action: "block" }],
    [{ ipAddress: "10.0.0.1", profileId: "11111111-1111-1111-1111-111111111111" }],
    [
      { id: "11111111-1111-1111-1111-111111111111", dohToken: null, logQueries: true, upstream: null }, // open auth
      { id: "22222222-2222-2222-2222-222222222222", dohToken: "s3cret", logQueries: true, upstream: null }, // token auth
    ],
  );
  return store;
};

// Mock the upstream: configurable answers, records calls
function mockUpstream(responses: Record<string, string[]>): { upstream: Upstream; calls: string[] } {
  const calls: string[] = [];
  const upstream: Upstream = {
    async resolveWire(wire: Uint8Array) {
      const packet = decode(Buffer.from(wire));
      const name = String(packet.questions?.[0]?.name ?? "?");
      calls.push(name);
      const ips = responses[name] ?? ["93.184.216.34"]; // default fake A
      return {
        wire: new Uint8Array(encode({
          id: wire[0]! << 8 | wire[1]!,
          type: "response",
          flags: 0x8180,
          questions: packet.questions,
          answers: ips.map((ip) => ({
            name,
            type: "A" as const,
            class: "IN" as const,
            ttl: 300,
            data: ip,
          })),
        } as never)),
        rttMs: 1,
      };
    },
  };
  return { upstream, calls };
}

const PROFILE = "11111111-1111-1111-1111-111111111111";
const TOKEN_PROFILE = "22222222-2222-2222-2222-222222222222";

function app(
  { logs = [], upstream }: { logs?: QueryLogEntry[]; upstream?: Upstream } = {},
) {
  return createDohApp({
    store: STORE_FIXTURE(),
    dnsCache: new DnsCache(),
    upstream: upstream ?? mockUpstream({}).upstream,
    logQuery: (e) => logs.push(e),
  });
}

describe("DoH endpoint", () => {
  test("POST query forwards to upstream and returns DNS answer", async () => {
    const mock = mockUpstream({});
    const res = await app({ upstream: mock.upstream }).request(`/v1/${PROFILE}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("example.com"),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/dns-message");
    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    expect(packet.type).toBe("response");
    expect((packet as any).answers?.[0]?.data).toBe("93.184.216.34");
    expect(mock.calls).toContain("example.com");
  });

  test("blocked domain returns sinkhole A=0.0.0.0 without upstream call", async () => {
    const mock = mockUpstream({});
    const res = await app({ upstream: mock.upstream }).request(`/v1/${PROFILE}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("evil.com"),
    });

    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    expect((packet as any).answers?.[0]?.data).toBe("0.0.0.0");
    expect(mock.calls).not.toContain("evil.com");
  });

  test("policy match is canonical: uppercase + FQDN root dot still blocked", async () => {
    const mock = mockUpstream({});
    const res = await app({ upstream: mock.upstream }).request(`/v1/${PROFILE}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("EVIL.COM."),
    });

    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    expect((packet as any).answers?.[0]?.data).toBe("0.0.0.0");
    expect(mock.calls).not.toContain("EVIL.COM.");
  });

  test("unknown profile silently 404s (no body)", async () => {
    mockUpstream({});
    const res = await app().request(`/v1/99999999-9999-9999-9999-999999999999`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("example.com"),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("profile with token requires correct token", async () => {
    mockUpstream({});
    const base = `/v1/${TOKEN_PROFILE}`;
    const req = (url: string) =>
      app().request(url, {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: wireQuery("example.com"),
      });

    expect((await req(base)).status).toBe(404); // missing token
    expect((await req(`${base}/wrong`)).status).toBe(404); // wrong token
    expect((await req(`${base}/s3cret`)).status).toBe(200); // correct
  });

  test("GET ?dns= base64url accepted (RFC 8484 GET)", async () => {
    mockUpstream({});
    const wire = wireQuery("example.com");
    const b64url = Buffer.from(wire)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await app().request(`/v1/${PROFILE}?dns=${b64url}`);
    expect(res.status).toBe(200);
    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    expect(packet.type).toBe("response");
  });

  test("cache: second identical query does not re-hit upstream", async () => {
    const mock = mockUpstream({});
    const api = app({ upstream: mock.upstream });
    const req = () =>
      api.request(`/v1/${PROFILE}`, {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: wireQuery("cacheable.test"),
      });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
    expect(mock.calls.filter((c) => c === "cacheable.test")).toHaveLength(1);
  });
});

describe("zone overrides", () => {
  const ZP = "33333333-3333-3333-3333-333333333333";
  const profiles = [
    { id: PROFILE, dohToken: null, logQueries: true, upstream: null },
    { id: ZP, dohToken: null, logQueries: true, upstream: "google" },
  ];

  function zoneApp(client: { resolveWire(w: Uint8Array, u?: string): Promise<{ wire: Uint8Array; rttMs: number }> }) {
    const store = new RuleStore();
    store.replaceAll(
      [{ profileId: ZP, domain: "danger.com", action: "block" }], // blocklist hit co-testing
      [],
      profiles,
      [
        { profileId: ZP, domain: "nas.lan", recordType: "A", values: ["192.168.1.24", "192.168.1.25"], ttl: 120 },
        { profileId: ZP, domain: "printer.home.example.com", recordType: "A", values: ["10.0.0.5"], ttl: 300 },
      ],
    );
    return createDohApp({ store, dnsCache: new DnsCache(), upstream: client, logQuery: () => {} });
  }

  test("zone HIT answers locally (both values, AA flag, no upstream call)", async () => {
    const mock = mockUpstream({});
    const res = await zoneApp(mock.upstream).request(`/v1/${ZP}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("nas.lan"),
    });

    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    const answers = (packet as any).answers;
    expect(answers.map((a: { data: string }) => a.data).sort()).toEqual(["192.168.1.24", "192.168.1.25"]);
    expect(answers[0]?.ttl).toBe(120);
    expect(mock.calls.filter((c) => c === "nas.lan")).toHaveLength(0); // never hit upstream
  });

  test("zone override WINS over a blocklist rule on the same domain", async () => {
    const store = new RuleStore();
    store.replaceAll(
      [{ profileId: ZP, domain: "override-test.com", action: "block" }],
      [],
      profiles,
      [{ profileId: ZP, domain: "override-test.com", recordType: "A", values: ["10.9.9.1"], ttl: 60 }],
    );
    const mock = mockUpstream({});
    const api = createDohApp({ store, dnsCache: new DnsCache(), upstream: mock.upstream, logQuery: () => {} });

    const res = await api.request(`/v1/${ZP}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("override-test.com"),
    });
    const packet = decode(Buffer.from(await (res as Response).arrayBuffer()));
    expect((packet as any).answers?.[0]?.data).toBe("10.9.9.1"); // 0.0.0.0, user wins
  });

  test("zone SET works with per-profile upstream selection (profile upstream passes through)", async () => {
    let requestedUrl: string | undefined;
    const upstream: Upstream = {
      async resolveWire(wire, upstreamUrl) {
        requestedUrl = upstreamUrl;
        return mockUpstream({}).upstream.resolveWire(wire);
      },
    };
    const store = new RuleStore();
    store.replaceAll([], [], profiles);
    const api = createDohApp({ store, dnsCache: new DnsCache(), upstream, logQuery: () => {} });

    await api.request(`/v1/${ZP}`, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wireQuery("some-other.com"),
    });
    expect(requestedUrl).toBe("google"); // profile-level override propagates
  });
});
