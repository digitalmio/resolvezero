import { describe, expect, test } from "bun:test";
import { encode, decode } from "dns-packet";
import { normalizeIp, UDP_MAX_PAYLOAD } from "./wire";
import { createDns53Service, type Dns53Deps } from "./dns53";
import { RuleStore } from "./ruleStore";
import { DnsCache } from "./dnsCache";
import { SuffixFingerprintBuilder } from "./fingerprint";
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

/** Minimal TCP DNS client (2-byte length-prefixed frames) for the test service. */
async function tcpAsk(port: number, wire: Uint8Array, proxySource?: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let buf = new Uint8Array(0);
    const timer = setTimeout(() => reject(new Error("tcp timeout")), 1500);
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket: { write(data: Uint8Array): unknown }) {
          const header = proxySource
            ? new TextEncoder().encode(`PROXY TCP4 ${proxySource} 127.0.0.1 12345 53\r\n`)
            : new Uint8Array(0);
          const frame = new Uint8Array(header.length + wire.length + 2);
          frame.set(header);
          frame[header.length] = wire.length >> 8;
          frame[header.length + 1] = wire.length & 0xff;
          frame.set(wire, header.length + 2);
          socket.write(frame);
        },
        data(_socket: unknown, data: Uint8Array | string) {
          const chunk = new Uint8Array(data as Uint8Array);
          const next = new Uint8Array(buf.length + chunk.length);
          next.set(buf);
          next.set(chunk, buf.length);
          buf = next;
          if (buf.length >= 2) {
            const len = (buf[0]! << 8) | buf[1]!;
            if (buf.length >= len + 2) {
              clearTimeout(timer);
              resolve(buf.slice(2, 2 + len));
            }
          }
        },
        error(_socket: unknown, err: Error) {
          clearTimeout(timer);
          reject(err);
        },
      },
    } as never).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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

  test("TCP framing path answers (TC fallback)", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: 15356 });
    expect(svc?.tcpPort).toBe(15356);
    const reply = await tcpAsk(15356, wireQuery("example.com"));
    const p = decode(Buffer.from(reply));
    expect((p.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
    await svc!.stop();
  });

  test("TCP PROXY protocol header supplies the real client IP", async () => {
    const deps = fakeDeps();
    // Only the PROXY-header source is authorized; the socket peer (127.0.0.1)
    // is intentionally not, so this fails unless the header is parsed.
    deps.store.replaceAll(
      [],
      [{ ipAddress: "9.9.9.9", profileId: P1 }],
      [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
      [],
    );
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: 15357 });
    const reply = await tcpAsk(15357, wireQuery("example.com"), "9.9.9.9");
    const p = decode(Buffer.from(reply));
    expect((p.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
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

  test("explicit allow overrides a remote blocklist (DoH parity)", async () => {
    const deps = fakeDeps();
    deps.store.replaceAll(
      [{ profileId: P1, domain: "allowed.example", action: "allow" }],
      [{ ipAddress: "127.0.0.1", profileId: P1 }],
      [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
      [],
    );
    const builder = new SuffixFingerprintBuilder();
    builder.add("allowed.example", "block");
    builder.add("other.example", "block");
    deps.store.upsertList("https://lists.example/block", builder.seal());
    deps.store.setSubscriptions(P1, ["https://lists.example/block"]);

    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    const c = await client(PORT);

    const allowed = decode(Buffer.from((await c.ask(wireQuery("allowed.example")))!));
    expect((allowed.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
    const blocked = decode(Buffer.from((await c.ask(wireQuery("other.example")))!));
    expect((blocked.answers?.[0] as { data?: string } | undefined)?.data).toBe("0.0.0.0");

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
