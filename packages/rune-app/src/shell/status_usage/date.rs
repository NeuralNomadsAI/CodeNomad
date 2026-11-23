pub(super) fn reset(millis: Option<f64>) -> Option<String> {
    let millis = millis.filter(|ms| *ms != 0.0 && ms.abs() <= 8.64e15)?;
    let date = short(millis, crate::strings::locale())?;
    Some(crate::strings::t("providerUsage.resets").replace("{time}", &date))
}

#[cfg(windows)]
use codenomad_host_process::local_short_date_time as short;

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

#[cfg(unix)]
fn short(millis: f64, locale: &str) -> Option<String> {
    let (year, month, day, hour, minute) =
        codenomad_host_process::local_clock((millis / 1000.0).floor() as i64)?;
    let date = match locale {
        "en" => format!("{month}/{day}/{:02}", year.rem_euclid(100)),
        "de" => format!("{day:02}.{month:02}.{:02}", year.rem_euclid(100)),
        "ru" => format!("{day:02}.{month:02}.{year:04}"),
        "tr" => format!("{day:02}.{month:02}.{year:04}"),
        "fr" => format!("{day:02}/{month:02}/{year:04}"),
        "he" => format!("{day}.{month}.{year:04}"),
        "ja" | "zh-Hans" | "ne" => format!("{year:04}/{month}/{day}"),
        _ => format!("{day}/{month}/{year:04}"),
    };
    let mut stamp = if locale == "en" {
        format!(
            "{date}, {}:{minute:02} {}",
            (hour + 11) % 12 + 1,
            if hour < 12 { "AM" } else { "PM" }
        )
    } else {
        format!("{date} {hour:02}:{minute:02}")
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
    Some(stamp)
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
