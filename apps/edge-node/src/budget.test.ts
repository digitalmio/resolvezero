import { describe, expect, test } from "vitest";

import { fitsBudget } from "./budget";

describe("fitsBudget", () => {
  test("replacing a stale table does not count it twice", () => {
    // 440k resident includes a 207k stale table; replacing it with 207k stays 440k.
    expect(fitsBudget(440_000, 207_000, 207_000, 500_000)).toBe(true);
  });

  test("adding a new table counts against the resident total", () => {
    expect(fitsBudget(440_000, 0, 60_000, 500_000)).toBe(true);
    expect(fitsBudget(440_000, 0, 61_000, 500_000)).toBe(false);
  });

  test("absent old tables are treated as zero", () => {
    expect(fitsBudget(0, 0, 500_000, 500_000)).toBe(true);
    expect(fitsBudget(0, 0, 500_001, 500_000)).toBe(false);
  });
});
