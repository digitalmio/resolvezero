import { allowPrivateTargets, fetchWithSafeRedirects } from "./netGuard";

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

/** DNS responses are small; anything bigger is a broken/malicious upstream. */
const MAX_UPSTREAM_BYTES = 65_535;
const UPSTREAM_TIMEOUT_MS = 2_500;

/**
 * Forwards a DNS wire-format query to a DoH upstream.
 * `upstreamUrl` is chosen per profile (preset name, absolute URL, or the
 * edge default). Custom URLs are SSRF-checked (redirects re-validated,
 * private targets denied unless ALLOW_PRIVATE_TARGETS=1 for self-hosting).
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

  const startedAt = performance.now();
  const { response } = await fetchWithSafeRedirects(
    finalUrl,
    {
      method: "POST",
      headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
      body: Buffer.from(wire),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    { label: "upstream", allowPrivate: allowPrivateTargets() },
  );
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0) throw new Error("empty upstream response");
  if (body.length > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
  const rttMs = Math.round(performance.now() - startedAt);
  return { wire: body as Uint8Array<ArrayBuffer>, rttMs };
}
