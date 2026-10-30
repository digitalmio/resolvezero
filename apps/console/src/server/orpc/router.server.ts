import { os } from "@orpc/server";

import type { ApiContext } from "./context.server";

/** Root builder: every procedure receives the resolved ApiContext. */
export const base = os.$context<ApiContext>();

const whoami = base
  .route({ method: "GET", path: "/whoami", summary: "Who is calling?" })
  .handler(({ context }) => ({
    via: context.principal.via,
    scope: context.principal.scope,
    userId: context.principal.userId,
    keyId: context.principal.keyId,
    profileId: context.profileId,
    profileName: context.profileName,
  }));

export const router = { whoami };

export type ApiRouter = typeof router;
