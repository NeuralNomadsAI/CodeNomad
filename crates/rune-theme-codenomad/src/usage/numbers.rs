/// Number conventions for the ten application locales; USD remains the native currency.
pub fn exact(locale: &str, count: u64) -> String {
    localized(locale, &count.to_string())
}

pub fn decimal(locale: &str, amount: f64) -> String {
    let raw = fixed(amount, 8);
    let decimal = raw.trim_end_matches('0').trim_end_matches('.');
    localized(locale, decimal)
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
        fixed(cost.abs(), 2)
    };
    currency(locale, &raw, cost.is_sign_negative())
}

pub fn dashboard_usd(locale: &str, cost: f64) -> String {
    let mut raw = fixed(cost.abs(), 4);
    while raw.ends_with('0') && raw.split_once('.').is_some_and(|(_, frac)| frac.len() > 2) {
        raw.pop();
    }
    currency(locale, &raw, cost.is_sign_negative())
}

// Intl's halfExpand rounds the shortest decimal representation, not the binary float.
fn fixed(amount: f64, places: usize) -> String {
    let raw = amount.abs().to_string();
    if !amount.is_finite() {
        return amount.to_string();
    }
    let (whole, fraction) = raw.split_once('.').unwrap_or((&raw, ""));
    let mut digits: Vec<_> = whole.bytes().chain(fraction.bytes().take(places)).collect();
    digits.resize(whole.len() + places, b'0');
    if fraction
        .as_bytes()
        .get(places)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut carry = true;
        for digit in digits.iter_mut().rev() {
            if *digit == b'9' {
                *digit = b'0';
            } else {
                *digit += 1;
                carry = false;
                break;
            }
        }
        if carry {
            digits.insert(0, b'1');
        }
    }
    digits.insert(digits.len() - places, b'.');
    if amount.is_sign_negative() {
        digits.insert(0, b'-');
    }
    digits.into_iter().map(char::from).collect()
}

fn currency(locale: &str, raw: &str, negative: bool) -> String {
    let amount = localized(locale, raw);
    let sign = if negative { "-" } else { "" };
    match locale {
        "es" => format!("{sign}{amount}\u{a0}US$"),
        "fr" => format!("{sign}{amount}\u{a0}$US"),
        "de" | "ru" => format!("{sign}{amount}\u{a0}$"),
        "he" => format!(
            "\u{200f}{}{amount}\u{a0}\u{200f}$",
            if sign.is_empty() { "" } else { "\u{200e}-" }
        ),
        "zh-Hans" => format!("{sign}US${amount}"),
        "ne" => format!("{sign}US$\u{a0}{amount}"),
        _ => format!("{sign}${amount}"),
    }
}

fn localized(locale: &str, ascii: &str) -> String {
    if let Some(magnitude) = ascii.strip_prefix('-') {
        return format!("-{}", localized(locale, magnitude));
    }
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
    assert_eq!(decimal("fr", 64744.83), "64\u{202f}744,83");
    assert_eq!(decimal("en", -123.25), "-123.25");
    assert_eq!(exact("ne", 12345678), "१,२३,४५,६७८");
    assert_eq!(usd("en", 0.0068, true), "$0.0068");
    assert_eq!(usd("fr", 0.0068, true), "0,0068\u{a0}$US");
    assert_eq!(usd("de", 1024.75, false), "1.024,75\u{a0}$");
    assert_eq!(usd("he", 0.5, false), "\u{200f}0.50\u{a0}\u{200f}$");
    assert_eq!(dashboard_usd("fr", 0.03125), "0,0313\u{a0}$US");
    assert_eq!(dashboard_usd("en", 9.99995), "$10.00");
}

#[cfg(test)]
#[test]
fn usd_matches_intl_half_expand_for_all_app_locales() {
    for (locale, positive, negative) in [
        ("en", "$1,024.13", "-$1,024.13"),
        ("de", "1.024,13\u{a0}$", "-1.024,13\u{a0}$"),
        ("es", "1024,13\u{a0}US$", "-1024,13\u{a0}US$"),
        (
            "fr",
            "1\u{202f}024,13\u{a0}$US",
            "-1\u{202f}024,13\u{a0}$US",
        ),
        (
            "he",
            "\u{200f}1,024.13\u{a0}\u{200f}$",
            "\u{200f}\u{200e}-1,024.13\u{a0}\u{200f}$",
        ),
        ("ja", "$1,024.13", "-$1,024.13"),
        ("ne", "US$\u{a0}१,०२४.१३", "-US$\u{a0}१,०२४.१३"),
        ("ru", "1\u{a0}024,13\u{a0}$", "-1\u{a0}024,13\u{a0}$"),
        ("tr", "$1.024,13", "-$1.024,13"),
        ("zh-Hans", "US$1,024.13", "-US$1,024.13"),
    ] {
        assert_eq!(usd(locale, 1024.125, false), positive);
        assert_eq!(usd(locale, -1024.125, false), negative);
    }
    assert_eq!(usd("en", 1.005, false), "$1.01");
    assert_eq!(usd("en", 9.995, false), "$10.00");
}
