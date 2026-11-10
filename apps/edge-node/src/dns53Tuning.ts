import { positiveInt } from "./limits";

export const TCP_MAX_BUFFER_BYTES = Math.max(
  4096,
  Number(process.env.TCP_MAX_BUFFER_BYTES ?? 65_536) || 65_536,
);
export const TCP_IDLE_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.TCP_IDLE_TIMEOUT_MS ?? 30_000) || 30_000,
);
export const TCP_MAX_LIFETIME_MS = positiveInt(process.env.TCP_MAX_LIFETIME_MS, 120_000);
export const TCP_MAX_CONNECTIONS = Math.max(
  1,
  Number(process.env.TCP_MAX_CONNECTIONS ?? 512) || 512,
);
export const TCP_MAX_CONNECTIONS_PER_SOURCE = positiveInt(
  process.env.TCP_MAX_CONNECTIONS_PER_SOURCE,
  8,
);
export const TCP_MAX_INFLIGHT = positiveInt(process.env.TCP_MAX_INFLIGHT, 128);
