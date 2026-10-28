import { createServerFn } from "@tanstack/react-start";

import { normalizeDomain, normalizeRecordType, normalizeZoneInput, type ZoneInput } from "../lib/zone";

export type { OverviewData, RulesData, LocalDnsData } from "./dashboard.server";

const MAX_DOMAIN_LENGTH = 253;
const MAX_RECORD_TYPE_LENGTH = 16;
const MAX_LOCAL_DNS_VALUES = 8;
const MAX_LOCAL_DNS_VALUE_LENGTH = 255;
const MAX_LOCAL_DNS_RAW_LENGTH = 4096;

/**
 * Structural only: cheap length checks before auth, no mapping/dedup work.
 * Full DNS validation runs in the authenticated handler.
 */
function validateLocalDnsShape(data: unknown): ZoneInput {
  if (!data || typeof data !== "object") throw new Error("Invalid local DNS input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid local DNS name");
  }
  if (typeof input.recordType !== "string" || input.recordType.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("Invalid record type");
  }
  const values = input.values;
  if (typeof values === "string") {
    if (values.length > MAX_LOCAL_DNS_RAW_LENGTH) throw new Error("Too many answer values");
  } else if (Array.isArray(values)) {
    if (values.length > MAX_LOCAL_DNS_VALUES) throw new Error("Add at most 8 answer values");
    for (const value of values) {
      if (typeof value !== "string" || value.length > MAX_LOCAL_DNS_VALUE_LENGTH) {
        throw new Error("Invalid answer value");
      }
    }
  } else {
    throw new Error("Invalid answer values");
  }
  if (input.ttl !== undefined && typeof input.ttl !== "string" && typeof input.ttl !== "number") {
    throw new Error("Invalid TTL");
  }
  return {
    domain: input.domain,
    recordType: input.recordType,
    values: values as string[] | string,
    ttl: input.ttl as string | number | undefined,
  };
}

function validateZoneKeyShape(data: unknown): { domain: string; recordType: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid local DNS input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid local DNS name");
  }
  if (typeof input.recordType !== "string" || input.recordType.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("Invalid record type");
  }
  return { domain: input.domain, recordType: input.recordType };
}

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
  .validator(validateLocalDnsShape)
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { upsertLocalDnsZone }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return upsertLocalDnsZone(user.id, normalizeZoneInput(data));
  });

export const deleteLocalDnsZone = createServerFn({ method: "POST" })
  .validator(validateZoneKeyShape)
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { removeLocalDnsZone }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return removeLocalDnsZone(user.id, normalizeDomain(data.domain), normalizeRecordType(data.recordType));
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
