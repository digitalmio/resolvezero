use std::collections::{HashMap, HashSet};

use tracing::warn;

use rz_core::netguard::redact_url;
use rz_db::BlocklistRow;

use crate::store::Subscription;

pub(crate) struct SubscriptionPlan {
    pub by_profile: HashMap<String, Vec<Subscription>>,
    pub configured: HashSet<String>,
    pub failed: usize,
}

/// Group enabled list rows into per-profile subscriptions, applying the unique
/// and per-profile caps. Pure so the cap/dedupe rules are unit-testable without
/// Postgres.
pub(crate) fn build_subscriptions(
    rows: Vec<BlocklistRow>,
    max_unique: usize,
    max_per_profile: usize,
) -> SubscriptionPlan {
    let mut plan = SubscriptionPlan {
        by_profile: HashMap::new(),
        configured: HashSet::new(),
        failed: 0,
    };
    let mut unique: HashSet<String> = HashSet::new();

    for row in rows {
        plan.configured.insert(row.profile_id.clone());
        let subscriptions = plan.by_profile.entry(row.profile_id.clone()).or_default();
        if !unique.contains(&row.url) {
            if unique.len() >= max_unique {
                warn!(
                    url = %redact_url(&row.url),
                    cap = max_unique,
                    "unique-list cap reached; list skipped"
                );
                plan.failed += 1;
                continue;
            }
            unique.insert(row.url.clone());
        }
        subscriptions.push(Subscription {
            url: row.url,
            list_id: Some(row.id),
            format: row.format,
            artifact_hash: row.artifact_hash,
        });
    }

    for (profile_id, subscriptions) in plan.by_profile.iter_mut() {
        let mut seen = HashSet::new();
        subscriptions.retain(|sub| seen.insert(sub.url.clone()));
        if subscriptions.len() > max_per_profile {
            warn!(
                profile_id,
                cap = max_per_profile,
                "per-profile list cap reached"
            );
            subscriptions.truncate(max_per_profile);
        }
    }
    plan
}
