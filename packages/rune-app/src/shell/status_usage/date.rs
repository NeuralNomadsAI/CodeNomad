pub(crate) fn short_local(millis: f64, locale: &str) -> Option<String> {
    let millis = (millis != 0.0 && millis.abs() <= 8.64e15).then_some(millis)?;
    short(millis, locale)
}

pub(super) fn reset(millis: Option<f64>) -> Option<String> {
    let millis = millis.filter(|ms| *ms != 0.0 && ms.abs() <= 8.64e15)?;
    let date = short(millis, crate::strings::locale())?;
    Some(crate::strings::t("providerUsage.resets").replace("{time}", &date))
}

#[cfg(target_arch = "wasm32")]
fn short(millis: f64, locale: &str) -> Option<String> {
    use js_sys::{Array, Intl, Object, Reflect};
    use wasm_bindgen::JsValue;
    let options = Object::new();
    for key in ["dateStyle", "timeStyle"] {
        Reflect::set(&options, &key.into(), &"short".into()).ok()?;
    }
    let locales = Array::of1(&JsValue::from_str(locale));
    Intl::DateTimeFormat::new(&locales, &options)
        .format()
        .call1(&JsValue::UNDEFINED, &millis.into())
        .ok()?
        .as_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn short(millis: f64, locale: &str) -> Option<String> {
    let local = codenomad_host_process::local_clock((millis / 1000.0).floor() as i64)?;
    Some(short_civil(local, locale))
}

#[cfg(not(target_arch = "wasm32"))]
fn short_civil(local: (i32, i32, i32, i32, i32), locale: &str) -> String {
    let (year, month, day, hour, minute) = local;
    let date = match locale {
        "en" => format!("{month}/{day}/{:02}", year.rem_euclid(100)),
        "de" => format!("{day:02}.{month:02}.{:02}", year.rem_euclid(100)),
        "es" => format!("{day}/{month}/{:02}", year.rem_euclid(100)),
        "ru" => format!("{day:02}.{month:02}.{year:04}"),
        "tr" => format!("{day}.{month:02}.{year:04}"),
        "fr" => format!("{day:02}/{month:02}/{year:04}"),
        "he" => format!("{day}.{month}.{year:04}"),
        "ja" => format!("{year:04}/{month:02}/{day:02}"),
        "ne" => format!("{:02}/{month}/{day}", year.rem_euclid(100)),
        "zh-Hans" => format!("{year:04}/{month}/{day}"),
        _ => format!("{day}/{month}/{year:04}"),
    };
    let mut stamp = if locale == "en" {
        format!(
            "{date}, {}:{minute:02} {}",
            (hour + 11) % 12 + 1,
            if hour < 12 { "AM" } else { "PM" }
        )
    } else {
        match locale {
            "es" | "he" => format!("{date}, {hour}:{minute:02}"),
            "de" | "ne" | "ru" => format!("{date}, {hour:02}:{minute:02}"),
            "ja" => format!("{date} {hour}:{minute:02}"),
            _ => format!("{date} {hour:02}:{minute:02}"),
        }
    };
    if locale == "ne" {
        stamp = stamp
            .chars()
            .map(|ch| {
                ch.to_digit(10)
                    .and_then(|digit| char::from_u32('०' as u32 + digit))
                    .unwrap_or(ch)
            })
            .collect();
    }
    stamp
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn short_civil_time_matches_intl_in_all_app_locales() {
    for (locale, morning, evening) in [
        ("en", "3/4/26, 8:07 AM", "11/18/26, 5:42 PM"),
        ("de", "04.03.26, 08:07", "18.11.26, 17:42"),
        ("es", "4/3/26, 8:07", "18/11/26, 17:42"),
        ("fr", "04/03/2026 08:07", "18/11/2026 17:42"),
        ("he", "4.3.2026, 8:07", "18.11.2026, 17:42"),
        ("ja", "2026/03/04 8:07", "2026/11/18 17:42"),
        ("ne", "२६/३/४, ०८:०७", "२६/११/१८, १७:४२"),
        ("ru", "04.03.2026, 08:07", "18.11.2026, 17:42"),
        ("tr", "4.03.2026 08:07", "18.11.2026 17:42"),
        ("zh-Hans", "2026/3/4 08:07", "2026/11/18 17:42"),
    ] {
        assert_eq!(short_civil((2026, 3, 4, 8, 7), locale), morning);
        assert_eq!(short_civil((2026, 11, 18, 17, 42), locale), evening);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn protocol_resets_use_the_app_locale_and_hide_missing_dates() {
    assert_eq!(reset(None), None);
    assert_eq!(reset(Some(0.0)), None);
    assert_eq!(reset(Some(f64::INFINITY)), None);
    let stamp = Some(1_800_000_000_000.0);
    let fr = crate::strings::with_locale("fr", || reset(stamp)).unwrap();
    let en = crate::strings::with_locale("en", || reset(stamp)).unwrap();
    assert_ne!(fr.split_once(' ').unwrap().1, en.split_once(' ').unwrap().1);
}
