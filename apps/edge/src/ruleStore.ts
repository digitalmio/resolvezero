import type { RuleUpdateEvent } from "@resolvezero/shared";

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
  /** source ip -> profile_id */
  private authorizedSourceIps = new Map<string, string>();
  /** profile_id -> log opt-out */
  private logQueries = new Map<string, boolean>();

  /** Atomically replace all state with a DB snapshot. */
  replaceAll(
    ruleRows: RuleRow[],
    sourceIpRows: SourceIpRow[],
    profileRows: ProfileRow[],
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
    this.profileTokens = new Map(
      profileRows.map((p) => [p.id, p.dohToken]),
    );
    this.logQueries.clear();
    this.authorizedSourceIps = new Map(
      sourceIpRows.map((r) => [r.ipAddress, r.profileId]),
    );
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

  /** Which profile (if any) does this source IP belong to? */
  authorizeSourceIp(ip: string): string | undefined {
    return this.authorizedSourceIps.get(ip);
  }

  get stats() {
    return {
      profiles: this.rules.size,
      rules: [...this.rules.values()].reduce((n, m) => n + m.size, 0),
      authorizedSourceIps: this.authorizedSourceIps.size,
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
