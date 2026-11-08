use sqlx::Row;

use super::{BlocklistRow, Db};

impl Db {
    pub async fn blocklists(&self) -> Result<Vec<BlocklistRow>, sqlx::Error> {
        sqlx::query(
            "select id::text as id, profile_id, url, format, artifact_hash from profile_blocklists where enabled = true",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(BlocklistRow {
                id: row.try_get("id")?,
                profile_id: row.try_get("profile_id")?,
                url: row.try_get("url")?,
                format: row.try_get("format")?,
                artifact_hash: row.try_get("artifact_hash")?,
            })
        })
        .collect()
    }

    pub async fn write_blocklist_status(
        &self,
        url: &str,
        status: &str,
        entries: i32,
        detected_format: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update profile_blocklists
                set last_synced_at = now(), last_status = $1, entry_count = $2,
                    detected_format = coalesce($3, detected_format)
              where url = $4",
        )
        .bind(status)
        .bind(entries)
        .bind(detected_format)
        .bind(url)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_purge(
        &self,
        profile_id: &str,
        domain: &str,
        record_type: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into dns_cache_purges (profile_id, domain, record_type)
             values ($1, $2, $3)",
        )
        .bind(profile_id)
        .bind(domain)
        .bind(record_type)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn pending_purges(
        &self,
        since: i64,
    ) -> Result<Vec<(String, String, Option<String>)>, sqlx::Error> {
        let rows = sqlx::query(
            "select profile_id, domain, record_type from dns_cache_purges
              where created_at > to_timestamp($1)",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok((
                    row.try_get("profile_id")?,
                    row.try_get("domain")?,
                    row.try_get("record_type")?,
                ))
            })
            .collect()
    }

    /// Returns false when the IP is linked to a different profile.
    pub async fn link_source_ip(&self, profile_id: &str, ip: &str) -> Result<bool, sqlx::Error> {
        let inserted = sqlx::query(
            "insert into profile_source_ips (ip_address, profile_id, last_seen_at)
             values ($1::inet, $2, now())
             on conflict (ip_address) do update
               set profile_id = excluded.profile_id,
                   last_seen_at = now()
               where profile_source_ips.last_seen_at < now() - interval '30 days'
             returning profile_id",
        )
        .bind(ip)
        .bind(profile_id)
        .fetch_optional(&self.pool)
        .await?;
        if inserted.is_some() {
            return Ok(true);
        }
        let owner: Option<String> =
            sqlx::query("select profile_id from profile_source_ips where ip_address = $1::inet")
                .bind(ip)
                .fetch_optional(&self.pool)
                .await?
                .and_then(|row| row.try_get("profile_id").ok());
        Ok(owner.as_deref() == Some(profile_id))
    }

    /// Keep an active link alive. Called at most once a day per source IP.
    pub async fn touch_source_ip(&self, ip: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update profile_source_ips set last_seen_at = now() where ip_address = $1::inet",
        )
        .bind(ip)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn touch_device(&self, profile_id: &str, device: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into profile_devices (profile_id, slug, first_seen_at, last_seen_at)
             select $1, $2, now(), now()
              where exists (
                      select 1 from profile_devices where profile_id = $1 and slug = $2
                    )
                 or (select count(*) from profile_devices where profile_id = $1) < 200
             on conflict (profile_id, slug) do update set last_seen_at = now()",
        )
        .bind(profile_id)
        .bind(device)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_probe(
        &self,
        nonce: &str,
        region: &str,
        transport: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into dns_probes (nonce, region, transport)
             values ($1, $2, $3)
             on conflict (nonce) do update set seen_at = now(), region = $2, transport = $3",
        )
        .bind(nonce)
        .bind(region)
        .bind(transport)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
