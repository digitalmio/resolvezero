import { describe, expect, test } from "bun:test";
import { RuleStore, type RuleRow, type SourceIpRow } from "./ruleStore";

const rows: RuleRow[] = [
  { profileId: "p1", domain: "evil.com", action: "block" },
  { profileId: "p1", domain: "bad.io", action: "allow" },
  { profileId: "p2", domain: "p2-only.dev", action: "block" },
];

const profiles = [
  { id: "p1", dohToken: null },
  { id: "p2", dohToken: null },
];

const sourceIps: SourceIpRow[] = [
  { ipAddress: "10.0.0.1", profileId: "p1" },
  { ipAddress: "10.0.0.2", profileId: "p2" },
];

describe("RuleStore", () => {
  test("resolves exact rules per profile", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.resolve("p1", "evil.com")).toBe("block");
    expect(store.resolve("p1", "bad.io")).toBe("allow");
    expect(store.resolve("p2", "p2-only.dev")).toBe("block");
  });

  test("does not leak rules across profiles", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.resolve("p2", "evil.com")).toBeUndefined();
    expect(store.resolve("unknown", "evil.com")).toBeUndefined();
  });

  test("suffix wildcard matches subdomains (longest-suffix semantics)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [...rows, { profileId: "p1", domain: "corp.example.com", action: "block" }],
      sourceIps,
      profiles,
    );

    expect(store.resolve("p1", "a.corp.example.com")).toBe("block");
    expect(store.resolve("p1", "x.y.z.corp.example.com")).toBe("block");
    expect(store.resolve("p1", "corp.example.com")).toBe("block");
    // "example.com" itself is NOT covered by a corp.example.com rule
    expect(store.resolve("p1", "example.com")).toBeUndefined();
    expect(store.resolve("p1", "other.example.com")).toBeUndefined();
  });

  test("authorizes source IP to profile", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.authorizeSourceIp("10.0.0.1")).toBe("p1");
    expect(store.authorizeSourceIp("10.0.0.2")).toBe("p2");
    expect(store.authorizeSourceIp("1.2.3.4")).toBeUndefined();
  });

  test("applyEvent INSERT/UPDATE upserts a rule", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    store.applyEvent({ op: "INSERT", profile_id: "p2", domain: "fresh.net", action: "allow" });
    expect(store.resolve("p2", "fresh.net")).toBe("allow");

    store.applyEvent({ op: "UPDATE", profile_id: "p2", domain: "fresh.net", action: "block" });
    expect(store.resolve("p2", "fresh.net")).toBe("block");
  });

  test("applyEvent DELETE removes the rule (and its wildcard reach)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [...rows, { profileId: "p1", domain: "corp.example.com", action: "block" }],
      sourceIps,
      profiles,
    );

    store.applyEvent({ op: "DELETE", profile_id: "p1", domain: "corp.example.com", action: null });
    expect(store.resolve("p1", "corp.example.com")).toBeUndefined();
    expect(store.resolve("p1", "a.corp.example.com")).toBeUndefined();
  });
});
