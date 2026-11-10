export interface Config {
  intervalSeconds: number;
  pollSeconds: number;
  heartbeatSeconds: number;
  maxBytes: number;
  maxEntries: number;
  forceOnce: boolean;
  once: boolean;
  shadow: boolean;
  instance: string;
}

function numberEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configFromEnv(): Config {
  return {
    intervalSeconds: Math.max(60, numberEnv("COMPILE_INTERVAL_SECONDS", 6 * 3600)),
    pollSeconds: Math.max(5, numberEnv("COMPILE_POLL_SECONDS", 10)),
    heartbeatSeconds: Math.max(5, numberEnv("COMPILER_HEARTBEAT_SECONDS", 15)),
    maxBytes: numberEnv("BLOCKLIST_MAX_LIST_BYTES", 30 * 1024 * 1024),
    maxEntries: numberEnv("BLOCKLIST_MAX_ENTRIES_PER_PROFILE", 1_500_000),
    forceOnce: process.env.FORCE_COMPILE === "1",
    once: process.env.COMPILER_ONCE === "1",
    shadow: process.env.COMPILER_SHADOW === "1",
    instance: (
      process.env.FLY_MACHINE_ID ??
      process.env.FLY_ALLOC_ID ??
      process.env.HOSTNAME ??
      "local"
    ).slice(0, 64),
  };
}

export function log(level: "info" | "warn" | "error", msg: string, fields: object = {}): void {
  process.stdout.write(`${JSON.stringify({ level, msg, ...fields })}\n`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
