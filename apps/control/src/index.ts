/**
 * ResolveZero control plane — login-first phase (readme §4a).
 * Better Auth (GitHub OAuth) + /api/me smoke route. Profile CRUD etc.
 * deliberately parked until the app design session.
 */
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@resolvezero/db/client";
import { user, session, account, verification } from "@resolvezero/db/schema";

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

const app = new Hono().basePath("/api");

// CORS: dev-open during login-first phase; allowlist (dash/api origins) at
// productionalization (readme §4a checklist). Must run BEFORE routes so the
// headers wrap every response.
app.use("*", async (c, next) => {
  await next();
  const origin = process.env.CORS_ORIGINS ?? "*";
  c.res.headers.set("access-control-allow-origin", origin);
  c.res.headers.set(
    "access-control-allow-credentials",
    origin === "*" ? "false" : "true",
  );
});

app
  .get("healthz", (c) => c.body(null, 204))
  .on(["GET", "POST"], ["auth/*"], (c) => auth.handler(c.req.raw))
  .get("me", async (c) => {
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

const server = Bun.serve({ port: PORT, fetch: app.fetch });
console.info(JSON.stringify({ module: "control", port: server.port, msg: "resolvezero control listening" }));

export { app };
