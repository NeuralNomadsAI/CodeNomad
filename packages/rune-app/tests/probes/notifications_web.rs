#![cfg(target_arch = "wasm32")]

#[path = "../../src/platform/notifications_web.rs"]
mod notifications;

use std::cell::{Cell, RefCell};
use wasm_bindgen::prelude::*;

thread_local! {
    static NOTICE: RefCell<Option<notifications::Presented>> = const { RefCell::new(None) };
    static CLICKS: Cell<u32> = const { Cell::new(0) };
}

#[wasm_bindgen]
pub fn request() -> Option<js_sys::Promise> {
    notifications::request_permission()
}

#[wasm_bindgen]
pub fn send() -> bool {
    let notice = notifications::show("Private project", "Question", || CLICKS.update(|n| n + 1));
    let sent = notice.is_some();
    NOTICE.replace(notice);
    sent
}

#[wasm_bindgen]
pub fn clicks() -> u32 {
    CLICKS.get()
}

#[wasm_bindgen]
pub fn revoke() {
    NOTICE.replace(None);
}
