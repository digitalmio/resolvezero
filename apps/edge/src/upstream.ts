import { ofetch } from "ofetch";

const UPSTREAM_DOH_URL = process.env.UPSTREAM_DOH_URL ?? "https://dns.quad9.net/dns-query";

export interface UpstreamResult {
  wire: Uint8Array;
  rttMs: number;
}

/**
 * Forwards a DNS wire-format query to the configured DoH upstream
 * (readme.md §2: Quad9 for MVP; 1-line/env change to swap).
 * Fail fast (no retries — the client stub resolver owns retransmission),
 * SERVFAIL upstream is NOT cached (only healthy responses enter the LRU).
 */
export async function resolveWire(wire: Uint8Array): Promise<UpstreamResult> {
  const startedAt = performance.now();
  const response = await ofetch.raw(UPSTREAM_DOH_URL, {
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
  return { wire: new Uint8Array(response._data as ArrayBuffer), rttMs };
}
