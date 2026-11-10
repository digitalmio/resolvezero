import { decode } from "dns-packet";
import type { QueryLogEntry, Upstream } from "./doh";
import type { DnsCache } from "./dnsCache";
import type { Recorder, Transport } from "./metrics";
import type { RuleStore } from "./ruleStore";
import type { Dns53Deps } from "./dns53";
import {
  blockedResponse,
  cnameResponse,
  decodeQuestion,
  noDataResponse,
  nxdomainResponse,
  servfailResponse,
  refusedResponse,
  zoneAnswer,
} from "./wire";
import { moduleLogger } from "./logger";
import { localNameAnswer } from "@resolvezero/shared";
import { matchProbeNonce } from "./probe";
import { safeSearchTarget } from "./safeSearch";
import { refreshDohCache } from "./dohCache";

const log = moduleLogger("dns53");

/** Core decision pipeline shared by UDP+TCP. Pure enough for tests. */
export async function resolveDnsPacket(
  deps: Dns53Deps,
  allowQuery: (profileId: string) => boolean,
  wire: Uint8Array,
  sourceIp: string,
  transport: Transport,
  profileOverride?: string,
): Promise<Uint8Array | null> {
  // 1. Source-IP auth — unknown source: REFUSED (default) or silent drop.
  //    DoT passes a profile resolved from the SNI hostname instead.
  //    QueryLog events are NEVER emitted for unauthorized sources (privacy).
  const profileId = profileOverride ?? deps.store.authorizeSourceIp(sourceIp);
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
  if (!profileOverride) deps.onSourceSeen?.(sourceIp);
  if (transport !== "udp" && !allowQuery(profileId)) {
    deps.recorder?.recordDrop("tcp_rate_limited");
    try {
      return refusedResponse(decodeQuestion(wire));
    } catch {
      return null;
    }
  }

  // 2. Parse question — broken packet also gets silence
  let question;
  try {
    question = decodeQuestion(wire);
  } catch {
    return null;
  }

  // 3. Resolver-presence canary. The random hostname has no public record;
  //    only clients using this resolver reach this point. Record it and
  //    answer NXDOMAIN so no wildcard certificate is needed.
  const probeNonce = matchProbeNonce(question.name, deps.probeDomain ?? null);
  if (probeNonce) {
    deps.onProbeSeen?.(probeNonce, transport);
    return nxdomainResponse(question);
  }

  // 4. Zone override (split-horizon; user config wins, AAA/CNAME/etc.)
  const zone = deps.store.resolveZone(profileId, question.name, question.type as never);
  if (zone) {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "override",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "zone",
      transport,
    });
    deps.recorder?.recordQuery("forward");
    try {
      return zoneAnswer(question, zone);
    } catch {
      return servfailResponse(question);
    }
  }

  // 4b. Local name exists but not for this type: local NODATA.
  if (deps.store.hasZoneName(profileId, question.name)) {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "override",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "zone",
      transport,
    });
    deps.recorder?.recordQuery("forward");
    return noDataResponse(question);
  }

  // 4. Blocklist (explicit rules first, then remote subscriptions w/ @@ allow precedence)
  //    Explicit ALLOW must also short-circuit remote blocks — parity with DoH.
  const explicit = deps.store.resolve(profileId, question.name);
  if (explicit === "block") {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "block",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "manual",
      transport,
    });
    deps.recorder?.recordQuery("block");
    return blockedResponse(question, deps.store.blockAnswer(profileId));
  }

  // SafeSearch rewrites: CNAME the search host to the provider's safe endpoint.
  const safeTarget = safeSearchTarget(deps.store.safeSearchSettings(profileId), question.name);
  if (safeTarget) {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "override",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "safesearch",
      transport,
    });
    deps.recorder?.recordQuery("forward");
    return cnameResponse(question, safeTarget);
  }

  await deps.ensureLists?.(profileId);
  const remote = explicit ? undefined : deps.store.resolveRemoteDetailed(profileId, question.name);
  if (remote?.action === "block") {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "block",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "blocklist",
      listId: remote.listId,
      transport,
    });
    deps.recorder?.recordQuery("block");
    return blockedResponse(question, deps.store.blockAnswer(profileId));
  }

  // 5. Synthetic local names (nip.io-style, scoped to .lan/.home.arpa)
  const local = localNameAnswer(wire, {
    localDomains: deps.localDomains ?? ["lan"],
    localTtl: deps.localTtl ?? 60,
    allowPublicIpEncoding: deps.allowPublicIpEncoding === true,
  });
  if (local) {
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "override",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      reason: "zone",
      transport,
    });
    deps.recorder?.recordQuery("forward");
    return local;
  }

  // 6. Cache (keyed by question + upstream)
  const upstreamUrl = deps.store.profileUpstream(profileId) ?? undefined;
  const upstream = deps.store.profileUpstreamLabel(profileId);
  const cached = deps.dnsCache.get(wire, upstreamUrl, () => refreshDohCache(deps, wire, upstreamUrl, profileId), profileId);
  if (cached) {
    deps.recorder?.recordCacheHit(transport);
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      transport,
      upstream,
    });
    deps.recorder?.recordQuery("forward");
    return cached;
  }

  // 6. Forward upstream (per-profile choice)
  deps.recorder?.recordCacheMiss(transport);
  try {
    const { wire: responseWire, rttMs } = await deps.upstream.resolveWire(
      wire,
      upstreamUrl,
    );
    deps.dnsCache.set(wire, responseWire, upstreamUrl, profileId);
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs,
      clientIp: sourceIp,
      device: null,
      transport,
      upstream,
    });
    deps.recorder?.recordQuery("forward");
    deps.recorder?.recordRtt(rttMs);
    return responseWire;
  } catch (err) {
    log.warn({ err, domain: question.name }, "upstream failed over UDP client");
    deps.logQuery({
      profileId,
      domain: question.name,
      action: "forward",
      rttMs: null,
      clientIp: sourceIp,
      device: null,
      transport,
      upstream,
    });
    deps.recorder?.recordQuery("forward");
    return servfailResponse(question);
  }
}