import { describe, expect, test } from "bun:test";
import { fetchListText, parseList } from "./blocklists";
import { RuleStore } from "./ruleStore";

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

describe("RuleStore remote sets", () => {
  test("resolveRemote: allow beats block, suffix wildcards", () => {
    const store = new RuleStore();
    expect(store.setRemoteBlocklists("p1", new Set(["doubleclick.net"]), new Set(["mail.doubleclick.net"]))).toBeTrue();
    expect(store.resolveRemote("p1", "ad.doubleclick.net")).toBe("block");
    expect(store.resolveRemote("p1", "mail.doubleclick.net")).toBe("allow");
    expect(store.resolveRemote("p1", "unrelated.net")).toBeUndefined();
    expect(store.resolveRemote("unknown-profile", "ad.doubleclick.net")).toBeUndefined();
  });

  test("setRemoteBlocklists change detection", () => {
    const store = new RuleStore();
    store.setRemoteBlocklists("p1", new Set(["a.com"]), new Set());
    expect(store.setRemoteBlocklists("p1", new Set(["a.com"]), new Set())).toBeFalse();
    expect(store.setRemoteBlocklists("p1", new Set(["a.com", "b.com"]), new Set())).toBeTrue();
  });
});

describe("fetchListText", () => {
  test("rejects junk urls quickly", async () => {
    await expect(fetchListText("not a url")).rejects.toThrow();
  }, 65_000);
});
