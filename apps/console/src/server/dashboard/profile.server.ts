import { asc, desc, eq } from "drizzle-orm";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@resolvezero/db/client";
import { profiles, statsHourly } from "@resolvezero/db/schema";

/**
 * Resolve the profile this session is allowed to see. Every query below is
 * scoped by the owning user id; there is no global "latest profile" fallback.
 */
export async function findProfile(ownerUserId: string): Promise<{ id: string; name: string }> {
  const owned = await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt));

  if (owned.length === 0) {
    throw new Error("No DNS profile is linked to this account.");
  }

  const preferred = preferredProfileId();
  if (preferred) {
    const match = owned.find((profile) => profile.id === preferred);
    if (match) return match;
  }

  const configuredProfile = process.env.DASHBOARD_PROFILE_ID;
  if (configuredProfile) {
    const configured = owned.find((profile) => profile.id === configuredProfile);
    if (configured) return configured;
  }

  // Prefer the owned profile with the most recent rollup so the dashboard
  // follows the profile that is actually serving queries.
  const latest = await db
    .select({ profileId: statsHourly.profileId })
    .from(statsHourly)
    .innerJoin(profiles, eq(statsHourly.profileId, profiles.id))
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(desc(statsHourly.hour))
    .limit(1);
  if (latest[0]) {
    const active = owned.find((profile) => profile.id === latest[0]!.profileId);
    if (active) return active;
  }

  return owned[0]!;
}

/** Profile selection is a UI preference; ownership is re-checked in findProfile. */
function preferredProfileId(): string | null {
  try {
    const cookie = getRequestHeaders().get("cookie") ?? "";
    const match = cookie.match(/(?:^|;\s*)rz_profile_id=([^;]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function ownedProfiles(ownerUserId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt));
}
