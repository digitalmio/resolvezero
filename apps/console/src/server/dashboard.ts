import { createServerFn } from "@tanstack/react-start";

import { normalizeDomain, normalizeRecordType, normalizeZoneInput, type ZoneInput } from "../lib/zone";

export type { OverviewData, RulesData, LocalDnsData } from "./dashboard.server";

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser, toViewer }, { loadOverview }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadOverview(user.id, toViewer(user));
});

export const getRulesData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadRules }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadRules(user.id);
});

export const getLocalDnsData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadLocalDns }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadLocalDns(user.id);
});

export const saveLocalDnsZone = createServerFn({ method: "POST" })
  .validator((data: ZoneInput) => normalizeZoneInput(data))
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { upsertLocalDnsZone }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return upsertLocalDnsZone(user.id, data);
  });

export const deleteLocalDnsZone = createServerFn({ method: "POST" })
  .validator((data: { domain: string; recordType: string }) => ({
    domain: normalizeDomain(data?.domain),
    recordType: normalizeRecordType(data?.recordType),
  }))
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { removeLocalDnsZone }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return removeLocalDnsZone(user.id, data.domain, data.recordType);
  });

export const getBlocklistsData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadBlocklists }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadBlocklists(user.id);
});

export const getAnalyticsData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadAnalytics }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadAnalytics(user.id);
});

export const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadSettings }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadSettings(user.id);
});

export const getLogsData = createServerFn({ method: "GET" }).handler(async () => {
  const [{ requireSessionUser }, { loadLogs }] = await Promise.all([
    import("./auth.server"),
    import("./dashboard.server"),
  ]);
  const user = await requireSessionUser();
  return loadLogs(user.id);
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
    const [{ requireSessionUser }, { purgeCache: runPurge }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return runPurge(user.id, data.domain, data.type);
  });

export const checkDnsProbe = createServerFn({ method: "POST" })
  .validator((nonce: string) => {
    if (!/^[a-z0-9]{16,64}$/.test(nonce)) throw new Error("invalid probe nonce");
    return nonce;
  })
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { loadDnsProbe }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return loadDnsProbe(user.id, data);
  });
