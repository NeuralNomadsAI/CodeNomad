/// Number conventions for the ten application locales; USD remains the native currency.
pub fn exact(locale: &str, count: u64) -> String {
    localized(locale, &count.to_string())
}

pub fn compact(locale: &str, count: u64) -> String {
    let (value, suffix) = match count {
        1_000_000_000.. => (format!("{:.1}", count as f64 / 1e9), "B"),
        1_000_000.. => (format!("{:.1}", count as f64 / 1e6), "M"),
        1_000.. => ((count.saturating_add(500) / 1000).to_string(), "K"),
        _ => return exact(locale, count),
    };
    format!("{}{suffix}", localized(locale, &value))
}

pub fn usd(locale: &str, cost: f64, small_cost_precision: bool) -> String {
    let raw = if small_cost_precision && cost > 0.0 && cost < 0.01 {
        let decimal_places = (1.0 - cost.log10().floor()) as usize;
        if decimal_places > 7 {
            format!("{cost:.1e}")
        } else {
            format!("{cost:.decimal_places$}")
        }
    } else {
        format!("{cost:.2}")
    };
    currency(locale, &raw)
}

pub fn dashboard_usd(locale: &str, cost: f64) -> String {
    let mut raw = format!("{cost:.4}");
    while raw.ends_with('0') && raw.split_once('.').is_some_and(|(_, frac)| frac.len() > 2) {
        raw.pop();
    }
    currency(locale, &raw)
}

fn currency(locale: &str, raw: &str) -> String {
    let amount = localized(locale, raw);
    match locale {
        "es" => format!("{amount}\u{a0}US$"),
        "fr" => format!("{amount}\u{a0}$US"),
        "de" | "ru" => format!("{amount}\u{a0}$"),
        "he" => format!("\u{200f}{amount}\u{a0}\u{200f}$"),
        "zh-Hans" => format!("US${amount}"),
        "ne" => format!("US$\u{a0}{amount}"),
        _ => format!("${amount}"),
    }
}

fn localized(locale: &str, ascii: &str) -> String {
    let group = match locale {
        "de" | "es" | "tr" => '.',
        "fr" => '\u{202f}',
        "ru" => '\u{a0}',
        _ => ',',
    };
    let decimal = match locale {
        "de" | "es" | "fr" | "ru" | "tr" => ',',
        _ => '.',
    };
    let whole = ascii.find(['.', 'e']).unwrap_or(ascii.len());
    let group_after = if locale == "es" { 4 } else { 3 };
    let mut result = String::with_capacity(ascii.len() + 8);
    for (i, c) in ascii.char_indices() {
        let remaining = whole.saturating_sub(i);
        if i != 0
            && whole > group_after
            && remaining >= 3
            && (if locale == "ne" {
                (remaining - 3).is_multiple_of(2)
            } else {
                remaining.is_multiple_of(3)
            })
        {
            result.push(group);
        }
        result.push(match c {
            '.' => decimal,
            '0'..='9' if locale == "ne" => {
                char::from_u32('०' as u32 + (c as u32 - '0' as u32)).unwrap_or(c)
            }
            _ => c,
        });
    }
    result
}

#[cfg(test)]
#[test]
fn formats_keep_units_and_usd_but_use_the_app_locales_symbols() {
    assert_eq!(compact("fr", 1_200_000), "1,2M");
    assert_eq!(exact("fr", 1_234_567), "1\u{202f}234\u{202f}567");
    assert_eq!(exact("es", 1234), "1234");
    assert_eq!(exact("ne", 12345678), "१,२३,४५,६७८");
    assert_eq!(usd("en", 0.0068, true), "$0.0068");
    assert_eq!(usd("fr", 0.0068, true), "0,0068\u{a0}$US");
    assert_eq!(usd("de", 1024.75, false), "1.024,75\u{a0}$");
    assert_eq!(usd("he", 0.5, false), "\u{200f}0.50\u{a0}\u{200f}$");
}
