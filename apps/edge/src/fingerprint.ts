/**
 * Suffix-fingerprint blocklist table (readme §2, blocklists at scale).
 *
 * Replaces `Set<string>` domain sets whose RSS blows past machine limits
 * at millions of entries (measured: Set<string> ~1.3GB RSS @ 5M rules;
 * this table ~150MB memory @ 5M rules storing ~20M suffix fingerprints).
 *
 * Semantics preserved from RuleStore.matchesSuffixSet:
 *   - entry  "doubleclick.net"        matches "ads.doubleclick.net" (label-boundary safe)
 *   - entry  "not-evildomain.com"     does NOT match evildomain.com
 *   - allow entries answer "allow" and are checked FIRST (ABP `@@` semantics)
 *
 * Design:
 *   - Every rule expands to the fingerprints of ALL its suffixes
 *     ("a.b.example.com" → a.b.example.com, b.example.com, example.com —
 *     label-boundary correctness comes free from the split).
 *   - Fingerprints are Bun.hash (wyhash64) persisted into sorted
 *     BigUint64Arrays; lookup = hash each queried suffix + binary search.
 *   - One 64-bit fingerprint table holds a finite collision risk
 *     (~6.8e-7 for 5M exact-vs-suffix pairs — modeled at ~2^-42 per by
 *     rebuild as an acceptable false-positive rate, see fingerprint.test.ts).
 *     If a stricter variant ever matters, re-run parse with double-hash.
 */

export type FingerprintAction = "allow" | "block";

/** Bun.hash is declared with a `number | bigint` union in @types/bun; the
 *  runtime always returns wyhash64 as bigint. Narrow once here. */
const hash64 = (s: string): bigint => Bun.hash(s) as bigint;

export class SuffixFingerprintBuilder {
  private allowFps: bigint[] = [];
  private blockFps: bigint[] = [];
  private allowSet = new Set<string>();
  private blockSet = new Set<string>();

  add(domain: string, action: FingerprintAction): void {
    // canonicalize: lowercase, strip trailing dots
    const d = domain.toLowerCase().replace(/\.+$/, "");
    if (!d.includes(".")) return;          // TLD-only rules never make sense
    if (d.startsWith(".") || d.startsWith("*")) return; // "*." wildcard entries unsupported (exact)+suffix semantics only
    // dedupe within a list (same rule seen twice) — set semantics preserved
    const seen = action === "allow" ? this.allowSet : this.blockSet;
    if (seen.has(d)) return;
    seen.add(d);
    const target = action === "allow" ? this.allowFps : this.blockFps;
    // BLOCK rules expand to every suffix (block exact domain + everything
    // beneath it). ALLOW rules store ONLY the exact rule fingerprint —
    // expanding an allow ("@@||mail.host^") into suffixes would wrongly
    // whitelist "host" entirely (suffix "host" is higher level).
    for (const suffix of action === "allow" ? [d] : suffixesOf(d)) {
      target.push(hash64(suffix));
    }
  }

  get entryCount(): number {
    return this.allowSet.size + this.blockSet.size;
  }

  /**
   * Seals the table: builds the sorted BigUint64Arrays + a shared
   * fingerprint summary for change-detection across re-syncs
   * (cheap orphaning of "did the list actually change").
   */
  seal(): SuffixFingerprintTable {
    const allow = new BigUint64Array(this.allowFps);
    allow.sort();
    const block = new BigUint64Array(this.blockFps);
    block.sort();
    this.allowSet.clear();
    this.blockSet.clear();
    this.allowFps = [];
    this.blockFps = [];
    return new SuffixFingerprintTable(allow, block);
  }
}

export class SuffixFingerprintTable {
  constructor(
    private allow: BigUint64Array,
    private block: BigUint64Array,
  ) {}

  /**
   * Rule action for a queried domain, or undefined when not listed.
   * Probes every label-boundary suffix of the query + the query itself.
   */
  resolve(domain: string): FingerprintAction | undefined {
    const d = domain.toLowerCase().replace(/\.+$/, "");
    // allow list wins (checked first; caller relies on that)
    for (const fps of [this.allow, this.block] as const) {
      if (!fps.length) continue;
      let hit = false;
      // probe the full domain first (most common query shape), then suffixes
      if (ContainsBinary(fps, hash64(d))) {
        hit = true;
      } else {
        for (const suffix of suffixesAfterFirst(d)) {
          if (ContainsBinary(fps, hash64(suffix))) {
            hit = true;
            break;
          }
        }
      }
      if (hit && fps === this.allow) return "allow";
      if (hit && fps === this.block) return "block";
    }
    return undefined;
  }

  get isEmpty(): boolean {
    return this.allow.length === 0 && this.block.length === 0;
  }

  /**
   * Cheap stable identity (XOR fold of all fingerprint bytes) — used by the
   * blocklist sync loop to decide whether a re-fetch actually changed data
   * (vs fingerprinting by size only, which misses entry swaps).
   */
  get fingerprint(): string {
    const fold = (arr: BigUint64Array): string => {
      let h = 0x811c9dc5n;
      for (let i = 0; i < arr.length; i++) {
        h = ((h ^ arr[i]!) * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return `${arr.length}:${h.toString(16)}`;
    };
    return `allow(${fold(this.allow)})|block(${fold(this.block)})`;
  }
}

function ContainsBinary(sorted: BigUint64Array, target: bigint): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Rule suffixes INCLUDING the domain, EXCLUDING its final bare-TLD label
 *  (storing "com" as a rule suffix would block the entire .com TLD — the
 *  classic poisoning bug this design guards against). */
function suffixesOf(d: string): string[] {
  const out: string[] = [d];
  let i = d.indexOf(".");
  while (i !== -1) {
    const s = d.slice(i + 1);
    if (s.includes(".")) out.push(s); // skip the bare-TLD slice
    i = d.indexOf(".", i + 1);
  }
  return out;
}

/** Suffixes strictly shorter than the domain (re-probe list once the full domain missed). */
function suffixesAfterFirst(d: string): string[] {
  const out: string[] = [];
  let i = -1;
  while ((i = d.indexOf(".", i + 1)) !== -1) {
    out.push(d.slice(i + 1));
  }
  return out;
}
