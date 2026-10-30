import { describe, expect, test } from "vitest";

import { normalizeSettingsInput } from "./settings";

const base = { upstream: null, upstreamUrl: null, logQueries: true, logRetentionDays: 30 };

describe("normalizeSettingsInput", () => {
  test("accepts the defaults", () => {
    expect(normalizeSettingsInput(base)).toEqual(base);
  });

  test("accepts presets case-insensitively and maps empty to null", () => {
    expect(normalizeSettingsInput({ ...base, upstream: "Cloudflare" }).upstream).toBe("cloudflare");
    expect(normalizeSettingsInput({ ...base, upstream: "" }).upstream).toBeNull();
    expect(normalizeSettingsInput({ ...base, upstream: "default" }).upstream).toBeNull();
  });

  test("rejects unknown presets", () => {
    expect(() => normalizeSettingsInput({ ...base, upstream: "opendns" })).toThrow(/one of cloudflare/);
  });

  test("accepts https custom upstreams and normalises empty to null", () => {
    expect(
      normalizeSettingsInput({ ...base, upstreamUrl: "https://dns.example.com/dns-query" }).upstreamUrl,
    ).toBe("https://dns.example.com/dns-query");
    expect(normalizeSettingsInput({ ...base, upstreamUrl: "   " }).upstreamUrl).toBeNull();
  });

  test("rejects non-https, relative, and credentialed upstream URLs", () => {
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: "http://dns.example.com" })).toThrow(/https/);
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: "dns.example.com" })).toThrow(/full https/);
    expect(() =>
      normalizeSettingsInput({ ...base, upstreamUrl: "https://user:pass@dns.example.com" }),
    ).toThrow(/credentials/);
  });

  test("rejects upstream URLs longer than 255 characters", () => {
    const long = `https://example.com/${"a".repeat(300)}`;
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: long })).toThrow(/255/);
  });

  test("validates retention bounds and whole numbers", () => {
    expect(normalizeSettingsInput({ ...base, logRetentionDays: 1 }).logRetentionDays).toBe(1);
    expect(normalizeSettingsInput({ ...base, logRetentionDays: 365 }).logRetentionDays).toBe(365);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 0 })).toThrow(/between 1 and 365/);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 366 })).toThrow(/between 1 and 365/);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 1.5 })).toThrow(/whole number/);
  });

  test("requires an explicit logQueries boolean", () => {
    expect(() => normalizeSettingsInput({ ...base, logQueries: "yes" })).toThrow(/true or false/);
    expect(() => normalizeSettingsInput({ ...base, logQueries: undefined })).toThrow();
  });
});
