import { describe, expect, test } from "bun:test";
import { encode, decode } from "dns-packet";
import { normalizeIp, UDP_MAX_PAYLOAD } from "./wire";
import { createDns53Service, type Dns53Deps } from "./dns53";
import { RuleStore } from "./ruleStore";
import { DnsCache } from "./dnsCache";
import type { QueryLogEntry } from "./doh";

const wireQuery = (name: string, type = "A") =>
  new Uint8Array(encode({
    id: 0x2, type: "query", flags: 0x0100,
    questions: [{ name, type }],
  } as never));

const P1 = "11111111-1111-1111-1111-111111111111";

function fakeDeps(authSourceIp: string | null = "127.0.0.1"): Dns53Deps & { logs: QueryLogEntry[]; calls: string[] } {
  const store = new RuleStore();
  store.replaceAll(
    [{ profileId: P1, domain: "evil.com", action: "block" }],
    authSourceIp ? [{ ipAddress: authSourceIp, profileId: P1 }] : [],
    [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
    [{ profileId: P1, domain: "nas.lan", recordType: "A", values: ["192.168.1.24"], ttl: 120 }],
  );
  const logs: QueryLogEntry[] = [];
  const calls: string[] = [];
  return {
    store,
    dnsCache: new DnsCache(),
    upstream: {
      async resolveWire(wire: Uint8Array) {
        const name = String(decode(Buffer.from(wire)).questions?.[0]?.name);
        calls.push(name);
        return {
          wire: new Uint8Array(encode({
            id: wire[0]! << 8 | wire[1]!,
            type: "response", flags: 0x8180,
            questions: decode(Buffer.from(wire)).questions,
            answers: [{ name, type: "A" as const, class: "IN" as const, ttl: 300, data: "1.2.3.4" }],
          } as never)),
          rttMs: 1,
        };
      },
    },
    logQuery: (e) => logs.push(e),
    logs,
    calls,
  };
}

/** Real UDP client pointed at the test service. */
async function client(port: number): Promise<{ ask(wire: Uint8Array): Promise<Uint8Array | undefined>; close(): Promise<void> }> {
  let pending: ((v: Uint8Array) => void) | undefined;
  const sock = await Bun.udpSocket({
    connect: { hostname: "127.0.0.1", port },
    socket: {
      data(_s: unknown, d: Uint8Array | string) {
        pending?.(new Uint8Array(d as Uint8Array));
      },
    },
  } as never) as unknown as Awaited<ReturnType<typeof Bun.udpSocket>> & { send(wire: Uint8Array): unknown };
  return {
    ask: (wire) => {
      return new Promise((resolve) => {
        pending = (v) => {
          pending = undefined;
          resolve(v);
        };
        (sock as any).send(wire);
        setTimeout(() => {
          if (pending) {
            pending = undefined;
            resolve(undefined); // timeout = silence
          }
        }, 700);
      });
    },
    close: async () => {
      await sock.close();
    },
  };
}

const PORT = 15353;
const PORT2 = 15354;
const PORT_TC = 15355;

describe("dns53 over real sockets", () => {
  test("normalizeIp", () => {
    expect(normalizeIp("::ffff:92.239.76.43")).toBe("92.239.76.43");
    expect(normalizeIp("92.239.76.43%en0")).toBe("92.239.76.43");
  });

  test("forward path: authorized source gets an upstream answer", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    expect(svc?.udpPort).toBe(PORT);

    const c = await client(PORT);
    const reply = await c.ask(wireQuery("example.com"));
    expect(reply).toBeDefined();
    const p = decode(Buffer.from(reply!));
    expect(((p as any).answers?.[0] as { data?: string })?.data).toBe("1.2.3.4");
    expect(deps.logs.some((l) => l.action === "forward")).toBe(true);
    await c.close();
    await svc!.stop();
  });

  test("unauthorized source gets REFUSED by default (debuggable, never logged)", async () => {
    const deps = fakeDeps(null); // no whitelisted source
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT2, tcp: false });
    const c = await client(PORT2);
    const reply = await c.ask(wireQuery("example.com"));
    expect(reply).toBeDefined();
    const p = decode(Buffer.from(reply!)) as { id: number; flags: number };
    expect(p.id).toBe(2); // wireQuery id
    expect(p.flags & 0x000f).toBe(5); // RCODE = REFUSED
    expect(deps.logs).toHaveLength(0); // nothing processed, nothing logged
    await c.close();
    await svc!.stop();
  });

  test("unauthorized source dropped silently in silent mode", async () => {
    const deps = fakeDeps(null);
    const prev = process.env.UDP_UNKNOWN_SOURCE;
    process.env.UDP_UNKNOWN_SOURCE = "silent";
    try {
      const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT2, tcp: false });
      const c = await client(PORT2);
      const reply = await c.ask(wireQuery("example.com"));
      expect(reply).toBeUndefined(); // timeout = silence
      expect(deps.logs).toHaveLength(0);
      await c.close();
      await svc!.stop();
    } finally {
      if (prev === undefined) delete process.env.UDP_UNKNOWN_SOURCE;
      else process.env.UDP_UNKNOWN_SOURCE = prev;
    }
  });

  test("block + zone override flow over UDP", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    const c = await client(PORT);
    expect((((decode(Buffer.from((await c.ask(wireQuery("ads.evil.com")))!)).answers?.[0] ?? {}) as { data?: string })).data).toBe("0.0.0.0");
    expect((((decode(Buffer.from((await c.ask(wireQuery("nas.lan")))!)).answers?.[0] ?? {}) as { data?: string })).data).toBe("192.168.1.24");
    expect(deps.calls).not.toContain("nas.lan"); // zone never hits upstream
    await c.close();
    await svc!.stop();
  });

  test("oversized reply is TC-flagged (client retries over TCP)", async () => {
    const deps = fakeDeps();
    deps.upstream = {
      async resolveWire(wire) {
        const name = String(decode(Buffer.from(wire)).questions?.[0]?.name);
        // ~2.4KB of A records → above UDP_MAX_PAYLOAD
        const replies = Array.from({ length: 100 }, (_, i) => ({
          name, type: "A" as const, class: "IN" as const, ttl: 300, data: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        }));
        return {
          wire: new Uint8Array(encode({
            id: wire[0]! << 8 | wire[1]!,
            type: "response", flags: 0x8180,
            questions: decode(Buffer.from(wire)).questions,
            answers: replies,
          } as never)),
          rttMs: 1,
        };
      },
    };
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT_TC, tcp: false });
    const c = await client(PORT_TC);
    const reply = await c.ask(wireQuery("big.test"));
    const flags = decode(Buffer.from(reply!)).flags!;
    expect(reply!.length).toBeLessThan(40);
    expect(flags & 0x0200).toBe(0x0200); // TC bit set
    await c.close();
    await svc!.stop();
  });

  test("UDP_MAX_PAYLOAD", () => {
    expect(UDP_MAX_PAYLOAD).toBe(1232);
  });
});
