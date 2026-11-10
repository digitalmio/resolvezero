/**
 * Compile blocklists into content-addressed artifacts and publish them.
 *
 *   pnpm tsx scripts/artifacts.ts --all
 *   pnpm tsx scripts/artifacts.ts --url https://example/list.txt
 *   pnpm tsx scripts/artifacts.ts --status
 *   pnpm tsx scripts/artifacts.ts --all --dry-run
 *
 * Compilation is in-process (`@resolvezero/rules`), so this script no longer
 * shells out to the Rust `rz-compile` binary. The worker
 * (`apps/artifacts/src/main.ts`) uses the same library.
 */
import { createArtifactStore, compileUrl } from "@resolvezero/rules";
import { rawClient } from "@resolvezero/db/client";

interface CompiledRow {
  id: string;
  source: string;
  allow: number;
  block: number;
  rules: number;
  bytes: number;
  compiler: string;
  sidecar: string;
  data: Uint8Array;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const dryRun = flag("--dry-run");
const updateDb = !flag("--no-db") && !dryRun;
const explicitFormat = value("--format", "auto")!;
const db = rawClient();

async function status(): Promise<void> {
  const rows = await db.unsafe(`
    select pb.url,
           pb.artifact_hash as hash,
           pb.artifact_rules as rules,
           pb.compiled_at,
           a.bytes
      from profile_blocklists pb
      left join rule_artifacts a on a.hash = pb.artifact_hash
     where pb.enabled = true
     order by pb.url
  `);
  console.table(rows);
  const artifacts = await db.unsafe(
    "select count(*)::int as count, coalesce(sum(bytes), 0)::bigint as bytes from rule_artifacts",
  );
  console.log(
    `artifacts: ${artifacts[0]?.count ?? 0}, stored bytes: ${artifacts[0]?.bytes ?? 0}`,
  );
}

async function compile(url: string, format: string): Promise<CompiledRow> {
  const compiled = await compileUrl(url, { format, source: url });
  return {
    id: compiled.hash,
    source: url,
    allow: compiled.allow,
    block: compiled.block,
    rules: compiled.rules,
    bytes: compiled.data.length,
    compiler: "rz-compile-node/0.1",
    sidecar: compiled.sidecar,
    data: compiled.data,
  };
}

async function publish(url: string, format: string): Promise<void> {
  const meta = await compile(url, format);
  if (!dryRun) {
    const store = createArtifactStore();
    if (!store) throw new Error("S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are required");
    await store.put(meta.id, meta.data, meta.sidecar);
    if (updateDb) {
      await db.unsafe(
        `insert into rule_artifacts (hash, source_url, bytes, allow_count, block_count, compiler)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (hash) do update set
           source_url = excluded.source_url,
           bytes = excluded.bytes,
           allow_count = excluded.allow_count,
           block_count = excluded.block_count,
           compiler = excluded.compiler`,
        [meta.id, url, meta.bytes, meta.allow, meta.block, meta.compiler],
      );
      await db.unsafe(
        `update profile_blocklists
            set artifact_hash = $1, artifact_rules = $2, compiled_at = now()
          where url = $3`,
        [meta.id, meta.rules, url],
      );
    }
  }
  console.log(
    `${dryRun ? "dry" : "published"} ${meta.rules} rules (${meta.bytes} bytes) ${meta.id.slice(0, 12)}… ${url}`,
  );
}

async function main(): Promise<void> {
  if (flag("--status")) {
    await status();
    return;
  }

  const explicit = value("--url");
  let targets: { url: string; format: string }[];
  if (explicit) {
    const rows = await db.unsafe(
      "select min(format) as format from profile_blocklists where enabled = true and url = $1",
      [explicit],
    );
    targets = [{ url: explicit, format: (rows[0]?.format as string) ?? explicitFormat }];
  } else {
    const rows = await db.unsafe(`
      select url, min(format) as format
        from profile_blocklists
       where enabled = true
       group by url
       order by url
    `);
    targets = rows.map((row) => ({ url: row.url as string, format: row.format as string }));
  }
  if (targets.length === 0) {
    console.log("no enabled lists");
    return;
  }

  let published = 0;
  for (const target of targets) {
    try {
      await publish(target.url, target.format === "auto" ? explicitFormat : target.format);
      published += 1;
    } catch (err) {
      console.error(`failed: ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (published > 0 && updateDb) {
    // artifact_hash updates are deliberately outside the trigger's column
    // list (status writes must not loop), so bump explicitly to reload edges.
    await db.unsafe(
      "update edge_config_state set blocklist_version = blocklist_version + 1, updated_at = now() where id = true",
    );
    console.log(`bumped blocklist_version; ${published}/${targets.length} lists published`);
  }
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error(err);
    await db.end();
    process.exit(1);
  });
