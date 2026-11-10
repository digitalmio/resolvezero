/** Device-tag registry with a hard per-profile cap and hourly refreshes. */
export class DeviceRegistry {
  private seen = new Map<string, Set<string>>();
  private lastSeen = new Map<string, Map<string, number>>();

  apply(profileId: string, device: string): boolean {
    let set = this.seen.get(profileId);
    if (!set) {
      set = new Set();
      this.seen.set(profileId, set);
    }
    if (set.has(device)) return false;
    // Never evict-and-continue: one leaked token must not create unbounded
    // profile_devices rows.
    if (set.size >= 200) return false;
    set.add(device);
    let touches = this.lastSeen.get(profileId);
    if (!touches) {
      touches = new Map();
      this.lastSeen.set(profileId, touches);
    }
    touches.set(device, Date.now());
    return true;
  }

  /** True at most once per interval, so `last_seen_at` refreshes hourly. */
  refreshDue(profileId: string, device: string, intervalMs: number): boolean {
    const touches = this.lastSeen.get(profileId);
    const last = touches?.get(device);
    if (!touches || last == null) return false;
    if (Date.now() - last < intervalMs) return false;
    touches.set(device, Date.now());
    return true;
  }
}
