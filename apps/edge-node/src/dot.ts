import net from "node:net";

import { moduleLogger } from "./logger";
import { positiveInt, Semaphore } from "./limits";
import type { RuleStore } from "./ruleStore";

const log = moduleLogger("dot");

const DOT_PORT = positiveInt(process.env.DOT_PORT, 853);
const DOT_SUFFIX = (process.env.DOT_SUFFIX ?? ".dot.resolvezero.com").toLowerCase();
const DOT_MAX_CONNECTIONS = positiveInt(process.env.DOT_MAX_CONNECTIONS, 512);
const DOT_MAX_CONNECTIONS_PER_SOURCE = positiveInt(process.env.DOT_MAX_CONNECTIONS_PER_SOURCE, 16);
const DOT_MAX_INFLIGHT = positiveInt(process.env.DOT_MAX_INFLIGHT, 128);
const DOT_MAX_BUFFER_BYTES = positiveInt(process.env.DOT_MAX_BUFFER_BYTES, 65_536);
const DOT_IDLE_TIMEOUT_MS = positiveInt(process.env.DOT_IDLE_TIMEOUT_MS, 120_000);
const DOT_MAX_LIFETIME_MS = positiveInt(process.env.DOT_MAX_LIFETIME_MS, 600_000);

import { parseProxyV2, type ProxyV2Info } from "./proxy";
/** `<label>.dot.resolvezero.com` → `label`; anything else → null. */
export function dotLabel(hostname: string, suffix = DOT_SUFFIX): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label) ? label : null;
}

export interface DotDeps {
  store: RuleStore;
  /** Policy pipeline shared with UDP/TCP/DoH. */
  resolve(wire: Uint8Array, sourceIp: string, profileId: string): Promise<Uint8Array | null>;
  port?: number;
}

export interface DotHandle {
  port: number;
  stop(): Promise<void>;
}

interface ConnectionState {
  buffer: Uint8Array;
  headerParsed: boolean;
  profileId: string | null;
  sourceIp: string;
}


function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * DNS-over-TLS ingress. TLS is terminated by Fly's proxy (the `tls` handler),
 * which prepends a PROXY v2 header carrying the client address and the SNI
 * authority TLV. We map `<label>.dot.resolvezero.com` → profile and run the
 * same policy pipeline as the other transports.
 */
export async function createDotService(deps: DotDeps): Promise<DotHandle | null> {
  const port = deps.port ?? DOT_PORT;
  const inflight = new Semaphore(DOT_MAX_INFLIGHT);
  const perSource = new Map<string, number>();
  let active = 0;

  const server = net.createServer((socket) => {
    if (active >= DOT_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    active += 1;

    const state: ConnectionState = {
      buffer: new Uint8Array(0),
      headerParsed: false,
      profileId: null,
      sourceIp: socket.remoteAddress ?? "",
    };

    const lifetime = setTimeout(() => socket.destroy(), DOT_MAX_LIFETIME_MS);
    socket.setTimeout(DOT_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(lifetime);
      active -= 1;
      if (state.sourceIp) {
        const current = perSource.get(state.sourceIp) ?? 0;
        if (current <= 1) perSource.delete(state.sourceIp);
        else perSource.set(state.sourceIp, current - 1);
      }
    });
    socket.on("error", () => socket.destroy());

    socket.on("data", (chunk) => {
      state.buffer = concat(state.buffer, new Uint8Array(chunk));
      if (state.buffer.length > DOT_MAX_BUFFER_BYTES) {
        socket.destroy();
        return;
      }

      if (!state.headerParsed) {
        const parsed = parseProxyV2(state.buffer);
        if (parsed.status === "need-more") return;
        if (parsed.status === "invalid") {
          log.warn("closing DoT connection without a valid PROXY v2 header");
          socket.destroy();
          return;
        }

        const suffix = DOT_SUFFIX;
        const label = parsed.info.authority ? dotLabel(parsed.info.authority, suffix) : null;
        const profileId = label ? deps.store.authorizeDotId(label) : undefined;
        if (!profileId) {
          log.warn({ authority: parsed.info.authority }, "closing DoT connection with unknown hostname");
          socket.destroy();
          return;
        }

        state.profileId = profileId;
        state.sourceIp = parsed.info.sourceIp ?? state.sourceIp;
        state.buffer = state.buffer.slice(parsed.length);
        state.headerParsed = true;

        const current = perSource.get(state.sourceIp) ?? 0;
        if (current >= DOT_MAX_CONNECTIONS_PER_SOURCE) {
          socket.destroy();
          return;
        }
        if (perSource.size > 10_000) perSource.clear();
        perSource.set(state.sourceIp, current + 1);
      }

      for (;;) {
        if (state.buffer.length < 2) return;
        const expected = (state.buffer[0]! << 8) | state.buffer[1]!;
        if (expected === 0) {
          socket.destroy();
          return;
        }
        if (state.buffer.length < expected + 2) return;

        const wire = state.buffer.slice(2, 2 + expected);
        state.buffer = state.buffer.slice(2 + expected);
        const profileId = state.profileId;
        if (!profileId) return;

        if (!inflight.tryAcquire()) {
          socket.destroy();
          return;
        }

        void deps
          .resolve(wire, state.sourceIp, profileId)
          .then((reply) => {
            if (!reply) return;
            const frame = new Uint8Array(reply.length + 2);
            frame[0] = reply.length >> 8;
            frame[1] = reply.length & 0xff;
            frame.set(reply, 2);
            if (socket.writableLength > DOT_MAX_BUFFER_BYTES) {
              socket.destroy();
              return;
            }
            socket.write(frame);
          })
          .catch((err) => log.warn({ err }, "DoT query failed"))
          .finally(() => inflight.release());
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    log.error({ err }, "DoT listener failed to bind");
    return null;
  }

  server.on("error", (err) => log.warn({ err }, "DoT server error"));
  log.info({ port }, "DoT listening");

  return {
    port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    },
  };
}

export { parseProxyV2 } from "./proxy";
