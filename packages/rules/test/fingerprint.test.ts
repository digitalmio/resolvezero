import { describe, expect, test } from "vitest";

import { SuffixFingerprintBuilder } from "../src/fingerprint";

describe("SuffixFingerprintTable semantics", () => {
  const build = () => {
    const builder = new SuffixFingerprintBuilder();
    builder.add("doubleclick.net", "block");
    builder.add("ads.tracker.example", "block");
    builder.add("mail.doubleclick.net", "allow");
    builder.add("disguise.pl", "block");
    builder.add("DoubleClick.net", "block");
    builder.add("collector.github.com", "block");
    return builder.seal();
  };

  test("rules match exactly and below, never the parent", () => {
    const table = build();
    expect(table.resolve("doubleclick.net")).toBe("block");
    expect(table.resolve("ad.doubleclick.net")).toBe("block");
    expect(table.resolve("fakedoubleclick.net")).toBeUndefined();
    expect(table.resolve("collector.github.com")).toBe("block");
    expect(table.resolve("github.com")).toBeUndefined();
  });

  test("allow wins over block", () => {
    const table = build();
    expect(table.resolve("mail.doubleclick.net")).toBe("allow");
    expect(table.resolve("www.mail.doubleclick.net")).toBe("allow");
  });

  test("duplicate and case-collapsed rules are stored once", () => {
    const table = build();
    const { allow, block } = table.artifactTables();
    expect(allow.length).toBe(1);
    expect(block.length).toBe(4);
  });

  test("TLD-only and wildcard rules are ignored", () => {
    const builder = new SuffixFingerprintBuilder();
    builder.add("com", "block");
    builder.add(".invalid", "block");
    builder.add("*.example.com", "block");
    expect(builder.seal().isEmpty).toBe(true);
  });
});
