import { describe, expect, test } from "vitest";

import { decodeArtifact } from "../src/artifact";
import { compileText, redactUrl } from "../src/compile";
import { SuffixFingerprintTable } from "../src/fingerprint";
import { parseList } from "../src/parse";

const HOSTS = [
  "# comment",
  "0.0.0.0 doubleclick.net",
  "0.0.0.0 ads.tracker.example tracker.example",
  "127.0.0.1 localhost",
  "::1 localhost",
].join("\n");

const ABP = [
  "! comment",
  "||ads.example.com^",
  "@@||cdn.example.com^",
  "||collector.github.com^$third-party",
  "example.com##.ad",
].join("\n");

describe("parse", () => {
  test("hosts format dedupes aliases and ignores IPs/localhost", () => {
    const parsed = parseList(HOSTS, "hosts");
    expect([...parsed.blocks].sort()).toEqual([
      "ads.tracker.example",
      "doubleclick.net",
      "tracker.example",
    ]);
  });

  test("abp format handles exceptions and ignores cosmetic rules", () => {
    const parsed = parseList(ABP, "abp");
    expect([...parsed.blocks].sort()).toEqual([
      "ads.example.com",
      "collector.github.com",
    ]);
    expect([...parsed.allows]).toEqual(["cdn.example.com"]);
  });

  test("auto detects abp", () => {
    const parsed = parseList(ABP, "auto");
    expect(parsed.blocks.has("ads.example.com")).toBe(true);
  });
});

describe("compile", () => {
  test("produces a decodable RZA1 artifact", () => {
    const compiled = compileText(HOSTS, { source: "https://example/list.txt" });
    expect(compiled.rules).toBe(3);
    expect(compiled.detectedFormat).toBe("hosts");
    expect(compiled.data.length).toBe(24 + compiled.rules * 8);

    const decoded = decodeArtifact(compiled.data);
    const table = SuffixFingerprintTable.fromArrays(decoded.allow, decoded.block);
    expect(table.resolve("doubleclick.net")).toBe("block");
    expect(table.resolve("x.doubleclick.net")).toBe("block");
    expect(table.resolve("example.com")).toBeUndefined();

    const meta = JSON.parse(compiled.sidecar);
    expect(meta).toMatchObject({
      id: compiled.hash,
      source: "https://example/list.txt",
      rules: 3,
      bytes: compiled.data.length,
      hash: "xxhash64/seed0",
    });
  });

  test("enforces the per-list rule budget", () => {
    expect(() => compileText(HOSTS, { maxEntries: 2 })).toThrow(/budget/);
  });

  test("redacts credentials in logs", () => {
    expect(redactUrl("https://user:pass@example.com/private/list?token=x")).toBe(
      "https://example.com/…",
    );
    expect(redactUrl("not a url")).toBe("<invalid URL>");
  });
});
