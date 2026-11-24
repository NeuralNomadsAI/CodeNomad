use crate::{State, strings::t};
use codenomad_client::{Receiver, bounded};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};

#[derive(Default)]
pub struct Recovery {
    required: bool,
    retry_pending: Option<Option<String>>,
    result: Option<Receiver<Option<bool>>>,
    focus: Option<FocusCheck>,
}

struct FocusCheck {
    window: web_sys::Window,
    listener: Closure<dyn FnMut()>,
    requested: Rc<Cell<bool>>,
}
impl FocusCheck {
    fn new(wake: rune::Waker) -> Option<Self> {
        let window = web_sys::window()?;
        let requested = Rc::new(Cell::new(false));
        let focused = requested.clone();
        let listener = Closure::new(move || {
            focused.set(true);
            wake();
        });
        window
            .add_event_listener_with_callback("focus", listener.as_ref().unchecked_ref())
            .ok()?;
        Some(Self {
            window,
            listener,
            requested,
        })
    }
}
impl Drop for FocusCheck {
    fn drop(&mut self) {
        let _ = self
            .window
            .remove_event_listener_with_callback("focus", self.listener.as_ref().unchecked_ref());
    }
}

pub fn available() -> bool {
    crate::platform::default_backend().starts_with("https:")
}

pub fn observe(s: &mut State) {
    if s.pairing.result.is_some() || !available() {
        return;
    }
    let (out, input) = bounded(1);
    s.pairing.result = Some(input);
    let wake = s.wake.clone();
    super::spawn(async move {
        let _ = out
            .send(
                codenomad_client::http::pairing_required()
                    .await
                    .ok()
                    .flatten(),
            )
            .await;
        wake();
    });
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    if let Some(target) = &s.pairing.retry_pending {
        if let Some(key) = target.as_deref()
            && !s.workspace.as_ref().is_some_and(|ui| ui.has_tab_key(key))
        {
            s.pairing.retry_pending = None;
        } else if !s.pairing.required
            && !s.composer.pending()
            && s.workspace.as_ref().map(|ui| ui.active_key()) == target.as_deref()
        {
            s.pairing.retry_pending = None;
            crate::retry_connection(s, tx);
            return true;
        }
    }
    if s.pairing.result.is_none()
        && s.pairing
            .focus
            .as_ref()
            .is_some_and(|focus| focus.requested.replace(false))
    {
        observe(s);
        return true;
    }
    let Some(result) = s.pairing.result.as_ref().and_then(|r| r.try_recv().ok()) else {
        return false;
    };
    s.pairing.result = None;
    let Some(required) = result else { return true };
    if required == s.pairing.required {
        return true;
    }
    s.pairing.required = required;
    if required {
        s.pairing.retry_pending = None;
        if let Some(l) = s.screen.launcher_mut() {
            l.password = rune::edit::TextEdit::new("");
        }
        crate::chat::events::poll_chat(s, 64);
        s.composer.picker.set_attachments_supported(false);
        let _ = crate::composer::menu::poll(s, tx);
        s.renew_scope();
        if let Some(reader) = &s.reader {
            reader.revoke();
        }
        if let Some(commands) = s.commands.take() {
            commands.close();
        }
        s.phase = crate::Phase::Failed;
        s.stream_offline = true;
        crate::workspace::revoke_cached_sessions(s);
        s.pairing.focus = FocusCheck::new(s.wake.clone());
    } else {
        s.pairing.focus = None;
        s.history_error = false;
        let active_tab = s.workspace.as_ref().map(|ui| ui.active_key().to_owned());
        crate::retry_connection(s, tx);
        s.pairing.retry_pending = s.composer.pending().then_some(active_tab);
    }
    true
}

pub fn required(s: &State) -> bool {
    s.pairing.required
}

pub fn view(s: &State) -> El {
    col()
        .key("pairing-recovery")
        .pad(Space::Md)
        .separate(Space::Sm)
        .role("dialog")
        .label(t("authRecovery.pairingTitle"))
        .modal(false, |_: &mut State| {})
        .child(text(t("authRecovery.pairingTitle")).text_role(TextRole::Title))
        .child(text(t("rune.pairing_guide")).role("alert"))
        .child(crate::components::button_tx(
            "pairing-check",
            t("authRecovery.check"),
            s.pairing.result.is_some(),
            crate::retry_connection,
        ))
}
