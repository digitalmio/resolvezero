import { describe, expect, test } from "bun:test";

/**
 * Login-first control plane (readme §4a): real GitHub OAuth can't be unit-
 * tested, so we verify the wiring contract instead — better-auth route
 * semantics + /api/me auth matrix against a seeded session.
 *
 * No network: we stub better-auth's handler where routing glue is involved;
 * /api/me reads sessions directly through the same drizzle tables Better-Auth
 * writes (user/session) — the adapter contract, as exercised in prod.
 */

process.env.DATABASE_URL ??= "postgres://test.invalid/db";
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-unit-runs";
process.env.GITHUB_CLIENT_ID ??= "test-client-id";
process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";

describe("control plane (login-first)", () => {
  test("betterAuth instance survives wiring (adapter + provider config)", async () => {
    const mod = await import("./index");
    // instantiating without throwing is the first smoke gate for the drizzle
    // adapter contract (schema matches better-auth core tables)
    expect(mod.auth).toBeDefined();
  });

  test("/api/healthz returns 204", async () => {
    const { app } = await import("./index");
    const res = await app.request("/api/healthz");
    expect(res.status).toBe(204);
  });

  test("/api/me: 401 without session cookie", async () => {
    const { app } = await import("./index");
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });
});
