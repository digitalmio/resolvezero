use rz_core::fingerprint::Action;

use super::{normalize_rule_domain, RuleStore, ZoneEntry};

impl RuleStore {
    /// Exact match first, then longest suffix (custom rules: block subtree).
    pub fn resolve_custom(&self, profile_id: &str, domain: &str) -> Option<Action> {
        let rules = self.rules.get(profile_id)?;
        let normalized = normalize_rule_domain(domain)?;
        if let Some(action) = rules.get(&normalized) {
            return Some(*action);
        }
        let labels: Vec<&str> = normalized.split('.').collect();
        for index in 1..labels.len() {
            if let Some(action) = rules.get(&labels[index..].join(".")) {
                return Some(*action);
            }
        }
        None
    }

    /// All allow tables first, then all block tables (cross-list precedence).
    pub fn resolve_remote(&self, profile_id: &str, domain: &str) -> Option<Action> {
        self.resolve_remote_detailed(profile_id, domain)
            .map(|(action, _)| action)
    }

    /// Same decision, plus the `profile_blocklists.id` that produced it for
    /// query-log attribution (never the URL).
    pub fn resolve_remote_detailed(
        &self,
        profile_id: &str,
        domain: &str,
    ) -> Option<(Action, Option<String>)> {
        let subscriptions = self.subscriptions.get(profile_id)?;
        for subscription in subscriptions {
            if let Some(table) = self.catalog.get(&subscription.url) {
                if table.check_allow(domain) {
                    return Some((Action::Allow, subscription.list_id.clone()));
                }
            }
        }
        for subscription in subscriptions {
            if let Some(table) = self.catalog.get(&subscription.url) {
                if table.check_block(domain) {
                    return Some((Action::Block, subscription.list_id.clone()));
                }
            }
        }
        None
    }

    pub fn zone_lookup(
        &self,
        profile_id: &str,
        domain: &str,
        record_type: &str,
    ) -> Option<ZoneEntry> {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        let key = format!("{}|{}|{}", profile_id, domain, record_type);
        if let Some(entry) = self.zones.get(&key) {
            return Some(entry.clone());
        }
        let labels: Vec<&str> = domain.split('.').collect();
        for index in 1..labels.len() {
            let suffix = labels[index..].join(".");
            let key = format!("{}|{}|{}", profile_id, suffix, record_type);
            if let Some(entry) = self.wildcard_zones.get(&key) {
                return Some(entry.clone());
            }
        }
        None
    }

    pub fn has_zone_name(&self, profile_id: &str, domain: &str) -> bool {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        self.zones
            .keys()
            .any(|key| key.starts_with(&format!("{}|{}|", profile_id, domain)))
            || self.wildcard_zones.keys().any(|key| {
                key.starts_with(&format!("{}|", profile_id))
                    && key.split('|').nth(1).is_some_and(|suffix| {
                        domain == suffix || domain.ends_with(&format!(".{suffix}"))
                    })
            })
    }
}
