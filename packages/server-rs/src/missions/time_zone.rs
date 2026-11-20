//! Time zone acceptance matching the reference's `new Intl.DateTimeFormat("en",
//! { timeZone })` (Node ICU): case-insensitive IANA names and links, ICU legacy
//! IDs and UTC offsets. The accepted names are generated from Node by
//! `generate-time-zones.mjs`; computations use the IANA data of `chrono-tz`.
use std::{collections::HashSet, sync::LazyLock};

static NAMES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    include_str!("time_zone_names.txt")
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .collect()
});

/// `±HH`, `±HHMM` or `±HH:MM`, hours 00-23 and minutes 00-59, as ICU accepts.
fn offset(zone: &str) -> bool {
    let b = zone.as_bytes();
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    let hours = |s: &[u8]| digits(s) && (s[0] < b'2' || s[0] == b'2' && s[1] <= b'3');
    let minutes = |s: &[u8]| digits(s) && s[0] <= b'5';
    matches!(b.first(), Some(b'+' | b'-'))
        && match b.len() {
            3 => hours(&b[1..3]),
            5 => hours(&b[1..3]) && minutes(&b[3..5]),
            6 => hours(&b[1..3]) && b[3] == b':' && minutes(&b[4..6]),
            _ => false,
        }
}

pub fn valid(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 100
        && (offset(zone) || NAMES.contains(zone.to_ascii_lowercase().as_str()))
}

/// The IANA zone for computations; ICU-only IDs and offsets have none.
#[cfg(test)]
pub fn parse(zone: &str) -> Option<chrono_tz::Tz> {
    if !valid(zone) {
        return None;
    }
    zone.parse()
        .ok()
        .or_else(|| chrono_tz::Tz::from_str_insensitive(zone).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_follow_node_intl() {
        // Verdicts observed with Node v25.2.1 (ICU 77.1, tz 2025b).
        for (zone, ok) in [
            ("Europe/Paris", true), ("europe/paris", true), ("EUROPE/PARIS", true), ("UTC", true),
            ("utc", true), ("Etc/GMT+1", true), ("Etc/GMT+14", false), ("Etc/GMT-15", false),
            ("GMT0", true), ("US/Eastern", true), ("EST5EDT", true), ("Asia/Calcutta", true),
            ("Invalid/Zone", false), ("+01:00", true), ("-0530", true), ("+01", true), ("Z", false),
            ("", false), ("Europe/Kiev", true), ("SystemV/EST5", true), ("ROC", true),
            ("Factory", false), ("localtime", false), ("America/Buenos_Aires", true),
            ("Europe/paris ", false), (" Europe/Paris", false), ("+24:00", false), ("+23:59", true),
            ("+0060", false), ("+1", false), ("+01:0", false), ("+01:00:00", false), ("-00:00", true),
        ] {
            assert_eq!(valid(zone), ok, "{zone}");
        }
    }

    #[test]
    fn iana_names_parse_for_computation() {
        assert_eq!(parse("europe/paris"), Some(chrono_tz::Europe::Paris));
        assert_eq!(parse("Asia/Calcutta").map(|z| z.name()), Some("Asia/Calcutta"));
        assert_eq!(parse("SystemV/EST5"), None);
        assert_eq!(parse("+01:00"), None);
        assert_eq!(parse("Not/AZone"), None);
    }
}
