use std::collections::{HashMap, HashSet};
use std::time::Instant;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use rz_core::fingerprint::{Action, FingerprintTable};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BlockMode {
    #[default]
    Null,
    Nxdomain,
    Refused,
    Custom,
}

#[derive(Clone, Debug)]
pub struct BlockAnswer {
    pub mode: BlockMode,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub ttl: u32,
}

impl Default for BlockAnswer {
    fn default() -> Self {
        Self {
            mode: BlockMode::Null,
            ipv4: None,
            ipv6: None,
            ttl: 300,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SafeSearch {
    pub google: bool,
    pub bing: bool,
    pub duckduckgo: bool,
    pub youtube: bool,
}

impl SafeSearch {
    pub fn from_json(raw: Option<&str>) -> Self {
        let value: serde_json::Value = raw
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(serde_json::Value::Null);
        let flag = |key: &str| value.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
        Self {
            google: flag("google"),
            bing: flag("bing"),
            duckduckgo: flag("duckduckgo"),
            youtube: flag("youtube"),
        }
    }

    pub fn any(&self) -> bool {
        self.google || self.bing || self.duckduckgo || self.youtube
    }
}

#[derive(Clone, Default)]
pub struct ProfileMeta {
    pub token: Option<String>,
    /// Per-profile query-log opt-out (defaults to true).
    pub log_queries: Option<bool>,
    pub dot_id: Option<String>,
    pub upstream: Option<String>,
    pub upstream_url: Option<String>,
    pub block: BlockAnswer,
    pub safe_search: SafeSearch,
}

impl ProfileMeta {
    /// Null token = id-only auth (dev only); Some = token required.
    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// Custom URL wins over the preset selector, as in the TS store.
    pub fn upstream_selector(&self) -> Option<&str> {
        self.upstream_url.as_deref().or(self.upstream.as_deref())
    }
}

#[derive(Clone, Debug)]
pub struct ZoneEntry {
    pub values: Vec<String>,
    pub ttl: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub url: String,
    pub list_id: Option<String>,
    pub format: String,
    pub artifact_hash: Option<String>,
}

impl Subscription {
    /// Test/convenience constructor for a raw (uncompiled) list subscription.
    pub fn raw(url: &str, list_id: Option<String>) -> Self {
        Self {
            url: url.to_string(),
            list_id,
            format: "hosts".to_string(),
            artifact_hash: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListSource {
    Artifact,
    Raw,
}

#[derive(Default)]
pub struct RuleStore {
    /// profile_id -> (domain -> action). Custom rules only.
    pub rules: HashMap<String, HashMap<String, Action>>,
    pub profiles: HashMap<String, ProfileMeta>,
    /// source ip -> profile_id (UDP/TCP auth).
    pub ips: HashMap<String, String>,
    /// dot id label -> profile_id.
    pub dot_ids: HashMap<String, String>,
    /// "profile|domain|type" -> entry
    zones: HashMap<String, ZoneEntry>,
    /// "profile|suffix|type" -> entry (from "*.suffix")
    wildcard_zones: HashMap<String, ZoneEntry>,
    /// profile -> exact zone names (any type), for O(labels) NODATA checks.
    zone_names: HashMap<String, HashSet<String>>,
    /// profile -> wildcard zone suffixes (any type).
    wildcard_names: HashMap<String, HashSet<String>>,
    /// url -> shared table (one copy per machine).
    pub catalog: HashMap<String, FingerprintTable>,
    /// url -> artifact hash that produced the table (None for raw text).
    pub catalog_hashes: HashMap<String, Option<String>>,
    /// How each loaded table was obtained (reporting only).
    pub list_sources: HashMap<String, ListSource>,
    pub subscriptions: HashMap<String, Vec<Subscription>>,
    /// Profiles whose subscriptions have been loaded into the catalog.
    loaded_profiles: HashMap<String, ProfileLoad>,
}

#[derive(Clone, Copy, Debug)]
pub struct ProfileLoad {
    pub at: Instant,
    /// Lists that failed the first time; retried after a short backoff.
    pub failed: usize,
}

impl RuleStore {
    pub fn should_log(&self, profile_id: &str) -> bool {
        self.profiles
            .get(profile_id)
            .and_then(|meta| meta.log_queries)
            .unwrap_or(true)
    }

    pub fn tokenless_profiles(&self) -> Vec<String> {
        self.profiles
            .iter()
            .filter(|(_, meta)| meta.token.is_none())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn has_profile(&self, profile_id: &str, token: Option<&str>) -> bool {
        if profile_id.is_empty()
            || profile_id.len() > 64
            || !profile_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return false;
        }
        let Some(meta) = self.profiles.get(profile_id) else {
            return false;
        };
        match meta.token.as_deref() {
            None => true,
            Some(stored) => token.is_some_and(|supplied| constant_time_eq(supplied, stored)),
        }
    }

    pub fn authorize_ip(&self, ip: &str) -> Option<&String> {
        self.ips.get(ip)
    }

    pub fn authorize_dot_id(&self, dot_id: &str) -> Option<&String> {
        self.dot_ids.get(dot_id)
    }

    pub fn profile_meta(&self, profile_id: &str) -> Option<&ProfileMeta> {
        self.profiles.get(profile_id)
    }
}

pub fn normalize_rule_domain(domain: &str) -> Option<String> {
    let normalized = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized.len() < 3 || !normalized.contains('.') {
        return None;
    }
    Some(normalized)
}

/// Hash both values first so the comparison is independent of length (tokens
/// are fixed-length hex today, but this removes the length oracle entirely).
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = Sha256::digest(left.as_bytes());
    let right = Sha256::digest(right.as_bytes());
    left.ct_eq(&right).into()
}

mod config;
mod lists;
mod resolve;

#[cfg(test)]
mod tests;
