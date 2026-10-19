import { db, sanitizePgUrl } from "@resolvezero/db/client";
import { moduleLogger } from "./logger";
import { profileRules, profiles, profileSourceIps, profileZones } from "@resolvezero/db/schema";
import {
  isIpUpdateEvent,
  isRuleUpdateEvent,
  isZoneUpdateEvent,
  type IpUpdateEvent,
  type RuleUpdateEvent,
  type ZoneRecordType,
  type ZoneUpdateEvent,
} from "@resolvezero/shared";
import createListener, { type Subscriber } from "pg-listen";
import {
  RuleStore,
  type ProfileRow,
  type RuleAction,
  type RuleRow,
  type SourceIpRow,
  type ZoneRow,
} from "./ruleStore";

const log = moduleLogger("ruleSync");

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
export async function startRuleSync(
  store: RuleStore,
  /** Called (debounced) when blocklist subscriptions change in PG. */
  onBlocklistEvent?: () => void,
): Promise<Subscriber> {
  // NOTE: dedicated direct postgres connection — must NOT pass through
  // PgBouncer in transaction pooling mode (LISTEN is unsupported there).
  const subscriber = createListener({
    // same sslrootcert sanitization as the query client (pg-connection-
    // string would otherwise read sslrootcert=system as a file path)
    connectionString: sanitizePgUrl(DATABASE_URL!),
    maxAttempts: Infinity,
  });

  const bufferedRules: RuleUpdateEvent[] = [];
  const bufferedZones: ZoneUpdateEvent[] = [];
  const bufferedIps: IpUpdateEvent[] = [];
  let snapshotLoaded = false;

  // 1. Listener event handlers registered before connecting.
  subscriber.events.on("connected", () => {
    log.info("LISTEN connection established");
  });
  subscriber.events.on("error", (err) => {
    log.error({ err }, "LISTEN connection error");
  });

  subscriber.notifications.on("profile_updates", (payload) => {
    if (!isRuleUpdateEvent(payload)) {
      log.warn("unrecognized NOTIFY payload, ignoring");
      return;
    }
    if (snapshotLoaded) {
      store.applyEvent(payload);
    } else {
      bufferedRules.push(payload);
    }
  });

  subscriber.notifications.on("zone_updates", (payload) => {
    if (!isZoneUpdateEvent(payload)) {
      log.warn("unrecognized zone NOTIFY payload, ignoring");
      return;
    }
    if (snapshotLoaded) {
      store.applyZoneEvent(payload);
    } else {
      bufferedZones.push(payload);
    }
  });

  subscriber.notifications.on("blocklist_updates", () => {
    // Only the trigger matters — sync reloads ALL enabled lists itself.
    onBlocklistEvent?.();
  });

  subscriber.notifications.on("ip_updates", (payload) => {
    if (!isIpUpdateEvent(payload)) {
      log.warn("unrecognized ip NOTIFY payload, ignoring");
      return;
    }
    if (snapshotLoaded) {
      store.applySourceIpEvent(payload);
    } else {
      bufferedIps.push(payload);
    }
  });

  // pg-listen auto-reconnects on connection loss (and re-issues LISTEN for
  // its cached channels); re-reconcile the snapshot afterwards in case we
  // missed events while disconnected.
  let reconciling = false;
  let reconcileQueued = false;
  subscriber.events.on("reconnect", () => {
    log.warn("reconnected — re-snapshotting rules");
    snapshotLoaded = false;
    void reconcileGuarded();
  });

  async function reconcileGuarded(): Promise<void> {
    if (reconciling) {
      reconcileQueued = true;
      return;
    }
    reconciling = true;
    try {
      await reconcile();
    } finally {
      reconciling = false;
      if (reconcileQueued) {
        reconcileQueued = false;
        void reconcileGuarded();
      }
    }
  }

  // 2-4. Connect + LISTEN, then snapshot, then replay the buffers.
  await subscriber.connect();
  await subscriber.listenTo("profile_updates");
  await subscriber.listenTo("zone_updates");
  await subscriber.listenTo("ip_updates");
  await subscriber.listenTo("blocklist_updates");
  await reconcileGuarded();

  async function reconcile(): Promise<void> {
    const MAX_BUFFERED = 5000;
    const clamp = <T>(buf: T[]): void => {
      if (buf.length > MAX_BUFFERED) {
        buf.splice(0, buf.length - MAX_BUFFERED);
        log.warn("pre-snapshot buffer overflow, dropped oldest events");
      }
    };
    try {
      const [profileRows, ruleRows, sourceIpRows, zoneRows] = await Promise.all([
        db
          .select({
            id: profiles.id,
            dohToken: profiles.dohToken,
            logQueries: profiles.logQueries,
            upstream: profiles.upstream,
            upstreamUrl: profiles.upstreamUrl,
          })
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
        db
          .select({
            profileId: profileZones.profileId,
            domain: profileZones.domain,
            recordType: profileZones.recordType,
            values: profileZones.values,
            ttl: profileZones.ttl,
          })
          .from(profileZones),
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
          (p): ProfileRow => ({
            id: p.id,
            dohToken: p.dohToken,
            logQueries: p.logQueries,
            upstream: p.upstream,
            upstreamUrl: p.upstreamUrl ?? null,
          }),
        ),
        zoneRows.map(
          (z): ZoneRow => ({ ...z, recordType: z.recordType as ZoneRecordType }),
        ),
      );

      const ruleEvents = bufferedRules.splice(0);
      for (const event of ruleEvents) {
        store.applyEvent(event);
      }
      const zoneEvents = bufferedZones.splice(0);
      for (const event of zoneEvents) {
        store.applyZoneEvent(event);
      }
      const ipEvents = bufferedIps.splice(0);
      for (const event of ipEvents) {
        store.applySourceIpEvent(event);
      }

      snapshotLoaded = true;
      log.info({ stats: store.stats }, "snapshot loaded");
    } catch (err) {
      log.error({ err }, "reconcile failed, retrying in 2s");
      await Bun.sleep(2000);
      if (!snapshotLoaded) {
        clamp(bufferedRules as unknown[]);
        clamp(bufferedZones as unknown[]);
        clamp(bufferedIps as unknown[]);
      }
      await reconcile();
    }
  }

  return subscriber;
}
