import type { SuffixFingerprintTable } from "./fingerprint";
import type { ListSubscription, RemoteResolution, RuleAction } from "./ruleTypes";

interface CatalogEntry {
  table: SuffixFingerprintTable;
  entryCount: number;
  fingerprint: string;
  artifactHash: string | null;
  source: "artifact" | "raw";
}

/**
 * Shared per-URL remote-list catalog and per-profile subscription wiring.
 * Memory follows the list, not the user; lazy-load markers live here too.
 */
export class RemoteCatalog {
  private listCatalog = new Map<string, CatalogEntry>();
  private subscriptions = new Map<string, ListSubscription[]>();
  private loadedProfiles = new Map<string, { at: number; failed: number }>();
  private changedSinceConsume = false;

  upsertList(
    url: string,
    table: SuffixFingerprintTable,
    artifactHash: string | null = null,
    source: "artifact" | "raw" = artifactHash ? "artifact" : "raw",
  ): boolean {
    const prev = this.listCatalog.get(url);
    const changed = prev?.fingerprint !== table.fingerprint;
    this.listCatalog.set(url, {
      table,
      entryCount: table.entryCount,
      fingerprint: table.fingerprint,
      artifactHash,
      source,
    });
    this.markChanged(changed);
    return changed;
  }

  hasList(url: string): boolean {
    return this.listCatalog.has(url);
  }

  consumeChanged(): boolean {
    const value = this.changedSinceConsume;
    this.changedSinceConsume = false;
    return value;
  }

  private markChanged(value: boolean): void {
    this.changedSinceConsume ||= value;
  }

  setSubscriptions(
    profileId: string,
    subscriptions: Array<string | ListSubscription>,
    opts: { prune?: boolean } = {},
  ): boolean {
    const normalized = subscriptions.map((item) =>
      typeof item === "string" ? { url: item } : item,
    );
    const prev = (this.subscriptions.get(profileId) ?? [])
      .map((s) => `${s.url}|${s.listId ?? ""}`)
      .join("|");
    const next = normalized.map((s) => `${s.url}|${s.listId ?? ""}`).join("|");
    this.subscriptions.set(profileId, normalized);
    if (prev !== next) this.loadedProfiles.delete(profileId);
    if (opts.prune !== false) this.pruneCatalog();
    this.markChanged(prev !== next);
    return prev !== next;
  }

  pruneUnreferencedLists(): void {
    this.pruneCatalog();
  }

  /** Drop subscriptions + catalog entries for profiles no longer present. */
  pruneForProfiles(alive: Set<string>): void {
    let pruned = false;
    for (const profileId of this.subscriptions.keys()) {
      if (!alive.has(profileId)) {
        this.subscriptions.delete(profileId);
        this.loadedProfiles.delete(profileId);
        pruned = true;
      }
    }
    if (pruned) this.pruneCatalog();
  }

  private pruneCatalog(): void {
    if (this.listCatalog.size === 0) return;
    const referenced = new Set<string>();
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) referenced.add(subscription.url);
    }
    for (const url of this.listCatalog.keys()) {
      if (!referenced.has(url)) this.listCatalog.delete(url);
    }
  }

  getSubscriptions(profileId: string): ListSubscription[] {
    return [...(this.subscriptions.get(profileId) ?? [])];
  }

  isProfileLoaded(profileId: string, retryMs: number): boolean {
    const load = this.loadedProfiles.get(profileId);
    if (!load) return false;
    return load.failed === 0 || Date.now() - load.at < retryMs;
  }

  markProfileLoaded(profileId: string, failed: number): void {
    this.loadedProfiles.set(profileId, { at: Date.now(), failed });
  }

  clearLoaded(): void {
    this.loadedProfiles.clear();
  }

  listUpToDate(subscription: ListSubscription): boolean {
    const entry = this.listCatalog.get(subscription.url);
    if (!entry) return false;
    return entry.artifactHash === (subscription.artifactHash ?? null);
  }

  listEntryCount(url: string): number {
    return this.listCatalog.get(url)?.entryCount ?? 0;
  }

  artifactLists(): number {
    return [...this.listCatalog.values()].filter((entry) => entry.source === "artifact").length;
  }

  rawLists(): number {
    return [...this.listCatalog.values()].filter((entry) => entry.source === "raw").length;
  }

  pendingLists(): number {
    const pending = new Set<string>();
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) {
        if (!this.listUpToDate(subscription)) pending.add(subscription.url);
      }
    }
    return pending.size;
  }

  resolveRemote(profileId: string, domain: string): RuleAction | undefined {
    return this.resolveRemoteDetailed(profileId, domain)?.action;
  }

  resolveRemoteDetailed(profileId: string, domain: string): RemoteResolution | undefined {
    const subscriptions = this.subscriptions.get(profileId);
    if (!subscriptions?.length) return undefined;
    for (const subscription of subscriptions) {
      const entry = this.listCatalog.get(subscription.url);
      if (!entry) continue;
      if (entry.table.checkAllow(domain)) {
        return { action: "allow", listId: subscription.listId };
      }
    }
    for (const subscription of subscriptions) {
      const entry = this.listCatalog.get(subscription.url);
      if (!entry) continue;
      if (entry.table.checkBlock(domain)) {
        return { action: "block", listId: subscription.listId };
      }
    }
    return undefined;
  }

  get remoteBlocklistEntryCount(): number {
    return [...this.listCatalog.values()].reduce((n, e) => n + e.entryCount, 0);
  }

  get stats() {
    return {
      remoteListTables: this.listCatalog.size,
      remoteListSubscriptions: this.subscriptions.size,
      artifactLists: this.artifactLists(),
      rawLists: this.rawLists(),
      pendingLists: this.pendingLists(),
    };
  }
}
