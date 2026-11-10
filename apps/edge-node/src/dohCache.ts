import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import type { Upstream } from "./dohTypes";

interface CacheDeps {
  dnsCache: DnsCache;
  upstream: Upstream;
  recorder?: Recorder;
}

/** Refresh a cached entry before it expires (no client-visible latency). */
export async function refreshDohCache(
  deps: CacheDeps,
  queryWire: Uint8Array,
  upstreamUrl: string | null | undefined,
  profileId: string,
): Promise<void> {
  const result = await deps.upstream.resolveWire(queryWire, upstreamUrl ?? undefined);
  deps.dnsCache.set(queryWire, result.wire, upstreamUrl, profileId);
  deps.recorder?.recordRtt(result.rttMs);
}
