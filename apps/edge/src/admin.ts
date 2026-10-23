import { Hono } from "hono";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileSourceIps } from "@resolvezero/db/schema";
import type { RuleStore } from "./ruleStore";
import { moduleLogger } from "./logger";
import { normalizeIp } from "./wire";

const log = moduleLogger("admin");

/** Tiny in-memory rate limiter (per key, fixed window). */
function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now > cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= limit;
  };
}

const updateIpLimiter = createRateLimiter(30, 60_000);
const syncLimiter = createRateLimiter(10, 60_000);

function bearerOrQuery(c: { req: { query(k: string): string | undefined; header(n: string): string | undefined } }): string | undefined {
  const q = c.req.query("token");
  if (q) return q;
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || undefined;
  return undefined;
}

export interface AdminDeps {
  store: RuleStore;
  /** Force a remote-blocklist re-sync (custom-URL feature). */
  blocklists?: { syncNow(): Promise<void> };
}

/**
 * Router-side account maintenance (NextDNS "linked IP" mechanic, readme §4):
 *   POST /v1/:profileId/update-ip[?token=][&ip=1.2.3.4]
 *
 * Links the calling Fly client IP to the profile's UDP whitelist. Explicit
 * ?ip= is disabled unless ALLOW_EXPLICIT_IP_LINK=1 (self-host/dev). IPs owned
 * by another profile return 409; ownership is never silently transferred.
 * The ip_update_trigger NOTIFY keeps already-running edges live.
 */
export function createAdminApp(deps: AdminDeps) {
  const app = new Hono().basePath("/v1");

  app.post(":profileId/update-ip", async (c) => {
    const profileId = c.req.param("profileId");
    const token = bearerOrQuery(c);

    if (!deps.store.hasProfile(profileId, token)) {
      return c.body(null, 404);
    }

    // Hosted profiles must use a token. The boot guard already refuses
    // token-free profiles in production, but keep the endpoint safe if that
    // guard is ever bypassed.
    if (process.env.FLY_REGION && !deps.store.hasToken(profileId)) {
      return c.body(null, 404);
    }

    const flyClientIp = c.req.header("fly-client-ip")?.trim();
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const caller = flyClientIp || (process.env.ALLOW_UNTRUSTED_IP_HEADERS === "1" ? xff : undefined) || "";
    if (!caller) return c.json({ error: "caller IP unavailable" }, 400);
    if (!updateIpLimiter(`${caller}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }

    const explicit = c.req.query("ip")?.trim();
    if (explicit && process.env.ALLOW_EXPLICIT_IP_LINK !== "1") {
      return c.json({ error: "explicit IP linking is disabled" }, 400);
    }
    const rawIp = explicit || caller;
    const ip = rawIp ? normalizeIp(rawIp) : "";
    if (!ip || isIP(ip) === 0) {
      return c.json({ error: "no valid caller IP" }, 400);
    }

    // Never steal an IP from another profile. onConflictDoNothing closes the
    // insert race; the follow-up owner check makes cross-profile moves a 409
    // instead of a silent ownership transfer.
    const inserted = await db
      .insert(profileSourceIps)
      .values({ ipAddress: ip, profileId })
      .onConflictDoNothing({ target: profileSourceIps.ipAddress })
      .returning({ profileId: profileSourceIps.profileId });

    if (inserted.length === 0) {
      const existing = await db
        .select({ profileId: profileSourceIps.profileId })
        .from(profileSourceIps)
        .where(eq(profileSourceIps.ipAddress, ip))
        .limit(1);
      if (existing[0] && existing[0].profileId !== profileId) {
        return c.json({ error: "IP is linked to another profile" }, 409);
      }
    }

    log.info({ profileId, ip }, "source IP linked");
    return c.json({ ok: true, ip, profileId });
  });

  app.post(":profileId/blocklists/sync", async (c) => {
    if (!deps.store.hasProfile(c.req.param("profileId"), bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    const caller = c.req.header("fly-client-ip") ?? "unknown";
    if (!syncLimiter(`${caller}:${c.req.param("profileId")}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    void deps.blocklists?.syncNow();
    return c.json({ ok: true, msg: "re-sync kicked" });
  });

  // Convenience informational endpoint (NextDNS /info parity)
  app.get(":profileId/info", (c) => {
    const region = process.env.FLY_REGION ?? "local";
    return c.json({
      app: "resolvezero",
      region,
      locationName: REGION_NAMES[region] ?? region,
      pop: region,
      rttMs: null, // Fly terminates TLS in its proxy — client measures its own RTT
      measuredBy: "client",
    });
  });

  return app;
}

const REGION_NAMES: Record<string, string> = {
  lhr: "London, United Kingdom",
  fra: "Frankfurt, Germany",
  iad: "Ashburn, United States",
  sjc: "San José, United States",
  nrt: "Tokyo, Japan",
  syd: "Sydney, Australia",
  gru: "São Paulo, Brazil",
};
