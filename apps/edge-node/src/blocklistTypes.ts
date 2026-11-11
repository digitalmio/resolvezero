import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";

export interface BlocklistDeps {
  store: RuleStore;
  dnsCache: DnsCache;
}

export interface BlocklistStatus {
  lastSyncAt: number | null;
  lastError: string | null;
  /** URLs that failed or are waiting for an artifact in the latest load. */
  failedUrls: string[];
  /** URLs skipped because the profile's rule budget was exceeded. */
  quotaSkipped: number;
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


