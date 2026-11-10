import { rawClient } from "@resolvezero/db/client";

export interface CompileTarget {
  url: string;
  format: string;
  artifactHash: string | null;
  /** Epoch seconds; null when never compiled. */
  compiledAt: number | null;
}

export interface CycleStatus {
  total: number;
  stale: number;
  compiled: number;
  failed: number;
  changed: number;
  missingArtifacts: number;
  oldestCompiledAt: number | null;
  blocklistVersion: number;
  error: string | null;
}

export interface ArtifactRecord {
  hash: string;
  sourceUrl: string;
  bytes: number;
  allow: number;
  block: number;
  compiler: string;
}

const sql = rawClient();

export async function compileTargets(): Promise<CompileTarget[]> {
  const rows = await sql<
    { url: string; format: string; artifact_hash: string | null; compiled_at: string | null }[]
  >`
    select url,
           min(format) as format,
           max(artifact_hash) as artifact_hash,
           (extract(epoch from max(compiled_at)))::bigint as compiled_at
      from profile_blocklists
     where enabled = true
     group by url
     order by url
  `;
  return rows.map((row) => ({
    url: row.url,
    format: row.format,
    artifactHash: row.artifact_hash,
    compiledAt: row.compiled_at == null ? null : Number(row.compiled_at),
  }));
}

export async function artifactExists(hash: string): Promise<boolean> {
  const rows = await sql`select 1 from rule_artifacts where hash = ${hash} limit 1`;
  return rows.length > 0;
}

export async function recordArtifact(record: ArtifactRecord): Promise<void> {
  await sql`
    insert into rule_artifacts (hash, source_url, bytes, allow_count, block_count, compiler)
    values (${record.hash}, ${record.sourceUrl}, ${record.bytes}, ${record.allow}, ${record.block}, ${record.compiler})
    on conflict (hash) do update set
      source_url = excluded.source_url,
      bytes = excluded.bytes,
      allow_count = excluded.allow_count,
      block_count = excluded.block_count,
      compiler = excluded.compiler
  `;
}

export async function setBlocklistArtifact(
  url: string,
  hash: string,
  rules: number,
): Promise<void> {
  await sql`
    update profile_blocklists
       set artifact_hash = ${hash}, artifact_rules = ${rules}, compiled_at = now(),
           last_status = 'ok', entry_count = ${rules}
     where url = ${url}
  `;
}

export async function writeBlocklistStatus(
  url: string,
  status: string,
  entries: number,
  detectedFormat?: string,
): Promise<void> {
  await sql`
    update profile_blocklists
       set last_synced_at = now(), last_status = ${status}, entry_count = ${entries},
           detected_format = coalesce(${detectedFormat ?? null}, detected_format)
     where url = ${url}
  `;
}

export async function bumpBlocklistVersion(): Promise<void> {
  await sql`
    update edge_config_state
       set blocklist_version = blocklist_version + 1, updated_at = now()
     where id = true
  `;
}

export async function blocklistVersion(): Promise<number> {
  const rows = await sql<{ blocklist_version: number }[]>`
    select blocklist_version from edge_config_state where id = true limit 1
  `;
  return rows[0]?.blocklist_version ?? 0;
}

export async function artifactFreshness(): Promise<{
  oldestCompiledAt: number | null;
  missingArtifacts: number;
}> {
  const rows = await sql<{ oldest: string | null; missing: number }[]>`
    select (extract(epoch from min(compiled_at)))::bigint as oldest,
           count(distinct url) filter (where artifact_hash is null) as missing
      from profile_blocklists
     where enabled = true
  `;
  const row = rows[0];
  return {
    oldestCompiledAt: row?.oldest == null ? null : Number(row.oldest),
    missingArtifacts: Number(row?.missing ?? 0),
  };
}

export async function heartbeat(instance: string): Promise<void> {
  await sql`
    insert into compiler_status (instance, last_poll_at, updated_at)
    values (${instance}, now(), now())
    on conflict (instance) do update set
      last_poll_at = now(),
      updated_at = now()
  `;
}

export async function recordCycle(instance: string, status: CycleStatus): Promise<void> {
  const error = status.error?.slice(0, 240) ?? null;
  await sql`
    insert into compiler_status
      (instance, last_poll_at, last_cycle_at, last_success_at, last_refresh_at,
       last_error_at, last_error, lists_total, lists_stale, lists_compiled,
       lists_failed, lists_changed, missing_artifacts, oldest_compiled_at,
       blocklist_version, updated_at)
    values
      (${instance}, now(), now(),
       case when ${status.failed} = 0 then now() end,
       case when ${status.failed} = 0 and ${status.compiled} > 0 then now() end,
       case when ${status.failed} > 0 then now() end, ${error}, ${status.total},
       ${status.stale}, ${status.compiled}, ${status.failed}, ${status.changed},
       ${status.missingArtifacts},
       case when ${status.oldestCompiledAt}::bigint is null then null
            else to_timestamp(${status.oldestCompiledAt}::bigint) end,
       ${status.blocklistVersion}, now())
    on conflict (instance) do update set
      last_poll_at = now(),
      last_cycle_at = now(),
      last_success_at = case
        when excluded.lists_failed = 0 then now()
        else compiler_status.last_success_at end,
      last_refresh_at = case
        when excluded.lists_failed = 0 and excluded.lists_compiled > 0 then now()
        else compiler_status.last_refresh_at end,
      last_error_at = case
        when excluded.lists_failed > 0 then now()
        else compiler_status.last_error_at end,
      last_error = excluded.last_error,
      lists_total = excluded.lists_total,
      lists_stale = excluded.lists_stale,
      lists_compiled = excluded.lists_compiled,
      lists_failed = excluded.lists_failed,
      lists_changed = excluded.lists_changed,
      missing_artifacts = excluded.missing_artifacts,
      oldest_compiled_at = excluded.oldest_compiled_at,
      blocklist_version = excluded.blocklist_version,
      updated_at = now()
  `;
}

export async function recordCycleError(instance: string, error: string): Promise<void> {
  await sql`
    insert into compiler_status
      (instance, last_poll_at, last_cycle_at, last_error_at, last_error,
       lists_failed, updated_at)
    values (${instance}, now(), now(), now(), ${error.slice(0, 240)}, 1, now())
    on conflict (instance) do update set
      last_poll_at = now(),
      last_cycle_at = now(),
      last_error_at = now(),
      last_error = ${error.slice(0, 240)},
      lists_failed = greatest(compiler_status.lists_failed, 1),
      updated_at = now()
  `;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
