use sqlx::Row;

use super::{CompileTarget, Db};

impl Db {
    pub async fn compile_targets(&self) -> Result<Vec<CompileTarget>, sqlx::Error> {
        let rows = sqlx::query(
            "select url,
                    min(format) as format,
                    max(artifact_hash) as artifact_hash,
                    (extract(epoch from max(compiled_at)))::bigint as compiled_at
               from profile_blocklists
              where enabled = true
              group by url
              order by url",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CompileTarget {
                    url: row.try_get("url")?,
                    format: row.try_get("format")?,
                    artifact_hash: row.try_get("artifact_hash")?,
                    compiled_at: row.try_get("compiled_at")?,
                })
            })
            .collect()
    }

    pub async fn artifact_exists(&self, hash: &str) -> Result<bool, sqlx::Error> {
        let row = sqlx::query("select 1 from rule_artifacts where hash = $1")
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn record_artifact(
        &self,
        hash: &str,
        source_url: &str,
        bytes: i32,
        allow: i32,
        block: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into rule_artifacts (hash, source_url, bytes, allow_count, block_count, compiler)
             values ($1, $2, $3, $4, $5, 'rz-compiler/0.1')
             on conflict (hash) do update set
               source_url = excluded.source_url,
               bytes = excluded.bytes,
               allow_count = excluded.allow_count,
               block_count = excluded.block_count,
               compiler = excluded.compiler",
        )
        .bind(hash)
        .bind(source_url)
        .bind(bytes)
        .bind(allow)
        .bind(block)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_blocklist_artifact(
        &self,
        url: &str,
        hash: &str,
        rules: i32,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update profile_blocklists
                set artifact_hash = $1, artifact_rules = $2, compiled_at = now(),
                    last_status = 'ok', entry_count = $2
              where url = $3",
        )
        .bind(hash)
        .bind(rules)
        .bind(url)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn bump_blocklist_version(&self) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update edge_config_state
                set blocklist_version = blocklist_version + 1, updated_at = now()
              where id = true",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct CycleStatus {
    pub total: i32,
    pub stale: i32,
    pub compiled: i32,
    pub failed: i32,
    pub changed: i32,
    pub missing_artifacts: i32,
    /// Epoch seconds; None when no list has ever compiled.
    pub oldest_compiled_at: Option<i64>,
    pub blocklist_version: i32,
    pub error: Option<String>,
}

impl Db {
    /// Liveness only. Must not overwrite the last cycle report.
    pub async fn heartbeat(&self, instance: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into compiler_status (instance, last_poll_at, updated_at)
             values ($1, now(), now())
             on conflict (instance) do update set
               last_poll_at = now(),
               updated_at = now()",
        )
        .bind(instance)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_cycle(
        &self,
        instance: &str,
        status: &CycleStatus,
    ) -> Result<(), sqlx::Error> {
        let error = status
            .error
            .as_deref()
            .map(|value| value.chars().take(240).collect::<String>());
        sqlx::query(
            "insert into compiler_status
               (instance, last_poll_at, last_cycle_at, last_success_at, last_refresh_at,
                last_error_at, last_error, lists_total, lists_stale, lists_compiled,
                lists_failed, lists_changed, missing_artifacts, oldest_compiled_at,
                blocklist_version, updated_at)
             values
               ($1, now(), now(),
                case when $5 = 0 then now() end,
                case when $5 = 0 and $4 > 0 then now() end,
                case when $5 > 0 then now() end, $6, $2, $3, $4, $5, $7, $8,
                case when $9 is null then null else to_timestamp($9) end,
                $10, now())
             on conflict (instance) do update set
               last_poll_at = now(),
               last_cycle_at = now(),
               last_success_at = case
                 when excluded.lists_failed = 0 then now()
                 else compiler_status.last_success_at
               end,
               last_refresh_at = case
                 when excluded.lists_failed = 0 and excluded.lists_compiled > 0 then now()
                 else compiler_status.last_refresh_at
               end,
               last_error_at = case
                 when excluded.lists_failed > 0 then now()
                 else compiler_status.last_error_at
               end,
               last_error = excluded.last_error,
               lists_total = excluded.lists_total,
               lists_stale = excluded.lists_stale,
               lists_compiled = excluded.lists_compiled,
               lists_failed = excluded.lists_failed,
               lists_changed = excluded.lists_changed,
               missing_artifacts = excluded.missing_artifacts,
               oldest_compiled_at = excluded.oldest_compiled_at,
               blocklist_version = excluded.blocklist_version,
               updated_at = now()",
        )
        .bind(instance)
        .bind(status.total)
        .bind(status.stale)
        .bind(status.compiled)
        .bind(status.failed)
        .bind(error)
        .bind(status.changed)
        .bind(status.missing_artifacts)
        .bind(status.oldest_compiled_at)
        .bind(status.blocklist_version)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record a cycle that failed before a report could be produced.
    pub async fn record_cycle_error(&self, instance: &str, error: &str) -> Result<(), sqlx::Error> {
        let error: String = error.chars().take(240).collect();
        sqlx::query(
            "insert into compiler_status
               (instance, last_poll_at, last_cycle_at, last_error_at, last_error,
                lists_failed, updated_at)
             values ($1, now(), now(), now(), $2, 1, now())
             on conflict (instance) do update set
               last_poll_at = now(),
               last_cycle_at = now(),
               last_error_at = now(),
               last_error = $2,
               lists_failed = greatest(compiler_status.lists_failed, 1),
               updated_at = now()",
        )
        .bind(instance)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn artifact_freshness(&self) -> Result<(Option<i64>, i32), sqlx::Error> {
        let row = sqlx::query(
            "select (extract(epoch from min(compiled_at)))::bigint as oldest,
                    count(distinct url) filter (where artifact_hash is null)::int as missing
               from profile_blocklists
              where enabled = true",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok((row.try_get("oldest")?, row.try_get("missing")?))
    }
}
