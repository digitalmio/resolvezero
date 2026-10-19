import { ofetch as $fetch } from "ofetch";

/**
 * Upstream DoH presets (readme §2). Verified against Bun's fetch:
 *  - cloudflare/google speak HTTP/2 **or** 1.1 → both return 200 over h1.
 *  - quad9 505s HTTP/1.1 ("requires HTTP/2", RFC 8484 §5.2) — legitimate
 *    preset, but verify h2 negotiation from the deploy target before
 *    making it the default. Cloudflare is the default preset for that reason.
 */
export const UPSTREAM_PRESETS = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  google: "https://dns.google/dns-query",
  quad9: "https://dns.quad9.net/dns-query",
} as const;

export type UpstreamPreset = keyof typeof UPSTREAM_PRESETS;

const ENV_URL = process.env.UPSTREAM_DOH_URL;
const ENV_PRESET = process.env.UPSTREAM_PRESET as UpstreamPreset | undefined;

/** Edge default: preset/env over rid. */
export function defaultUpstreamUrl(): string {
  if (ENV_URL) return ENV_URL;
  if (ENV_PRESET && Object.hasOwn(UPSTREAM_PRESETS, ENV_PRESET)) return UPSTREAM_PRESETS[ENV_PRESET as UpstreamPreset];
  return UPSTREAM_PRESETS.cloudflare;
}

export interface UpstreamResult {
  /** Backed by a dedicated ArrayBuffer (TS5.7 generics; BodyInit-safe). */
  wire: Uint8Array<ArrayBuffer>;
  rttMs: number;
}

/**
 * Forwards a DNS wire-format query to a DoH upstream.
 * `upstreamUrl` is chosen per profile (preset name, absolute URL, or the
 * edge default). Self-hosters can point it anywhere — e.g. a local
 * Unbound DoH listener (readme §2, 1-line/env change).
 *
 * Fail fast (no retries — the client stub resolver owns retransmission);
 * SERVFAIL upstream is NOT cached (only healthy responses enter the LRU).
 */
export async function resolveWire(
  wire: Uint8Array,
  upstreamUrl?: string,
): Promise<UpstreamResult> {
  const url = upstreamUrl ?? defaultUpstreamUrl();
  const finalUrl = Object.hasOwn(UPSTREAM_PRESETS, url)
    ? UPSTREAM_PRESETS[url as UpstreamPreset]
    : url;
  assertSafeUpstreamUrl(finalUrl);

  const startedAt = performance.now();
  const response = await $fetch.raw(finalUrl, {
    method: "POST",
    headers: { "content-type": "application/dns-message" },
    body: Buffer.from(wire),
    // doh responses are application/dns-message — ofetch would otherwise
    // hand us text; force the raw buffer through.
    responseType: "arrayBuffer" as never,
    retry: 0,
    timeout: 2500,
  });
  const rttMs = Math.round(performance.now() - startedAt);
  if (!response._data) {
    throw new Error("empty upstream response");
  }
  return { wire: new Uint8Array(response._data as ArrayBuffer) as Uint8Array<ArrayBuffer>, rttMs };
}

/** Blocks metadata endpoints + credentialed URLs on custom upstreams.
 *  Presets are allowlisted above; self-host private hosts remain allowed
 *  (Unbound use-case) unless STRICT_UPSTREAM_SSRF=1. */
function assertSafeUpstreamUrl(finalUrl: string): void {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    throw new Error("invalid upstream URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("upstream must be http(s)");
  if (u.username || u.password) throw new Error("upstream URL must not embed credentials");
  const host = u.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error("upstream host blocked");
  }
  if (process.env.STRICT_UPSTREAM_SSRF === "1" && isPrivateHost(host)) {
    throw new Error("private upstream blocked");
  }
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}
