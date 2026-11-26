use std::{cell::Cell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};

pub(super) struct Watch {
    target: web_sys::EventTarget,
    change: Closure<dyn FnMut()>,
    changed: Rc<Cell<bool>>,
}

impl Watch {
    pub(super) fn new(wake: rune::Waker) -> Option<Self> {
        let window = web_sys::window()?;
        let screen = js_sys::Reflect::get(window.as_ref(), &"screen".into()).ok()?;
        let orientation = js_sys::Reflect::get(&screen, &"orientation".into()).ok()?;
        let target: web_sys::EventTarget = orientation.dyn_into().ok()?;
        let changed = Rc::new(Cell::new(false));
        let flag = changed.clone();
        let change = Closure::new(move || {
            flag.set(true);
            wake();
        });
        target
            .add_event_listener_with_callback("change", change.as_ref().unchecked_ref())
            .ok()?;
        Some(Self {
            target,
            change,
            changed,
        })
    }

    pub(super) fn take_changed(&self) -> bool {
        self.changed.replace(false)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self
            .target
            .remove_event_listener_with_callback("change", self.change.as_ref().unchecked_ref());
    }
}
