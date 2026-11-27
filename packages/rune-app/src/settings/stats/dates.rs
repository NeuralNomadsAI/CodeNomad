#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue, closure::Closure};

#[derive(Default)]
pub(in crate::settings) struct Visibility {
    #[cfg(target_arch = "wasm32")]
    listener: Option<(web_sys::Document, Closure<dyn FnMut()>)>,
}

impl Visibility {
    pub fn visible(&mut self, wake: &rune::Waker) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            let Some(doc) = web_sys::window().and_then(|window| window.document()) else {
                return false;
            };
            if self.listener.is_none() {
                let wake = wake.clone();
                let listener = Closure::<dyn FnMut()>::new(move || wake());
                if doc
                    .add_event_listener_with_callback(
                        "visibilitychange",
                        listener.as_ref().unchecked_ref(),
                    )
                    .is_ok()
                {
                    self.listener = Some((doc.clone(), listener));
                }
            }
            doc.visibility_state() == web_sys::VisibilityState::Visible
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = wake;
            true
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for Visibility {
    fn drop(&mut self) {
        if let Some((doc, listener)) = self.listener.take() {
            let _ = doc.remove_event_listener_with_callback(
                "visibilitychange",
                listener.as_ref().unchecked_ref(),
            );
        }
    }
}

pub(super) fn now() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

pub(super) fn timezone() -> String {
    #[cfg(target_arch = "wasm32")]
    let zone = {
        let format =
            js_sys::Intl::DateTimeFormat::new(&js_sys::Array::new(), &js_sys::Object::new());
        js_sys::Reflect::get(&format.resolved_options(), &JsValue::from_str("timeZone"))
            .ok()
            .and_then(|value| value.as_string())
    };
    #[cfg(not(target_arch = "wasm32"))]
    let zone = codenomad_host_process::local_time_zone();
    zone.unwrap_or_else(|| "UTC".to_owned())
}

pub(super) fn date_time(millis: u64, locale: &str, _zone: &str) -> String {
    #[cfg(target_arch = "wasm32")]
    let localized = {
        let date = js_sys::Date::new(&JsValue::from_f64(millis as f64));
        date.to_locale_string(locale, &JsValue::UNDEFINED)
            .as_string()
    };
    #[cfg(not(target_arch = "wasm32"))]
    let localized = codenomad_host_process::local_date_time(millis, locale, _zone);
    localized
        .unwrap_or_else(|| codenomad_client::settings::stats::utc_stamp(millis).unwrap_or_default())
}
