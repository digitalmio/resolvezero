import { decode } from "dns-packet";
import type { QueryLogEntry, Upstream } from "./doh";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import type { RuleStore } from "./ruleStore";
import {
  UDP_MAX_PAYLOAD,
  decodeQuestion,
  normalizeIp,
  sinkholeResponse,
  servfailResponse,
  refusedResponse,
  truncatedResponse,
  zoneAnswer,
} from "./wire";
import { moduleLogger } from "./logger";

const log = moduleLogger("dns53");

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
}

export interface Dns53Handle {
  stop(): Promise<void>;
  udpPort: number;
  tcpPort?: number;
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
/** Bun runtime socket surfaces, pinned structurally (types churn between versions). */
interface UdpSocketLike {
  readonly port: number;
  readonly hostname: string;
  send(data: Uint8Array, port: number, address: string): number;
  ref?(): void;
  unref?(): void;
  close(): void;
}
interface TcpListenerLike {
  readonly port: number;
  stop(closeActive?: boolean): void;
}

export async function createDns53Service(deps: Dns53Deps): Promise<Dns53Handle | null> {
  const host = deps.host ?? process.env.UDP_HOST ?? "fly-global-services";
  const port = deps.port ?? Number(process.env.UDP_PORT ?? 53);

  let udp: UdpSocketLike | undefined;
  let tcp: TcpListenerLike | undefined;

  try {
    udp = (await Bun.udpSocket<"buffer">({
      hostname: host,
      port,
      socket: {
        data(sock: { send(data: Uint8Array, port: number, address: string): number }, data: Uint8Array | string, _port: number, addr: string) {
          void handleUdp(new Uint8Array(data as Uint8Array), normalizeIp(addr)).then((reply) => {
            if (reply) sock.send(reply as Uint8Array, _port, addr);
          }).catch((err) => log.error({ err }, "udp handler failed"));
        },
        error(_sock: unknown, err: Error) {
          log.error({ err }, "udp socket error");
        },
      },
    } as never)) as unknown as UdpSocketLike;
    log.info({ host, port }, "UDP 53 listening");
  } catch (err) {
    log.warn({ err, host, port }, "UDP 53 unavailable (local dev? port in use?) — continuing without DNS ingress");
    return null;
  }

  if (deps.tcp ?? true) {
    try {
      tcp = Bun.listen({
        hostname: host,
        port,
        socket: {
          open(_socket: unknown) {},
          data(socket: { write(data: Uint8Array): unknown; remoteAddress?: string }, data: Uint8Array | string) {
            void handleTcp(socket, new Uint8Array(data as Uint8Array));
          },
          error(_socket: unknown, err: Error) {
            log.warn({ err }, "tcp listener error");
          },
        },
      } as never) as unknown as TcpListenerLike;
      log.info({ host, port }, "TCP 53 listening");
    } catch (err) {
      log.warn({ err }, "TCP 53 unavailable — TC-flag fallback still works; oversized queries fail");
    }
  }

  const socketRef = udp;
  return {
    udpPort: socketRef.port,
    tcpPort: tcp ? port : undefined,
    async stop() {
      socketRef.close();
      tcp?.stop(true);
    },
  };

  // ---- UDP path ----
  async function handleUdp(wire: Uint8Array, sourceIp: string): Promise<Uint8Array | null> {
    const reply = await handlePacket(wire, sourceIp);
    if (reply && reply.length > UDP_MAX_PAYLOAD) {
      // TC bit — real clients will retry over TCP
      const q = decodeQuestion(wire);
      return truncatedResponse(q);
    }
    return reply;
  }

  // ---- TCP framing path (2-byte length prefix per RFC 1035) ----
  async function handleTcp(socket: { write(data: Uint8Array): unknown; remoteAddress?: string }, data: Uint8Array): Promise<void> {
    const expected = data[0]! << 8 | data[1]!;
    if (expected !== data.length - 2) return; // frame size sanity
    const reply = await handlePacket(data.subarray(2), normalizeIp(socket.remoteAddress ?? ""));
    if (!reply) return; // silent drop
    const frame = new Uint8Array(reply.length + 2);
    frame[0] = reply.length >> 8;
    frame[1] = reply.length & 0xff;
    frame.set(reply, 2);
    socket.write(frame);
  }

  /** Core decision pipeline shared by UDP+TCP. Pure enough for tests. */
  async function handlePacket(wire: Uint8Array, sourceIp: string): Promise<Uint8Array | null> {
    // 1. Source-IP auth — unknown source: REFUSED (default) or silent drop.
    //    QueryLog events are NEVER emitted for unauthorized sources (privacy).
    const profileId = deps.store.authorizeSourceIp(sourceIp);
    if (!profileId) {
      deps.recorder?.recordDrop("unauthorized_source");
      if ((process.env.UDP_UNKNOWN_SOURCE ?? "refused") === "refused") {
        try {
          return refusedResponse(decodeQuestion(wire));
        } catch {
          return null; // unparseable packet stays silent even in refused mode
        }
      }
      return null;
    }

    // 2. Parse question — broken packet also gets silence
    let question;
    try {
      question = decodeQuestion(wire);
    } catch {
      return null;
    }

    // 3. Zone override (split-horizon; user config wins, AAA/CNAME/etc.)
    const zone = deps.store.resolveZone(profileId, question.name, question.type as never);
    if (zone) {
      deps.logQuery({ profileId, domain: question.name, action: "override", rttMs: null, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("forward");
      try {
        return zoneAnswer(question, zone);
      } catch {
        return servfailResponse(question);
      }
    }

    // 4. Blocklist (explicit rules first, then remote subscriptions w/ @@ allow precedence)
    //    Explicit ALLOW must also short-circuit remote blocks — parity with DoH.
    const explicit = deps.store.resolve(profileId, question.name);
    if (explicit === "block") {
      deps.logQuery({ profileId, domain: question.name, action: "block", rttMs: null, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("block");
      return sinkholeResponse(question);
    }
    if (!explicit && deps.store.resolveRemote(profileId, question.name) === "block") {
      deps.logQuery({ profileId, domain: question.name, action: "block", rttMs: null, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("block");
      return sinkholeResponse(question);
    }

    // 5. Cache (keyed by question + upstream)
    const upstreamUrl = deps.store.profileUpstream(profileId) ?? undefined;
    const cached = deps.dnsCache.get(wire, upstreamUrl);
    if (cached) {
      deps.logQuery({ profileId, domain: question.name, action: "forward", rttMs: null, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("forward");
      return cached;
    }

    // 6. Forward upstream (per-profile choice)
    try {
      const { wire: responseWire, rttMs } = await deps.upstream.resolveWire(
        wire,
        upstreamUrl,
      );
      deps.dnsCache.set(wire, responseWire, upstreamUrl);
      deps.logQuery({ profileId, domain: question.name, action: "forward", rttMs, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("forward");
      deps.recorder?.recordRtt(rttMs);
      return responseWire;
    } catch (err) {
      log.warn({ err, domain: question.name }, "upstream failed over UDP client");
      deps.logQuery({ profileId, domain: question.name, action: "forward", rttMs: null, clientIp: sourceIp, device: null });
      deps.recorder?.recordQuery("forward");
      return servfailResponse(question);
    }
  }
}

