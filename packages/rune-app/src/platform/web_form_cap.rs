//! Browser-side capture-phase replacement cap for Rune's hidden form `<textarea>`.
//!
//! Runs strictly before Rune's `bridge.js` bubble-phase `input` / `compositionend` listeners so
//! large browser text replacements (autocorrect, dictation, spellcheck, IME commit, drag-drop)
//! are bounded to `MAX_FORM_EDITOR_UTF16` before `web_edit` passes them into `TextEdit`.

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn bound_dom_replacement(
    prev: &[u16],
    next: &[u16],
    doc_utf16: usize,
    max_utf16: usize,
) -> Option<(Vec<u16>, usize)> {
    // Find maximal common prefix and suffix without splitting surrogate pairs.
    let min_len = prev.len().min(next.len());
    let mut prefix = 0usize;
    while prefix < min_len && prev[prefix] == next[prefix] {
        prefix += 1;
    }
    if prefix > 0 && is_high_surrogate(next[prefix - 1]) {
        prefix -= 1;
    }
    let mut suffix = 0usize;
    while suffix < (min_len - prefix)
        && prev[prev.len() - 1 - suffix] == next[next.len() - 1 - suffix]
    {
        suffix += 1;
    }
    if suffix > 0 && is_low_surrogate(next[next.len() - suffix]) {
        suffix -= 1;
    }
    let deleted = prev.len().saturating_sub(prefix + suffix);
    let inserted_len = next.len().saturating_sub(prefix + suffix);
    let doc_kept = doc_utf16.saturating_sub(deleted);
    let max_insert = max_utf16.saturating_sub(doc_kept);
    let max_dom_insert = max_utf16.saturating_sub(prefix + suffix);
    let allowed_insert = max_insert.min(max_dom_insert);
    if inserted_len <= allowed_insert {
        return None;
    }
    let mut take = allowed_insert;
    if take > 0
        && prefix + take < next.len().saturating_sub(suffix)
        && is_high_surrogate(next[prefix + take - 1])
    {
        take -= 1;
    }
    let mut out = Vec::with_capacity(prefix + take + suffix);
    out.extend_from_slice(&next[..prefix]);
    out.extend_from_slice(&next[prefix..prefix + take]);
    out.extend_from_slice(&next[next.len() - suffix..]);
    Some((out, prefix + take))
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

#[cfg(target_arch = "wasm32")]
mod web {
    use super::bound_dom_replacement;
    use rune_theme_codenomad::form_controls::MAX_FORM_EDITOR_UTF16;
    use std::sync::Mutex;
    use wasm_bindgen::{JsCast, closure::Closure};

    struct CapState {
        installed: bool,
        active_doc_utf16: Option<usize>,
        prev_dom: Vec<u16>,
    }

    static STATE: Mutex<CapState> = Mutex::new(CapState {
        installed: false,
        active_doc_utf16: None,
        prev_dom: Vec::new(),
    });

    pub(crate) fn sync(doc_utf16: Option<usize>) {
        if let Ok(mut guard) = STATE.lock() {
            let prev = guard.active_doc_utf16;
            guard.active_doc_utf16 = doc_utf16;
            if doc_utf16.is_none() && prev.is_some() {
                guard.prev_dom.clear();
            }
        }
    }

    pub(crate) fn install() {
        let Ok(mut guard) = STATE.lock() else {
            return;
        };
        if guard.installed {
            return;
        }
        let Some(document) = web_sys::window().and_then(|w| w.document()) else {
            return;
        };
        guard.installed = true;
        drop(guard);
        let target: &web_sys::EventTarget = document.as_ref();

        let snapshot_cb = Closure::<dyn FnMut(web_sys::Event)>::new(|event: web_sys::Event| {
            let Ok(mut guard) = STATE.lock() else {
                return;
            };
            if guard.active_doc_utf16.is_none() {
                return;
            }
            let Some(textarea) = event_textarea(&event) else {
                return;
            };
            if is_composing(&event) && event.type_() == "beforeinput" {
                return;
            }
            guard.prev_dom = textarea.value().encode_utf16().collect();
        });
        for kind in ["focusin", "beforeinput", "compositionstart"] {
            let _ = target.add_event_listener_with_callback_and_bool(
                kind,
                snapshot_cb.as_ref().unchecked_ref(),
                true,
            );
        }
        snapshot_cb.forget();

        let clamp_cb = Closure::<dyn FnMut(web_sys::Event)>::new(|event: web_sys::Event| {
            let Ok(mut guard) = STATE.lock() else {
                return;
            };
            let Some(doc_utf16) = guard.active_doc_utf16 else {
                return;
            };
            let Some(textarea) = event_textarea(&event) else {
                return;
            };
            let composing = is_composing(&event) && event.type_() != "compositionend";
            let raw = textarea.value();
            let next: Vec<u16> = raw.encode_utf16().collect();
            let clamped =
                bound_dom_replacement(&guard.prev_dom, &next, doc_utf16, MAX_FORM_EDITOR_UTF16);
            if let Some((bounded, caret)) = clamped {
                let text = String::from_utf16_lossy(&bounded);
                textarea.set_value(&text);
                let pos = caret.min(u32::MAX as usize) as u32;
                let _ = textarea.set_selection_range(pos, pos);
                if !composing {
                    guard.prev_dom = bounded;
                }
            } else if !composing {
                guard.prev_dom = next;
            }
        });
        for kind in ["input", "compositionend"] {
            let _ = target.add_event_listener_with_callback_and_bool(
                kind,
                clamp_cb.as_ref().unchecked_ref(),
                true,
            );
        }
        clamp_cb.forget();
    }

    fn event_textarea(event: &web_sys::Event) -> Option<web_sys::HtmlTextAreaElement> {
        event
            .target()?
            .dyn_into::<web_sys::HtmlTextAreaElement>()
            .ok()
    }

    fn is_composing(event: &web_sys::Event) -> bool {
        js_sys::Reflect::get(event.as_ref(), &"isComposing".into())
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) use web::{install, sync};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn install() {}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn sync(_doc_utf16: Option<usize>) {}

#[cfg(test)]
mod tests {
    use super::bound_dom_replacement;

    #[test]
    fn bounds_large_multiline_dom_replacement_before_bridge_dispatch() {
        let prev: Vec<u16> = "ab".encode_utf16().collect();
        let inserted = "x\n".repeat(25_000);
        let next_str = format!("a{inserted}b");
        let next: Vec<u16> = next_str.encode_utf16().collect();
        let (bounded, caret) =
            bound_dom_replacement(&prev, &next, 2, 20_480).expect("must clamp oversized insert");
        assert_eq!(bounded.len(), 20_480);
        assert_eq!(caret, 20_479);
        assert_eq!(bounded[0], b'a' as u16);
        assert_eq!(*bounded.last().unwrap(), b'b' as u16);
    }

    #[test]
    fn preserves_surrogate_pairs_and_passes_within_budget_edits() {
        let prev: Vec<u16> = "hi".encode_utf16().collect();
        let ok: Vec<u16> = "hi!".encode_utf16().collect();
        assert_eq!(bound_dom_replacement(&prev, &ok, 2, 10), None);

        // 5 remaining UTF-16 units with 3 surrogate-pair emojis (6 units): keeps 2 emojis (4 units).
        let emoji_next: Vec<u16> = "hi🦀🦀🦀".encode_utf16().collect();
        let (bounded, caret) =
            bound_dom_replacement(&prev, &emoji_next, 2, 7).expect("must clamp at surrogate pair");
        assert_eq!(String::from_utf16(&bounded).unwrap(), "hi🦀🦀");
        assert_eq!(caret, 6);
    }

    #[test]
    fn accounts_for_unmirrored_document_units_outside_dom_window() {
        let prev: Vec<u16> = "tail".encode_utf16().collect();
        let next: Vec<u16> = "tail123456".encode_utf16().collect();
        let (bounded, caret) = bound_dom_replacement(&prev, &next, 20_477, 20_480)
            .expect("must respect full document UTF-16 budget");
        assert_eq!(String::from_utf16(&bounded).unwrap(), "tail123");
        assert_eq!(caret, 7);
    }
}
