import type { RuleStore } from "./ruleStore";
import { memoryLimitMb, rssMb } from "./memory";

interface ReadinessFlags {
  rulesLoaded: boolean;
  blocklistsLoaded: boolean;
  dns53Bound: boolean;
}

interface StatusSource {
  status(): { lastPollAt: number | null; lastPollError: string | null };
}

interface BlocklistSource {
  status(): {
    lastSyncAt: number | null;
    lastError: string | null;
    failedUrls: string[];
  };
}

export function readinessPayload(input: {
  readiness: ReadinessFlags;
  ruleSync: StatusSource;
  blocklists: BlocklistSource;
  store: RuleStore;
}): { ok: boolean; details: Record<string, unknown> } {
  const rs = input.ruleSync.status();
  const bs = input.blocklists.status();
  const blocklistsLoaded =
    input.readiness.blocklistsLoaded && bs.lastError == null && bs.failedUrls.length === 0;
  return {
    ok: input.readiness.rulesLoaded && blocklistsLoaded && input.readiness.dns53Bound,
    details: {
      region: process.env.FLY_REGION ?? "local",
      rulesLoaded: input.readiness.rulesLoaded,
      blocklistsLoaded,
      dns53Bound: input.readiness.dns53Bound,
      lazyLists: true,
      artifactOnly: process.env.ARTIFACT_ONLY_LISTS === "1",
      remoteLists: input.store.remoteBlocklistEntryCount,
      remoteListTables: input.store.stats.remoteListTables,
      artifactLists: input.store.stats.artifactLists,
      rawLists: input.store.stats.rawLists,
      pendingLists: input.store.stats.pendingLists,
      profiles: input.store.stats.profileCount,
      configPollAgeMs: rs.lastPollAt == null ? null : Date.now() - rs.lastPollAt,
      configPollError: rs.lastPollError != null,
      blocklistLastSyncAt: bs.lastSyncAt,
      blocklistError: bs.lastError != null,
      failedBlocklists: bs.failedUrls.length,
      rssMb: rssMb(),
      memoryLimitMb: memoryLimitMb(),
    },
  };
}
