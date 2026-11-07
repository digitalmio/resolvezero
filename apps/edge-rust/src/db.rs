use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

use crate::fingerprint::Action;
use crate::store::{BlocklistRow, ProfileRow, RuleRow, SourceIpRow, ZoneRow};

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

#[derive(Clone, Copy, Debug)]
pub struct Versions {
    pub config: i32,
    pub blocklist: i32,
}

#[derive(Debug, Default)]
pub struct Snapshot {
    pub profiles: Vec<ProfileRow>,
    pub rules: Vec<RuleRow>,
    pub ips: Vec<SourceIpRow>,
    pub zones: Vec<ZoneRow>,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect(&sanitize_url(url))
            .await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn versions(&self) -> Result<Versions, sqlx::Error> {
        let row = sqlx::query(
            "select config_version, blocklist_version from edge_config_state where id = true limit 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(row) => Versions {
                config: row.try_get("config_version")?,
                blocklist: row.try_get("blocklist_version")?,
            },
            None => Versions {
                config: 0,
                blocklist: 0,
            },
        })
    }

    pub async fn snapshot(&self) -> Result<Snapshot, sqlx::Error> {
        let profiles = sqlx::query(
            "select id, dot_id, doh_token, log_queries, upstream, upstream_url, block_mode,
                    block_ipv4, block_ipv6, block_ttl
             from profiles",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(ProfileRow {
                id: row.try_get("id")?,
                dot_id: row.try_get("dot_id")?,
                doh_token: row.try_get("doh_token")?,
                log_queries: row.try_get("log_queries")?,
                upstream: row.try_get("upstream")?,
                upstream_url: row.try_get("upstream_url")?,
                block_mode: row.try_get("block_mode")?,
                block_ipv4: row.try_get("block_ipv4")?,
                block_ipv6: row.try_get("block_ipv6")?,
                block_ttl: row.try_get("block_ttl")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

        let rules = sqlx::query(
            "select profile_id, domain, action from profile_rules where enabled = true",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            let action: String = row.try_get("action")?;
            Ok(RuleRow {
                profile_id: row.try_get("profile_id")?,
                domain: row.try_get("domain")?,
                action: if action == "allow" {
                    Action::Allow
                } else {
                    Action::Block
                },
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

        let ips = sqlx::query(
            "select host(ip_address) as ip_address, profile_id from profile_source_ips",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(SourceIpRow {
                ip_address: row.try_get("ip_address")?,
                profile_id: row.try_get("profile_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

        let zones = sqlx::query(
            "select profile_id, domain, record_type, array(select jsonb_array_elements_text(values)) as values, ttl from profile_zones",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            Ok(ZoneRow {
                profile_id: row.try_get("profile_id")?,
                domain: row.try_get("domain")?,
                record_type: row.try_get("record_type")?,
                values: row.try_get("values")?,
                ttl: row.try_get("ttl")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

        Ok(Snapshot {
            profiles,
            rules,
            ips,
            zones,
        })
    }

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
}

/// PlanetScale's URL says `sslrootcert=system`, which means "use the OS trust
/// store" in node-postgres. sqlx treats it as a file path and fails with ENOENT,
/// so drop that parameter and let rustls use its bundled roots.
pub fn sanitize_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|part| !part.is_empty() && !part.starts_with("sslrootcert="))
        .collect();
    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_url;

    #[test]
    fn drops_sslrootcert_system() {
        assert_eq!(
            sanitize_url("postgresql://u:p@h:6432/db?sslmode=verify-full&sslrootcert=system"),
            "postgresql://u:p@h:6432/db?sslmode=verify-full"
        );
    }

    #[test]
    fn keeps_other_parameters() {
        assert_eq!(
            sanitize_url("postgresql://u@h/db?sslmode=require&application_name=rz"),
            "postgresql://u@h/db?sslmode=require&application_name=rz"
        );
    }
}
