import { describe, expect, test } from "vitest";

import { SuffixFingerprintBuilder } from "./fingerprint";
import { RuleStore } from "./ruleStore";

function table(blocks: string[]) {
  const builder = new SuffixFingerprintBuilder();
  for (const domain of blocks) builder.add(domain, "block");
  return builder.seal();
}

describe("lazy profile loading markers", () => {
  test("subscriptions stay pending until the exact artifact is present", () => {
    const store = new RuleStore();
    store.setSubscriptions("p1", [{ url: "https://lists/a", artifactHash: "hash-a" }]);
    expect(store.stats.pendingLists).toBe(1);

    store.upsertList("https://lists/a", table(["ads.example"]), "old-hash", "artifact");
    expect(store.stats.pendingLists).toBe(1);

    store.upsertList("https://lists/a", table(["ads.example"]), "hash-a", "artifact");
    expect(store.stats.pendingLists).toBe(0);
    expect(store.stats.artifactLists).toBe(1);
    expect(store.stats.rawLists).toBe(0);
  });

  test("failed loads enter a retry backoff; success clears it", () => {
    const store = new RuleStore();
    store.markProfileLoaded("p1", 1);
    expect(store.isProfileLoaded("p1", 60_000)).toBe(true);
    expect(store.isProfileLoaded("p1", 0)).toBe(false);

    store.markProfileLoaded("p1", 0);
    expect(store.isProfileLoaded("p1", 0)).toBe(true);
    store.clearLoaded();
    expect(store.isProfileLoaded("p1", 60_000)).toBe(false);
  });

  test("rewiring subscriptions drops the lazy marker", () => {
    const store = new RuleStore();
    store.setSubscriptions("p1", [{ url: "https://lists/a", artifactHash: "a" }]);
    store.markProfileLoaded("p1", 0);
    expect(store.isProfileLoaded("p1", 0)).toBe(true);

    store.setSubscriptions("p1", [{ url: "https://lists/b", artifactHash: "b" }]);
    expect(store.isProfileLoaded("p1", 0)).toBe(false);
  });

  test("an idle store has no list tables", () => {
    const store = new RuleStore();
    expect(store.stats.artifactLists).toBe(0);
    expect(store.stats.rawLists).toBe(0);
    expect(store.stats.pendingLists).toBe(0);
    expect(store.remoteBlocklistEntryCount).toBe(0);
  });
});
