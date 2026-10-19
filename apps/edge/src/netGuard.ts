import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for server-side fetches whose URL can be influenced by a user
 * (remote blocklist subscriptions and per-profile custom upstreams).
 *
 * Two layers:
 *  1. Syntax/literal checks (protocol, credentials, metadata hostnames,
 *     private IP literals).
 *  2. DNS resolution: every address the hostname resolves to must be public.
 *
 * Callers that follow redirects MUST use `fetchWithSafeRedirects` so each
 * hop is re-validated — otherwise an attacker can redirect a safe initial
 * URL to `http://169.254.169.254/`.
 *
 * Self-hosters pointing at a local Unbound / internal list server can opt
 * out of the private-range check with ALLOW_PRIVATE_TARGETS=1. Metadata
 * endpoints remain blocked regardless.
 */

export interface SafeUrlOptions {
  /** Allowed protocols (default: http + https). Lists should pass ["https:"]. */
  protocols?: string[];
  /** Allow RFC1918/loopback/link-local targets (self-host only). */
  allowPrivate?: boolean;
  /** Human label used in error messages ("list URL", "upstream"). */
  label?: string;
}

const DEFAULT_PROTOCOLS = ["http:", "https:"];
const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { expiresAt: number; private: boolean }>();

export function allowPrivateTargets(): boolean {
  return process.env.ALLOW_PRIVATE_TARGETS === "1";
}

/** Rejects unsafe URLs and, unless private targets are opted in, unsafe DNS. */
export async function assertSafeRemoteUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  const label = opts.label ?? "URL";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label}: invalid URL`);
  }

  const protocols = opts.protocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(u.protocol)) {
    throw new Error(`${label}: protocol must be ${protocols.join(" or ")}`);
  }
  if (u.username || u.password) {
    throw new Error(`${label}: must not embed credentials`);
  }

  const host = stripBrackets(u.hostname).toLowerCase().replace(/\.+$/, "");
  if (!host) throw new Error(`${label}: missing host`);
  if (isMetadataHost(host)) throw new Error(`${label}: metadata host blocked`);

  const literal = isIP(host);
  if (literal !== 0) {
    if (isPrivateIp(host) && !opts.allowPrivate) {
      throw new Error(`${label}: private/loopback address blocked`);
    }
    return u;
  }

  if (opts.allowPrivate) return u;

  const resolved = await resolvePrivate(host);
  if (resolved) throw new Error(`${label}: host resolves to a private address`);
  return u;
}

/** Fetch with manual redirect handling; every hop is re-validated. */
export async function fetchWithSafeRedirects(
  raw: string,
  init: RequestInit,
  opts: SafeUrlOptions = {},
  maxRedirects = 3,
): Promise<{ response: Response; finalUrl: string }> {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await assertSafeRemoteUrl(current, opts);
    const response = await fetch(safe, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${opts.label ?? "URL"}: redirect without Location`);
      current = new URL(location, safe).toString();
      // Drain the redirect body so the connection can be reused.
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    return { response, finalUrl: safe.toString() };
  }
  throw new Error(`${opts.label ?? "URL"}: too many redirects`);
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

function isMetadataHost(host: string): boolean {
  return (
    host === "metadata.google.internal" ||
    host === "metadata.goog" ||
    host === "169.254.169.254" ||
    host === "fd00:ec2::254"
  );
}

/** True when `ip` is loopback/private/link-local/CGNAT/multicast/reserved. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 / 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) and NAT64 (64:ff9b::/96)
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (h.includes(":ffff:") || h.startsWith("64:ff9b:")) {
    const groups = h.split(":");
    const hi = Number.parseInt(groups.at(-2) ?? "", 16);
    const lo = Number.parseInt(groups.at(-1) ?? "", 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }
  return false;
}

/** Resolves a hostname; returns true when any address is private (fail closed). */
async function resolvePrivate(host: string): Promise<boolean> {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > now) return cached.private;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Fail closed: an unresolvable host cannot be safely fetched.
    throw new Error("host could not be resolved");
  }
  const isPrivate = addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address));
  dnsCache.set(host, { expiresAt: now + DNS_CACHE_TTL_MS, private: isPrivate });
  return isPrivate;
}
