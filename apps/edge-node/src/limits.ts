/**
 * Small, dependency-free resource controls for the edge.
 *
 * These are intentionally process-local: they bound work on one PoP, while
 * per-tenant/config limits live in the database. Keep them cheap enough for the
 * DNS hot path — no timers, no async, no unbounded maps.
 */

import { isIP } from "node:net";

export interface RateLimiter {
  (key: string): boolean;
}

/** Collapse IPv6 to /64 so rotating addresses cannot grow the key map. */
function rateKey(raw: string): string {
  if (isIP(raw) !== 6) return raw;
  const [head, tail] = raw.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail.split(":");
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g || "0").join(":")}::`;
}

/** Fixed-window limiter with a hard key cap so hostile keys can't grow memory. */
export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (raw: string): boolean => {
    const key = rateKey(raw);
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now > cur.resetAt) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) {
          if (now > v.resetAt) hits.delete(k);
        }
        // Never clear the whole map: that would reset every tenant's window
        // and let a key flood bypass the limiter. Reject new keys instead.
        if (hits.size >= maxKeys) return false;
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= limit;
  };
}

/** Bounded in-flight work counter. */
export class Semaphore {
  private active = 0;

  constructor(readonly capacity: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.capacity) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  get inFlight(): number {
    return this.active;
  }
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
