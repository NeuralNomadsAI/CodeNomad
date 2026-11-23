pub(super) fn display(stamp: &str, locale: &str) -> String {
    local_month_day(stamp, locale).unwrap_or_else(|| stamp.get(..10).unwrap_or(stamp).into())
}

#[cfg(windows)]
use codenomad_host_process::local_month_day;

#[cfg(target_arch = "wasm32")]
fn local_month_day(stamp: &str, locale: &str) -> Option<String> {
    use js_sys::{Array, Date, Intl, Object, Reflect};
    use wasm_bindgen::JsValue;

    let millis = Date::parse(stamp);
    if !millis.is_finite() {
        return None;
    }
    let options = Object::new();
    for (key, value) in [("month", "short"), ("day", "numeric")] {
        Reflect::set(&options, &key.into(), &value.into()).ok()?;
    }
    let locales = Array::of1(&JsValue::from_str(locale));
    Intl::DateTimeFormat::new(&locales, &options)
        .format()
        .call1(&JsValue::UNDEFINED, &millis.into())
        .ok()?
        .as_string()
}

#[cfg(not(any(windows, target_arch = "wasm32")))]
fn local_month_day(_: &str, _: &str) -> Option<String> {
    None
}
