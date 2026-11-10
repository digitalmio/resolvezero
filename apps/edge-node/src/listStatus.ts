import { and, eq } from "drizzle-orm";

import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";

import { moduleLogger } from "./logger";

const log = moduleLogger("blocklists");

export async function markStatus(
  subscription: { listId?: string },
  status: string,
  count: number,
  detectedFormat?: string,
): Promise<void> {
  if (!subscription.listId) return;
  await writeStatus(subscription.listId, status, count, detectedFormat).catch((err) =>
    log.warn({ err, listId: subscription.listId }, "blocklist status write failed"),
  );
}

async function writeStatus(
  id: string,
  status: string,
  count: number,
  detectedFormat?: string,
): Promise<void> {
  await db
    .update(profileBlocklists)
    .set({
      lastSyncedAt: new Date(),
      lastStatus: status,
      entryCount: count,
      ...(detectedFormat ? { detectedFormat } : {}),
    })
    .where(and(eq(profileBlocklists.id, id)));
}
