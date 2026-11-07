/**
 * Compare policy answers between two edges for the same profile.
 *
 *   pnpm exec tsx apps/edge/scripts/parity-check.ts \
 *     --a http://127.0.0.1:8088 --b http://127.0.0.1:8089 \
 *     --profile <id> --token <token> --limit 100
 *
 * Samples real blocked domains from the Hagezi list and verifies both edges
 * return the same sinkhole. Forwarded CDN answers are intentionally excluded:
 * upstream GeoDNS legitimately returns different sets between runs.
 */
import { encode, decode } from "dns-packet";

const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const baseA = value("--a", "http://127.0.0.1:8088")!;
const baseB = value("--b", "http://127.0.0.1:8089")!;
const profile = value("--profile")!;
const token = value("--token")!;
const limit = Number(value("--limit", "100"));
const listUrl = value(
  "--list",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt",
)!;

interface Answer {
  rcode: string;
  answers: string[];
}

async function ask(base: string, name: string, type: string): Promise<Answer> {
  const wire = encode({ type: "query", id: 0x1234, flags: 0x0100, questions: [{ type, name }] });
  const response = await fetch(`${base}/v1/${profile}/${token}`, {
    method: "POST",
    headers: { "content-type": "application/dns-message" },
    body: wire,
  });
  if (!response.ok) throw new Error(`${base} returned HTTP ${response.status}`);
  const message = decode(Buffer.from(await response.arrayBuffer()));
  return {
    rcode: String(message.rcode),
    answers: (message.answers ?? []).map((answer) => `${answer.type}:${answer.data}`).sort(),
  };
}

async function main() {
  if (!profile || !token) throw new Error("--profile and --token are required");
  const text = await (await fetch(listUrl)).text();
  const domains = [...text.matchAll(/^\|\|([a-z0-9.-]+)\^\s*$/gim)]
    .map((match) => match[1])
    .filter((domain): domain is string => Boolean(domain))
    .slice(0, limit);

  let mismatches = 0;
  for (const domain of domains) {
    for (const type of ["A", "AAAA"]) {
      const [a, b] = await Promise.all([ask(baseA, domain, type), ask(baseB, domain, type)]);
      const same = a.rcode === b.rcode && JSON.stringify(a.answers) === JSON.stringify(b.answers);
      if (!same) {
        mismatches += 1;
        console.log("DIFF", domain, type, "a:", a, "b:", b);
      }
    }
  }
  console.log(`${domains.length} blocked domains × 2 types · mismatches: ${mismatches}`);
  if (mismatches > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
