import "@tanstack/react-start/server-only";

import { ORPCError } from "@orpc/server";

import { auth } from "../auth.server";
import { findProfile } from "../dashboard/profile.server";

/** `read-write` implies `read`; keys are either read-only or read-write. */
export type Scope = "read" | "read-write";

export type Principal =
  | { via: "session"; userId: string; keyId: null; scope: Scope }
  | { via: "key"; userId: string; keyId: string; scope: Scope };

/** Resolved once per request and passed to every procedure. */
export interface ApiContext {
  principal: Principal;
  profileId: string;
  profileName: string;
}

/**
 * Resolve the caller from either a Better Auth session cookie or a long-lived
 * API key. Both paths end at exactly one profile: keys are bound to a profile,
 * and the session path keeps the `rz_profile_id` switcher working.
 */
export async function resolveContext(headers: Headers): Promise<ApiContext> {
  const session = await auth.api.getSession({ headers });

  if (session?.user) {
    const profile = await findProfile(session.user.id, null, headers.get("cookie") ?? undefined);
    return {
      principal: { via: "session", userId: session.user.id, keyId: null, scope: "read-write" },
      profileId: profile.id,
      profileName: profile.name,
    };
  }

  throw new ORPCError("UNAUTHORIZED", { message: "Sign in or supply an API key." });
}

export function requireScope(context: ApiContext, scope: Scope): void {
  const allowed = context.principal.scope === "read-write" || context.principal.scope === scope;
  if (!allowed) {
    throw new ORPCError("FORBIDDEN", { message: `This key is read-only.` });
  }
}

/** Internal procedures are session-only: an API key can never reach them. */
export function requireSession(context: ApiContext): void {
  if (context.principal.via !== "session") {
    throw new ORPCError("FORBIDDEN", { message: "This operation is not available to API keys." });
  }
}
