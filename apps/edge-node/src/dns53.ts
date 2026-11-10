import { decode } from "dns-packet";
import dgram from "node:dgram";
import net from "node:net";
import type { QueryLogEntry, Upstream } from "./doh";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import type { RuleStore } from "./ruleStore";
import {
  UDP_MAX_PAYLOAD,
  blockedResponse,
  cnameResponse,
  decodeQuestion,
  noDataResponse,
  normalizeIp,
  nxdomainResponse,
  servfailResponse,
  refusedResponse,
  truncatedResponse,
  zoneAnswer,
} from "./wire";
import { moduleLogger } from "./logger";
import { localNameAnswer } from "@resolvezero/shared";
import { matchProbeNonce } from "./probe";
import { safeSearchTarget } from "./safeSearch";
import { createRateLimiter, positiveInt, Semaphore } from "./limits";
import type { Transport } from "./metrics";
import { resolveDnsPacket } from "./dns53Resolve";
import * as tuning from "./dns53Tuning";
import { PROXY_SIGNATURE, concatBytes, indexOfCrlf, matchesPrefix, type TcpState } from "./proxy";

const log = moduleLogger("dns53");

const UDP_RATE_LIMIT_PER_MIN = positiveInt(process.env.UDP_RATE_LIMIT_PER_MIN, 6000);
const TCP_RATE_LIMIT_PER_MIN = positiveInt(process.env.TCP_RATE_LIMIT_PER_MIN, 6000);
const UDP_MAX_INFLIGHT = positiveInt(process.env.UDP_MAX_INFLIGHT, 1024);

export interface Dns53Deps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
  recorder?: Recorder;
  /** Bind hostname — "fly-global-services" on Fly (mandatory for UDP there). */
  host?: string;
  port?: number;
  tcp?: boolean;
  /** Local suffixes for IP-encoded names (default: lan). */
  localDomains?: readonly string[];
  localTtl?: number;
  allowPublicIpEncoding?: boolean;
  /** Resolver-presence canary suffix; no public record should exist for it. */
  probeDomain?: string | null;
  /** Called for a valid probe lookup, after source-IP auth. */
  onProbeSeen?(nonce: string, transport: "doh" | "udp" | "tcp" | "dot"): void;
  /** Ensure this profile's lazy blocklist artifacts are loaded before policy. */
  ensureLists?(profileId: string): Promise<void>;
  /** Keep an actively used source-IP link alive (at most once/day). */
  onSourceSeen?(ip: string): void;
}

export interface Dns53Handle {
  stop(): Promise<void>;
  udpPort: number;
  tcpPort?: number;
  /** Run the policy pipeline for a caller already authenticated by another transport (DoT). */
  resolve(wire: Uint8Array, sourceIp: string, transport: Transport, profileId: string): Promise<Uint8Array | null>;
}

/**
 * Port-53 DNS ingress (readme §6.4, the Deco/router path):
 *  - UDP bound to `fly-global-services` (mandatory on Fly; define [[services]]
 *    udp 53 in fly.toml) + TCP for oversized/TC-fallback queries.
 *  - Auth = profile via source-IP whitelist (profile_source_ips). Unknown or
 *    unauthorized senders get REFUSED by default (UDP_UNKNOWN_SOURCE=refused)
 *    or silence with =silent (open-resolver defense, readme §4).
 * - Same pipeline as DoH: zone override → blocklist → LRU → upstream.
 */
export async function createDns53Service(deps: Dns53Deps): Promise<Dns53Handle | null> {
  const host = deps.host ?? process.env.UDP_HOST ?? "fly-global-services";
  const port = deps.port ?? Number(process.env.UDP_PORT ?? 53);
  const tcpStates = new WeakMap<object, TcpState>();
  const udpRateLimit = createRateLimiter(UDP_RATE_LIMIT_PER_MIN, 60_000, 20_000);
  const queryRateLimit = createRateLimiter(TCP_RATE_LIMIT_PER_MIN, 60_000, 20_000);
  const udpSlots = new Semaphore(UDP_MAX_INFLIGHT);
  const tcpSlots = new Semaphore(tuning.TCP_MAX_INFLIGHT);
  const tcpSourceCounts = new Map<string, number>();

  let udp: dgram.Socket | undefined;
  let tcp: net.Server | undefined;

  try {
    udp = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      udp!.once("error", onError);
      udp!.bind({ address: host, port }, () => {
        udp!.off("error", onError);
        resolve();
      });
    });
    udp.on("error", (err) => log.error({ err }, "udp socket error"));
    udp.on("message", (data, rinfo) => {
      const started = performance.now();
      const sourceIp = normalizeIp(rinfo.address);
      if (!udpRateLimit(sourceIp)) {
        deps.recorder?.recordDrop("udp_rate_limited");
        return;
      }
      if (!udpSlots.tryAcquire()) {
        deps.recorder?.recordDrop("udp_inflight_limit");
        return;
      }
      void handleUdp(new Uint8Array(data), sourceIp)
        .then((reply) => {
          if (!reply) return;
          udp!.send(reply, rinfo.port, rinfo.address, (err) => {
            if (err) log.warn({ err }, "udp send failed");
          });
        })
        .catch((err) => log.error({ err }, "udp handler failed"))
        .finally(() => {
          udpSlots.release();
          deps.recorder?.recordDuration("udp", performance.now() - started);
        });
    });
    log.info({ host, port }, "UDP 53 listening");
  } catch (err) {
    log.warn({ err, host, port }, "UDP 53 unavailable (local dev? port in use?) — continuing without DNS ingress");
    try { udp?.close(); } catch { /* not bound */ }
    return null;
  }

  if (deps.tcp ?? true) {
    // Fly's TCP service proxy connects to the instance's wildcard address,
    // while `fly-global-services` is UDP-specific. Binding TCP there makes it
    // unreachable (proxy: "is your app listening on 0.0.0.0:53?").
    const tcpHost = process.env.TCP_HOST ?? (host === "fly-global-services" ? "0.0.0.0" : host);
    try {
      tcp = net.createServer((socket) => {
        const deadline = setTimeout(() => {
          log.warn({ lifetimeMs: tuning.TCP_MAX_LIFETIME_MS }, "closing long-lived TCP DNS connection");
          socket.destroy();
        }, tuning.TCP_MAX_LIFETIME_MS);
        deadline.unref?.();
        socket.setTimeout(tuning.TCP_IDLE_TIMEOUT_MS, () => {
          log.warn({ timeoutMs: tuning.TCP_IDLE_TIMEOUT_MS }, "closing idle TCP DNS connection");
          socket.destroy();
        });
        socket.on("data", (chunk) => tcpData(socket, new Uint8Array(chunk)));
        socket.on("error", (err) => log.warn({ err }, "tcp socket error"));
        socket.on("close", () => {
          clearTimeout(deadline);
          const state = tcpStates.get(socket);
          if (state?.counted) {
            const current = tcpSourceCounts.get(state.sourceIp) ?? 0;
            if (current <= 1) tcpSourceCounts.delete(state.sourceIp);
            else tcpSourceCounts.set(state.sourceIp, current - 1);
          }
          tcpStates.delete(socket);
        });
      });
      tcp.maxConnections = tuning.TCP_MAX_CONNECTIONS;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        tcp!.once("error", onError);
        tcp!.listen({ host: tcpHost, port }, () => {
          tcp!.off("error", onError);
          resolve();
        });
      });
      tcp.on("error", (err) => log.warn({ err }, "tcp listener error"));
      log.info({ host: tcpHost, port }, "TCP 53 listening");
    } catch (err) {
      log.warn({ err }, "TCP 53 unavailable — TC-flag fallback still works; oversized queries fail");
      try { tcp?.close(); } catch { /* not bound */ }
      tcp = undefined;
    }
  }

  const udpPort = udp.address().port;
  return {
    udpPort,
    tcpPort: tcp ? port : undefined,
    resolve: (wire, sourceIp, transport, profileId) =>
      resolveDnsPacket(deps, queryRateLimit, wire, sourceIp, transport, profileId),
    async stop() {
      await new Promise<void>((resolve) => udp!.close(() => resolve()));
      if (tcp) {
        tcp.close();
        (tcp as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }
    },
  };

  // ---- UDP path ----
  async function handleUdp(wire: Uint8Array, sourceIp: string): Promise<Uint8Array | null> {
    const reply = await resolveDnsPacket(deps, queryRateLimit, wire, sourceIp, "udp");
    if (reply && reply.length > UDP_MAX_PAYLOAD) {
      // TC bit — real clients will retry over TCP
      const q = decodeQuestion(wire);
      return truncatedResponse(q);
    }
    return reply;
  }

  // ---- TCP framing path (2-byte length prefix per RFC 1035) ----
  // Fly's TCP proxy hides the client address; the `proxy_proto` handler
  // prepends a v1 header ("PROXY TCP4 src dst sport dport\r\n"). Parse it
  // when present, otherwise fall back to the socket peer address (local /
  // direct deployments). Also buffers partial writes and multiple frames.
  function tcpData(socket: net.Socket, chunk: Uint8Array): void {
    let state = tcpStates.get(socket);
    if (!state) {
      state = {
        buffer: new Uint8Array(0),
        headerParsed: false,
        sourceIp: normalizeIp(socket.remoteAddress ?? ""),
        counted: false,
      };
      tcpStates.set(socket, state);
    }
    if (state.buffer.length + chunk.length > tuning.TCP_MAX_BUFFER_BYTES) {
      log.warn({ bytes: state.buffer.length + chunk.length }, "closing oversized TCP DNS buffer");
      socket.destroy();
      return;
    }
    state.buffer = concatBytes(state.buffer, chunk);

    if (!state.headerParsed) {
      const couldBeProxy = matchesPrefix(state.buffer, PROXY_SIGNATURE);
      if (couldBeProxy && state.buffer.length < PROXY_SIGNATURE.length) return; // wait for full signature
      if (couldBeProxy) {
        const end = indexOfCrlf(state.buffer);
        if (end < 0) return; // wait for the header terminator
        const line = new TextDecoder().decode(state.buffer.slice(0, end));
        const parts = line.split(" ");
        // "PROXY TCP4 1.2.3.4 5.6.7.8 1234 53" — UNKNOWN has no addresses.
        if (parts[1] && parts[1] !== "UNKNOWN" && parts[2]) {
          state.sourceIp = normalizeIp(parts[2]);
        }
        state.buffer = state.buffer.slice(end + 2);
      }
      state.headerParsed = true;
    }

    if (!state.counted) {
      const active = tcpSourceCounts.get(state.sourceIp) ?? 0;
      if (active >= tuning.TCP_MAX_CONNECTIONS_PER_SOURCE) {
        log.warn({ sourceIp: state.sourceIp, active }, "closing TCP DNS connection over per-source cap");
        socket.destroy();
        return;
      }
      if (tcpSourceCounts.size > 10_000) tcpSourceCounts.clear();
      tcpSourceCounts.set(state.sourceIp, active + 1);
      state.counted = true;
    }

    // Process every complete DNS frame in the buffer.
    for (;;) {
      if (state.buffer.length < 2) return;
      const expected = (state.buffer[0]! << 8) | state.buffer[1]!;
      if (expected === 0) {
        log.warn("closing TCP DNS connection with zero-length frame");
        socket.destroy();
        return;
      }
      if (state.buffer.length < expected + 2) return;
      const wire = state.buffer.slice(2, 2 + expected);
      state.buffer = state.buffer.slice(2 + expected);
      const sourceIp = state.sourceIp;
      const started = performance.now();
      if (!tcpSlots.tryAcquire()) {
        deps.recorder?.recordDrop("tcp_inflight_limit");
        socket.destroy();
        return;
      }
      void resolveDnsPacket(deps, queryRateLimit, wire, sourceIp, "tcp")
        .then((reply) => {
          if (!reply) return;
          const frame = new Uint8Array(reply.length + 2);
          frame[0] = reply.length >> 8;
          frame[1] = reply.length & 0xff;
          frame.set(reply, 2);
          if (socket.writableLength > tuning.TCP_MAX_BUFFER_BYTES) {
            log.warn({ pending: socket.writableLength }, "closing TCP DNS connection with backed-up writes");
            socket.destroy();
            return;
          }
          socket.write(frame);
        })
        .catch((err) => log.error({ err }, "tcp handler failed"))
        .finally(() => {
          tcpSlots.release();
          deps.recorder?.recordDuration("tcp", performance.now() - started);
        });
    }
  }

}

