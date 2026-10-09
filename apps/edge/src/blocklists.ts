import { and, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";
import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";

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

/**
 * Fetches + parses remote blocklists and swaps them into the RuleStore.
 * NOTIFY-driven (DB trigger) + interval refresh; failures keep previous sets.
 */
export function startBlocklistSync(deps: BlocklistDeps): { syncNow(): Promise<void>; stop(): void } {
  const intervalHours = Number(process.env.LIST_SYNC_INTERVAL_HOURS ?? 6);
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  let pending: Promise<void> | undefined;

  const BOOT_SYNC_DELAY_MS = 5_000;
  const bootKick = setTimeout(() => void syncNow(), BOOT_SYNC_DELAY_MS);

  const sync = async () => {
    if (syncing) return;
    syncing = true;
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

      // Group by profile — one swap per profile (atomic setRemoteBlocklists).
      const perProfile = new Map<string, { rows: BlocklistRow[] }>();
      for (const row of rows) {
        perProfile.set(row.profileId, perProfile.get(row.profileId) ?? { rows: [] });
        perProfile.get(row.profileId)!.rows.push(row);
      }

      let cacheFlushed = false;
      for (const [profileId, group] of perProfile) {
        const merged: ParsedList = { blocks: new Set(), allows: new Set() };
        await Promise.all(
          group.rows.map(async (row) => {
            try {
              const parsed = await fetchListText(row.url).then((t) => parseList(t, row.format));
              for (const d of parsed.blocks) merged.blocks.add(d);
              for (const d of parsed.allows) merged.allows.add(d);
              await writeStatus(row.id, "ok", parsed.blocks.size + parsed.allows.size).catch(() => {});
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn({ url: row.url, err: msg }, "list fetch failed — keeping previous");
              await writeStatus(row.id, `error: ${msg.slice(0, 42)}`, 0).catch(() => {});
              // keep previous behavior: don't add anything; merged stays valid
            }
          }),
        );
        const changed = deps.store.setRemoteBlocklists(profileId, merged.blocks, merged.allows);
        if (!cacheFlushed && changed) {
          deps.dnsCache.clear();
          cacheFlushed = true;
        }
        log.info(
          { profileId, entries: merged.blocks.size + merged.allows.size, changed },
          "blocklists synced",
        );
      }
    } catch (err) {
      log.error({ err }, "blocklist sync cycle failed");
    } finally {
      syncing = false;
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
    timer = setInterval(() => void sync(), intervalHours * 3600_000);
    timer.unref?.();
  }

  return {
    syncNow,
    stop() {
      clearTimeout(bootKick);
      if (timer) clearInterval(timer);
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
 */
export async function fetchListText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "resolvezero-edge/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_LIST_BYTES) throw new Error(`too large: ${len}B`);
  const text = await res.text();
  if (text.length > MAX_LIST_BYTES) throw new Error(`too large: ${text.length}B`);
  return text;
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
    const candidate = tokens[tokens.length - 1] ?? "";
    const domain = candidate.replace(/\.+$/, "");
    if (!domain) continue;
    // hosts files use bare "localhost" alias lines; ignore punct garbage
    if (domain === "localhost" || PUNCT_HOSTS_RE.test(domain) || domain.length < 3) continue;
    if (!DOMAIN_RE.test(domain) || !domain.includes(".")) continue;
    blocks.add(domain);
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
