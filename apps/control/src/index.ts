/**
 * ResolveZero control plane — login + server-rendered dashboard (readme §4a).
 * /api/*  : better-auth (GitHub OAuth) + healthz + me (JSON contract)
 * /*      : SSR dashboard pages (dash.ts) — login, Setup, Rules, Analytics,
 *           Logs, Settings.
 */
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@resolvezero/db/client";
import { user, session, account, verification } from "@resolvezero/db/schema";
import { dropPrivileges } from "@resolvezero/shared";
import { createDashApp } from "./dash";

const PORT = Number(process.env.PORT ?? 8080);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}
if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET is not set");
}
if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  throw new Error("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set");
}

export type TAuth = ReturnType<typeof betterAuth>;

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "").split(",").filter(Boolean),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
});

const api = new Hono();

// CORS: dev-open during login-first phase; allowlist (dash/api origins) at
// productionalization (readme §4a checklist). Must run BEFORE routes so the
// headers wrap every response.
api.use("*", async (c, next) => {
  await next();
  // Production default is same-origin (no CORS headers). Set CORS_ORIGINS
  // (comma-separated) only when a separate API origin is intentionally used.
  const allowed = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return;
  const requestOrigin = c.req.header("origin") ?? "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(requestOrigin) ? requestOrigin : "";
  if (!allow) return;
  c.res.headers.set("access-control-allow-origin", allow);
  c.res.headers.set("vary", "Origin");
  c.res.headers.set(
    "access-control-allow-credentials",
    allow === "*" ? "false" : "true",
  );
});

api
  .get("/api/healthz", (c) => c.body(null, 204))
  .get("/healthz", (c) => c.body(null, 204))
  .on(["GET", "POST"], ["/api/auth/*"], (c) => auth.handler(c.req.raw))
  .get("/api/me", async (c) => {
    const sessionData = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!sessionData?.user) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({
      id: sessionData.user.id,
      name: sessionData.user.name,
      email: sessionData.user.email,
      image: sessionData.user.image,
    });
  });

const site = new Hono();
// Baseline browser hardening for every dashboard/API response.
site.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  h.set("x-frame-options", "DENY");
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
});
site.route("/", api);
site.route("/", createDashApp(auth));

const server = Bun.serve({ port: PORT, fetch: site.fetch });

// No privileged ports here, but drop root anyway (shared image).
try {
  const dropped = dropPrivileges({
    onDrop: (uid, gid) => console.info(JSON.stringify({ module: "control", msg: "dropped root privileges", uid, gid })),
  });
  if (!dropped) {
    console.info(JSON.stringify({ module: "control", msg: "running without privilege drop", uid: process.getuid?.(), gid: process.getgid?.() }));
  }
} catch (err) {
  console.error(JSON.stringify({ module: "control", msg: "privilege drop failed", error: String(err) }));
  if (process.env.FLY_REGION || process.env.DROP_PRIVILEGES === "1") process.exit(1);
}

console.info(JSON.stringify({ module: "control", port: server.port, msg: "resolvezero control listening" }));

export { site };
