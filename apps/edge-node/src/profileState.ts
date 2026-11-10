import { blockedServiceDomains } from "@resolvezero/db";
import type { SafeSearchSettings } from "@resolvezero/db/schema";

import type {
  BlockedServiceRow,
  ProfileRow,
  RuleAction,
  RuleRow,
  SourceIpRow,
} from "./ruleTypes";
import { DEFAULT_BLOCK_ANSWER, type BlockAnswer, type BlockMode } from "./wire";

export interface ProfileState {
  rules: Map<string, Map<string, RuleAction>>;
  profileTokens: Map<string, string | null>;
  dotIds: Map<string, string>;
  logQueries: Map<string, boolean>;
  profileUpstreams: Map<string, string | null>;
  profileUpstreamUrls: Map<string, string | null>;
  blockAnswers: Map<string, BlockAnswer>;
  safeSearch: Map<string, SafeSearchSettings>;
  authorizedSourceIps: Map<string, string>;
}

/** Build the profile/rule state from a DB snapshot. */
export function buildProfileState(
  ruleRows: RuleRow[],
  sourceIpRows: SourceIpRow[],
  profileRows: ProfileRow[],
  serviceRows: BlockedServiceRow[],
): ProfileState {
  const rules = new Map<string, Map<string, RuleAction>>();
  for (const row of ruleRows) {
    const domain = normalizeRuleDomain(row.domain);
    if (!domain) continue;
    let profile = rules.get(row.profileId);
    if (!profile) {
      profile = new Map();
      rules.set(row.profileId, profile);
    }
    profile.set(domain, row.action);
  }

  const servicesByProfile = new Map<string, string[]>();
  for (const row of serviceRows) {
    const list = servicesByProfile.get(row.profileId) ?? [];
    list.push(row.service);
    servicesByProfile.set(row.profileId, list);
  }
  for (const [profileId, services] of servicesByProfile) {
    let profile = rules.get(profileId);
    if (!profile) {
      profile = new Map();
      rules.set(profileId, profile);
    }
    for (const domain of blockedServiceDomains(services)) {
      if (!profile.has(domain)) profile.set(domain, "block");
    }
  }

  return {
    rules,
    profileTokens: new Map(profileRows.map((p) => [p.id, p.dohToken])),
    dotIds: new Map(
      profileRows
        .filter((p) => typeof p.dotId === "string" && p.dotId.length > 0)
        .map((p) => [p.dotId as string, p.id]),
    ),
    logQueries: new Map(profileRows.map((p) => [p.id, p.logQueries])),
    profileUpstreams: new Map(profileRows.map((p) => [p.id, p.upstream ?? null])),
    profileUpstreamUrls: new Map(profileRows.map((p) => [p.id, p.upstreamUrl ?? null])),
    blockAnswers: new Map(
      profileRows.map((p) => [
        p.id,
        {
          mode: normalizeBlockMode(p.blockMode),
          ipv4: p.blockIpv4 ?? null,
          ipv6: p.blockIpv6 ?? null,
          ttl: p.blockTtl ?? DEFAULT_BLOCK_ANSWER.ttl,
        },
      ]),
    ),
    safeSearch: new Map(profileRows.map((p) => [p.id, p.safeSearch ?? {}])),
    authorizedSourceIps: new Map(sourceIpRows.map((r) => [r.ipAddress, r.profileId])),
  };
}

function normalizeBlockMode(raw: string | null | undefined): BlockMode {
  return raw === "nxdomain" || raw === "refused" || raw === "custom" ? raw : "null";
}

function normalizeRuleDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.+$/, "");
}
