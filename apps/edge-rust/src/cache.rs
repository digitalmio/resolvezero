use std::collections::HashMap;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug)]
struct Entry {
    bytes: Vec<u8>,
    stored_at: Instant,
    expires: Instant,
}

#[derive(Debug, Default)]
pub struct DnsCache {
    entries: HashMap<String, Entry>,
    bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

impl DnsCache {
    /// Returns the cached wire response plus how long it has been stored;
    /// callers normalize (strip OPT, rewrite question case, count TTLs down,
    /// patch transaction id) before returning it to a client.
    pub fn get(&mut self, key: &str) -> Option<(Vec<u8>, Duration)> {
        let now = Instant::now();
        match self.entries.get(key) {
            Some(entry) if entry.expires > now => {
                self.hits += 1;
                Some((entry.bytes.clone(), now.duration_since(entry.stored_at)))
            }
            Some(_) => {
                if let Some(removed) = self.entries.remove(key) {
                    self.bytes = self.bytes.saturating_sub(removed.bytes.len());
                }
                self.misses += 1;
                None
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    pub fn put(&mut self, key: String, bytes: Vec<u8>, ttl: Duration) {
        if bytes.len() > MAX_BYTES || ttl.is_zero() {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.bytes.len());
        }
        self.bytes += bytes.len();
        let stored_at = Instant::now();
        self.entries.insert(
            key,
            Entry {
                bytes,
                stored_at,
                expires: stored_at + ttl,
            },
        );
        self.evict();
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn evict(&mut self) {
        while self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
            let Some(key) = self.entries.keys().next().cloned() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&key) {
                self.bytes = self.bytes.saturating_sub(removed.bytes.len());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_returns_bytes_and_age() {
        let mut cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_secs(30));
        let (bytes, age) = cache.get("k").unwrap();
        assert_eq!(&bytes[0..2], &[0, 0]);
        assert!(age < Duration::from_secs(1));
        assert_eq!(cache.hits, 1);
    }

    #[test]
    fn expired_entries_miss() {
        let mut cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("k").is_none());
        assert_eq!(cache.misses, 1);
    }

    #[test]
    fn clear_resets_size() {
        let mut cache = DnsCache::default();
        cache.put("k".into(), vec![0u8; 64], Duration::from_secs(30));
        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.bytes, 0);
    }
}
