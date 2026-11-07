use rz_core::fingerprint::Action;

#[derive(Clone, Debug)]
pub struct ProfileRow {
    pub id: String,
    pub dot_id: Option<String>,
    pub doh_token: Option<String>,
    pub log_queries: bool,
    pub safe_search: Option<String>,
    pub upstream: Option<String>,
    pub upstream_url: Option<String>,
    pub block_mode: Option<String>,
    pub block_ipv4: Option<String>,
    pub block_ipv6: Option<String>,
    pub block_ttl: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct RuleRow {
    pub profile_id: String,
    pub domain: String,
    pub action: Action,
}

#[derive(Clone, Debug)]
pub struct SourceIpRow {
    pub ip_address: String,
    pub profile_id: String,
}

#[derive(Clone, Debug)]
pub struct ZoneRow {
    pub profile_id: String,
    pub domain: String,
    pub record_type: String,
    pub values: Vec<String>,
    pub ttl: i32,
}

#[derive(Clone, Debug)]
pub struct BlockedServiceRow {
    pub profile_id: String,
    pub service: String,
}

pub struct BlocklistRow {
    pub id: String,
    pub profile_id: String,
    pub url: String,
    pub format: String,
    pub artifact_hash: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CompileTarget {
    pub url: String,
    pub format: String,
    pub artifact_hash: Option<String>,
    /// Epoch seconds of the newest `compiled_at`, if any.
    pub compiled_at: Option<i64>,
}
