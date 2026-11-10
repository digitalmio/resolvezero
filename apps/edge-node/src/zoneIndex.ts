import type { ZoneRecordType, ZoneUpdateEvent } from "@resolvezero/shared";

import type { ZoneAnswer, ZoneEntry, ZoneRow } from "./ruleTypes";

/**
 * Split-horizon local zones, indexed per profile. Exact names and wildcard
 * suffixes keep their own name sets so `hasZoneName` is O(labels), not
 * O(total zones).
 */
export class ZoneIndex {
  private zones = new Map<string, Map<string, ZoneEntry>>();
  private wildcardZones = new Map<string, Map<string, ZoneEntry>>();
  private zoneNames = new Map<string, Set<string>>();
  private wildcardNames = new Map<string, Set<string>>();

  replaceAll(rows: ZoneRow[]): void {
    this.zones.clear();
    this.wildcardZones.clear();
    this.zoneNames.clear();
    this.wildcardNames.clear();
    for (const row of rows) {
      this.apply(row.profileId, row.domain, row.recordType, row.values, row.ttl);
    }
  }

  apply(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
    values: string[],
    ttl: number,
  ): void {
    const wildcard = domain.startsWith("*.");
    const name = (wildcard ? domain.slice(2) : domain).toLowerCase();
    const entry: ZoneEntry = { wildcard, values, ttl };
    const target = wildcard ? this.wildcardZones : this.zones;
    let zones = target.get(profileId);
    if (!zones) {
      zones = new Map();
      target.set(profileId, zones);
    }
    zones.set(`${name}|${recordType}`, entry);
    const names = wildcard ? this.wildcardNames : this.zoneNames;
    let set = names.get(profileId);
    if (!set) {
      set = new Set();
      names.set(profileId, set);
    }
    set.add(name);
  }

  /** Apply a single `zone_updates` NOTIFY event. Idempotent per event. */
  applyEvent(event: ZoneUpdateEvent): void {
    if (event.op === "DELETE" || event.values === null || event.ttl === null) {
      this.delete(event.profile_id, event.domain, event.record_type);
      return;
    }
    this.apply(event.profile_id, event.domain, event.record_type, event.values, event.ttl);
  }

  private delete(profileId: string, domain: string, recordType: ZoneRecordType): void {
    const wildcard = domain.startsWith("*.");
    const name = (wildcard ? domain.slice(2) : domain).toLowerCase();
    (wildcard ? this.wildcardZones : this.zones).get(profileId)?.delete(`${name}|${recordType}`);
  }

  /**
   * Zone override lookup: exact domain first; then `*.` wildcard zones
   * matched suffix-style. CNAME is returned for A/AAAA/TXT misses so local
   * aliases behave like normal DNS.
   */
  resolve(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
  ): ZoneAnswer | undefined {
    const direct = this.find(profileId, domain, recordType);
    if (direct) return direct;
    if (recordType === "CNAME") return undefined;
    return this.find(profileId, domain, "CNAME");
  }

  /** Does this local name exist for any record type? */
  hasName(profileId: string, domain: string): boolean {
    const target = domain.toLowerCase();
    if (this.zoneNames.get(profileId)?.has(target)) return true;
    const wildcards = this.wildcardNames.get(profileId);
    if (!wildcards?.size) return false;
    const labels = target.split(".");
    for (let i = 1; i < labels.length; i += 1) {
      if (wildcards.has(labels.slice(i).join("."))) return true;
    }
    return false;
  }

  private find(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
  ): ZoneAnswer | undefined {
    const exact = this.zones.get(profileId)?.get(`${domain.toLowerCase()}|${recordType}`);
    if (exact) return { values: exact.values, ttl: exact.ttl, recordType };

    const wildcards = this.wildcardZones.get(profileId);
    if (!wildcards?.size) return undefined;
    const labels = domain.toLowerCase().split(".");
    for (let i = 1; i < labels.length; i += 1) {
      const entry = wildcards.get(`${labels.slice(i).join(".")}|${recordType}`);
      if (entry) return { values: entry.values, ttl: entry.ttl, recordType };
    }
    return undefined;
  }

  get stats(): { zones: number; wildcardZones: number } {
    return {
      zones: [...this.zones.values()].reduce((sum, map) => sum + map.size, 0),
      wildcardZones: [...this.wildcardZones.values()].reduce((sum, map) => sum + map.size, 0),
    };
  }
}
