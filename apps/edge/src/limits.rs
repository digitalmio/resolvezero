use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_MAX_KEYS: usize = 50_000;

/// Fixed-window per-key limiter with a hard key cap so hostile sources cannot
/// grow memory without bound.
pub struct FixedWindow {
    limit: u32,
    window: Duration,
    max_keys: usize,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl FixedWindow {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self::with_max_keys(limit, window, DEFAULT_MAX_KEYS)
    }

    pub fn with_max_keys(limit: u32, window: Duration, max_keys: usize) -> Self {
        Self {
            limit: limit.max(1),
            window,
            max_keys: max_keys.max(1),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let key = source_key(key);
        let mut buckets = self.buckets.lock().expect("rate limiter");
        if buckets.len() >= self.max_keys {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < self.window);
            if !buckets.contains_key(&key) && buckets.len() >= self.max_keys {
                return false;
            }
        }
        let entry = buckets.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 1);
            return true;
        }
        if entry.1 >= self.limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}

/// Collapse IPv6 addresses to their /64 so a rotating /64 cannot grow the
/// limiter map without bound. Non-IP keys (admin/logs/purge) pass through.
fn source_key(key: &str) -> String {
    match key.parse::<IpAddr>() {
        Ok(IpAddr::V6(ip)) => {
            let segments = ip.segments();
            Ipv6Addr::new(
                segments[0],
                segments[1],
                segments[2],
                segments[3],
                0,
                0,
                0,
                0,
            )
            .to_string()
        }
        _ => key.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_the_window() {
        let limiter = FixedWindow::new(2, Duration::from_millis(50));
        assert!(limiter.allow("a"));
        assert!(limiter.allow("a"));
        assert!(!limiter.allow("a"));
        assert!(limiter.allow("b"));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.allow("a"));
    }

    #[test]
    fn caps_the_key_map() {
        let limiter = FixedWindow::with_max_keys(2, Duration::from_secs(60), 2);
        assert!(limiter.allow("a"));
        assert!(limiter.allow("b"));
        assert!(!limiter.allow("c"));
        assert!(limiter.allow("a"));
    }

    #[test]
    fn normalizes_ipv6_to_64() {
        assert_eq!(source_key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::");
        assert_eq!(source_key("admin:1.2.3.4"), "admin:1.2.3.4");
    }
}
