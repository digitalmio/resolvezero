use std::collections::HashSet;
use std::time::{Duration, Instant};

use rz_core::fingerprint::FingerprintTable;

use super::{ListSource, ProfileLoad, RuleStore, Subscription};

impl RuleStore {
    pub fn wire_subscriptions(&mut self, profile_id: &str, urls: Vec<Subscription>) {
        let unchanged = self
            .subscriptions
            .get(profile_id)
            .is_some_and(|previous| previous == &urls);
        if urls.is_empty() {
            self.subscriptions.remove(profile_id);
        } else {
            self.subscriptions.insert(profile_id.to_string(), urls);
        }
        if !unchanged {
            self.loaded_profiles.remove(profile_id);
        }
    }

    pub fn is_profile_loaded(&self, profile_id: &str, retry: Duration) -> bool {
        match self.loaded_profiles.get(profile_id) {
            Some(load) => load.failed == 0 || load.at.elapsed() < retry,
            None => false,
        }
    }

    pub fn mark_profile_loaded(&mut self, profile_id: &str, failed: usize) {
        self.loaded_profiles.insert(
            profile_id.to_string(),
            ProfileLoad {
                at: Instant::now(),
                failed,
            },
        );
    }

    /// Drop every lazy marker after the blocklist watermark moves, so each
    /// profile re-checks its lists on its next query.
    pub fn clear_loaded(&mut self) {
        self.loaded_profiles.clear();
    }

    /// True when this exact artifact (or a raw table) is already in the catalog.
    pub fn list_up_to_date(&self, subscription: &Subscription) -> bool {
        self.catalog.contains_key(&subscription.url)
            && self
                .catalog_hashes
                .get(&subscription.url)
                .is_some_and(|hash| hash == &subscription.artifact_hash)
    }

    pub fn upsert_list(
        &mut self,
        url: &str,
        artifact_hash: Option<&str>,
        source: ListSource,
        table: FingerprintTable,
    ) -> bool {
        let changed = self
            .catalog
            .get(url)
            .is_none_or(|previous| previous.fingerprint != table.fingerprint);
        self.catalog.insert(url.to_string(), table);
        self.catalog_hashes
            .insert(url.to_string(), artifact_hash.map(str::to_string));
        self.list_sources.insert(url.to_string(), source);
        changed
    }

    pub fn prune_catalog(&mut self) {
        let referenced: HashSet<&str> = self
            .subscriptions
            .values()
            .flatten()
            .map(|subscription| subscription.url.as_str())
            .collect();
        self.catalog
            .retain(|url, _| referenced.contains(url.as_str()));
        self.catalog_hashes
            .retain(|url, _| referenced.contains(url.as_str()));
        self.list_sources
            .retain(|url, _| referenced.contains(url.as_str()));
    }

    pub fn artifact_lists(&self) -> usize {
        self.list_sources
            .values()
            .filter(|source| **source == ListSource::Artifact)
            .count()
    }

    pub fn raw_lists(&self) -> usize {
        self.list_sources
            .values()
            .filter(|source| **source == ListSource::Raw)
            .count()
    }

    pub fn pending_lists(&self) -> usize {
        let mut urls: HashSet<&str> = HashSet::new();
        for subscription in self.subscriptions.values().flatten() {
            if !self.list_up_to_date(subscription) {
                urls.insert(subscription.url.as_str());
            }
        }
        urls.len()
    }

    pub fn remote_rules(&self) -> usize {
        self.catalog.values().map(|table| table.entries).sum()
    }
}
