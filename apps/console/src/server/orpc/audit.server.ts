import "@tanstack/react-start/server-only";

import { db } from "@resolvezero/db/client";
import { apiAuditLog } from "@resolvezero/db/schema";

import type { ApiContext } from "./context.server";

export interface AuditEntry {
  procedure: string;
  /** Short human description, never the raw payload. */
  summary: string;
  status?: "ok" | "error";
}

/**
 * Record a mutating call. Auditing must never fail the operation it describes,
 * so write failures are logged and swallowed.
 */
export async function auditWrite(context: ApiContext, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(apiAuditLog).values({
      profileId: context.profileId,
      userId: context.principal.userId,
      keyId: context.principal.keyId,
      via: context.principal.via,
      procedure: entry.procedure,
      summary: entry.summary.slice(0, 255),
      status: entry.status ?? "ok",
      ip: context.request.ip,
      userAgent: context.request.userAgent?.slice(0, 255) ?? null,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "api audit write failed",
        procedure: entry.procedure,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
