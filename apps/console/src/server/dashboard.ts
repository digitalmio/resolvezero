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

export const getBlocklistsData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadBlocklists } = await import("./dashboard.server");
  return loadBlocklists();
});

export const getAnalyticsData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadAnalytics } = await import("./dashboard.server");
  return loadAnalytics();
});

export const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadSettings } = await import("./dashboard.server");
  return loadSettings();
});

export const getLogsData = createServerFn({ method: "GET" }).handler(async () => {
  const { loadLogs } = await import("./dashboard.server");
  return loadLogs();
});

export const checkDnsProbe = createServerFn({ method: "POST" })
  .validator((nonce: string) => {
    if (!/^[a-z0-9]{16,64}$/.test(nonce)) throw new Error("invalid probe nonce");
    return nonce;
  })
  .handler(async ({ data }) => {
    const { loadDnsProbe } = await import("./dashboard.server");
    return loadDnsProbe(data);
  });
