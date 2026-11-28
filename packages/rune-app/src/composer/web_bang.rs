//! Positive opt-in `!` detection for the browser `<textarea>` bridge.
#[cfg(target_arch = "wasm32")]
use std::{
    cell::RefCell,
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) fn qualifies_beforeinput(
    input_type: Option<&str>,
    data: Option<&str>,
    is_composing: bool,
) -> bool {
    !is_composing && input_type == Some("insertText") && data == Some("!")
}

pub(super) fn qualifies_input(
    input_type: Option<&str>,
    data: Option<&str>,
    is_composing: bool,
) -> bool {
    !is_composing
        && input_type.is_none_or(|kind| kind == "insertText")
        && data.is_none_or(|text| text == "!")
}

pub(super) struct Gate<T> {
    armed_target: Option<T>,
    pending_bang: bool,
}

impl<T> Default for Gate<T> {
    fn default() -> Self {
        Self {
            armed_target: None,
            pending_bang: false,
        }
    }
}

impl<T: PartialEq> Gate<T> {
    pub(super) fn on_beforeinput(
        &mut self,
        target: Option<T>,
        input_type: Option<&str>,
        data: Option<&str>,
        is_composing: bool,
    ) {
        self.pending_bang = false;
        self.armed_target = if qualifies_beforeinput(input_type, data, is_composing) {
            target
        } else {
            None
        };
    }

    pub(super) fn on_input_capture(
        &mut self,
        target: Option<&T>,
        input_type: Option<&str>,
        data: Option<&str>,
        is_composing: bool,
    ) -> bool {
        let matched = self
            .armed_target
            .take()
            .is_some_and(|expected| target == Some(&expected))
            && qualifies_input(input_type, data, is_composing);
        self.pending_bang = matched;
        matched
    }

    pub(super) fn on_reset(&mut self) {
        self.armed_target = None;
        self.pending_bang = false;
    }

    #[cfg(test)]
    pub(super) fn take(&mut self) -> bool {
        std::mem::take(&mut self.pending_bang)
    }
}

#[cfg(target_arch = "wasm32")]
static INSTALLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_arch = "wasm32")]
static PENDING_BANG: AtomicBool = AtomicBool::new(false);

#[cfg(target_arch = "wasm32")]
fn event_fields(event: &web_sys::Event) -> (Option<String>, Option<String>, bool) {
    let input_type = js_sys::Reflect::get(event, &"inputType".into())
        .ok()
        .and_then(|value| value.as_string());
    let data = js_sys::Reflect::get(event, &"data".into())
        .ok()
        .and_then(|value| value.as_string());
    let is_composing = js_sys::Reflect::get(event, &"isComposing".into())
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    (input_type, data, is_composing)
}

#[cfg(target_arch = "wasm32")]
fn textarea_target(event: &web_sys::Event) -> Option<web_sys::EventTarget> {
    use wasm_bindgen::JsCast;

    let target = event.target()?;
    target
        .clone()
        .dyn_into::<web_sys::HtmlTextAreaElement>()
        .ok()
        .map(|_| target)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn install() {
    use wasm_bindgen::{JsCast, closure::Closure};

    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        INSTALLED.store(false, Ordering::SeqCst);
        return;
    };
    let gate = Rc::new(RefCell::new(Gate::<web_sys::EventTarget>::default()));

    let beforeinput_gate = gate.clone();
    let on_beforeinput = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
        let target = textarea_target(&event);
        let (input_type, data, is_composing) = event_fields(&event);
        beforeinput_gate.borrow_mut().on_beforeinput(
            target,
            input_type.as_deref(),
            data.as_deref(),
            is_composing,
        );
        PENDING_BANG.store(false, Ordering::SeqCst);
    });
    let _ = document.add_event_listener_with_callback_and_bool(
        "beforeinput",
        on_beforeinput.as_ref().unchecked_ref(),
        true,
    );
    on_beforeinput.forget();

    let input_gate = gate.clone();
    let on_input_capture =
        Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            let target = textarea_target(&event);
            let (input_type, data, is_composing) = event_fields(&event);
            let armed = input_gate.borrow_mut().on_input_capture(
                target.as_ref(),
                input_type.as_deref(),
                data.as_deref(),
                is_composing,
            );
            PENDING_BANG.store(armed, Ordering::SeqCst);
        });
    let _ = document.add_event_listener_with_callback_and_bool(
        "input",
        on_input_capture.as_ref().unchecked_ref(),
        true,
    );
    on_input_capture.forget();

    let clear = Closure::<dyn FnMut(web_sys::Event)>::new(move |_: web_sys::Event| {
        gate.borrow_mut().on_reset();
        PENDING_BANG.store(false, Ordering::SeqCst);
    });
    for (name, capture) in [
        ("input", false),
        ("keydown", true),
        ("pointerdown", true),
        ("compositionstart", true),
        ("paste", true),
        ("drop", true),
        ("blur", true),
    ] {
        let _ = document.add_event_listener_with_callback_and_bool(
            name,
            clear.as_ref().unchecked_ref(),
            capture,
        );
    }
    clear.forget();
}

#[cfg(target_arch = "wasm32")]
pub(super) fn take() -> bool {
    PENDING_BANG.swap(false, Ordering::SeqCst)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn clear() {
    PENDING_BANG.store(false, Ordering::SeqCst);
}
