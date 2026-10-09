import { Hono } from "hono";
import { db } from "@resolvezero/db/client";
import { profileSourceIps } from "@resolvezero/db/schema";
import type { RuleStore } from "./ruleStore";
import { moduleLogger } from "./logger";

const log = moduleLogger("admin");

export interface AdminDeps {
  store: RuleStore;
  /** Force a remote-blocklist re-sync (custom-URL feature). */
  blocklists?: { syncNow(): Promise<void> };
}

/**
 * Router-side account maintenance (NextDNS "linked IP" mechanic, readme §4):
 *   POST /v1/:profileId/update-ip[?token=][&ip=1.2.3.4]
 *
 * Links the calling IP (or explicit ?ip=) to the profile's UDP whitelist.
 * Profiles WITH a token require it here; token-free profile ids are open
 * (dev-friendly) — flip on tokens before hosted launch.
 * The ip_update_trigger NOTIFY keeps already-running edges live.
 */
export function createAdminApp(deps: AdminDeps) {
  const app = new Hono().basePath("/v1");

  app.post(":profileId/update-ip", async (c) => {
    const profileId = c.req.param("profileId");
    const token = c.req.query("token");

    if (!deps.store.hasProfile(profileId, token)) {
      return c.body(null, 404);
    }

    const ip = c.req.query("ip")?.trim() ?? c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(ip)) {
      return c.json({ error: "no valid IP supplied (use ?ip= or call via the edge)" }, 400);
    }

    await db
      .insert(profileSourceIps)
      .values({ ipAddress: ip, profileId })
      .onConflictDoNothing();

    log.info({ profileId, ip }, "source IP linked");
    return c.json({ ok: true, ip, profileId });
  });

  app.post(":profileId/blocklists/sync", async (c) => {
    if (!deps.store.hasProfile(c.req.param("profileId"), c.req.query("token"))) {
      return c.body(null, 404);
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
