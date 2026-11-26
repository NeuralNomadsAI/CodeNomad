//! Positive opt-in `!` detection for the browser `<textarea>` bridge.
#[cfg(target_arch = "wasm32")]
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) fn qualifies_beforeinput(
    input_type: Option<&str>,
    data: Option<&str>,
    is_composing: bool,
) -> bool {
    !is_composing && input_type == Some("insertText") && data == Some("!")
}

#[cfg(target_arch = "wasm32")]
static INSTALLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_arch = "wasm32")]
static PENDING_BANG: AtomicBool = AtomicBool::new(false);

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
    let on_beforeinput = Closure::<dyn FnMut(web_sys::Event)>::new(|event: web_sys::Event| {
        let on_textarea = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::HtmlTextAreaElement>().ok())
            .is_some();
        if !on_textarea {
            PENDING_BANG.store(false, Ordering::SeqCst);
            return;
        }
        let input_type = js_sys::Reflect::get(&event, &"inputType".into())
            .ok()
            .and_then(|value| value.as_string());
        let data = js_sys::Reflect::get(&event, &"data".into())
            .ok()
            .and_then(|value| value.as_string());
        let is_composing = js_sys::Reflect::get(&event, &"isComposing".into())
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        PENDING_BANG.store(
            qualifies_beforeinput(input_type.as_deref(), data.as_deref(), is_composing),
            Ordering::SeqCst,
        );
    });
    let _ = document.add_event_listener_with_callback_and_bool(
        "beforeinput",
        on_beforeinput.as_ref().unchecked_ref(),
        true,
    );
    on_beforeinput.forget();

    let clear = Closure::<dyn FnMut(web_sys::Event)>::new(|_: web_sys::Event| {
        PENDING_BANG.store(false, Ordering::SeqCst);
    });
    for name in ["compositionstart", "paste", "blur"] {
        let _ = document.add_event_listener_with_callback_and_bool(
            name,
            clear.as_ref().unchecked_ref(),
            true,
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
