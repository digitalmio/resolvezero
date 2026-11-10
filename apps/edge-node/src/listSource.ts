import { createHash } from "node:crypto";

import { decodeArtifact, isArtifact } from "./artifact";
import { readTextBounded } from "./body";
import { SuffixFingerprintTable } from "./fingerprint";
import { fetchWithSafeRedirects } from "./netGuard";
import type { S3ClientLike } from "./sinks/s3";

/** Hard cap per list (bytes) — protects edge memory from runaway sources. */
export const MAX_LIST_BYTES = 30 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/;
const PUNCT_HOSTS_RE = /^[\s#&+|!'"]*$/;

export interface ParsedList {
  blocks: Set<string>;
  allows: Set<string>;
}

/**
 * Sniff the list syntax from its content so users never have to pick a format.
 * Samples real (non-comment) lines and scores ABP, hosts, and domain shapes.
 */
export function detectFormat(text: string): "abp" | "hosts" | "domains" {
  let abp = 0;
  let hosts = 0;
  let domains = 0;
  let sampled = 0;
  for (const raw of text.split("\n")) {
    if (sampled >= 2_000) break;
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("//")) continue;
    sampled += 1;
    if (/^(@@)?\|\|[a-z0-9.-]+\^/.test(line)) {
      abp += 1;
      continue;
    }
    const tokens = line.split("#")[0]!.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && isIpLiteral(tokens[0]!)) {
      hosts += 1;
      continue;
    }
    if (tokens.length === 1 && DOMAIN_RE.test(tokens[0]!) && tokens[0]!.includes(".")) {
      domains += 1;
    }
  }
  if (abp >= hosts && abp >= domains && abp > 0) return "abp";
  if (hosts > domains) return "hosts";
  return "domains";
}

/** Resolve a stored format, sniffing the payload when it is `auto`. */
export function resolveListFormat(text: string, format: string): string {
  return format === "auto" ? detectFormat(text) : format;
}

export function parseList(text: string, format: string): ParsedList {
  const resolved = resolveListFormat(text, format);
  const blocks = new Set<string>();
  const allows = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("//")) continue;
    if (resolved === "abp") {
      if (line.startsWith("@@||")) {
        const domain = extractAbpDomain(line);
        if (domain) allows.add(domain);
      } else {
        const domain = extractAbpDomain(line);
        if (domain) blocks.add(domain);
      }
      continue;
    }
    const tokens = line.split("#")[0]!.trim().split(/\s+/).filter(Boolean);
    for (const candidate of tokens) {
      const domain = candidate.replace(/\.+$/, "");
      if (!domain) continue;
      if (isIpLiteral(domain)) continue;
      if (domain === "localhost" || PUNCT_HOSTS_RE.test(domain) || domain.length < 3) continue;
      if (!DOMAIN_RE.test(domain) || !domain.includes(".")) continue;
      blocks.add(domain);
    }
  }
  return { blocks, allows };
}

function extractAbpDomain(rule: string): string | undefined {
  const match = rule.replace(/^@@\|\|/, "||").match(/^\|\|([a-z0-9.-]+)(\^\S*)?$/);
  if (!match) return undefined;
  const domain = match[1]!.replace(/\*+/g, "");
  if (!domain.includes(".") || !DOMAIN_RE.test(domain)) return undefined;
  return domain;
}

function isIpLiteral(value: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return true;
  if (value.includes(":")) return /^[0-9a-f:]+$/i.test(value);
  return false;
}

/**
 * Fetch a raw list file with timeout + size cap. Throws a short reason that
 * can be stored in `last_status`.
 */
export async function fetchListText(url: string): Promise<string> {
  const { response } = await fetchWithSafeRedirects(
    url,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "resolvezero-edge/0.1" },
    },
    { protocols: ["https:"], label: "list URL" },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const len = Number(response.headers.get("content-length") ?? 0);
  return readTextBounded(response.body, MAX_LIST_BYTES, len);
}

/**
 * Load and verify a compiled artifact from object storage. The sha256 check is
 * mandatory: the file name is the content hash, so a truncated/corrupted
 * upload must never be trusted.
 */
export async function loadArtifactTable(
  store: S3ClientLike,
  hash: string,
): Promise<SuffixFingerprintTable> {
  const prefix = process.env.ARTIFACT_PREFIX ?? "artifacts";
  const key = `${prefix.replace(/^\/+|\/+$/g, "")}/${hash}.bin`;
  const bytes = new Uint8Array(await store.file(key).arrayBuffer());
  if (!isArtifact(bytes)) throw new Error(`${key} is not an artifact`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== hash) throw new Error(`${key} hash mismatch (${actual})`);
  const { allow, block } = decodeArtifact(bytes);
  return SuffixFingerprintTable.fromArrays(allow, block);
}
