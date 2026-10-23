import { and, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";
import { moduleLogger } from "./logger";
import { SuffixFingerprintBuilder } from "./fingerprint";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";
import { fetchWithSafeRedirects } from "./netGuard";
import { readTextBounded } from "./body";

const log = moduleLogger("blocklists");

/** Hard cap per list (bytes) — protects edge memory from runaway sources. */
const MAX_LIST_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

export interface BlocklistDeps {
  store: RuleStore;
  dnsCache: DnsCache;
}

export interface BlocklistRow {
  id: string;
  profileId: string;
  url: string;
  format: string;
}

export interface ParsedList {
  blocks: Set<string>;
  allows: Set<string>;
}

export interface BlocklistStatus {
  lastSyncAt: number | null;
  lastError: string | null;
  /** URLs that failed in the most recent cycle (served from previous table). */
  failedUrls: string[];
}

export interface BlocklistSyncHandle {
  /** Debounced NOTIFY-driven re-sync (3s). */
  syncNow(): Promise<void>;
  /** Boot-time synchronous cycle — callers await this before serving DNS. */
  initialSync(): Promise<void>;
  stop(): void;
  status(): BlocklistStatus;
}

/**
 * Fetches + parses remote blocklists and swaps them into the RuleStore.
 * NOTIFY-driven (DB trigger) + interval refresh; failures keep previous sets.
 */
export function startBlocklistSync(deps: BlocklistDeps): BlocklistSyncHandle {
  const intervalHours = Number(process.env.LIST_SYNC_INTERVAL_HOURS ?? 6);
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  let needsResync = false;
  let pending: Promise<void> | undefined;
  let lastSyncAt: number | null = null;
  let lastError: string | null = null;
  let failedUrls: string[] = [];

  const sync = async () => {
    if (syncing) {
      // A NOTIFY arrived mid-fetch: run once more after the current cycle
      // instead of silently dropping it until the 6-hour interval.
      needsResync = true;
      return;
    }
    syncing = true;
    const cycleFailed: string[] = [];
    let cycleError: string | null = null;
    try {
      const rows = (await db
        .select({
          id: profileBlocklists.id,
          profileId: profileBlocklists.profileId,
          url: profileBlocklists.url,
          format: profileBlocklists.format,
        })
        .from(profileBlocklists)
        .where(eq(profileBlocklists.enabled, true))) as BlocklistRow[];

      // Shared-catalog model: parse each unique URL ONCE per cycle, register
      // it in the store's catalog, then wire per-profile subscriptions.
      const uniqueUrls = new Map<string, { url: string; format: string }>();
      const enabledByProfile = new Map<string, BlocklistRow[]>();
      for (const row of rows) {
        uniqueUrls.set(row.url, { url: row.url, format: row.format });
        enabledByProfile.set(row.profileId, enabledByProfile.get(row.profileId) ?? []);
        enabledByProfile.get(row.profileId)!.push(row);
      }

      // 1) catalog refresh — each URL fetched + parsed once.
      // SEQUENTIAL on purpose: parse+build peak-allocates tens of MB per
      // big list (raw text + string sets + fp arrays); running them in
      // parallel OOM'd the 256MB VMs at boot (multiplied transients).
      let cacheFlushed = false;
      for (const { url, format } of [...uniqueUrls.values()]) {
        try {
          const text = await fetchListText(url);
          const parsed = parseList(text, format);
          const builder = new SuffixFingerprintBuilder();
          for (const d of parsed.blocks) builder.add(d, "block");
          for (const d of parsed.allows) builder.add(d, "allow");
          const entryCount = parsed.blocks.size + parsed.allows.size;
          const table = builder.seal(entryCount);
          const changed = deps.store.upsertList(url, table);
          if (changed) cacheFlushed = true; // flush flag handled below
          log.info({ url, entries: table.entryCount, changed }, "list parsed");
          // statuses per row that reference this URL
          for (const profileRowGroups of enabledByProfile.values()) {
            for (const row of profileRowGroups) {
              if (row.url === url) {
                await writeStatus(row.id, "ok", table.entryCount).catch((err) =>
                  log.warn({ err, url }, "blocklist status write failed"),
                );
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          cycleFailed.push(url);
          log.warn({ url, err: msg }, "list fetch failed — keeping previous table");
          for (const profileRowGroups of enabledByProfile.values()) {
            for (const row of profileRowGroups) {
              if (row.url === url) {
                await writeStatus(row.id, `error: ${msg.slice(0, 42)}`, 0).catch((statusErr) =>
                  log.warn({ err: statusErr, url }, "blocklist status write failed"),
                );
              }
            }
          }
          // the subscription wiring below drops URLs with no table only
          // when the catalog ALSO lacks one (crash-reboot case) — a
          // previously-good table remains in force until de-listed.
        }
      }
      const fetchedAnyChanged = cacheFlushed;

      // 2) wiring — subscriptions for every profile (urls whose table exists).
      //    Defer pruning until all profiles are wired: a profile with a subset
      //    of lists must not delete tables another profile still references.
      for (const [profileId, rowsForProfile] of enabledByProfile) {
        const urls = [...new Set(rowsForProfile.map((r) => r.url))].filter((url) =>
          deps.store.hasList(url),
        );
        const changed = deps.store.setSubscriptions(profileId, urls, { prune: false });
        if (changed && !fetchedAnyChanged) log.info({ profileId, urls: urls.length }, "subscriptions rewired");
      }
      deps.store.pruneUnreferencedLists();
      if (deps.store.consumeChanged()) {
        deps.dnsCache.clear();
        log.info("blocklist state changed — dns cache flushed");
      }
    } catch (err) {
      cycleError = err instanceof Error ? err.message : String(err);
      log.error({ err }, "blocklist sync cycle failed");
    } finally {
      failedUrls = cycleFailed;
      lastError = cycleError ?? (failedUrls.length > 0 ? `${failedUrls.length} list(s) failed` : null);
      lastSyncAt = Date.now();
      syncing = false;
      if (needsResync) {
        needsResync = false;
        void sync();
      }
    }
  };

  const syncNow = (): Promise<void> => {
    // trailing debounce — bursty NOTIFYs (multi-row writes) coalesce
    if (pending) return pending;
    pending = new Promise<void>((resolve) => {
      const t = setTimeout(async () => {
        pending = undefined;
        await sync();
        resolve();
      }, 3_000);
      t.unref?.();
    });
    return pending;
  };

  if (intervalHours > 0) {
    // Jitter ±10% so fra/lhr don't hammer the same list hosts in lockstep.
    const jitterMs = intervalHours * 3600_000 * (0.9 + Math.random() * 0.2);
    timer = setInterval(() => void sync(), jitterMs);
    timer.unref?.();
  }

  return {
    syncNow,
    async initialSync() {
      if (syncing) {
        needsResync = true;
        return;
      }
      await sync();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    status() {
      return { lastSyncAt, lastError, failedUrls: [...failedUrls] };
    },
  };
}

async function writeStatus(id: string, status: string, count: number): Promise<void> {
  await db
    .update(profileBlocklists)
    .set({ lastSyncedAt: new Date(), lastStatus: status, entryCount: count })
    .where(and(eq(profileBlocklists.id, id)));
}

/**
 * Fetch a raw list file (any text format) with timeout + size cap.
 * Throws with a short human-readable reason (goes into last_status).
 * SSRF guard: https-only, no private/metadata hosts, and every redirect
 * hop is re-validated (no https → metadata redirect).
 */
export async function fetchListText(url: string): Promise<string> {
  const { response: res } = await fetchWithSafeRedirects(
    url,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "resolvezero-edge/0.1" },
    },
    { protocols: ["https:"], label: "list URL" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  return readTextBounded(res.body, MAX_LIST_BYTES, len);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/;
const PUNCT_HOSTS_RE = /^[\s#&+|!'"]*$/;

export function parseList(text: string, format: string): ParsedList {
  const blocks = new Set<string>();
  const allows = new Set<string>();
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("//")) continue;
    if (format === "abp") {
      // @@||host^  → allow  |  ||host^  → block. Cosmetic/CSS selectors ignored.
      if (line.startsWith("@@||")) {
        const d = extractAbpDomain(line);
        if (d) allows.add(d);
      } else {
        const d = extractAbpDomain(line);
        if (d) blocks.add(d);
      }
      continue;
    }
    // strip inline comments after the first `#` (hosts + domains formats)
    const noComment = line.split("#")[0].trim();
    const tokens = noComment.split(/\s+/).filter(Boolean);
    // Hosts lines pack aliases ("0.0.0.0 a.com b.com") — every name token
    // counts, not just the last. Skip IP literals themselves.
    for (const candidate of tokens) {
      const domain = candidate.replace(/\.+$/, "");
      if (!domain) continue;
      if (isIpLiteral(domain)) continue;
      // hosts files use bare "localhost" alias lines; ignore punct garbage
      if (domain === "localhost" || PUNCT_HOSTS_RE.test(domain) || domain.length < 3) continue;
      if (!DOMAIN_RE.test(domain) || !domain.includes(".")) continue;
      blocks.add(domain);
    }
  }
  return { blocks, allows };
}

/** `||ads.example.com^$third-party` → `ads.example.com`; `@@||host^` handled by caller. */
function extractAbpDomain(rule: string): string | undefined {
  const m = rule.replace(/^@@\|\|/, "||").match(/^\|\|([a-z0-9.-]+)(\^\S*)?$/);
  if (!m) return undefined;
  const d = m[1].replace(/\*+/g, "");
  if (!d.includes(".") || !DOMAIN_RE.test(d)) return undefined;
  return d;
}

function isIpLiteral(s: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;
  if (s.includes(":")) return /^[0-9a-f:]+$/i.test(s);
  return false;
}
