import type { RuleAction, RuleStore, ZoneAnswer } from "./ruleStore";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";

export type QueryLogReason = "manual" | "blocklist" | "zone" | "safesearch";

export interface QueryLogEntry {
  profileId: string;
  domain: string;
  action: RuleAction | "forward" | "override";
  rttMs: number | null;
  clientIp: string | null;
  device: string | null;
  reason?: QueryLogReason;
  listId?: string;
  transport?: "doh" | "udp" | "tcp" | "dot" | "dot";
  upstream?: string;
}

export interface Upstream {
  resolveWire(
    wire: Uint8Array,
    upstreamUrl?: string,
  ): Promise<{ wire: Uint8Array<ArrayBuffer>; rttMs: number }>;
}

export interface DohAppDeps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
  ensureLists?(profileId: string): Promise<void>;
  onNewDevice?(profileId: string, device: string): void;
  recorder?: Recorder;
  localDomains?: readonly string[];
  localTtl?: number;
  allowPublicIpEncoding?: boolean;
  probeDomain?: string | null;
  onProbeSeen?(nonce: string, transport: "doh" | "udp" | "tcp" | "dot"): void;
}

export type { ZoneAnswer };
