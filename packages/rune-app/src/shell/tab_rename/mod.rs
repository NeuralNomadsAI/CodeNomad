#[cfg(test)]
mod tests;

use crate::{
    State,
    components::window_close_button::{WindowCloseState, close_button},
    screen, settings,
    shell::shortcuts,
    strings::{locale, t, with_locale},
    workspace,
};
use rune::{El, Key, KeyEvent, Mods, Tx, edit::TextEdit};
use rune_theme_codenomad::{field_kit, layout, shell::tab_rename as theme};
use std::rc::Rc;

const INPUT_KEY: &str = "tab-rename-input";
const FOCUS: &str = "tab-rename-input/value/input";
const INPUT_AUTOFILL: rune::Autofill = rune::Autofill::Off;
const CLOSE_KEY: &str = "tab-rename-close";
const CANCEL_KEY: &str = "tab-rename-cancel";

#[derive(Default)]
pub(crate) struct Rename {
    open: bool,
    scope: Option<Rc<()>>,
    tab_key: Option<String>,
    input: TextEdit,
    return_focus: Option<String>,
    viewport: (f32, f32),
    close_control: WindowCloseState,
}

impl Rename {
    pub(crate) fn dismiss(&mut self) {
        self.open = false;
        self.scope = None;
        self.tab_key = None;
        self.input = TextEdit::new("");
        self.return_focus = None;
        self.close_control = WindowCloseState::default();
    }
}

pub(crate) fn is_open(s: &State) -> bool {
    s.tab_rename.open
        && s.tab_rename
            .scope
            .as_ref()
            .is_some_and(|scope| s.current_scope(scope))
}

pub(crate) fn is_composing(s: &State) -> bool {
    is_open(s) && s.tab_rename.input.is_composing()
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.tab_rename.viewport;
    if *viewport != (width, height) {
        *viewport = (width, height);
        if is_open(s) {
            tx.instant();
        }
        true
    } else {
        false
    }
}

fn blocked_by_higher_modal(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    shortcuts::authentication_required(s)
}

fn blocked_for_open(s: &State) -> bool {
    blocked_by_higher_modal(s) || shortcuts::modal_open(s)
}

pub(crate) fn can_rename_active(s: &State) -> bool {
    workspace::active_workspace(s).is_some()
}

pub(crate) fn open_active(s: &mut State, tx: &mut Tx) -> bool {
    open_active_with_return_focus(s, None, tx)
}

pub(crate) fn open_active_with_return_focus(
    s: &mut State,
    return_focus: Option<String>,
    tx: &mut Tx,
) -> bool {
    let Some((tab_key, _)) = workspace::active_workspace(s) else {
        return false;
    };
    let tab_key = tab_key.to_owned();
    open_for_tab_with_return_focus(s, &tab_key, return_focus, tx)
}

pub(crate) fn open_for_tab(s: &mut State, tab_key: &str, tx: &mut Tx) -> bool {
    open_for_tab_with_return_focus(s, tab_key, None, tx)
}

fn open_for_tab_with_return_focus(
    s: &mut State,
    tab_key: &str,
    explicit_return: Option<String>,
    tx: &mut Tx,
) -> bool {
    if is_open(s) || blocked_for_open(s) {
        return false;
    }
    let Some(initial) = workspace::tab_rename_seed(s, tab_key) else {
        return false;
    };
    let return_focus = if explicit_return.is_some() {
        explicit_return
    } else {
        let prior = tx
            .focused()
            .filter(|key| !key.starts_with("command-palette-"))
            .map(str::to_owned);
        let floating_fallback = if s.shell.floating_sessions().is_some() {
            Some("sessions-panel-toggle".to_owned())
        } else if s.shell.has_floating() {
            Some("right-panel-toggle".to_owned())
        } else {
            None
        };
        match (prior.as_deref(), floating_fallback) {
            (Some(theme::TRIGGER), _) => prior,
            (_, Some(toggle_key)) => Some(toggle_key),
            _ => prior.or_else(|| Some(format!("t-{tab_key}"))),
        }
    };
    super::Panels::dismiss_outside(s, tx);
    let mut input = TextEdit::new(&initial);
    input.set_selection(0, initial.len());
    input.focused = true;
    let scope = s.input_scope.clone();
    let rename = &mut s.tab_rename;
    rename.open = true;
    rename.scope = Some(scope);
    rename.tab_key = Some(tab_key.to_owned());
    rename.input = input;
    rename.return_focus = return_focus;
    tx.focus_when_shown(FOCUS, true);
    tx.instant();
    true
}

fn close_with_focus(s: &mut State, tx: &mut Tx) {
    let fallback = s
        .tab_rename
        .tab_key
        .as_deref()
        .map(|key| format!("t-{key}"));
    let target = s.tab_rename.return_focus.take().or(fallback);
    s.tab_rename.dismiss();
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

pub(crate) fn cancel(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    close_with_focus(s, tx);
}

pub(crate) fn commit(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let Some(tab_key) = s.tab_rename.tab_key.clone() else {
        close_with_focus(s, tx);
        return;
    };
    let raw = s.tab_rename.input.text.clone();
    workspace::rename_tab(s, &tab_key, &raw);
    close_with_focus(s, tx);
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) || is_composing(s) || blocked_by_higher_modal(s) {
        return false;
    }
    if event.key == Key::Escape && event.mods == Mods::default() {
        if !tx.key_repeat() {
            cancel(s, tx);
        }
        return true;
    }
    if event.key == Key::Enter
        && event.mods == Mods::default()
        && !matches!(tx.focused(), Some(CLOSE_KEY | CANCEL_KEY))
    {
        if !tx.key_repeat() {
            commit(s, tx);
        }
        return true;
    }
    false
}

pub(crate) fn trigger(s: &State, touch: bool) -> Option<El> {
    can_rename_active(s).then(|| {
        let label = t("instanceTab.actions.rename");
        let help = settings::with_shortcut_label(s, label, "instance-rename");
        theme::trigger(
            label,
            help,
            is_open(s),
            touch,
            screen::action_tx(&s.input_scope, |s, tx| {
                if is_open(s) {
                    cancel(s, tx);
                } else {
                    open_active(s, tx);
                }
            }),
        )
    })
}

pub(crate) fn overlay(s: &State) -> Option<El> {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return None;
    }
    let rename = &s.tab_rename;
    let scope = rename
        .scope
        .clone()
        .unwrap_or_else(|| s.input_scope.clone());
    let render_locale = locale();
    let input = layout::hinted_field(&rename.input, t("projectRenameDialog.input.placeholder"))
        .label(t("projectRenameDialog.input.label"))
        .autofill(INPUT_AUTOFILL)
        .on_edit({
            let scope = scope.clone();
            move |s: &mut State| {
                if s.current_scope(&scope) {
                    &mut s.tab_rename.input
                } else {
                    &mut s.rejected_edit
                }
            }
        })
        .on_key({
            let scope = scope.clone();
            move |s: &mut State, event, tx| {
                s.current_scope(&scope) && with_locale(render_locale, || handle_key(s, event, tx))
            }
        })
        .build(&field_kit(layout::dark()))
        .key(INPUT_KEY);
    let close_control = close_button(
        &rename.close_control,
        CLOSE_KEY,
        layout::dark(),
        None,
        |s: &mut State| &mut s.tab_rename.close_control,
        screen::action_tx(&scope, cancel),
    );
    let key_scope = scope.clone();
    Some(theme::dialog(
        t("projectRenameDialog.title"),
        t("projectRenameDialog.input.label"),
        input,
        close_control,
        t("projectRenameDialog.actions.cancel"),
        t("projectRenameDialog.actions.rename"),
        rename.viewport,
        move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        },
        screen::action_tx(&scope, cancel),
        screen::action_tx(&scope, commit),
    ))
}
