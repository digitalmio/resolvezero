import type { Context } from "hono";

import { readBytesBounded } from "./body";
import type { RuleStore } from "./ruleStore";

const DEVICE_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export interface DohIdentity {
  profileId: string;
  device: string | null;
  token: string | undefined;
}

/** Parse the NextDNS-style path shapes:
 *  /v1/:id | /v1/:id/:token | /v1/:id/:device | /v1/:id/:device/:token */
export function resolveDohIdentity(
  store: RuleStore,
  profileId: string,
  token: string | undefined,
  seg2: string | undefined,
): DohIdentity | null {
  let device: string | null = null;
  let effectiveToken = token;
  if (seg2 !== undefined) {
    if (token !== undefined) {
      if (!DEVICE_RE.test(seg2)) return null;
      device = seg2;
    } else if (store.hasToken(profileId)) {
      effectiveToken = seg2;
    } else if (DEVICE_RE.test(seg2)) {
      device = seg2;
    } else {
      return null;
    }
  }
  return { profileId, device, token: effectiveToken };
}

export function clientIp(c: Context): string | null {
  return (
    c.req.header("fly-client-ip")?.trim() ||
    (process.env.ALLOW_UNTRUSTED_IP_HEADERS === "1"
      ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      : undefined) ||
    null
  );
}

function base64urlDecode(value: string): Uint8Array | undefined {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Extract the RFC 8484 wire query from GET ?dns= or POST body. */
export async function readDohWire(c: Context): Promise<Uint8Array | undefined> {
  try {
    if (c.req.method === "GET") {
      const dns = c.req.query("dns");
      if (dns && dns.length > 4096) return undefined;
      return dns ? base64urlDecode(dns) : undefined;
    }
    if (c.req.header("content-type") === "application/dns-message") {
      const len = Number(c.req.header("content-length") ?? "0");
      if (len > 65535) return undefined;
      const body = await readBytesBounded(c.req.raw.body, 65535, len);
      return body.length > 0 ? body : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
