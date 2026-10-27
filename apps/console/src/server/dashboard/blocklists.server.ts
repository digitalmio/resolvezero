import { asc, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";

import { findProfile } from "./profile.server";
import type { BlocklistsData } from "./types";

export async function loadBlocklists(ownerUserId: string): Promise<BlocklistsData> {
  const profile = await findProfile(ownerUserId);
  const lists = await db
    .select({
      id: profileBlocklists.id,
      url: profileBlocklists.url,
      format: profileBlocklists.format,
      enabled: profileBlocklists.enabled,
      entries: profileBlocklists.entryCount,
      lastSyncedAt: profileBlocklists.lastSyncedAt,
      lastStatus: profileBlocklists.lastStatus,
    })
    .from(profileBlocklists)
    .where(eq(profileBlocklists.profileId, profile.id))
    .orderBy(asc(profileBlocklists.url));

  return {
    profileId: profile.id,
    profileName: profile.name,
    lists: lists.map((list) => ({
      ...list,
      lastSyncedAt: list.lastSyncedAt ? list.lastSyncedAt.toISOString() : null,
    })),
  };
}
