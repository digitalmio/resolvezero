import { Hono } from "hono";
import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";
import { profilePrefix, type S3ClientLike } from "./sinks/s3";

const log = moduleLogger("logs");

const CSV_HEADER = "time,domain,action,client_ip,rtt_ms\n";

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
    if (!deps.store.hasProfile(profileId, c.req.query("token"))) {
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

    const keys: string[] = [];
    const page = await deps.client.list({ prefix: objectPrefix });
    for (const obj of page.contents ?? []) keys.push(obj.key);
    keys.sort();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (format === "csv") controller.enqueue(encoder.encode(CSV_HEADER));
        try {
          for (const key of keys) {
            const raw = new TextDecoder().decode(
              Bun.gunzipSync(new Uint8Array(await deps.client!.file(key).arrayBuffer())),
            );
            for (const line of raw.split("\n")) {
              if (!line) continue;
              if (format === "jsonl") {
                controller.enqueue(encoder.encode(line + "\n"));
                continue;
              }
              const e = JSON.parse(line) as Record<string, unknown>;
              const row = [
                e.time,
                e.domain,
                e.action,
                e.clientIp ?? "",
                e.rttMs ?? "",
              ].join(",");
              controller.enqueue(encoder.encode(row + "\n"));
            }
          }
        } catch (err) {
          log.error({ err }, "log download failed mid-stream");
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
        "content-disposition": `attachment; filename="rz-logs-${profileId}${date ? "-" + date : ""}.${format}"`,
      },
    });
  });

  app.delete(":profileId/logs", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, c.req.query("token"))) {
      return c.body(null, 404);
    }
    if (!deps.client) {
      return c.json({ error: "raw log archive not configured" }, 503);
    }

    const keys: string[] = [];
    const page = await deps.client.list({ prefix: profilePrefix(prefix, profileId) });
    for (const obj of page.contents ?? []) keys.push(obj.key);
    await Promise.all(keys.map((k) => deps.client!.delete(k)));
    log.info({ profileId, removed: keys.length }, "raw logs cleared");
    return c.json({ removed: keys.length });
  });

  return app;
}
