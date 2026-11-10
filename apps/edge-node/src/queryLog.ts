import type { QueryLogBatcher } from "./batcher";
import type { QueryLogEntry } from "./dohTypes";
import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";

const log = moduleLogger("query");

/** Enqueue a query for rollups, and optionally emit the Log Shipper line. */
export function createLogQuery(
  store: RuleStore,
  batcher: QueryLogBatcher,
  stdout: boolean,
): (entry: QueryLogEntry) => void {
  return (entry) => {
    if (!store.shouldLog(entry.profileId)) return;
    if (stdout) {
      log.info({
        kind: "query",
        time: new Date().toISOString(),
        profile: entry.profileId,
        domain: entry.domain,
        action: entry.action,
        rttMs: entry.rttMs,
        clientIp: entry.clientIp,
        region: process.env.FLY_REGION ?? "local",
      });
    }
    batcher.add(entry);
  };
}
