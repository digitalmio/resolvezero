import { eq } from "drizzle-orm";

import { db } from "@resolvezero/db/client";
import { dnsProbes, profileSourceIps } from "@resolvezero/db/schema";

import { createRateLimiter } from "./limits";
import { moduleLogger } from "./logger";

const log = moduleLogger("writes");
const probeWriteLimit = createRateLimiter(120, 60_000, 2_048);

/** Record a resolver-presence canary; capped so random nonces can't grow the table. */
export function recordProbe(
  nonce: string,
  transport: "doh" | "udp" | "tcp" | "dot" | "dot",
): void {
  if (!probeWriteLimit("probes")) return;
  void db
    .insert(dnsProbes)
    .values({ nonce, transport, region: process.env.FLY_REGION ?? "local" })
    .onConflictDoNothing()
    .catch((err) => log.warn({ err }, "probe insert failed"));
}

const touchedSourceIps = new Map<string, number>();

/** Keep an actively used source-IP link alive (at most once/day). */
export function onSourceSeen(ip: string): void {
  const now = Date.now();
  const last = touchedSourceIps.get(ip);
  if (last != null && now - last < 86_400_000) return;
  if (last == null && touchedSourceIps.size >= 4_096) return;
  touchedSourceIps.set(ip, now);
  void db
    .update(profileSourceIps)
    .set({ lastSeenAt: new Date() })
    .where(eq(profileSourceIps.ipAddress, ip))
    .catch((err) => log.warn({ err, ip }, "source IP touch failed"));
}
