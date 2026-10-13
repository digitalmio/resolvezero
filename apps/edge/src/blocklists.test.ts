import { describe, expect, test } from "bun:test";
import { fetchListText, parseList } from "./blocklists";
import { RuleStore } from "./ruleStore";
import { SuffixFingerprintBuilder } from "./fingerprint";

describe("parseList", () => {
  test("hosts format (polish-pihole hostfile shape)", () => {
    const text = `# comment
127.0.0.1 localhost
0.0.0.0 ads.example.com
0.0.0.0 sub.tracker.pl # inline note
tracker2.pl
`
        .replace("tracker2.pl", "tracker2.pl");
    const { blocks } = parseList(text, "hosts");
    expect(blocks.has("ads.example.com")).toBeTrue();
    expect(blocks.has("sub.tracker.pl")).toBeTrue();
    expect(blocks.has("tracker2.pl")).toBeTrue();
    expect(blocks.has("localhost")).toBeFalse();
  });

  test("empty file", () => {
    const { blocks, allows } = parseList("", "hosts");
    expect(blocks.size).toBe(0);
    expect(allows.size).toBe(0);
  });

  test("abp: blocks and @@ exceptions split", () => {
    const text = `! title line
||ads.pl^
||cdn.adnet.pl^$third-party
@@||cdn.adnet.pl^
##.advert
||not-a-domain^
`;
    const { blocks, allows } = parseList(text, "abp");
    expect(blocks.has("ads.pl")).toBeTrue();
    // @@ exceptions live in `allows`; resolveRemote applies allow-first
    expect(allows.has("cdn.adnet.pl")).toBeTrue();
    expect(blocks.size).toBe(2); // cosmetics + non-domain rules dropped
  });

  test("invalid domains dropped", () => {
    const { blocks } = parseList(`notadomain\n0.0.0.0 .bad\n0.0.0.0 ok.example.com..`, "hosts");
    expect(blocks.has("notadomain")).toBeFalse();
    expect(blocks.has("bad") || blocks.has(".bad")).toBeFalse();
    expect(blocks.has("ok.example.com")).toBeTrue();
  });
});

describe("RuleStore shared blocklist catalog", () => {
  const tableFrom = (blocks: string[], allows: string[] = []) => {
    const b = new SuffixFingerprintBuilder();
    for (const d of blocks) b.add(d, "block");
    for (const d of allows) b.add(d, "allow");
    return b.seal();
  };

  test("upsertList + setSubscriptions: allow beats block across lists", () => {
    const store = new RuleStore();
    const blockedList = tableFrom(["doubleclick.net"]);
    const allowedList = tableFrom(["mail.doubleclick.net"], ["mail.doubleclick.net"]);
    store.upsertList("https://lists.example/blocked", blockedList);
    store.upsertList("https://lists.example/allow", allowedList);
    // subscription order does NOT matter; allow-tables checked first
    store.setSubscriptions("p1", ["https://lists.example/blocked", "https://lists.example/allow"]);
    expect(store.resolveRemote("p1", "ad.doubleclick.net")).toBe("block");
    expect(store.resolveRemote("p1", "mail.doubleclick.net")).toBe("allow");
    expect(store.resolveRemote("p1", "www.mail.doubleclick.net")).toBe("allow");
    expect(store.resolveRemote("unknown-profile", "ad.doubleclick.net")).toBeUndefined();
    // syntax sanity: ```
  });

  test("catalog dedups: two profiles sharing one list parse/store once", () => {
    const store = new RuleStore();
    const t = tableFrom(["a.com", "b.com"]);
    expect(store.upsertList("https://lists.example/shared", t)).toBeTrue();
    store.setSubscriptions("p1", ["https://lists.example/shared"]);
    // second profile subscribing: no new catalog entry
    store.setSubscriptions("p2", ["https://lists.example/shared"]);
    expect(store.stats.remoteListTables).toBe(1);
    expect(store.stats.remoteListSubscriptions).toBe(2);
    expect(store.resolveRemote("p2", "a.com")).toBe("block");
    // same-content re-upsert doesn't change state's consumed-changed flag
    store.consumeChanged();
    expect(store.upsertList("https://lists.example/shared", tableFrom(["a.com", "b.com"]))).toBeFalse();
    expect(store.consumeChanged()).toBeFalse();
    // changed content does
    expect(store.upsertList("https://lists.example/shared", tableFrom(["a.com", "c.com"]))).toBeTrue();
    expect(store.consumeChanged()).toBeTrue();
  });

  test("GC: catalog entry dropped when no profile subscribes to it", () => {
    const store = new RuleStore();
    store.upsertList("u", tableFrom(["a.com"]));
    store.setSubscriptions("p1", ["u"]);
    store.setSubscriptions("p1", []); // unsubscribed
    expect(store.hasList("u")).toBeFalse();
    expect(store.stats.remoteListTables).toBe(0);
  });

  test("replaceAll prunes subscriptions of dead profiles (roughly), keeps live ones", () => {
    const store = new RuleStore();
    store.upsertList("u", tableFrom(["a.com"]));
    store.setSubscriptions("p1", ["u"]);
    // a DB snapshot without p1 must drop its subscription
    store.replaceAll([], [], [{ id: "other", dohToken: null, logQueries: true, upstream: null }]);
    expect(store.stats.remoteListSubscriptions).toBe(0);
    expect(store.hasList("u")).toBeFalse();
  });
});

describe("fetchListText", () => {
  test("rejects junk urls quickly", async () => {
    await expect(fetchListText("not a url")).rejects.toThrow();
  }, 65_000);
});
