/**
 * One-shot artifact compiler (Node replacement for `rz-compile`).
 *
 *   tsx apps/artifacts/src/cli.ts --url https://example/list.txt --out ./artifacts
 *   tsx apps/artifacts/src/cli.ts --file ./list.txt --format hosts --out ./artifacts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { compileText, compileUrl, DEFAULT_MAX_LIST_BYTES } from "@resolvezero/rules";

interface Args {
  url?: string;
  file?: string;
  format: string;
  out: string;
  maxBytes: number;
  maxEntries?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { format: "auto", out: "artifacts", maxBytes: DEFAULT_MAX_LIST_BYTES };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--url":
        args.url = next();
        break;
      case "--file":
        args.file = next();
        break;
      case "--format":
        args.format = next() ?? "auto";
        break;
      case "--out":
        args.out = next() ?? "artifacts";
        break;
      case "--max-bytes": {
        const value = Number(next());
        if (Number.isFinite(value) && value > 0) args.maxBytes = value;
        break;
      }
      case "--max-entries": {
        const value = Number(next());
        if (Number.isFinite(value) && value > 0) args.maxEntries = value;
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.url && !args.file) throw new Error("provide --url or --file");
  if (args.url && args.file) throw new Error("use --url or --file, not both");
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "usage: cli.ts --url <https://…> [--format auto|hosts|domains|abp] [--out dir]",
      "       cli.ts --file <path>    [--format auto|hosts|domains|abp] [--out dir]",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const compiled = args.url
    ? await compileUrl(args.url, {
        format: args.format,
        maxBytes: args.maxBytes,
        maxEntries: args.maxEntries,
        source: args.url,
      })
    : compileText(await readFile(args.file!, "utf8"), {
        format: args.format,
        maxBytes: args.maxBytes,
        maxEntries: args.maxEntries,
        source: `file:${args.file}`,
      });

  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, `${compiled.hash}.bin`), compiled.data);
  await writeFile(join(args.out, `${compiled.hash}.json`), compiled.sidecar);
  process.stdout.write(compiled.sidecar);
}

main().catch((err) => {
  process.stderr.write(`compile failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
