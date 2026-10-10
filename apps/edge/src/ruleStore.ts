import type { IpUpdateEvent, RuleUpdateEvent, ZoneRecordType, ZoneUpdateEvent } from "@resolvezero/shared";

export type RuleAction = "block" | "allow";

export interface RuleRow {
  profileId: string;
  domain: string;
  action: RuleAction;
}

export interface SourceIpRow {
  ipAddress: string;
  profileId: string;
}

export interface ProfileRow {
  id: string;
  dohToken: string | null;
  logQueries: boolean;
  /** Upstream selector ('cloudflare' | 'google' | 'quad9' | …) or custom URL. */
  upstream: string | null;
}

export interface ZoneEntry {
  /** '*' when authored as '*.' (suffix wildcard), else exact-match. */
  wildcard: boolean;
  values: string[];
  ttl: number;
}

export interface ZoneRow {
  profileId: string;
  domain: string;
  recordType: ZoneRecordType;
  values: string[];
  ttl: number;
}

export interface ZoneAnswer {
  values: string[];
  ttl: number;
  recordType: ZoneRecordType;
}

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
  /** profile_id -> configured DoH token (null = id-only auth) */
  private profileTokens = new Map<string, string | null>();
  /** profile_id -> log opt-out (false = do not record queries) */
  private logQueries = new Map<string, boolean>();
  /** source ip -> profile_id */
  private authorizedSourceIps = new Map<string, string>();
  /** profile_id -> upstream selector/custom URL (null = edge default) */
  private profileUpstreams = new Map<string, string | null>();
  /** profile_id -> `${domain}|${type}` -> entry (EXACT domain zones) */
  private zones = new Map<string, Map<string, ZoneEntry>>();
  /** profile_id -> `${suffix}|${type}` -> entry (from '*.' wildcard zones) */
  private wildcardZones = new Map<string, Map<string, ZoneEntry>>();
  /** profile_id -> remote blocklist domain sets (parsed from subscribed URLs). */
  private remoteBlocks = new Map<string, Set<string>>();
  /** profile_id -> remote allowlist domains (blocklist `@@` exceptions; win first). */
  private remoteAllows = new Map<string, Set<string>>();
  /** profile_id -> set of device slugs seen (dedupe for lazy DB write-behind). */
  private seenDevices = new Map<string, Set<string>>();

  /**
   * Atomically replace the parsed remote blocklists for a profile and
   * report whether anything changed (callers flush the DNS cache only
   * on real changes).
   */
  setRemoteBlocklists(profileId: string, blocks: Set<string>, allows: Set<string>): boolean {
    const fingerprint = (s: Set<string>) => {
      let h = s.size;
      for (const d of s) {
        for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) | 0;
      }
      return h;
    };
    const prev = `${fingerprint(this.remoteBlocks.get(profileId) ?? new Set())}/${fingerprint(this.remoteAllows.get(profileId) ?? new Set())}`;
    const next = `${fingerprint(blocks)}/${fingerprint(allows)}`;
    this.remoteBlocks.set(profileId, blocks);
    this.remoteAllows.set(profileId, allows);
    return prev !== next;
  }

  /** Atomically replace all state with a DB snapshot. */
  replaceAll(
    ruleRows: RuleRow[],
    sourceIpRows: SourceIpRow[],
    profileRows: ProfileRow[],
    zoneRows: ZoneRow[] = [],
  ): void {
    const rules = new Map<string, Map<string, RuleAction>>();
    for (const row of ruleRows) {
      let profile = rules.get(row.profileId);
      if (!profile) {
        profile = new Map();
        rules.set(row.profileId, profile);
      }
      profile.set(row.domain, row.action);
    }
    this.rules = rules;

    this.profileTokens = new Map(profileRows.map((p) => [p.id, p.dohToken]));
    this.logQueries = new Map(profileRows.map((p) => [p.id, p.logQueries]));
    this.profileUpstreams = new Map(profileRows.map((p) => [p.id, p.upstream ?? null]));
    this.authorizedSourceIps = new Map(
      sourceIpRows.map((r) => [r.ipAddress, r.profileId]),
    );

    this.zones = new Map();
    this.wildcardZones = new Map();
    for (const row of zoneRows) {
      this.applyZone(row.profileId, row.domain, row.recordType, row.values, row.ttl);
    }
  }

  /**
   * DoH auth: profile must exist; token must match when one is configured.
   * Tokens are compared timing-safely against the stored value (stored
   * plaintext for MVP — switch to hash-compare before hosted launch,
   * readme.md §4 DoH token log hygiene).
   */
  hasProfile(profileId: string, token: string | undefined): boolean {
    if (!/^[0-9a-f-]{12,64}$/i.test(profileId)) return false;
    const stored = this.profileTokens.get(profileId);
    if (stored === undefined) return false; // no such profile
    if (stored === null) return true; // id-only auth
    if (!token) return false; // token required
    return constantTimeEquals(token, stored);
  }

  /** Apply a single NOTIFY event from Postgres. Idempotent per event. */
  applyEvent(event: RuleUpdateEvent): void {
    if (event.op === "DELETE" || event.action === null) {
      this.rules.get(event.profile_id)?.delete(event.domain);
      return;
    }
    let profile = this.rules.get(event.profile_id);
    if (!profile) {
      profile = new Map();
      this.rules.set(event.profile_id, profile);
    }
    profile.set(event.domain, event.action);
  }

  /** Returns the action if the domain matches profile rules, else undefined.
   *  O(domain depth): a rule stored as "corp.example.com" matches the query
   *  domain and any subdomain of it ("*.corp.example.com"). */
  resolve(profileId: string, domain: string): RuleAction | undefined {
    const profile = this.rules.get(profileId);
    if (!profile) return undefined;

    const exact = profile.get(domain);
    if (exact) return exact;

    const labels = domain.split(".");
    for (let i = 1; i < labels.length; i++) {
      const action = profile.get(labels.slice(i).join("."));
      if (action) return action;
    }
    return undefined;
  }

  /**
   * Remote blocklist check (label-boundary suffix match). `@@` exceptions
   * from ABP sources win over their own list's blocks — but explicit
   * profile_rules are resolved separately in doh.ts (user config > remote).
   * Returns the effective action or undefined.
   */
  resolveRemote(profileId: string, domain: string): RuleAction | undefined {
    const allows = this.remoteAllows.get(profileId);
    if (allows && matchesSuffixSet(allows, domain)) return "allow";
    const blocks = this.remoteBlocks.get(profileId);
    if (blocks && matchesSuffixSet(blocks, domain)) return "block";
    return undefined;
  }

  get remoteBlocklistEntryCount(): number {
    return (
      [...this.remoteBlocks.values()].reduce((n, s) => n + s.size, 0) +
      [...this.remoteAllows.values()].reduce((n, s) => n + s.size, 0)
    );
  }

  /**
   * Where should this profile's queries be recorded? Default true
   * ("log the lot" is the default, like NextDNS — readme §3 C);
   * false only when the profile explicitly opted out.
   */
  shouldLog(profileId: string): boolean {
    return this.logQueries.get(profileId) ?? true;
  }

  /** Upstream URL/selector override for this profile, or null for edge default. */
  profileUpstream(profileId: string): string | null {
    return this.profileUpstreams.get(profileId) ?? null;
  }

  // ---- Zone overrides (split-horizon records) ----

  private applyZone(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
    values: string[],
    ttl: number,
  ): void {
    const wildcard = domain.startsWith("*.");
    const name = wildcard ? domain.slice(2).toLowerCase() : domain.toLowerCase();
    const entry: ZoneEntry = { wildcard, values, ttl };
    const target = wildcard ? this.wildcardZones : this.zones;
    let zones = target.get(profileId);
    if (!zones) {
      zones = new Map();
      target.set(profileId, zones);
    }
    zones.set(`${name}|${recordType}`, entry);
  }

  /** Apply a single `zone_updates` NOTIFY event. Idempotent per event. */
  applyZoneEvent(event: ZoneUpdateEvent): void {
    if (event.op === "DELETE" || event.values === null || event.ttl === null) {
      this.deleteZone(event.profile_id, event.domain, event.record_type);
      return;
    }
    this.applyZone(event.profile_id, event.domain, event.record_type, event.values, event.ttl);
  }

  private deleteZone(profileId: string, domain: string, recordType: ZoneRecordType): void {
    const wildcard = domain.startsWith("*.");
    const d = wildcard ? domain.slice(2).toLowerCase() : domain.toLowerCase();
    (wildcard ? this.wildcardZones : this.zones).get(profileId)?.delete(`${d}|${recordType}`);
  }

  /**
   * Zone override lookup: exact domain first; then `*.` wildcard zones
   * matched suffix-style (a wildcard "*.home.example.com" TXT matches
   * "print.home.example.com" but not "home.example.com" itself — authored
   * explicitly if needed). Zone hits short-circuit BEFORE policy/upstream.
   */
  resolveZone(profileId: string, domain: string, recordType: ZoneRecordType): ZoneAnswer | undefined {
    const exact = this.zones.get(profileId)?.get(`${domain.toLowerCase()}|${recordType}`);
    if (exact) {
      return { values: exact.values, ttl: exact.ttl, recordType };
    }

    const wildcards = this.wildcardZones.get(profileId);
    if (wildcards?.size) {
      const labels = domain.toLowerCase().split(".");
      for (let i = 1; i < labels.length; i++) {
        const entry = wildcards.get(`${labels.slice(i).join(".")}|${recordType}`);
        if (entry) return { values: entry.values, ttl: entry.ttl, recordType };
      }
    }
    return undefined;
  }

  /** Which profile (if any) does this source IP belong to? */
  authorizeSourceIp(ip: string): string | undefined {
    return this.authorizedSourceIps.get(ip);
  }

  /** Apply a single `ip_updates` NOTIFY event (whitelist stays live). */
  applySourceIpEvent(event: IpUpdateEvent): void {
    if (event.op === "DELETE") {
      this.authorizedSourceIps.delete(event.ip_address);
      return;
    }
    this.authorizedSourceIps.set(event.ip_address, event.profile_id);
  }

  /** Does a profile carry a DoH token? (path-shape disambiguation helper) */
  hasToken(profileId: string): boolean {
    const stored = this.profileTokens.get(profileId);
    return stored !== undefined && stored !== null;
  }

  /** Device-seen registry: dedupes lazy device row inserts.
   *  Unbounded by design (device slugs, per user call); revisit with quotas. */
  applyDeviceSeen(profileId: string, device: string): boolean {
    let set = this.seenDevices.get(profileId);
    if (!set) {
      set = new Set();
      this.seenDevices.set(profileId, set);
    }
    if (set.has(device)) return false;
    set.add(device);
    return true;
  }

  get stats() {
    return {
      profiles: this.rules.size,
      rules: [...this.rules.values()].reduce((n, m) => n + m.size, 0),
      authorizedSourceIps: this.authorizedSourceIps.size,
      zones: [...this.zones.values()].reduce((n, m) => n + m.size, 0),
      wildcardZones: [...this.wildcardZones.values()].reduce((n, m) => n + m.size, 0),
    };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Exact match or any-suffix (label-boundary safe) for remote list domains. */
function matchesSuffixSet(set: Set<string>, domain: string): boolean {
  if (set.has(domain)) return true;
  const labels = domain.split(".");
  for (let i = 1; i < labels.length; i++) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
