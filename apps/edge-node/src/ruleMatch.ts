import type { RuleUpdateEvent } from "@resolvezero/shared";

import type { RuleAction } from "./ruleTypes";

export function normalizeRuleDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.+$/, "");
}

/** Explicit rule lookup: exact name plus every parent suffix. */
export function resolveRule(
  rules: Map<string, Map<string, RuleAction>>,
  profileId: string,
  domain: string,
): RuleAction | undefined {
  const profile = rules.get(profileId);
  if (!profile) return undefined;
  const normalized = normalizeRuleDomain(domain);
  if (!normalized) return undefined;
  const exact = profile.get(normalized);
  if (exact) return exact;

  const labels = normalized.split(".");
  for (let i = 1; i < labels.length; i += 1) {
    const action = profile.get(labels.slice(i).join("."));
    if (action) return action;
  }
  return undefined;
}

/** Apply a single `rule_updates` NOTIFY event (idempotent per event). */
export function applyRuleEvent(
  rules: Map<string, Map<string, RuleAction>>,
  event: RuleUpdateEvent,
): void {
  const domain = normalizeRuleDomain(event.domain);
  if (!domain) return;
  if (event.op === "DELETE" || event.action === null) {
    rules.get(event.profile_id)?.delete(domain);
    return;
  }
  let profile = rules.get(event.profile_id);
  if (!profile) {
    profile = new Map();
    rules.set(event.profile_id, profile);
  }
  profile.set(domain, event.action);
}
