import { db } from "@resolvezero/db/client";
import { profileRules, profiles, profileSourceIps } from "@resolvezero/db/schema";
import { isRuleUpdateEvent, type RuleUpdateEvent } from "@resolvezero/shared";
import createListener, { type Subscriber } from "pg-listen";
import {
  RuleStore,
  type ProfileRow,
  type RuleAction,
  type RuleRow,
  type SourceIpRow,
} from "./ruleStore";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

/**
 * Race-free rule sync (readme.md §3 B, Boot Phase):
 *   1. subscribe FIRST      — LISTEN registered before any snapshot
 *   2. buffer               — collect NOTIFY payloads arriving during snapshot
 *   3. snapshot             — bulk SELECT into the RuleStore
 *   4. reconcile            — replay buffered events in order (idempotent,
 *                             since each payload carries full row state)
 *
 * A change committed between steps 2-4 can only be *double-applied*, never
 * lost — events are upsert semantics, so replay is harmless.
 */
export async function startRuleSync(store: RuleStore): Promise<Subscriber> {
  // NOTE: dedicated direct postgres connection — must NOT pass through
  // PgBouncer in transaction pooling mode (LISTEN is unsupported there).
  const subscriber = createListener({
    connectionString: DATABASE_URL,
    maxAttempts: Infinity,
  });

  const buffered: RuleUpdateEvent[] = [];
  let snapshotLoaded = false;

  // 1. Listener event handlers registered before connecting.
  subscriber.events.on("connected", () => {
    console.log("[ruleSync] LISTEN connection established");
  });
  subscriber.events.on("error", (err) => {
    console.error("[ruleSync] connection error:", err.message);
  });

  subscriber.notifications.on("profile_updates", (payload) => {
    if (!isRuleUpdateEvent(payload)) {
      console.warn("[ruleSync] unrecognized NOTIFY payload, ignoring");
      return;
    }
    if (snapshotLoaded) {
      store.applyEvent(payload);
    } else {
      buffered.push(payload);
    }
  });

  // pg-listen auto-reconnects on connection loss (and re-issues LISTEN for
  // its cached channels); re-reconcile the snapshot afterwards in case we
  // missed events while disconnected.
  subscriber.events.on("reconnect", () => {
    console.warn("[ruleSync] reconnected — re-snapshotting rules");
    snapshotLoaded = false;
    void reconcile();
  });

  // 2-4. Connect + LISTEN, then snapshot, then replay the buffer.
  await subscriber.connect();
  await subscriber.listenTo("profile_updates");
  await reconcile();

  async function reconcile(): Promise<void> {
    try {
      const [profileRows, ruleRows, sourceIpRows] = await Promise.all([
        db
          .select({ id: profiles.id, dohToken: profiles.dohToken })
          .from(profiles),
        db
          .select({
            profileId: profileRules.profileId,
            domain: profileRules.domain,
            action: profileRules.action,
          })
          .from(profileRules),
        db
          .select({
            ipAddress: profileSourceIps.ipAddress,
            profileId: profileSourceIps.profileId,
          })
          .from(profileSourceIps),
      ]);

      // Snapshot replaces state atomically, then buffered events re-apply.
      store.replaceAll(
        ruleRows.map(
          (r): RuleRow => ({ ...r, action: r.action as RuleAction }),
        ),
        sourceIpRows.map(
          (s): SourceIpRow => ({ ipAddress: s.ipAddress, profileId: s.profileId }),
        ),
        profileRows.map(
          (p): ProfileRow => ({ id: p.id, dohToken: p.dohToken }),
        ),
      );

      const events = buffered.splice(0);
      for (const event of events) {
        store.applyEvent(event);
      }

      snapshotLoaded = true;
      console.log(`[ruleSync] snapshot loaded: ${JSON.stringify(store.stats)}`);
    } catch (err) {
      console.error("[ruleSync] reconcile failed, retrying in 2s:", err);
      await Bun.sleep(2000);
      void reconcile();
    }
  }

  return subscriber;
}
