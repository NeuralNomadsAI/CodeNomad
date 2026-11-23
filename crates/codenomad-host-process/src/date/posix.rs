pub(super) fn offset_name(seconds: i64) -> Option<String> {
    let minutes = seconds / 60;
    let magnitude = minutes.unsigned_abs();
    if magnitude >= 24 * 60 {
        return None;
    }
    if magnitude == 0 {
        return Some("UTC".into());
    }
    let sign = if minutes < 0 { '-' } else { '+' };
    Some(format!("{sign}{:02}:{:02}", magnitude / 60, magnitude % 60))
}

pub(super) fn offset_seconds(name: &str) -> Option<i64> {
    if name == "UTC" {
        return Some(0);
    }
    let (sign, time) = match name.as_bytes().first()? {
        b'+' => (1, &name[1..]),
        b'-' => (-1, &name[1..]),
        _ => return None,
    };
    let (hour, minute) = time.split_once(':')?;
    let (hour, minute) = (hour.parse::<u8>().ok()?, minute.parse::<u8>().ok()?);
    (hour < 24 && minute < 60).then(|| sign * (i64::from(hour) * 3600 + i64::from(minute) * 60))
}

pub(super) fn fixed_zone(spec: &str) -> Option<String> {
    if matches!(spec, "" | "UTC" | "GMT" | "Etc/UTC" | "Etc/GMT") {
        return Some("UTC".into());
    }
    // POSIX TZ signs say how much to add to local time to get UTC.
    let east = if let Some(name) = spec.strip_prefix('<') {
        name.split_once('>')?.1
    } else {
        let from = spec.bytes().take_while(u8::is_ascii_alphabetic).count();
        if from < 3 {
            return None;
        }
        &spec[from..]
    };
    let (sign, east) = if let Some(value) = east.strip_prefix('-') {
        (1, value)
    } else {
        (-1, east.strip_prefix('+').unwrap_or(east))
    };
    let mut parts = east.split(':');
    let num = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    let hours = num(parts.next()?)?.checked_mul(3600)?;
    let minutes = parts
        .next()
        .map_or(Some(0), |s| num(s).filter(|&v| v < 60))?;
    if parts.next().is_some() {
        return None;
    }
    offset_name(sign * hours.checked_add(minutes * 60)?)
}

pub(super) fn civil([y, m, d, h, min, s]: [i32; 6], locale: &str) -> String {
    let date = match locale {
        "en" => format!("{m}/{d}/{y}"),
        "de" | "he" => format!("{d}.{m}.{y}"),
        "ru" | "tr" => format!("{d:02}.{m:02}.{y}"),
        "fr" => format!("{d:02}/{m:02}/{y}"),
        "ja" | "zh-Hans" => format!("{y}/{m}/{d}"),
        "ne" => format!("{y}-{m:02}-{d:02}"),
        _ => format!("{d}/{m}/{y}"),
    };
    if locale == "en" {
        return format!(
            "{date}, {}:{min:02}:{s:02} {}",
            (h + 11) % 12 + 1,
            if h < 12 { "AM" } else { "PM" }
        );
    }
    let hour = if matches!(locale, "es" | "he" | "ja") {
        h.to_string()
    } else {
        format!("{h:02}")
    };
    let separator = if matches!(locale, "de" | "es" | "he" | "ne" | "ru") {
        ", "
    } else {
        " "
    };
    let text = format!("{date}{separator}{hour}:{min:02}:{s:02}");
    if locale != "ne" {
        return text;
    }
    text.chars()
        .map(|c| {
            c.to_digit(10)
                .and_then(|d| char::from_u32('०' as u32 + d))
                .unwrap_or(c)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_fixed_zones_use_iso_offsets_or_utc() {
        for (value, result, seconds) in [
            ("UTC0", "UTC", 0),
            ("GMT+0", "UTC", 0),
            ("EST5", "-05:00", -18_000),
            ("<+0545>-5:45", "+05:45", 20_700),
        ] {
            assert_eq!(fixed_zone(value).as_deref(), Some(result));
            assert_eq!(offset_seconds(result), Some(seconds));
        }
        assert_eq!(fixed_zone("EST5EDT,M3.2.0/2,M11.1.0/2"), None);
        assert_eq!(fixed_zone("Europe/Paris"), None);
    }

    #[test]
    fn civil_stamp_matches_intl_for_each_app_locale() {
        for (locale, expected) in [
            ("en", "3/4/2026, 8:07:06 AM"),
            ("de", "4.3.2026, 08:07:06"),
            ("es", "4/3/2026, 8:07:06"),
            ("fr", "04/03/2026 08:07:06"),
            ("he", "4.3.2026, 8:07:06"),
            ("ja", "2026/3/4 8:07:06"),
            ("ne", "२०२६-०३-०४, ०८:०७:०६"),
            ("ru", "04.03.2026, 08:07:06"),
            ("tr", "04.03.2026 08:07:06"),
            ("zh-Hans", "2026/3/4 08:07:06"),
        ] {
            assert_eq!(civil([2026, 3, 4, 8, 7, 6], locale), expected, "{locale}");
        }
    }
}
