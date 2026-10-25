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

export const purgeCache = createServerFn({ method: "POST" })
  .validator((data: { domain: string; type?: string }) => {
    const domain = String(data?.domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (
      !domain ||
      domain.length > 253 ||
      domain.includes("..") ||
      !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/.test(domain)
    ) {
      throw new Error("Enter a valid DNS name");
    }
    const type = data?.type ? String(data.type).toUpperCase() : undefined;
    return { domain, type };
  })
  .handler(async ({ data }) => {
    const { purgeCache: runPurge } = await import("./dashboard.server");
    return runPurge(data.domain, data.type);
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
