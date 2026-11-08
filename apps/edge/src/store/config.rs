use std::collections::{HashMap, HashSet};

use rz_core::fingerprint::Action;
use rz_db::{BlockedServiceRow, ProfileRow, RuleRow, SourceIpRow, ZoneRow};

use super::{
    normalize_rule_domain, BlockAnswer, BlockMode, ProfileMeta, RuleStore, SafeSearch, ZoneEntry,
};
use crate::services::blocked_service_domains;

impl RuleStore {
    pub fn replace_config(
        &mut self,
        profiles: Vec<ProfileRow>,
        rules: Vec<RuleRow>,
        ips: Vec<SourceIpRow>,
        zones: Vec<ZoneRow>,
        services: Vec<BlockedServiceRow>,
    ) {
        let mut rule_map: HashMap<String, HashMap<String, Action>> = HashMap::new();
        for row in rules {
            let Some(domain) = normalize_rule_domain(&row.domain) else {
                continue;
            };
            rule_map
                .entry(row.profile_id)
                .or_default()
                .insert(domain, row.action);
        }
        // Blocked services expand into synthetic suffix rules. Existing custom
        // rules win, so an explicit allow can carve a host out of a service.
        let mut services_by_profile: HashMap<String, Vec<String>> = HashMap::new();
        for row in services {
            services_by_profile
                .entry(row.profile_id)
                .or_default()
                .push(row.service);
        }
        for (profile_id, ids) in services_by_profile {
            let profile = rule_map.entry(profile_id).or_default();
            for domain in blocked_service_domains(&ids) {
                profile.entry(domain.to_string()).or_insert(Action::Block);
            }
        }
        self.rules = rule_map;

        self.profiles = profiles
            .into_iter()
            .map(|row| {
                let block = BlockAnswer {
                    mode: match row.block_mode.as_deref() {
                        Some("nxdomain") => BlockMode::Nxdomain,
                        Some("refused") => BlockMode::Refused,
                        Some("custom") => BlockMode::Custom,
                        _ => BlockMode::Null,
                    },
                    ipv4: row.block_ipv4,
                    ipv6: row.block_ipv6,
                    ttl: row.block_ttl.unwrap_or(300).max(1) as u32,
                };
                (
                    row.id,
                    ProfileMeta {
                        token: row.doh_token,
                        log_queries: Some(row.log_queries),
                        dot_id: row.dot_id,
                        upstream: row.upstream,
                        upstream_url: row.upstream_url,
                        block,
                        safe_search: SafeSearch::from_json(row.safe_search.as_deref()),
                    },
                )
            })
            .collect();

        self.dot_ids = self
            .profiles
            .iter()
            .filter_map(|(id, meta)| meta.dot_id.as_ref().map(|dot| (dot.clone(), id.clone())))
            .collect();

        self.ips = ips
            .into_iter()
            .map(|row| (row.ip_address, row.profile_id))
            .collect();

        self.zones.clear();
        self.wildcard_zones.clear();
        self.zone_names.clear();
        self.wildcard_names.clear();
        for row in zones {
            let domain = row.domain.trim_end_matches('.').to_ascii_lowercase();
            if domain.is_empty() || row.values.is_empty() {
                continue;
            }
            let wildcard = domain.starts_with("*.");
            let name = domain.trim_start_matches("*.").to_string();
            let key = format!("{}|{}|{}", row.profile_id, name, row.record_type);
            let entry = ZoneEntry {
                values: row.values,
                ttl: row.ttl.max(1) as u32,
            };
            if wildcard {
                self.wildcard_names
                    .entry(row.profile_id.clone())
                    .or_default()
                    .insert(name.clone());
                self.wildcard_zones.insert(key, entry);
            } else {
                self.zone_names
                    .entry(row.profile_id.clone())
                    .or_default()
                    .insert(name.clone());
                self.zones.insert(key, entry);
            }
        }

        // Drop subscriptions for deleted profiles; the catalog is pruned by
        // the blocklist sync after re-wiring.
        let alive: HashSet<&String> = self.profiles.keys().collect();
        self.subscriptions
            .retain(|profile_id, _| alive.contains(profile_id));
        self.loaded_profiles
            .retain(|profile_id, _| alive.contains(profile_id));
    }
}
