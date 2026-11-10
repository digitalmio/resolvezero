import { describe, expect, test } from "vitest";

import { isStale } from "../src/schedule";

describe("isStale", () => {
  test("missing artifact or timestamp is stale", () => {
    expect(isStale({ artifactHash: null, compiledAt: null }, 1000, 3600)).toBe(true);
    expect(isStale({ artifactHash: "abc", compiledAt: null }, 1000, 3600)).toBe(true);
  });

  test("fresh artifact is not stale", () => {
    expect(isStale({ artifactHash: "abc", compiledAt: 1000 }, 2000, 3600)).toBe(false);
  });

  test("old artifact is stale", () => {
    expect(isStale({ artifactHash: "abc", compiledAt: 1000 }, 5000, 3600)).toBe(true);
  });

  test("force always wins", () => {
    expect(isStale({ artifactHash: "abc", compiledAt: 1000 }, 1001, 3600, true)).toBe(true);
  });
});
