use std::collections::HashMap;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug)]
struct Entry {
    bytes: Vec<u8>,
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
    pub fn get(&mut self, key: &str, transaction_id: u16) -> Option<Vec<u8>> {
        let now = Instant::now();
        match self.entries.get(key) {
            Some(entry) if entry.expires > now => {
                self.hits += 1;
                let mut bytes = entry.bytes.clone();
                if bytes.len() >= 2 {
                    bytes[0..2].copy_from_slice(&transaction_id.to_be_bytes());
                }
                Some(bytes)
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
        self.entries.insert(
            key,
            Entry {
                bytes,
                expires: Instant::now() + ttl,
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
    fn patched_transaction_id_on_hit() {
        let mut cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_secs(30));
        let hit = cache.get("k", 0x4242).unwrap();
        assert_eq!(&hit[0..2], &[0x42, 0x42]);
        assert_eq!(cache.hits, 1);
    }

    #[test]
    fn expired_entries_miss() {
        let mut cache = DnsCache::default();
        cache.put("k".into(), vec![0, 0, 9, 9], Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(cache.get("k", 1).is_none());
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
