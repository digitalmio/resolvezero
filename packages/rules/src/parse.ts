/**
 * Blocklist parser shared by the Node artifacts service and (later) the Node
 * edge. The output is deduped domain sets; fingerprinting happens in
 * `fingerprint.ts`.
 */
export interface ParsedList {
  blocks: Set<string>;
  allows: Set<string>;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/;
const PUNCT_HOSTS_RE = /^[\s#&+|!'"]*$/;

/**
 * Sniff the list syntax from its content so users never have to pick a format.
 * Samples real (non-comment) lines and scores ABP, hosts, and bare-domain
 * shapes.
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
      // @@||host^ -> allow | ||host^ -> block. Cosmetic/CSS selectors ignore.
      if (line.startsWith("@@||")) {
        const domain = extractAbpDomain(line);
        if (domain) allows.add(domain);
      } else {
        const domain = extractAbpDomain(line);
        if (domain) blocks.add(domain);
      }
      continue;
    }
    // Strip inline comments after the first `#` (hosts + domains formats).
    const tokens = line
      .split("#")[0]!
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    // Hosts lines pack aliases ("0.0.0.0 a.com b.com"); every name token
    // counts, not just the last. Skip IP literals themselves.
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

/** `||ads.example.com^$third-party` -> `ads.example.com`; `@@||host^` handled by caller. */
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
