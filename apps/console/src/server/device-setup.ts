import { createServerFn } from "@tanstack/react-start";

export interface DeviceSetup {
  profileId: string;
  profileName: string;
  /** Base for DoH URLs: `<dohBase>/<device>/<token>`. */
  dohBase: string;
  token: string;
  /** `<dotId>.dot.resolvezero.com`, or null until generated. */
  dotHostname: string | null;
}

const DOT_SUFFIX = (process.env.DOT_SUFFIX ?? ".dot.resolvezero.com").toLowerCase();
const DOH_BASE = (process.env.DOH_PUBLIC_URL ?? "https://doh.resolvezero.com").replace(/\/+$/, "");
const DOT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomDotId(length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += DOT_ALPHABET[byte % DOT_ALPHABET.length];
  return out;
}

async function sessionProfile() {
  const [{ db }, { eq }, { requireSessionUser }, { findProfile }, { profiles }] = await Promise.all([
    import("@resolvezero/db/client"),
    import("drizzle-orm"),
    import("./auth.server"),
    import("./dashboard/profile.server"),
    import("@resolvezero/db/schema"),
  ]);
  const user = await requireSessionUser();
  const profile = await findProfile(user.id);
  return { db, eq, profiles, user, profile };
}

export const getDeviceSetup = createServerFn({ method: "GET" }).handler(async (): Promise<DeviceSetup> => {
  const { db, eq, profiles, profile } = await sessionProfile();
  const [row] = await db
    .select({ token: profiles.dohToken, dotId: profiles.dotId })
    .from(profiles)
    .where(eq(profiles.id, profile.id))
    .limit(1);
  if (!row?.token) throw new Error("This profile has no DoH token yet.");

  return {
    profileId: profile.id,
    profileName: profile.name,
    dohBase: `${DOH_BASE}/v1/${profile.id}`,
    token: row.token,
    dotHostname: row.dotId ? `${row.dotId}${DOT_SUFFIX}` : null,
  };
});

/** Generate the DoT label on first use; idempotent afterwards. */
export const ensureDotId = createServerFn({ method: "POST" }).handler(async (): Promise<{ hostname: string }> => {
  const { db, eq, profiles, profile } = await sessionProfile();
  const [row] = await db
    .select({ dotId: profiles.dotId })
    .from(profiles)
    .where(eq(profiles.id, profile.id))
    .limit(1);
  if (row?.dotId) return { hostname: `${row.dotId}${DOT_SUFFIX}` };

  const dotId = randomDotId();
  await db.update(profiles).set({ dotId }).where(eq(profiles.id, profile.id));
  return { hostname: `${dotId}${DOT_SUFFIX}` };
});
