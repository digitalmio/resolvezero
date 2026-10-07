// Shape of the `profile_updates` NOTIFY payload emitted by the
// notify_rule_change() trigger (see readme.md §5).
export type RuleOp = "INSERT" | "UPDATE" | "DELETE";

export interface RuleUpdateEvent {
  op: RuleOp;
  profile_id: string;
  domain: string;
  // NULL on DELETE => the edge must remove the rule.
  action: "block" | "allow" | null;
}

export function isRuleUpdateEvent(value: unknown): value is RuleUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.profile_id === "string" &&
    typeof v.domain === "string" &&
    (v.action === "block" || v.action === "allow" || v.action === null)
  );
}
