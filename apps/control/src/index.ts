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
  const origin = process.env.CORS_ORIGINS ?? "*";
  c.res.headers.set("access-control-allow-origin", origin);
  c.res.headers.set(
    "access-control-allow-credentials",
    origin === "*" ? "false" : "true",
  );
});

api
  .get("/api/healthz", (c) => c.body(null, 204))
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
site.route("/", api);
site.route("/", createDashApp(auth));

const server = Bun.serve({ port: PORT, fetch: site.fetch });
console.info(JSON.stringify({ module: "control", port: server.port, msg: "resolvezero control listening" }));

export { site };
