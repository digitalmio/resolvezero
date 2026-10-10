import { moduleLogger } from "../logger";
import type { QueryLogRow } from "../batcher";

const log = moduleLogger("s3sink");

/** Minimal surface of Bun.S3Client we rely on (injectable for tests). */
export interface S3ClientLike {
  write(key: string, body: Uint8Array): Promise<unknown>;
  file(key: string): { arrayBuffer(): Promise<ArrayBuffer> };
  /** Bun's list() currently resolves to a single page ({contents:[{key}]}),
   *  not an AsyncIterable — and ignores `after` on some providers. Callers
   *  cap at maxKeys=1000 per prefix; TODO paginate when log volume forces it. */
  list(opts: { prefix: string }): Promise<{ contents: { key: string }[] }>;
  delete(key: string): Promise<unknown>;
}

export interface S3SinkOptions {
  client: S3ClientLike;
  /** Object key root. Default "logs". */
  prefix?: string;
  /** Flush window in minutes — one object per window per profile. Default 15. */
  flushMinutes?: number;
  log?: LoggerBaseLike;
}

/**
 * Key layout (SHARED CONTRACT with the Log Shipper/Vector path and the
 * /logs download + clear endpoints — do not change without updating all):
 *   {prefix}/{profileId}/{YYYY-MM-DD}/{HHmm}.{seq}.jsonl.gz
 * Raw NDJSON (one query event per line), gzip-compressed via Bun.gzipSync.
 */
export function logObjectKey(
  prefix: string,
  profileId: string,
  windowStart: Date,
  seq: number,
): string {
  const date = windowStart.toISOString().slice(0, 10);
  const hh = String(windowStart.getUTCHours()).padStart(2, "0");
  const mm = String(windowStart.getUTCMinutes()).padStart(2, "0");
  return `${prefix}/${profileId}/${date}/${hh}${mm}.${seq}.jsonl.gz`;
}

export function profilePrefix(prefix: string, profileId: string): string {
  return `${prefix}/${profileId}/`;
}

interface PendingObject {
  key: string;
  payload: Uint8Array;
  attempts: number;
}

/**
 * In-process raw-log sink: stages events in memory per flush window,
 * PUTs one gzip NDJSON object per completed window per profile.
 * Failed uploads are retained and retried on the next tick (cap 200
 * pending objects, oldest dropped + warned).
 *
 * Crash window = flushMinutes (raw events in RAM) — acceptable; rollups
 * (stats_hourly) are written independently and are the near-live path.
 */
export class S3ArchiveSink {
  private staging = new Map<string, { startsAt: number; profileId: string; lines: string[] }>();
  private pending: PendingObject[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private readonly log: LoggerBaseLike;

  constructor(private opts: S3SinkOptions) {
    this.log = opts.log ?? moduleLogger("s3sink");
    this.start();
  }

  private start(): void {
    const intervalMs = (this.opts.flushMinutes ?? 15) * 60_000;
    this.timer = setInterval(() => void this.flushCompleted(), intervalMs);
    this.timer.unref?.();
  }

  /** Append rows to their window staging buffers. Never throws. */
  add(rows: QueryLogRow[]): void {
    try {
      for (const row of rows) {
        const startsAt = windowFloor(row.loggedAt.getTime(), this.windowMs());
        const key = `${startsAt}|${row.profileId}`;
        let buf = this.staging.get(key);
        if (!buf) {
          buf = { startsAt, profileId: row.profileId, lines: [] };
          this.staging.set(key, buf);
        }
        buf.lines.push(JSON.stringify(lineFor(row)));
      }
    } catch (err) {
      this.log.error({ err }, "staging failed");
    }
  }

  /** PUT all staged windows whose window has fully elapsed. */
  async flushCompleted(): Promise<void> {
    const now = this.nowMs();
    for (const [key, buf] of [...this.staging]) {
      if (buf.startsAt + this.windowMs() <= now) {
        this.staging.delete(key);
        await this.put(this.objectKey(buf.startsAt, buf.profileId), buf.lines);
      }
    }
    await this.retryPending();
  }

  /** Force-PUT everything staged (SIGTERM / drain). */
  async flushAll(): Promise<void> {
    for (const [key, buf] of [...this.staging]) {
      this.staging.delete(key);
      await this.put(this.objectKey(buf.startsAt, buf.profileId), buf.lines);
    }
    await this.retryPending();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  get stats() {
    return {
      stagedWindows: this.staging.size,
      pendingUploads: this.pending.length,
      stagedLines: [...this.staging.values()].reduce((n, b) => n + b.lines.length, 0),
    };
  }

  // exposed for tests
  protected nowMs(): number {
    return Date.now();
  }

  private windowMs(): number {
    return (this.opts.flushMinutes ?? 15) * 60_000;
  }

  private objectKey(startsAt: number, profileId: string): string {
    return logObjectKey(
      this.opts.prefix ?? "logs",
      profileId,
      new Date(startsAt),
      this.seq++,
    );
  }

  private async put(key: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const payload = gzip(lines.join("\n"));
    try {
      await this.opts.client.write(key, payload);
      this.log.debug({ key, lines: lines.length }, "archive object written");
    } catch (err) {
      this.pending.push({ key, payload, attempts: 0 });
      if (this.pending.length > 200) {
        const dropped = this.pending.splice(0, this.pending.length - 200);
        this.log.warn({ dropped: dropped.length }, "pending archive uploads overflow, dropped oldest");
      }
      this.log.error({ err, key }, "archive upload failed (queued for retry)");
    }
  }

  private async retryPending(): Promise<void> {
    const still: PendingObject[] = [];
    for (const p of this.pending) {
      try {
        await this.opts.client.write(p.key, p.payload);
      } catch {
        if (++p.attempts > 48) { // 12h worth of 15-min retries
          this.log.error({ key: p.key }, "archive upload abandoned after max attempts");
          continue;
        }
        still.push(p);
      }
    }
    this.pending = still;
  }
}

export interface LoggerBaseLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Wire format for one archived query event (raw-log contract). */
export function lineFor(row: QueryLogRow): Record<string, unknown> {
  return {
    kind: "query",
    time: row.loggedAt.toISOString(),
    profile: row.profileId,
    domain: row.domain,
    action: row.action,
    rttMs: row.rttMs,
    clientIp: row.clientIp,
    // omit device:null — keep the raw-log schema minimal for tokenless queries
    ...(row.device ? { device: row.device } : {}),
    region: process.env.FLY_REGION ?? "local", // which PoP served this query
  };
}

function gzip(text: string): Uint8Array {
  return Bun.gzipSync(new TextEncoder().encode(text));
}

/** Aligns a timestamp to the flush window grid (aligned to unix epoch). */
export function windowFloor(t: number, windowMs: number): number {
  return Math.floor(t / windowMs) * windowMs;
}
