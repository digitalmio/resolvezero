import { LRUCache } from "lru-cache";
import { decode, type Packet } from "dns-packet";

/**
 * LRU cache for upstream DNS responses — the ONLY evictable state
 * (readme.md §2: policies must never be evicted, this must always evict).
 * Keyed by question (name|type), profile-agnostic: DNS answers don't vary
 * by profile since only allowed (un-blocked) queries reach the upstream.
 * RCODE-0/3 only; upstream network failures and SERVFAIL are not cached.
 * ttlMs: min TTL across answers+authorities from the upstream response
 * (includes negative/SOA TTLs for NXDOMAIN), capped at 24h.
 */
export class DnsCache {
  private cache = new LRUCache<string, Uint8Array>({
    max: 100_000,
    maxSize: 50 * 1024 * 1024,
    sizeCalculation(v) {
      return v.length;
    },
  });

  get(wire: Uint8Array): Uint8Array | undefined {
    const key = questionKey(wire);
    if (!key) return undefined;
    const cached = this.cache.get(key);
    // patch in the client's transaction id before returning
    return cached ? withTransactionId(cached, wire) : undefined;
  }

  set(wire: Uint8Array): void {
    const key = questionKey(wire);
    const packet = safeDecode(wire);
    if (!key || !packet) return;

    const rcode = (packet.flags ?? 0) & 0x000f;
    if (rcode !== 0 && rcode !== 3) return; // only NOERROR / NXDOMAIN

    const ttl = minTtl(packet);
    if (ttl <= 0) return;
    this.cache.set(key, wire, { ttl: Math.min(ttl, 86_400_000) });
  }

  get stats() {
    return {
      entries: this.cache.size,
      maxSize: this.cache.max,
    };
  }
}

function questionKey(wire: Uint8Array): string | undefined {
  const packet = safeDecode(wire);
  const q = packet?.questions?.[0];
  if (!q) return undefined;
  return `${q.name.toLowerCase()}|${q.type}`;
}

function safeDecode(wire: Uint8Array): Packet | undefined {
  try {
    return decode(Buffer.from(wire));
  } catch {
    return undefined;
  }
}

function minTtl(packet: Packet): number {
  const answers = (packet.answers ?? []) as { ttl?: number }[];
  const authorities = (packet.authorities ?? []) as { ttl?: number }[];
  let min = Infinity;
  for (const record of [...answers, ...authorities]) {
    if (typeof record.ttl === "number" && record.ttl < min) {
      min = record.ttl;
    }
  }
  if (min === Infinity) return 0;
  return min * 1000;
}

function withTransactionId(source: Uint8Array, query: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source);
  copy[0] = query[0];
  copy[1] = query[1];
  return copy;
}
