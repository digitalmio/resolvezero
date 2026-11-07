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
