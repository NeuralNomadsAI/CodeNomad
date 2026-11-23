use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use web_sys::{Notification, NotificationOptions, NotificationPermission};

pub(crate) fn permission() -> Option<NotificationPermission> {
    let window = web_sys::window()?;
    let constructor = js_sys::Reflect::get(&window, &JsValue::from_str("Notification")).ok()?;
    constructor.is_function().then(Notification::permission)
}

/// Invoke synchronously from the Preferences control's trusted click.
pub(crate) fn request_permission() -> Option<js_sys::Promise> {
    (permission()? == NotificationPermission::Default)
        .then(|| Notification::request_permission().ok())
        .flatten()
}

pub(crate) fn focused() -> bool {
    web_sys::window()
        .and_then(|window| window.document())
        .is_none_or(|doc| {
            doc.visibility_state() == web_sys::VisibilityState::Visible
                && doc.has_focus().unwrap_or(true)
        })
}

pub(crate) fn hidden() -> bool {
    web_sys::window()
        .and_then(|w| w.document())
        .is_some_and(|doc| doc.hidden())
}

pub(crate) fn show(title: &str, body: &str, click: impl FnOnce() + 'static) -> Option<Presented> {
    if permission()? != NotificationPermission::Granted {
        return None;
    }
    let options = NotificationOptions::new();
    options.set_body(body);
    let notification = Notification::new_with_options(title, &options).ok()?;
    let mut click = Some(click);
    let activated = Closure::new(move |_: web_sys::Event| {
        if let Some(click) = click.take() {
            if let Some(window) = web_sys::window() {
                let _ = window.focus();
            }
            click();
        }
    });
    notification.set_onclick(Some(activated.as_ref().unchecked_ref()));
    Some(Presented {
        notification,
        _activated: activated,
    })
}

pub(crate) struct Presented {
    notification: Notification,
    _activated: Closure<dyn FnMut(web_sys::Event)>,
}

impl Drop for Presented {
    fn drop(&mut self) {
        self.notification.set_onclick(None);
        self.notification.close();
    }
}
