/**
 * Node artifact worker: keeps content-addressed RZA1 artifacts fresh in S3.
 *
 * Drop-in replacement for `resolvezero-compiler` (Rust). It reads the same
 * `profile_blocklists` rows, writes the same `rule_artifacts` / `artifact_hash`
 * columns, bumps the same blocklist watermark, and heartbeats the same
 * `compiler_status` table.
 *
 * COMPILER_SHADOW=1 uploads artifacts and records rule_artifacts but does not
 * update profile_blocklists or bump blocklist_version. Use it to run alongside
 * the Rust compiler during cutover.
 */
import {
  createArtifactStore,
  compileUrl,
  redactUrl,
  type ArtifactStore,
} from "@resolvezero/rules";

import {
  artifactExists,
  artifactFreshness,
  blocklistVersion,
  bumpBlocklistVersion,
  closeDb,
  compileTargets,
  heartbeat,
  recordArtifact,
  recordCycle,
  recordCycleError,
  setBlocklistArtifact,
  writeBlocklistStatus,
  type CycleStatus,
} from "./db";
import { isStale } from "./schedule";
import { configFromEnv, errorMessage, log, sleep, type Config } from "./support";

async function uploadWithRetry(
  store: ArtifactStore,
  hash: string,
  data: Uint8Array,
  sidecar: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await store.put(hash, data, sidecar);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function cycle(
  config: Config,
  store: ArtifactStore,
  force: boolean,
): Promise<CycleStatus> {
  const targets = await compileTargets();
  const now = Math.floor(Date.now() / 1000);
  const status: CycleStatus = {
    total: targets.length,
    stale: 0,
    compiled: 0,
    failed: 0,
    changed: 0,
    missingArtifacts: 0,
    oldestCompiledAt: null,
    blocklistVersion: 0,
    error: null,
  };

  for (const target of targets) {
    if (!isStale(target, now, config.intervalSeconds, force)) continue;
    status.stale += 1;

    try {
      const compiled = await compileUrl(target.url, {
        format: target.format,
        maxBytes: config.maxBytes,
        maxEntries: config.maxEntries,
        source: target.url,
      });

      if (!(await store.exists(compiled.hash))) {
        await uploadWithRetry(store, compiled.hash, compiled.data, compiled.sidecar);
      }
      if (!(await artifactExists(compiled.hash))) {
        await recordArtifact({
          hash: compiled.hash,
          sourceUrl: target.url,
          bytes: compiled.data.length,
          allow: compiled.allow,
          block: compiled.block,
          compiler: "rz-compile-node/0.1",
        });
      }

      const changed = target.artifactHash !== compiled.hash;
      if (!config.shadow) {
        await setBlocklistArtifact(target.url, compiled.hash, compiled.rules);
        await writeBlocklistStatus(target.url, "ok", compiled.rules, compiled.detectedFormat);
      }
      status.compiled += 1;
      if (changed) status.changed += 1;
      log("info", "artifact ready", {
        url: redactUrl(target.url),
        rules: compiled.rules,
        changed,
        hash: compiled.hash.slice(0, 12),
        shadow: config.shadow,
      });
    } catch (err) {
      const message = errorMessage(err);
      status.failed += 1;
      status.error ??= `${redactUrl(target.url)}: ${message.slice(0, 160)}`;
      log("warn", "compile failed", { url: redactUrl(target.url), err: message });
      if (!config.shadow) {
        await writeBlocklistStatus(
          target.url,
          `error: ${message.slice(0, 42)}`,
          0,
        ).catch((statusErr) => log("warn", "status write failed", { err: errorMessage(statusErr) }));
      }
    }
  }

  const freshness = await artifactFreshness();
  status.oldestCompiledAt = freshness.oldestCompiledAt;
  status.missingArtifacts = freshness.missingArtifacts;
  status.blocklistVersion = await blocklistVersion();
  return status;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const store = createArtifactStore();
  if (!store) {
    throw new Error("S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are required");
  }

  let running = true;
  process.on("SIGTERM", () => {
    running = false;
  });
  process.on("SIGINT", () => {
    running = false;
  });

  const heartbeatTimer = setInterval(() => {
    void heartbeat(config.instance).catch((err) =>
      log("error", "compiler heartbeat failed", { err: errorMessage(err) }),
    );
  }, config.heartbeatSeconds * 1000);
  heartbeatTimer.unref?.();

  log("info", "artifact compiler started", {
    instance: config.instance,
    interval_secs: config.intervalSeconds,
    poll_secs: config.pollSeconds,
    heartbeat_secs: config.heartbeatSeconds,
    shadow: config.shadow,
  });

  let force = config.forceOnce;
  let pendingBump = false;
  while (running) {
    try {
      const status = await cycle(config, store, force);
      if (status.changed > 0) pendingBump = true;
      if (pendingBump && !config.shadow) {
        try {
          await bumpBlocklistVersion();
          pendingBump = false;
          log("info", "blocklist_version bumped");
        } catch (err) {
          status.error = `blocklist_version bump failed: ${errorMessage(err)}`;
          log("error", "blocklist_version bump failed", { err: errorMessage(err) });
        }
      }
      await recordCycle(config.instance, status);
      log("info", "compile cycle complete", {
        total: status.total,
        stale: status.stale,
        compiled: status.compiled,
        failed: status.failed,
        changed: status.changed,
        missing: status.missingArtifacts,
      });
    } catch (err) {
      const message = errorMessage(err);
      log("error", "compile cycle failed", { err: message });
      await recordCycleError(config.instance, message).catch(() => undefined);
    }

    force = false;
    if (config.once) break;
    for (let waited = 0; running && waited < config.pollSeconds; waited += 1) {
      await sleep(1000);
    }
  }

  clearInterval(heartbeatTimer);
  await closeDb();
  log("info", "artifact compiler stopped");
}

main().catch((err) => {
  log("error", "artifact compiler crashed", { err: errorMessage(err) });
  process.exitCode = 1;
});
