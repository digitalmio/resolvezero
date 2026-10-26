import "@tanstack/react-start/server-only";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "@resolvezero/db/client";
import { account, session, user, verification } from "@resolvezero/db/schema";

import { requiredEnv } from "./env.server";

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
};

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  appName: "ResolveZero",
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (isProduction ? requiredEnv("BETTER_AUTH_URL") : "http://localhost:3000"),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  socialProviders: {
    github: {
      clientId: requiredEnv("GITHUB_CLIENT_ID"),
      clientSecret: requiredEnv("GITHUB_CLIENT_SECRET"),
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  // Must be the last plugin: it forwards better-auth's Set-Cookie headers
  // through TanStack Start's response helpers.
  plugins: [tanstackStartCookies()],
});

/** Read the current session inside a server function/route handler. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!result?.user) return null;
  return {
    id: result.user.id,
    name: result.user.name || "Account",
    email: result.user.email ?? null,
    image: result.user.image ?? null,
  };
}

/** The data boundary: every private server function calls this. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export function toViewer(user: SessionUser): { name: string; image: string | null; email: string | null } {
  return { name: user.name, image: user.image, email: user.email };
}
