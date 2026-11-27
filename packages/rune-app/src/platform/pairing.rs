use super::pairing_state::{Action, AuthSignal, PairingState, Settled};
use crate::{State, strings::t};
use codenomad_client::{Receiver, bounded};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::{JsCast, closure::Closure};

#[derive(Default)]
pub struct Recovery {
    state: PairingState,
    observed_tab: Option<Option<String>>,
    retry_pending: Option<Option<String>>,
    result: Option<Receiver<Option<bool>>>,
    retry_timer: Option<Receiver<()>>,
    focus: Option<FocusCheck>,
    conversation_generation: u64,
}

struct FocusCheck {
    window: web_sys::Window,
    focus_listener: Closure<dyn FnMut()>,
    document: Option<web_sys::Document>,
    visibility_listener: Option<Closure<dyn FnMut()>>,
    requested: Rc<Cell<bool>>,
}
impl FocusCheck {
    fn new(wake: rune::Waker) -> Option<Self> {
        let window = web_sys::window()?;
        let requested = Rc::new(Cell::new(false));
        let focused = requested.clone();
        let focus_wake = wake.clone();
        let focus_listener = Closure::new(move || {
            focused.set(true);
            focus_wake();
        });
        window
            .add_event_listener_with_callback("focus", focus_listener.as_ref().unchecked_ref())
            .ok()?;
        let (document, visibility_listener) = match window.document() {
            Some(doc) => {
                let visible_doc = doc.clone();
                let visible_requested = requested.clone();
                let visible_wake = wake;
                let listener = Closure::new(move || {
                    if visible_doc.visibility_state() == web_sys::VisibilityState::Visible {
                        visible_requested.set(true);
                        visible_wake();
                    }
                });
                if doc
                    .add_event_listener_with_callback(
                        "visibilitychange",
                        listener.as_ref().unchecked_ref(),
                    )
                    .is_ok()
                {
                    (Some(doc), Some(listener))
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        };
        Some(Self {
            window,
            focus_listener,
            document,
            visibility_listener,
            requested,
        })
    }
}
impl Drop for FocusCheck {
    fn drop(&mut self) {
        let _ = self.window.remove_event_listener_with_callback(
            "focus",
            self.focus_listener.as_ref().unchecked_ref(),
        );
        if let (Some(doc), Some(listener)) = (&self.document, &self.visibility_listener) {
            let _ = doc.remove_event_listener_with_callback(
                "visibilitychange",
                listener.as_ref().unchecked_ref(),
            );
        }
    }
}

pub fn available() -> bool {
    crate::platform::default_backend().starts_with("https:")
}

fn start_check(s: &mut State) {
    if s.pairing.state.should_defer_start() {
        return;
    }
    s.pairing.retry_timer = None;
    if s.pairing.focus.is_none() {
        s.pairing.focus = FocusCheck::new(s.wake.clone());
    }
    s.pairing.observed_tab = Some(s.workspace.as_ref().map(|ui| ui.active_key().to_owned()));
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

fn schedule_retry(s: &mut State, delay_ms: u64) {
    let (out, input) = bounded(1);
    s.pairing.retry_timer = Some(input);
    let wake = s.wake.clone();
    super::spawn(async move {
        super::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let _ = out.send(()).await;
        wake();
    });
}

pub fn set_defer_checks(s: &mut State, defer: bool) {
    s.pairing.state.set_defer_checks(defer);
}

pub fn flush_deferred_checks(s: &mut State) {
    if s.pairing.state.take_deferred_check() && available() {
        start_check(s);
    }
}

pub fn observe(s: &mut State) {
    if !available() {
        return;
    }
    if s.pairing.state.observe_passive() == Action::StartCheck {
        start_check(s);
    }
}

pub fn recheck(s: &mut State) {
    if !available() {
        return;
    }
    if s.pairing.state.request_recheck() == Action::StartCheck {
        start_check(s);
    }
}

pub fn observe_launcher_authenticated(s: &mut State, generation: u64) {
    if !available() {
        return;
    }
    if s.pairing
        .state
        .on_authenticated_signal(AuthSignal::Launcher(generation))
        == Action::StartCheck
    {
        start_check(s);
    }
}

pub fn observe_conversation_authenticated(s: &mut State, newly_connected: bool) {
    if !available() {
        return;
    }
    if newly_connected || s.pairing.conversation_generation == 0 {
        s.pairing.conversation_generation = s.pairing.conversation_generation.wrapping_add(1);
    }
    let generation = s.pairing.conversation_generation;
    if s.pairing
        .state
        .on_authenticated_signal(AuthSignal::Conversation(generation))
        == Action::StartCheck
    {
        start_check(s);
    }
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    if let Some(target) = &s.pairing.retry_pending {
        if let Some(key) = target.as_deref()
            && !s.workspace.as_ref().is_some_and(|ui| ui.has_tab_key(key))
        {
            s.pairing.retry_pending = None;
        } else if !s.pairing.state.required
            && !s.composer.pending()
            && !s.screen.launcher().is_some_and(|l| l.pending)
            && s.workspace.as_ref().map(|ui| ui.active_key()) == target.as_deref()
        {
            s.pairing.retry_pending = None;
            if s.screen.is_launcher()
                || matches!(
                    s.phase,
                    crate::Phase::Failed
                        | crate::Phase::WorkspaceMissing
                        | crate::Phase::RestoreFailed
                )
            {
                crate::retry_connection(s, tx);
            }
            return true;
        }
    }
    let mut changed = false;
    if s.pairing
        .focus
        .as_ref()
        .is_some_and(|focus| focus.requested.replace(false))
    {
        recheck(s);
        changed = true;
    }
    if s.pairing
        .retry_timer
        .as_ref()
        .is_some_and(|timer| timer.try_recv().is_ok())
    {
        s.pairing.retry_timer = None;
        if available() && s.pairing.state.on_retry_timer() == Action::StartCheck {
            start_check(s);
            changed = true;
        }
    }
    let Some(result) = s.pairing.result.as_ref().and_then(|r| r.try_recv().ok()) else {
        return changed;
    };
    s.pairing.result = None;
    let observed_tab = s.pairing.observed_tab.take();
    match s.pairing.state.settle(result) {
        Settled::Unchanged => {
            s.pairing.retry_timer = None;
            if !s.pairing.state.watches_focus() {
                s.pairing.focus = None;
            }
        }
        Settled::Required => {
            let needs_recheck = s.pairing.state.in_flight;
            s.pairing.retry_pending = None;
            if let Some(l) = s.screen.launcher_mut() {
                l.password = rune::edit::TextEdit::new("");
            }
            crate::chat::events::poll_chat(s, 64);
            s.composer.picker.set_attachments_supported(false);
            let _ = crate::composer::menu::poll(s, tx);
            s.renew_scope();
            s.blank_cleanup.cancel();
            if let Some(reader) = &s.reader {
                reader.revoke();
            }
            if let Some(commands) = s.commands.take() {
                commands.close();
            }
            if !matches!(
                s.phase,
                crate::Phase::WorkspaceMissing | crate::Phase::RestoreFailed
            ) {
                s.phase = crate::Phase::Failed;
            }
            s.stream_offline = true;
            crate::workspace::revoke_cached_sessions(s);
            if s.pairing.focus.is_none() {
                s.pairing.focus = FocusCheck::new(s.wake.clone());
            }
            if needs_recheck && s.pairing.result.is_none() {
                start_check(s);
            }
        }
        Settled::Recheck => start_check(s),
        Settled::RetryAfter(delay_ms) => schedule_retry(s, delay_ms),
        Settled::Recovered => {
            s.pairing.retry_timer = None;
            s.pairing.focus = None;
            crate::chat::reader::cancel_page(s);
            s.history_error = false;
            let target_tab = observed_tab
                .unwrap_or_else(|| s.workspace.as_ref().map(|ui| ui.active_key().to_owned()));
            let active_matches =
                s.workspace.as_ref().map(|ui| ui.active_key()) == target_tab.as_deref();
            let launcher_busy = s.screen.launcher().is_some_and(|l| l.pending);
            if active_matches && !s.composer.pending() && !launcher_busy {
                crate::retry_connection(s, tx);
                s.pairing.retry_pending = None;
            } else if target_tab
                .as_deref()
                .is_none_or(|key| s.workspace.as_ref().is_some_and(|ui| ui.has_tab_key(key)))
            {
                s.pairing.retry_pending = Some(target_tab);
            }
        }
    }
    true
}

pub fn required(s: &State) -> bool {
    s.pairing.state.required
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
        .child(
            crate::components::button_tx(
                "pairing-check",
                t("authRecovery.check"),
                s.pairing.result.is_some(),
                crate::retry_connection,
            )
            .autofocus(),
        )
}
