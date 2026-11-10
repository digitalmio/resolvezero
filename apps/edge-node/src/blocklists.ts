import { moduleLogger } from "./logger";
import { SuffixFingerprintBuilder, type SuffixFingerprintTable } from "./fingerprint";
import { fetchListText, loadArtifactTable, parseList, resolveListFormat } from "./listSource";
import { markStatus } from "./listStatus";
import { createGate } from "./gate";
import { createS3ClientFromEnv, type S3ClientLike } from "./sinks/s3";
import type { RuleStore } from "./ruleStore";
import { syncBlocklistMetadata } from "./blocklistMetadata";
import type { DnsCache } from "./dnsCache";
import { positiveInt } from "./limits";

const log = moduleLogger("blocklists");

const MAX_LISTS_PER_PROFILE = positiveInt(process.env.BLOCKLIST_MAX_LISTS_PER_PROFILE, 64);
const MAX_TOTAL_ENTRIES = positiveInt(process.env.BLOCKLIST_MAX_TOTAL_ENTRIES, 5_000_000);
const MAX_ENTRIES_PER_PROFILE = positiveInt(
  process.env.BLOCKLIST_MAX_ENTRIES_PER_PROFILE,
  1_500_000,
);
const CYCLE_DEADLINE_MS = positiveInt(process.env.BLOCKLIST_CYCLE_DEADLINE_MS, 180_000);
const RETRY_MS = positiveInt(process.env.BLOCKLIST_LAZY_RETRY_SECONDS, 60) * 1000;
/** Hosted default: never parse raw text; wait for the compiler artifact. */
const ARTIFACT_ONLY = process.env.ARTIFACT_ONLY_LISTS === "1";

export interface BlocklistDeps {
  store: RuleStore;
  dnsCache: DnsCache;
}

export interface BlocklistStatus {
  lastSyncAt: number | null;
  lastError: string | null;
  /** URLs that failed or are waiting for an artifact in the latest load. */
  failedUrls: string[];
}

export interface BlocklistSyncHandle {
  /** Metadata-only re-sync (debounced). Does not fetch list content. */
  syncNow(): Promise<void>;
  /** Boot-time metadata sync — lists load lazily on first query. */
  initialSync(): Promise<void>;
  /** Fetch only this profile's missing artifacts (single-flight, gated). */
  ensureProfileLoaded(profileId: string): Promise<void>;
  stop(): void;
  status(): BlocklistStatus;
}


/**
 * Shared-catalog, per-profile lazy loading:
 *   1. metadata sync wires every profile's subscriptions (no S3 fetch)
 *   2. the first query for a profile loads only its missing artifacts
 *   3. a blocklist watermark move clears the lazy markers; the next query
 *      reloads that profile
 *
 * This mirrors the Rust edge's `lazy.rs` and keeps an idle PoP at zero list
 * tables.
 */
export function startBlocklistSync(deps: BlocklistDeps): BlocklistSyncHandle {
  const intervalHours = Number(process.env.LIST_SYNC_INTERVAL_HOURS ?? 6);
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  let needsResync = false;
  let pending: Promise<void> | undefined;
  let lastSyncAt: number | null = null;
  let lastError: string | null = null;
  const failedByProfile = new Map<string, Set<string>>();
  const loadingProfiles = new Map<string, Promise<void>>();
  let gate: Promise<unknown> = Promise.resolve();

  const sync = async () => {
    if (syncing) {
      needsResync = true;
      return;
    }
    syncing = true;
    try {
      const active = await syncBlocklistMetadata(deps.store, MAX_LISTS_PER_PROFILE);
      // Drop failures for profiles/lists that are no longer subscribed.
      for (const profileId of [...failedByProfile.keys()]) {
        const urls = active.get(profileId);
        if (!urls) {
          failedByProfile.delete(profileId);
          continue;
        }
        for (const url of [...failedByProfile.get(profileId)!]) {
          if (!urls.has(url)) failedByProfile.get(profileId)!.delete(url);
        }
      }
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.error({ err }, "blocklist metadata sync failed");
    } finally {
      lastSyncAt = Date.now();
      syncing = false;
      if (needsResync) {
        needsResync = false;
        void sync();
      }
    }
  };

  const syncNow = (): Promise<void> => {
    // Trailing debounce — bursty NOTIFYs (multi-row writes) coalesce.
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

  const withGate = createGate();

  const recordFailure = (profileId: string, url: string): void => {
    let urls = failedByProfile.get(profileId);
    if (!urls) {
      urls = new Set();
      failedByProfile.set(profileId, urls);
    }
    urls.add(url);
  };

  const clearFailure = (profileId: string, url: string): void => {
    const urls = failedByProfile.get(profileId);
    if (!urls) return;
    urls.delete(url);
    if (urls.size === 0) failedByProfile.delete(profileId);
  };

  const ensureProfileLoaded = async (profileId: string): Promise<void> => {
    if (deps.store.isProfileLoaded(profileId, RETRY_MS)) return;
    const existing = loadingProfiles.get(profileId);
    if (existing) return existing;

    const work = withGate(async () => {
      if (deps.store.isProfileLoaded(profileId, RETRY_MS)) return;
      const subscriptions = deps.store.getSubscriptions(profileId);
      if (subscriptions.length === 0) {
        deps.store.markProfileLoaded(profileId, 0);
        return;
      }

      const artifactStore = createS3ClientFromEnv();
      const deadline = Date.now() + CYCLE_DEADLINE_MS;
      let failed = 0;
      let pendingArtifacts = 0;
      let profileEntries = subscriptions.reduce(
        (sum, sub) =>
          sum + (deps.store.listUpToDate(sub) ? deps.store.listEntryCount(sub.url) : 0),
        0,
      );

      for (const subscription of subscriptions) {
        if (deps.store.listUpToDate(subscription)) continue;
        if (Date.now() > deadline) {
          failed += 1;
          recordFailure(profileId, subscription.url);
          await markStatus(subscription, "error: cycle deadline exceeded", 0);
          continue;
        }
        if (ARTIFACT_ONLY && !subscription.artifactHash) {
          pendingArtifacts += 1;
          continue;
        }

        try {
          let table: SuffixFingerprintTable;
          let source: "artifact" | "raw";
          let detectedFormat: string | undefined;
          if (subscription.artifactHash && artifactStore) {
            table = await loadArtifactTable(artifactStore, subscription.artifactHash);
            source = "artifact";
          } else {
            if (ARTIFACT_ONLY) {
              pendingArtifacts += 1;
              continue;
            }
            const text = await fetchListText(subscription.url);
            detectedFormat = resolveListFormat(text, "auto");
            const parsed = parseList(text, detectedFormat);
            const builder = new SuffixFingerprintBuilder();
            for (const domain of parsed.blocks) builder.add(domain, "block");
            for (const domain of parsed.allows) builder.add(domain, "allow");
            table = builder.seal(parsed.blocks.size + parsed.allows.size);
            source = "raw";
          }

          if (profileEntries + table.entryCount > MAX_ENTRIES_PER_PROFILE) {
            throw new Error(
              `per-profile rule budget exceeded (${profileEntries + table.entryCount} > ${MAX_ENTRIES_PER_PROFILE})`,
            );
          }
          if (deps.store.remoteBlocklistEntryCount + table.entryCount > MAX_TOTAL_ENTRIES) {
            throw new Error(
              `global rule budget exceeded (${deps.store.remoteBlocklistEntryCount + table.entryCount} > ${MAX_TOTAL_ENTRIES})`,
            );
          }
          profileEntries += table.entryCount;
          deps.store.upsertList(
            subscription.url,
            table,
            subscription.artifactHash ?? null,
            source,
          );
          clearFailure(profileId, subscription.url);
          await markStatus(subscription, "ok", table.entryCount, detectedFormat);
          log.info(
            {
              profileId,
              url: subscription.url,
              entries: table.entryCount,
              artifact: source === "artifact",
            },
            "lazy list loaded",
          );
        } catch (err) {
          failed += 1;
          recordFailure(profileId, subscription.url);
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ profileId, url: subscription.url, err: message }, "lazy list load failed");
          await markStatus(subscription, `error: ${message.slice(0, 42)}`, 0);
        }
      }

      deps.store.markProfileLoaded(profileId, failed + pendingArtifacts);
      if (deps.store.consumeChanged()) deps.dnsCache.clear();
    });

    loadingProfiles.set(profileId, work);
    try {
      await work;
    } finally {
      loadingProfiles.delete(profileId);
    }
  };

  if (intervalHours > 0) {
    // Jitter ±10% so fra/lhr don't hit the same list hosts in lockstep.
    const jitterMs = intervalHours * 3600_000 * (0.9 + Math.random() * 0.2);
    timer = setInterval(() => void sync(), jitterMs);
    timer.unref?.();
  }

  return {
    syncNow,
    async initialSync() {
      await sync();
    },
    ensureProfileLoaded,
    stop() {
      if (timer) clearInterval(timer);
    },
    status() {
      const failedUrls = new Set<string>();
      for (const urls of failedByProfile.values()) {
        for (const url of urls) failedUrls.add(url);
      }
      return { lastSyncAt, lastError, failedUrls: [...failedUrls] };
    },
  };
}


export { detectFormat, fetchListText, parseList, resolveListFormat } from "./listSource";
