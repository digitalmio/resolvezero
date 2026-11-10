import { asc, gte } from "drizzle-orm";

import { db } from "@resolvezero/db/client";
import { dnsCachePurges } from "@resolvezero/db/schema";

import type { DnsCache } from "./dnsCache";
import { moduleLogger } from "./logger";

const log = moduleLogger("purge");
const POLL_MS = Math.max(1_000, Number(process.env.CACHE_PURGE_POLL_MS ?? 5_000) || 5_000);

/** Per-PoP poll of `dns_cache_purges`; evicts matching local entries. */
export function startPurgePoller(dnsCache: DnsCache): void {
  let lastPurgeAt = new Date(Date.now() - 10 * 60_000);
  const processed = new Set<string>();

  const poll = async (): Promise<void> => {
    const rows = await db
      .select({
        id: dnsCachePurges.id,
        profileId: dnsCachePurges.profileId,
        domain: dnsCachePurges.domain,
        recordType: dnsCachePurges.recordType,
        createdAt: dnsCachePurges.createdAt,
      })
      .from(dnsCachePurges)
      .where(gte(dnsCachePurges.createdAt, lastPurgeAt))
      .orderBy(asc(dnsCachePurges.createdAt))
      .limit(500);

    for (const row of rows) {
      if (processed.has(row.id)) continue;
      processed.add(row.id);
      const removed = dnsCache.purge(row.profileId, row.domain, row.recordType);
      if (removed > 0) {
        log.info(
          { profileId: row.profileId, domain: row.domain, recordType: row.recordType, removed },
          "cache entries purged",
        );
      }
      if (row.createdAt > lastPurgeAt) lastPurgeAt = row.createdAt;
    }
    if (processed.size > 5_000) processed.clear();
  };

  const timer = setInterval(() => {
    void poll().catch((err) => log.warn({ err }, "cache purge poll failed"));
  }, POLL_MS);
  timer.unref?.();
  void poll().catch((err) => log.warn({ err }, "initial cache purge poll failed"));
}
