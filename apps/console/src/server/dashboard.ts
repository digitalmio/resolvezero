import { createServerFn } from "@tanstack/react-start";

import { DEFAULT_OVERVIEW_RANGE, isOverviewRange } from "../lib/overview-range";
import { normalizeDomain, normalizeRecordType, normalizeZoneInput, type ZoneInput } from "../lib/zone";
import { sessionClient } from "./orpc/call.server";

export type { OverviewData, RulesData, LocalDnsData } from "./dashboard.server";

const MAX_DOMAIN_LENGTH = 253;
const MAX_RECORD_TYPE_LENGTH = 16;
const MAX_LOCAL_DNS_VALUES = 8;
const MAX_LOCAL_DNS_VALUE_LENGTH = 255;
const MAX_LOCAL_DNS_RAW_LENGTH = 4096;

function validateProfileId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("Invalid profile id");
  const value = raw.trim();
  if (!/^[0-9a-f-]{12,64}$/i.test(value)) throw new Error("Invalid profile id");
  return value;
}

/**
 * Structural only: cheap length checks before auth, no mapping/dedup work.
 * Full DNS validation runs in the authenticated handler.
 */
function validateLocalDnsShape(data: unknown): ZoneInput & { profileId?: string } {
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
    profileId: validateProfileId(input.profileId),
  };
}

function validateZoneKeyShape(data: unknown): { domain: string; recordType: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid local DNS input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid local DNS name");
  }
  if (typeof input.recordType !== "string" || input.recordType.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("Invalid record type");
  }
  return {
    domain: input.domain,
    recordType: input.recordType,
    profileId: validateProfileId(input.profileId),
  };
}

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.overview();
});

export const getQueryVolume = createServerFn({ method: "GET" })
  .validator((data: { range?: string } | undefined) => {
    const range = data?.range ?? DEFAULT_OVERVIEW_RANGE;
    if (!isOverviewRange(range)) throw new Error("Invalid overview range");
    return { range };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.queryVolume({ range: data.range });
  });

export const getRulesData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.rules.list();
});

export const getLocalDnsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.localDns.list();
});

export const saveLocalDnsZone = createServerFn({ method: "POST" })
  .validator(validateLocalDnsShape)
  .handler(async ({ data }) => {
    const zone = normalizeZoneInput(data);
    const client = await sessionClient();
    return client.localDns.upsert({
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values,
      ttl: zone.ttl,
    });
  });

export const deleteLocalDnsZone = createServerFn({ method: "POST" })
  .validator(validateZoneKeyShape)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.localDns.delete({
      domain: normalizeDomain(data.domain),
      recordType: normalizeRecordType(data.recordType),
    });
  });

export const getBlocklistsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.blocklists.list();
});

export const getAnalyticsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.analytics();
});

export const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.settings();
});

export const getLogsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.logs();
});

export const purgeCache = createServerFn({ method: "POST" })
  .validator((data: { domain: string; type?: string; profileId?: string }) => {
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
    return { domain, type, profileId: validateProfileId(data?.profileId) };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.cache.purge({ domain: data.domain, type: data.type });
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
