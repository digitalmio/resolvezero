import { LRUCache } from "lru-cache";
import { decode, type Packet } from "dns-packet";

/**
 * LRU cache for upstream DNS responses — the ONLY evictable state
 * (readme.md §2: policies must never be evicted, this must always evict).
 * Keyed by question (name|type|class) + upstream: DNS answers vary by
 * provider, so per-profile upstreams must not share entries.
 * RCODE-0/3 only; upstream network failures and SERVFAIL are not cached.
 *
 * TTL policy (filtering-resolver style, not a plain forwarder):
 *  - Positive answers: min TTL across answers+authorities, capped at
 *    MAX_POSITIVE_TTL_MS (5 min default). Short cap = fast control when
 *    records or policy change; warm DoH is ~2ms so re-fetch is cheap.
 *  - Empty NOERROR (NODATA) and NXDOMAIN: cached at most
 *    MAX_NEGATIVE_TTL_MS (60s). A transient upstream NODATA must never
 *    hide a real record for 30 min (howmuchpermile.co.uk apex-A incident).
 */
const MAX_POSITIVE_TTL_MS = 5 * 60_000;
const MAX_NEGATIVE_TTL_MS = 60_000;
export class DnsCache {
  private cache = new LRUCache<string, Uint8Array<ArrayBuffer>>({
    max: 100_000,
    maxSize: 50 * 1024 * 1024,
    sizeCalculation(v) {
      return v.length;
    },
  });

  get(wire: Uint8Array, upstream?: string | null): Uint8Array<ArrayBuffer> | undefined {
    const key = questionKey(wire, upstream);
    if (!key) return undefined;
    const cached = this.cache.get(key);
    // patch in the client's transaction id before returning
    return cached ? withTransactionId(cached, wire) : undefined;
  }

  set(wire: Uint8Array<ArrayBuffer>, upstream?: string | null): void {
    const key = questionKey(wire, upstream);
    const packet = safeDecode(wire);
    if (!key || !packet) return;

    const rcode = (packet.flags ?? 0) & 0x000f;
    if (rcode !== 0 && rcode !== 3) return; // only NOERROR / NXDOMAIN

    const ttl = minTtl(packet);
    if (ttl <= 0) return;
    const negative = rcode === 3 || (packet.answers ?? []).length === 0;
    const cap = negative ? MAX_NEGATIVE_TTL_MS : MAX_POSITIVE_TTL_MS;
    this.cache.set(key, wire, { ttl: Math.min(ttl, cap) });
  }

  /** Drop every cached upstream answer (blocklist refresh may change policy). */
  clear(): void {
    this.cache.clear();
  }

  get stats() {
    return {
      entries: this.cache.size,
      maxSize: this.cache.max,
    };
  }
}

function questionKey(wire: Uint8Array, upstream?: string | null): string | undefined {
  const packet = safeDecode(wire);
  const q = packet?.questions?.[0];
  if (!q) return undefined;
  const name = q.name.toLowerCase().replace(/\.+$/, "");
  const cls = (q as { class?: string }).class ?? "IN";
  return `${name}|${q.type}|${cls}|${upstream ?? "default"}`;
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

function withTransactionId(
  source: Uint8Array<ArrayBuffer>,
  query: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(source.length);
  copy.set(source);
  copy[0] = query[0]!;
  copy[1] = query[1]!;
  return copy;
}
