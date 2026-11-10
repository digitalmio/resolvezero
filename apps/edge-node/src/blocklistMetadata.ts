import { eq } from "drizzle-orm";

import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";

import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";

const log = moduleLogger("blocklists");

interface Row {
  id: string;
  profileId: string;
  url: string;
  format: string;
  artifactHash: string | null;
}

/**
 * Wire every profile's subscriptions without fetching list content. Returns
 * the active URL set per profile so the caller can prune stale failures.
 */
export async function syncBlocklistMetadata(
  store: RuleStore,
  maxListsPerProfile: number,
): Promise<Map<string, Set<string>>> {
  const rows = (await db
    .select({
      id: profileBlocklists.id,
      profileId: profileBlocklists.profileId,
      url: profileBlocklists.url,
      format: profileBlocklists.format,
      artifactHash: profileBlocklists.artifactHash,
    })
    .from(profileBlocklists)
    .where(eq(profileBlocklists.enabled, true))) as Row[];

  const byProfile = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    let lists = byProfile.get(row.profileId);
    if (!lists) {
      lists = new Map();
      byProfile.set(row.profileId, lists);
    }
    const existing = lists.get(row.url);
    if (!existing || (!existing.artifactHash && row.artifactHash)) {
      lists.set(row.url, row);
    }
  }

  const active = new Map<string, Set<string>>();
  for (const [profileId, lists] of byProfile) {
    const entries = [...lists.values()];
    if (entries.length > maxListsPerProfile) {
      log.warn(
        { profileId, total: entries.length, cap: maxListsPerProfile },
        "profile blocklist subscription cap reached; extra lists ignored",
      );
    }
    const selected = entries.slice(0, maxListsPerProfile);
    active.set(profileId, new Set(selected.map((row) => row.url)));
    store.setSubscriptions(
      profileId,
      selected.map((row) => ({
        url: row.url,
        listId: row.id,
        artifactHash: row.artifactHash,
      })),
      { prune: false },
    );
  }

  store.pruneUnreferencedLists();
  return active;
}
