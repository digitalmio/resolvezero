export const UPSTREAM_PRESETS = ["cloudflare", "google", "quad9"] as const;
export type UpstreamPreset = (typeof UPSTREAM_PRESETS)[number];

export interface SettingsInput {
  upstream: UpstreamPreset | null;
  upstreamUrl: string | null;
  logQueries: boolean;
  logRetentionDays: number;
}

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const MAX_UPSTREAM_URL_LENGTH = 255;

function normalizeUpstream(raw: unknown): UpstreamPreset | null {
  if (raw === null || raw === undefined || raw === "" || raw === "default") return null;
  const value = String(raw).trim().toLowerCase();
  if (!(UPSTREAM_PRESETS as readonly string[]).includes(value)) {
    throw new Error(`Upstream must be one of ${UPSTREAM_PRESETS.join(", ")}`);
  }
  return value as UpstreamPreset;
}

function normalizeUpstreamUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_UPSTREAM_URL_LENGTH) {
    throw new Error(`Custom upstream URL must be ${MAX_UPSTREAM_URL_LENGTH} characters or fewer`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Custom upstream must be a full https:// URL");
  }
  if (url.protocol !== "https:") throw new Error("Custom upstream must use https://");
  if (!url.hostname) throw new Error("Custom upstream must include a hostname");
  if (url.username || url.password) throw new Error("Upstream URLs with credentials are not supported");
  return url.toString();
}

function normalizeRetention(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    throw new Error(`Retention must be a whole number between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`);
  }
  return value;
}

export function normalizeSettingsInput(raw: unknown): SettingsInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid settings input");
  const input = raw as Record<string, unknown>;
  if (typeof input.logQueries !== "boolean") throw new Error("logQueries must be true or false");

  return {
    upstream: normalizeUpstream(input.upstream),
    upstreamUrl: normalizeUpstreamUrl(input.upstreamUrl),
    logQueries: input.logQueries,
    logRetentionDays: normalizeRetention(input.logRetentionDays),
  };
}
