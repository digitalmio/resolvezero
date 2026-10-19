import { Hono } from "hono";
import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";
import { listAllKeys, profilePrefix, type S3ClientLike } from "./sinks/s3";

const log = moduleLogger("logs");

const CSV_HEADER = "time,domain,action,client_ip,rtt_ms\n";
// Cap inflated log objects at 32 MB — a poisoned/oversized archive object
// must not OOM the 256 MB edge during download.
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

function bearerOrQuery(c: { req: { query(k: string): string | undefined; header(n: string): string | undefined } }): string | undefined {
  const q = c.req.query("token");
  if (q) return q;
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || undefined;
  return undefined;
}

function csvField(v: unknown): string {
  const s = String(v ?? "");
  // Quote always (commas/quotes/newlines in domains) + neutralize spreadsheet
  // formula injection (=,+,-,@,tab) per OWASP CSV guidance.
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface LogsDeps {
  store: RuleStore;
  /** Present only when S3 archive is configured (raw logs live there). */
  client: S3ClientLike | null;
  /** Same object key root as the sinks (default "logs"). */
  prefix?: string;
}

/**
 * Raw-log manager endpoints (NextDNS-parity, readme §6):
 *   GET    /v1/:profileId/logs?format=jsonl|csv&date=YYYY-MM-DD[&token=]
 *   DELETE /v1/:profileId/logs[?token=]
 *
 * Streams objects from the archive bucket; retention/enforcement of the
 * physical raw-log lifetime is the bucket's lifecycle rule (deploy-side).
 */
export function createLogsApp(deps: LogsDeps) {
  const app = new Hono().basePath("/v1");
  const prefix = deps.prefix ?? "logs";

  app.get(":profileId/logs", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    if (!deps.client) {
      return c.json({ error: "raw log archive not configured" }, 503);
    }

    const format = c.req.query("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "csv") {
      return c.json({ error: "format must be jsonl|csv" }, 400);
    }

    let date = c.req.query("date") ?? "";
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    }

    const objectPrefix = date
      ? `${profilePrefix(prefix, profileId)}${date}/`
      : profilePrefix(prefix, profileId);

    const { keys, truncated } = await listAllKeys(deps.client, objectPrefix);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (truncated) {
          controller.enqueue(
            encoder.encode(format === "jsonl" ? `{"warning":"truncated at ${keys.length} objects"}\n` : `# warning: truncated at ${keys.length} objects\n`),
          );
        }
        if (format === "csv") controller.enqueue(encoder.encode(CSV_HEADER));
        try {
          for (const key of keys) {
            const compressed = new Uint8Array(await deps.client!.file(key).arrayBuffer());
            if (compressed.length > MAX_INFLATED_BYTES) {
              log.warn({ key }, "log object too large, skipped");
              continue;
            }
            let raw: string;
            try {
              raw = new TextDecoder().decode(Bun.gunzipSync(compressed.slice(0, MAX_INFLATED_BYTES + 1)));
            } catch (err) {
              log.error({ err, key }, "log object corrupt, skipped");
              continue;
            }
            if (raw.length > MAX_INFLATED_BYTES) {
              log.warn({ key }, "log object inflated too large, skipped");
              continue;
            }
            for (const line of raw.split("\n")) {
              if (!line) continue;
              if (format === "jsonl") {
                controller.enqueue(encoder.encode(line + "\n"));
                continue;
              }
              const e = JSON.parse(line) as Record<string, unknown>;
              const row = [
                csvField(e.time),
                csvField(e.domain),
                csvField(e.action),
                csvField(e.clientIp ?? ""),
                csvField(e.rttMs ?? ""),
              ].join(",");
              controller.enqueue(encoder.encode(row + "\n"));
            }
          }
        } catch (err) {
          log.error({ err }, "log download failed mid-stream");
          controller.error(err instanceof Error ? err : new Error(String(err)));
          return;
        } finally {
          try {
            controller.close();
          } catch {
            // already errored
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
        "content-disposition": `attachment; filename="rz-logs-${profileId}${date ? "-" + date : ""}.${format}"`,
        ...(truncated ? { "x-rz-truncated": "true" } : {}),
      },
    });
  });

  app.delete(":profileId/logs", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    if (!deps.client) {
      return c.json({ error: "raw log archive not configured" }, 503);
    }

    const { keys, truncated } = await listAllKeys(deps.client, profilePrefix(prefix, profileId));
    await Promise.all(keys.map((k) => deps.client!.delete(k)));
    log.info({ profileId, removed: keys.length, truncated }, "raw logs cleared");
    // Never claim completeness when the listing was truncated.
    return c.json({ removed: keys.length, truncated });
  });

  return app;
}
