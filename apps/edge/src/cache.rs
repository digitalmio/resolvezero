use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use moka::sync::Cache;
use moka::Expiry;

/// Approximate per-entry bookkeeping (Arc, Instant, hash table/linked list).
/// Moka's capacity is a weight, so include it to bound entry count as well as
/// raw response bytes.
const ENTRY_OVERHEAD: u64 = 512;
const MAX_WEIGHT: u64 = 50 * 1024 * 1024;
const MAX_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
struct Entry {
    bytes: Arc<[u8]>,
    stored_at: Instant,
    ttl: Duration,
}

impl Entry {
    fn weight(&self) -> u32 {
        (self.bytes.len() as u64 + ENTRY_OVERHEAD).min(u32::MAX as u64) as u32
    }

    fn expired(&self) -> bool {
        self.stored_at.elapsed() >= self.ttl
    }
}

struct DnsExpiry;

impl Expiry<String, Entry> for DnsExpiry {
    fn expire_after_create(
        &self,
        _key: &String,
        value: &Entry,
        _created_at: Instant,
    ) -> Option<Duration> {
        Some(value.ttl)
    }

    fn expire_after_update(
        &self,
        _key: &String,
        value: &Entry,
        _updated_at: Instant,
        _duration_until_expiry: Option<Duration>,
    ) -> Option<Duration> {
        Some(value.ttl)
    }
}

/// Per-PoP DNS answer cache. Moka provides concurrent access, TinyLFU/LRU
/// eviction, and per-entry TTL; policy is still checked before this cache.
pub struct DnsCache {
    entries: Cache<String, Entry>,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl Default for DnsCache {
    fn default() -> Self {
        Self::new()
    }
}

impl DnsCache {
    pub fn new() -> Self {
        let entries = Cache::<String, Entry>::builder()
            .max_capacity(MAX_WEIGHT)
            .weigher(|_key: &String, value: &Entry| value.weight())
            .expire_after(DnsExpiry)
            .build();
        Self {
            entries,
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    /// Returns the cached wire response plus how long it has been stored;
    /// callers normalize (strip OPT, rewrite question case, count TTLs down,
    /// patch transaction id) before returning it to a client.
    pub fn get(&self, key: &str) -> Option<(Arc<[u8]>, Duration, Duration)> {
        match self.entries.get(key) {
            Some(entry) if !entry.expired() => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some((entry.bytes.clone(), entry.stored_at.elapsed(), entry.ttl))
            }
            Some(_) => {
                // Moka's housekeeping is lazy; never serve a stale answer even
                // if the expiry sweep has not run yet.
                self.entries.invalidate(key);
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    pub fn put(&self, key: String, bytes: Vec<u8>, ttl: Duration) {
        let ttl = ttl.min(MAX_TTL);
        if ttl.is_zero() {
            return;
        }
        self.entries.insert(
            key,
            Entry {
                bytes: bytes.into(),
                stored_at: Instant::now(),
                ttl,
            },
        );
    }

    pub fn clear(&self) {
        self.entries.invalidate_all();
        self.entries.run_pending_tasks();
    }

    /// Evict one name (optionally one record type) after a console purge.
    pub fn purge(&self, profile: &str, domain: &str, record_type: Option<&str>) {
        let prefix = format!(
            "{}|{}|",
            profile,
            domain.trim_end_matches('.').to_ascii_lowercase()
        );
        let keys: Vec<String> = self
            .entries
            .iter()
            .filter_map(|(key, _)| {
                let key = key.as_ref();
                let hit = key.starts_with(&prefix)
                    && record_type.is_none_or(|wanted| key.split('|').nth(2) == Some(wanted));
                hit.then(|| key.clone())
            })
            .collect();
        for key in keys {
            self.entries.invalidate(&key);
        }
        self.entries.run_pending_tasks();
    }

    pub fn len(&self) -> usize {
        self.entries.run_pending_tasks();
        self.entries.entry_count() as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::Relaxed)
    }

    pub fn misses(&self) -> u64 {
        self.misses.load(Ordering::Relaxed)
    }

    /// Weighted bytes, including the per-entry overhead.
    pub fn bytes(&self) -> usize {
        self.entries.run_pending_tasks();
        self.entries.weighted_size() as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_returns_bytes_and_age() {
        let cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_secs(30));
        let (bytes, age, ttl) = cache.get("k").unwrap();
        assert_eq!(&bytes[0..2], &[0, 0]);
        assert!(age < Duration::from_secs(1));
        assert_eq!(ttl, Duration::from_secs(30));
        assert_eq!(cache.hits(), 1);
    }

    #[test]
    fn expired_entries_miss() {
        let cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("k").is_none());
        assert_eq!(cache.misses(), 1);
    }

    #[test]
    fn clear_resets_size() {
        let cache = DnsCache::default();
        cache.put("a".into(), vec![0; 8], Duration::from_secs(30));
        cache.put("b".into(), vec![0; 8], Duration::from_secs(30));
        assert_eq!(cache.len(), 2);
        cache.clear();
        assert_eq!(cache.len(), 0);
        assert!(cache.is_empty());
    }

    #[test]
    fn purge_matches_name_and_type() {
        let cache = DnsCache::default();
        cache.put(
            "home|example.com|A|IN|false|none|u".into(),
            vec![0; 8],
            Duration::from_secs(30),
        );
        cache.put(
            "home|example.com|AAAA|IN|false|none|u".into(),
            vec![0; 8],
            Duration::from_secs(30),
        );
        cache.put(
            "home|other.com|A|IN|false|none|u".into(),
            vec![0; 8],
            Duration::from_secs(30),
        );
        cache.purge("home", "example.com", Some("A"));
        assert!(cache.get("home|example.com|A|IN|false|none|u").is_none());
        assert!(cache.get("home|example.com|AAAA|IN|false|none|u").is_some());
        assert!(cache.get("home|other.com|A|IN|false|none|u").is_some());
    }
}
