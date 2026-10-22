import { createServerFn } from "@tanstack/react-start";

export type { OverviewData, RulesData } from "./dashboard.server";

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { loadOverview } = await import("./dashboard.server");
  return loadOverview();
});

export const getRulesData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadRules } = await import("./dashboard.server");
  return loadRules();
});
