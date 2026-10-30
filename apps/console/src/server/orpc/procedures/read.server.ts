import "@tanstack/react-start/server-only";

import { z } from "zod";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { loadSettings } from "../../dashboard/settings.server";
import { loadAnalytics } from "../../dashboard/analytics.server";
import { loadLogs } from "../../dashboard/logs.server";
import { loadOverview } from "../../dashboard/overview.server";
import { loadQueryVolume } from "../../dashboard/query-volume.server";
import { loadEdgeHealth } from "../../dashboard/edge.server";

/**
 * Read procedures. Output schemas are intentionally loose for the aggregate
 * views (they mirror the UI payloads); tightening them is a follow-up.
 */
export const reads = {
  overview: base
    .route({ method: "GET", path: "/overview", summary: "Dashboard overview" })
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadOverview(context.principal.userId, context.viewer, context.profileId);
    }),

  queryVolume: base
    .route({ method: "GET", path: "/overview/query-volume", summary: "Query volume series" })
    .input(z.object({ range: z.enum(["1h", "24h", "7d", "30d"]).default("24h") }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read");
      return loadQueryVolume(context.principal.userId, input.range, context.profileId);
    }),

  analytics: base
    .route({ method: "GET", path: "/analytics", summary: "Analytics rollups" })
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadAnalytics(context.principal.userId, context.profileId);
    }),

  logs: base
    .route({ method: "GET", path: "/logs", summary: "Recent query log entries" })
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadLogs(context.principal.userId, context.profileId);
    }),

  settings: base
    .route({ method: "GET", path: "/settings", summary: "Profile settings and capacity" })
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadSettings(context.principal.userId, context.profileId);
    }),

  edge: base
    .route({ method: "GET", path: "/edge", summary: "Edge health for this profile" })
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadEdgeHealth();
    }),
};
