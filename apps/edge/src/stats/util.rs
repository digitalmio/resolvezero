use std::collections::HashMap;

use serde_json::{json, Value};
use time::macros::format_description;
use time::OffsetDateTime;

pub(super) fn floor(value: i64, width: i64) -> i64 {
    value - value.rem_euclid(width)
}

pub(super) fn top_json(map: &HashMap<String, i64>, key: &str, cap: usize) -> String {
    let mut entries: Vec<(&String, &i64)> = map.iter().collect();
    entries.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let values: Vec<Value> = entries
        .into_iter()
        .take(cap)
        .map(|(name, count)| json!({ key: name, "count": count }))
        .collect();
    Value::Array(values).to_string()
}

pub(super) fn format_time(at_ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos((at_ms as i128) * 1_000_000)
        .ok()
        .and_then(|time| {
            time.format(&format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
            ))
            .ok()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_to_window_boundaries() {
        assert_eq!(floor(0, 60), 0);
        assert_eq!(floor(125, 60), 120);
        assert_eq!(floor(-1, 60), -60);
        assert_eq!(floor(3_600, 3_600), 3_600);
    }

    #[test]
    fn top_json_sorts_by_count_then_name_and_caps() {
        let map = HashMap::from([
            ("a".to_string(), 2),
            ("b".to_string(), 5),
            ("c".to_string(), 5),
        ]);
        let value: Value = serde_json::from_str(&top_json(&map, "domain", 2)).unwrap();
        let entries = value.as_array().expect("array");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["domain"], "b");
        assert_eq!(entries[0]["count"], 5);
        assert_eq!(entries[1]["domain"], "c");
    }

    #[test]
    fn formats_millisecond_timestamps() {
        assert_eq!(format_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }
}
