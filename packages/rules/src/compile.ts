import { createHash } from "node:crypto";

import { encodeArtifact } from "./artifact";
import { readTextBounded } from "./body";
import { SuffixFingerprintBuilder } from "./fingerprint";
import { fetchWithSafeRedirects } from "./netGuard";
import { parseList, resolveListFormat } from "./parse";

export const DEFAULT_MAX_LIST_BYTES = 30 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 1_500_000;
const FETCH_TIMEOUT_MS = 60_000;

export interface CompileOptions {
  /** Stored list format: auto | hosts | domains | abp. */
  format?: string;
  maxBytes?: number;
  maxEntries?: number;
  /** Source URL recorded in the artifact sidecar. */
  source?: string;
  /** Only https is accepted unless a self-host opts into http. */
  protocols?: string[];
}

export interface CompiledArtifact {
  hash: string;
  data: Uint8Array;
  sidecar: string;
  rules: number;
  allow: number;
  block: number;
  detectedFormat: string;
}

export interface ArtifactMeta {
  id: string;
  source: string;
  allow: number;
  block: number;
  rules: number;
  bytes: number;
  compiler: string;
  hash: string;
  createdAt: string;
}

/** Log-safe URL: origin only, never query/path credentials. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}/…`;
  } catch {
    return "<invalid URL>";
  }
}

/** Fetch a remote list with SSRF-safe redirects and a hard byte cap. */
export async function fetchListText(
  url: string,
  maxBytes = DEFAULT_MAX_LIST_BYTES,
  protocols: string[] = ["https:"],
): Promise<string> {
  const { response } = await fetchWithSafeRedirects(
    url,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "resolvezero-artifacts/0.1" },
    },
    { protocols, label: "list URL" },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  return readTextBounded(response.body, maxBytes, declared);
}

export function compileText(text: string, options: CompileOptions = {}): CompiledArtifact {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const format = options.format ?? "auto";
  const detectedFormat = resolveListFormat(text, format);
  const parsed = parseList(text, detectedFormat);
  const rules = parsed.blocks.size + parsed.allows.size;
  if (rules > maxEntries) {
    throw new Error(`list has ${rules} rules, which exceeds the ${maxEntries} per-profile budget`);
  }

  const builder = new SuffixFingerprintBuilder();
  for (const domain of parsed.blocks) builder.add(domain, "block");
  for (const domain of parsed.allows) builder.add(domain, "allow");
  const table = builder.seal(rules);
  const { allow, block } = table.artifactTables();
  const data = encodeArtifact({ allow, block });
  const hash = createHash("sha256").update(data).digest("hex");
  const meta: ArtifactMeta = {
    id: hash,
    source: options.source ?? "",
    allow: allow.length,
    block: block.length,
    rules,
    bytes: data.length,
    compiler: "rz-compile-node/0.1",
    hash: "xxhash64/seed0",
    createdAt: new Date().toISOString(),
  };

  return {
    hash,
    data,
    sidecar: `${JSON.stringify(meta, null, 2)}\n`,
    rules,
    allow: allow.length,
    block: block.length,
    detectedFormat,
  };
}

export async function compileUrl(
  url: string,
  options: CompileOptions = {},
): Promise<CompiledArtifact> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LIST_BYTES;
  const text = await fetchListText(url, maxBytes, options.protocols ?? ["https:"]);
  return compileText(text, { ...options, source: options.source ?? url });
}
