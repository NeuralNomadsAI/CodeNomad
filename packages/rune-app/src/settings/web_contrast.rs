use wasm_bindgen::{JsCast, closure::Closure};

pub(super) struct Watch {
    query: web_sys::MediaQueryList,
    change: Closure<dyn FnMut()>,
}

impl Watch {
    pub fn new(wake: rune::Waker) -> Option<Self> {
        let query = web_sys::window()?
            .match_media("(prefers-contrast: more)")
            .ok()??;
        let change = Closure::new(move || wake());
        query
            .add_event_listener_with_callback("change", change.as_ref().unchecked_ref())
            .ok()?;
        Some(Self { query, change })
    }

    pub fn more(&self) -> bool {
        self.query.matches()
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self
            .query
            .remove_event_listener_with_callback("change", self.change.as_ref().unchecked_ref());
    }
}
