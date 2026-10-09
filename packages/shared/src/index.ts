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

// Shape of the `ip_updates` NOTIFY payload (notify_ip_change trigger).
export interface IpUpdateEvent {
  op: RuleOp;
  ip_address: string;
  profile_id: string;
}

export function isIpUpdateEvent(value: unknown): value is IpUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.ip_address === "string" &&
    typeof v.profile_id === "string"
  );
}

// Shape of the `zone_updates` NOTIFY payload (notify_zone_change trigger).
export type ZoneRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export interface ZoneUpdateEvent {
  op: RuleOp;
  profile_id: string;
  domain: string; // 'nas.lan' exact | '*.home.example.com' wildcard (suffix)
  record_type: ZoneRecordType;
  values: string[] | null; // null on DELETE
  ttl: number | null;
}

export function isZoneUpdateEvent(value: unknown): value is ZoneUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.profile_id === "string" &&
    typeof v.domain === "string" &&
    typeof v.record_type === "string" &&
    ["A", "AAAA", "CNAME", "TXT"].includes(v.record_type) &&
    (v.values === null || (Array.isArray(v.values) && v.values.every((x) => typeof x === "string"))) &&
    (v.ttl === null || typeof v.ttl === "number")
  );
}
