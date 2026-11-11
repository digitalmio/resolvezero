import type { IpUpdateEvent, RuleUpdateEvent, ZoneRecordType, ZoneUpdateEvent } from "@resolvezero/shared";
import type { SafeSearchSettings } from "@resolvezero/db/schema";
import { SuffixFingerprintTable, type FingerprintAction } from "./fingerprint";
import { DEFAULT_BLOCK_ANSWER, type BlockAnswer } from "./wire";
import { ZoneIndex } from "./zoneIndex";
import { buildProfileState } from "./profileState";
import { AuthState } from "./authState";
import { DeviceRegistry } from "./deviceRegistry";
import { applyRuleEvent, resolveRule } from "./ruleMatch";
import { RemoteCatalog } from "./remoteCatalog";
import type {
  BlockedServiceRow,
  ListSubscription,
  ProfileRow,
  RemoteResolution,
  RuleAction,
  RuleRow,
  SourceIpRow,
  ZoneAnswer,
  ZoneRow,
} from "./ruleTypes";

/**
 * In-memory rule state for the edge data plane.
 *
 * Backed by plain Maps — rules are a bounded set and must NEVER be
 * evicted (LRU is reserved for the dnsCache; see readme.md §2).
 * Lookups are O(1) exact match plus longest-suffix wildcard match.
 */
export class RuleStore {
  /** profile_id -> (domain -> action) */
  private rules = new Map<string, Map<string, RuleAction>>();
  private auth = new AuthState();
  /** profile_id -> log opt-out (false = do not record queries) */
  private logQueries = new Map<string, boolean>();
  /** source ip -> profile_id */
  private authorizedSourceIps = new Map<string, string>();
  /** profile_id -> upstream selector/custom URL (null = edge default) */
  private profileUpstreams = new Map<string, string | null>();
  /** profile_id -> custom upstream DoH URL (wins over preset selector). */
  private profileUpstreamUrls = new Map<string, string | null>();
  /** profile_id -> how blocked answers are shaped. */
  private blockAnswers = new Map<string, BlockAnswer>();
  /** profile_id -> forced SafeSearch engines. */
  private safeSearch = new Map<string, SafeSearchSettings>();
  private zoneIndex = new ZoneIndex();
  /** Dot hostname label -> profile id. */
  private remote = new RemoteCatalog();

  upsertList(
    url: string,
    table: SuffixFingerprintTable,
    artifactHash: string | null = null,
    source: "artifact" | "raw" = artifactHash ? "artifact" : "raw",
  ): boolean {
    return this.remote.upsertList(url, table, artifactHash, source);
  }

  hasList(url: string): boolean {
    return this.remote.hasList(url);
  }

  consumeChanged(): boolean {
    return this.remote.consumeChanged();
  }

  setSubscriptions(
    profileId: string,
    subscriptions: Array<string | ListSubscription>,
    opts: { prune?: boolean } = {},
  ): boolean {
    return this.remote.setSubscriptions(profileId, subscriptions, opts);
  }

  pruneUnreferencedLists(): void {
    this.remote.pruneUnreferencedLists();
  }

  private devices = new DeviceRegistry();

  /** Atomically replace all state with a DB snapshot. */
  replaceAll(
    ruleRows: RuleRow[],
    sourceIpRows: SourceIpRow[],
    profileRows: ProfileRow[],
    zoneRows: ZoneRow[] = [],
    serviceRows: BlockedServiceRow[] = [],
  ): void {
    const state = buildProfileState(ruleRows, sourceIpRows, profileRows, serviceRows);
    this.rules = state.rules;
    this.auth.replace(state.profileTokens, state.dotIds, state.authorizedSourceIps);
    this.logQueries = state.logQueries;
    this.profileUpstreams = state.profileUpstreams;
    this.profileUpstreamUrls = state.profileUpstreamUrls;
    this.blockAnswers = state.blockAnswers;
    this.safeSearch = state.safeSearch;

    this.zoneIndex.replaceAll(zoneRows);

    // Remote subscriptions are owned by the blocklist sync loop, but stale
    // subscriptions of DELETED profiles must go.
    this.remote.pruneForProfiles(new Set(profileRows.map((p) => p.id)));
  }

  /**
   * DoH auth: profile must exist; token must match when one is configured.
   * Tokens are compared timing-safely against the stored value (stored
   * plaintext for MVP — switch to hash-compare before hosted launch,
   * readme.md §4 DoH token log hygiene).
   */
  hasProfile(profileId: string, token: string | undefined): boolean {
    return this.auth.hasProfile(profileId, token);
  }

  /** Apply a single NOTIFY event from Postgres. Idempotent per event. */
  applyEvent(event: RuleUpdateEvent): void {
    applyRuleEvent(this.rules, event);
  }

  /** Resolve a DoT hostname label to its profile. */
  authorizeDotId(dotId: string): string | undefined {
    return this.auth.authorizeDotId(dotId);
  }

  /** Returns the action if the domain matches profile rules, else undefined. */
  resolve(profileId: string, domain: string): RuleAction | undefined {
    return resolveRule(this.rules, profileId, domain);
  }

  /** Blocked-answer shape for a profile (defaults to the classic sinkhole). */
  blockAnswer(profileId: string): BlockAnswer {
    return this.blockAnswers.get(profileId) ?? DEFAULT_BLOCK_ANSWER;
  }

  /** Forced SafeSearch engines for a profile. */
  safeSearchSettings(profileId: string): SafeSearchSettings {
    return this.safeSearch.get(profileId) ?? {};
  }

  /**
   * Where should this profile's queries be recorded? Default true
   * ("log the lot" is the default, like NextDNS — readme §3 C);
   * false only when the profile explicitly opted out.
   */
  shouldLog(profileId: string): boolean {
    return this.logQueries.get(profileId) ?? true;
  }

  /**
   * Remote blocklist check across the profile's subscribed tables.
   * Allow-tables of ALL lists win first (cross-list ABP `@@` semantics),
   * then block-tables — observable parity with previous merged sets.
   */
  getSubscriptions(profileId: string): ListSubscription[] {
    return this.remote.getSubscriptions(profileId);
  }

  isProfileLoaded(profileId: string, retryMs: number): boolean {
    return this.remote.isProfileLoaded(profileId, retryMs);
  }

  markProfileLoaded(profileId: string, failed: number): void {
    this.remote.markProfileLoaded(profileId, failed);
  }

  clearLoaded(): void {
    this.remote.clearLoaded();
  }

  failedProfiles(): string[] {
    return this.remote.failedProfiles();
  }

  listUpToDate(subscription: ListSubscription): boolean {
    return this.remote.listUpToDate(subscription);
  }

  listEntryCount(url: string): number {
    return this.remote.listEntryCount(url);
  }

  artifactLists(): number {
    return this.remote.artifactLists();
  }

  rawLists(): number {
    return this.remote.rawLists();
  }

  pendingLists(): number {
    return this.remote.pendingLists();
  }

  resolveRemote(profileId: string, domain: string): RuleAction | undefined {
    return this.remote.resolveRemote(profileId, domain);
  }

  resolveRemoteDetailed(profileId: string, domain: string): RemoteResolution | undefined {
    return this.remote.resolveRemoteDetailed(profileId, domain);
  }

  get remoteBlocklistEntryCount(): number {
    return this.remote.remoteBlocklistEntryCount;
  }

  get stats() {
    return {
      profiles: this.rules.size,
      profileCount: this.auth.profileTokens.size,
      rules: [...this.rules.values()].reduce((n, m) => n + m.size, 0),
      authorizedSourceIps: this.authorizedSourceIps.size,
      zones: this.zoneIndex.stats.zones,
      wildcardZones: this.zoneIndex.stats.wildcardZones,
      ...this.remote.stats,
    };
  }

  /** Upstream URL/selector override for this profile, or null for edge default. */
  profileUpstream(profileId: string): string | null {
    // Custom URL wins over the preset selector (readme §2).
    return this.profileUpstreamUrls.get(profileId) ?? this.profileUpstreams.get(profileId) ?? null;
  }

  /** Safe upstream label for logs — never expose a custom URL (may contain a token). */
  profileUpstreamLabel(profileId: string): string {
    const value = this.profileUpstream(profileId);
    if (!value) return "edge-default";
    return value.includes("://") ? "custom" : value;
  }

  // ---- Zone overrides (split-horizon records) ----

  applyZoneEvent(event: ZoneUpdateEvent): void {
    this.zoneIndex.applyEvent(event);
  }

  resolveZone(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
  ): ZoneAnswer | undefined {
    return this.zoneIndex.resolve(profileId, domain, recordType);
  }

  hasZoneName(profileId: string, domain: string): boolean {
    return this.zoneIndex.hasName(profileId, domain);
  }

  /** Which profile (if any) does this source IP belong to? */
  authorizeSourceIp(ip: string): string | undefined {
    return this.auth.authorizeSourceIp(ip);
  }

  /** Apply a single `ip_updates` NOTIFY event (whitelist stays live). */
  applySourceIpEvent(event: IpUpdateEvent): void {
    this.auth.applySourceIpEvent(event);
  }

  /** Does a profile carry a DoH token? (path-shape disambiguation helper) */
  hasToken(profileId: string): boolean {
    return this.auth.hasToken(profileId);
  }

  /** Profiles that still rely on the dev-only token-free mode. */
  tokenlessProfileIds(): string[] {
    return this.auth.tokenlessProfileIds();
  }

  /** Device-seen registry: dedupes lazy device row inserts (hard cap per profile). */
  applyDeviceSeen(profileId: string, device: string): boolean {
    return this.devices.apply(profileId, device);
  }

  /** True at most once per interval, so `last_seen_at` refreshes hourly. */
  deviceRefreshDue(profileId: string, device: string, intervalMs: number): boolean {
    return this.devices.refreshDue(profileId, device, intervalMs);
  }
}

export type * from "./ruleTypes";
