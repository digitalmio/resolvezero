import { isIP } from "node:net";

const PROXY_V2_MAGIC = new Uint8Array([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const TLV_AUTHORITY = 0x02;

export interface ProxyV2Info {
  sourceIp: string | null;
  sourcePort: number | null;
  destinationIp: string | null;
  destinationPort: number | null;
  /** SNI hostname from the PP2_TYPE_AUTHORITY TLV, if present. */
  authority: string | null;
}

export type ProxyV2Result =
  | { status: "ok"; info: ProxyV2Info; length: number }
  | { status: "need-more" }
  | { status: "invalid" };

function ipv4(buf: Uint8Array, at: number): string {
  return `${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`;
}

function ipv6(buf: Uint8Array, at: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(((buf[at + i * 2]! << 8) | buf[at + i * 2 + 1]!).toString(16));
  }
  // RFC 5952: compress the longest run of zero groups.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === "0") {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const length = i - runStart;
      if (length > bestLength && length > 1) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/**
 * Parse a PROXY protocol v2 header as sent by Fly's proxy in front of the TLS
 * handler. Returns `need-more` until the whole header has arrived.
 */
export function parseProxyV2(buf: Uint8Array): ProxyV2Result {
  if (buf.length < 12) {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== PROXY_V2_MAGIC[i]) return { status: "invalid" };
    }
    return { status: "need-more" };
  }
  for (let i = 0; i < PROXY_V2_MAGIC.length; i += 1) {
    if (buf[i] !== PROXY_V2_MAGIC[i]) return { status: "invalid" };
  }
  if (buf.length < 16) return { status: "need-more" };

  const versionCommand = buf[12]!;
  if (versionCommand >> 4 !== 2) return { status: "invalid" };
  const command = versionCommand & 0x0f; // 0 = LOCAL, 1 = PROXY
  const familyProtocol = buf[13]!;
  const family = familyProtocol >> 4; // 1 = IPv4, 2 = IPv6, 0 = UNSPEC
  const payloadLength = (buf[14]! << 8) | buf[15]!;
  const total = 16 + payloadLength;
  if (buf.length < total) return { status: "need-more" };

  const info: ProxyV2Info = {
    sourceIp: null,
    sourcePort: null,
    destinationIp: null,
    destinationPort: null,
    authority: null,
  };

  let offset = 16;
  let headerEnd = total;

  if (command === 1) {
    if (family === 1) {
      if (offset + 12 > total) return { status: "invalid" };
      info.sourceIp = ipv4(buf, offset);
      info.destinationIp = ipv4(buf, offset + 4);
      info.sourcePort = (buf[offset + 8]! << 8) | buf[offset + 9]!;
      info.destinationPort = (buf[offset + 10]! << 8) | buf[offset + 11]!;
      offset += 12;
    } else if (family === 2) {
      if (offset + 36 > total) return { status: "invalid" };
      info.sourceIp = ipv6(buf, offset);
      info.destinationIp = ipv6(buf, offset + 16);
      info.sourcePort = (buf[offset + 32]! << 8) | buf[offset + 33]!;
      info.destinationPort = (buf[offset + 34]! << 8) | buf[offset + 35]!;
      offset += 36;
    }
  }

  while (offset + 3 <= headerEnd) {
    const type = buf[offset]!;
    const length = (buf[offset + 1]! << 8) | buf[offset + 2]!;
    const valueStart = offset + 3;
    if (valueStart + length > headerEnd) return { status: "invalid" };
    if (type === TLV_AUTHORITY) {
      info.authority = new TextDecoder().decode(buf.subarray(valueStart, valueStart + length)).toLowerCase();
    }
    offset = valueStart + length;
  }

  return { status: "ok", info, length: total };
}

/** PROXY protocol v1 signature ("PROXY "). */
export const PROXY_SIGNATURE = new TextEncoder().encode("PROXY ");

export function matchesPrefix(buf: Uint8Array, signature: Uint8Array): boolean {
  const n = Math.min(buf.length, signature.length);
  for (let i = 0; i < n; i++) {
    if (buf[i] !== signature[i]) return false;
  }
  return true;
}

export function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}



export interface TcpState {
  buffer: Uint8Array;
  headerParsed: boolean;
  sourceIp: string;
  counted: boolean;
}
