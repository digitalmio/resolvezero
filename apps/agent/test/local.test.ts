import { describe, expect, test } from "vitest";
import { decode, encode, type Packet } from "dns-packet";
import type { AgentConfig } from "../src/config";
import { extractIpv4, isPrivateIpv4, localAnswer } from "../src/local";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    profileId: "p",
    token: "t",
    dohUrl: "https://edge.example",
    bindHost: "127.0.0.1",
    dnsPort: 0,
    timeoutMs: 5_000,
    healthPort: 0,
    healthHost: "127.0.0.1",
    devices: new Map(),
    localDomains: ["lan"],
    localTtl: 60,
    allowPublicIpEncoding: false,
    ...overrides,
  };
}

function query(name: string, type: "A" | "AAAA" = "A"): Uint8Array {
  return new Uint8Array(
    encode({
      id: 7,
      type: "query",
      flags: 0x0100,
      questions: [{ name, type, class: "IN" }],
    } as never),
  );
}

function answer(name: string, type: "A" | "AAAA" = "A", cfg = config()): Packet | undefined {
  const res = localAnswer(cfg, query(name, type));
  return res ? decode(Buffer.from(res)) : undefined;
}

describe("local IP-encoded names", () => {
  test("maps dotted and hyphenated IPv4 names", () => {
    for (const name of [
      "192.168.1.20.lan",
      "app.192.168.1.20.lan",
      "192-168-1-20.lan",
      "app.192-168-1-20.lan",
    ]) {
      expect((answer(name)?.answers?.[0] as { data?: string } | undefined)?.data).toBe("192.168.1.20");
    }
  });

  test("returns NODATA for AAAA", () => {
    const packet = answer("192.168.1.20.lan", "AAAA");
    expect(packet?.answers).toEqual([]);
    expect((packet?.flags ?? 0) & 0xf).toBe(0);
  });

  test("does not map public IPs by default", () => {
    expect(answer("8.8.8.8.lan")).toBeUndefined();
  });

  test("can opt into public IP encoding", () => {
    const packet = answer("8.8.8.8.lan", "A", config({ allowPublicIpEncoding: true }));
    expect((packet?.answers?.[0] as { data?: string } | undefined)?.data).toBe("8.8.8.8");
  });

  test("does not intercept ordinary local names", () => {
    expect(answer("nas.lan")).toBeUndefined();
    expect(answer("192.168.1.20.example.com")).toBeUndefined();
  });

  test("supports home.arpa when configured", () => {
    const packet = answer("10.0.0.5.home.arpa", "A", config({ localDomains: ["lan", "home.arpa"] }));
    expect((packet?.answers?.[0] as { data?: string } | undefined)?.data).toBe("10.0.0.5");
  });
});

describe("helpers", () => {
  test("extracts IPs only from configured local domains", () => {
    expect(extractIpv4("app.192.168.1.20.lan", ["lan"])).toBe("192.168.1.20");
    expect(extractIpv4("192.168.1.20.example.com", ["lan"])).toBeNull();
  });

  test("recognises private IPv4 ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "127.0.0.1"]) {
      expect(isPrivateIpv4(ip)).toBe(true);
    }
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });
});
