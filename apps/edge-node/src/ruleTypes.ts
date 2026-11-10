import type { ZoneRecordType } from "@resolvezero/shared";
import type { SafeSearchSettings } from "@resolvezero/db/schema";

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
  /** Lowercase label for `<dot_id>.dot.resolvezero.com` (DoT). */
  dotId?: string | null;
  dohToken: string | null;
  logQueries: boolean;
  /** Upstream selector ('cloudflare' | 'google' | 'quad9' | …) or custom URL. */
  upstream: string | null;
  /** Custom upstream DoH URL — wins over `upstream` preset when set. */
  upstreamUrl?: string | null;
  /** Blocked-answer shape for this profile. */
  blockMode?: string | null;
  blockIpv4?: string | null;
  blockIpv6?: string | null;
  blockTtl?: number | null;
  /** SafeSearch engines forced for this profile. */
  safeSearch?: SafeSearchSettings | null;
}

/** A service the profile blocks wholesale (catalog lives in @resolvezero/db). */
export interface BlockedServiceRow {
  profileId: string;
  service: string;
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

/** One enabled remote-list subscription for a profile. */
export interface ListSubscription {
  url: string;
  /** `profile_blocklists.id` for log attribution (IDs never contain secrets). */
  listId?: string;
  /** Content-addressed artifact currently expected for this URL. */
  artifactHash?: string | null;
}

export interface RemoteResolution {
  action: RuleAction;
  /** Present when the match came from a subscribed remote list. */
  listId?: string;
}

