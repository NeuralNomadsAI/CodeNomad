mod commands;
#[cfg(test)]
mod tests;
mod view;

use crate::{State, components::window_close_button::WindowCloseState, settings};
use rune::{Key, KeyEvent, Mods, Tx, edit::TextEdit};
use rune_theme_codenomad::shell::command_palette as theme;

pub(crate) use view::{overlay, trigger};

const FIELD: &str = "command-palette-query";
const FOCUS: &str = "command-palette-query/value/input";
const CLOSE_KEY: &str = "command-palette-close";

pub(super) fn item_key(id: &str) -> String {
    format!("command-palette-item-{id}")
}

#[derive(Default)]
pub(crate) struct Palette {
    open: bool,
    scope: Option<std::rc::Rc<()>>,
    query: TextEdit,
    selected_id: Option<&'static str>,
    ignore_pointer_hover: bool,
    last_pointer_pos: Option<(f32, f32)>,
    return_focus: Option<String>,
    viewport: (f32, f32),
    close_control: WindowCloseState,
}

impl Palette {
    pub(crate) fn dismiss(&mut self) {
        self.open = false;
        self.scope = None;
        self.query = TextEdit::new("");
        self.selected_id = None;
        self.ignore_pointer_hover = false;
        self.last_pointer_pos = None;
        self.return_focus = None;
        self.close_control = WindowCloseState::default();
    }

    #[cfg(test)]
    pub(in crate::shell) fn query_for_test(&mut self, text: &str) {
        self.query = TextEdit::new(text);
        self.selected_id = None;
    }
}

pub(crate) fn is_open(s: &State) -> bool {
    s.command_palette.open
        && s.command_palette
            .scope
            .as_ref()
            .is_some_and(|scope| s.current_scope(scope))
}

pub(crate) fn is_composing(s: &State) -> bool {
    is_open(s) && s.command_palette.query.is_composing()
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.command_palette.viewport;
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

pub(super) fn blocked_by_higher_modal(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    super::shortcuts::authentication_required(s)
}

fn blocked_for_open(s: &State) -> bool {
    blocked_by_higher_modal(s) || super::shortcuts::modal_open(s)
}

pub(crate) fn open(s: &mut State, tx: &mut Tx) {
    if is_open(s) || blocked_for_open(s) {
        return;
    }
    let prior = tx.focused().map(str::to_owned);
    let floating_fallback = if s.shell.floating_sessions().is_some() {
        Some("sessions-panel-toggle".to_owned())
    } else if s.shell.has_floating() {
        Some("right-panel-toggle".to_owned())
    } else {
        None
    };
    let return_focus = match (prior.as_deref(), floating_fallback) {
        (Some(theme::TRIGGER), _) => prior,
        (_, Some(toggle_key)) => Some(toggle_key),
        _ => prior,
    };
    super::Panels::dismiss_outside(s, tx);
    let scope = s.input_scope.clone();
    let palette = &mut s.command_palette;
    palette.open = true;
    palette.scope = Some(scope);
    palette.query = TextEdit::new("");
    palette.query.focused = true;
    palette.selected_id = None;
    palette.ignore_pointer_hover = true;
    palette.last_pointer_pos = None;
    palette.return_focus = return_focus;
    tx.scroll_to_instant(theme::LIST, 0.0, 0.0);
    tx.focus_when_shown(FOCUS, true);
    tx.instant();
}

pub(crate) fn close(s: &mut State, tx: &mut Tx) {
    if !is_open(s) {
        return;
    }
    let target = take_closed_state(s);
    restore_focus(target, tx);
    tx.instant();
}

pub(crate) fn toggle(s: &mut State, tx: &mut Tx) {
    if is_open(s) {
        close(s, tx);
    } else {
        open(s, tx);
    }
}

fn take_closed_state(s: &mut State) -> Option<String> {
    let target = s.command_palette.return_focus.take();
    s.command_palette.dismiss();
    target
}

fn restore_focus(target: Option<String>, tx: &mut Tx) {
    let focus_target = target.as_deref().unwrap_or(theme::TRIGGER);
    tx.return_focus(focus_target, tx.focus_visible());
}

fn visible_commands(s: &State) -> Vec<commands::CommandItem> {
    commands::filter(&s.command_palette.query.text, commands::collect(s))
}

#[cfg(test)]
pub(in crate::shell) fn item_disabled(s: &State, id: &str) -> Option<bool> {
    visible_commands(s)
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| item.disabled)
}

fn resolved_selection(
    items: &[commands::CommandItem],
    current: Option<&'static str>,
) -> Option<usize> {
    if items.is_empty() {
        return None;
    }
    if let Some(id) = current
        && let Some(index) = items.iter().position(|item| item.id == id)
    {
        return Some(index);
    }
    items.iter().position(|item| !item.disabled).or(Some(0))
}

fn move_selection(s: &mut State, delta: isize, tx: &mut Tx) {
    let items = visible_commands(s);
    let Some(current) = resolved_selection(&items, s.command_palette.selected_id) else {
        s.command_palette.selected_id = None;
        return;
    };
    let len = items.len();
    let next = if delta >= 0 {
        (current + (delta as usize)) % len
    } else {
        let step = delta.unsigned_abs() % len;
        (current + len - step) % len
    };
    let id = items[next].id;
    s.command_palette.selected_id = Some(id);
    s.command_palette.ignore_pointer_hover = true;
    if next == 0 {
        tx.scroll_to_instant(theme::LIST, 0.0, 0.0);
    }
    tx.scroll_into_view_in(theme::LIST, item_key(id));
}

fn select_edge(s: &mut State, end: bool, tx: &mut Tx) {
    let items = visible_commands(s);
    let target = if end { items.last() } else { items.first() };
    let id = target.map(|item| item.id);
    s.command_palette.selected_id = id;
    s.command_palette.ignore_pointer_hover = true;
    if let Some(id) = id {
        if !end {
            tx.scroll_to_instant(theme::LIST, 0.0, 0.0);
        }
        tx.scroll_into_view_in(theme::LIST, item_key(id));
    }
}

pub(super) fn execute_by_id(s: &mut State, id: &'static str, tx: &mut Tx) -> bool {
    let items = visible_commands(s);
    let Some(item) = items.into_iter().find(|item| item.id == id) else {
        return false;
    };
    if item.disabled {
        return false;
    }
    let target = take_closed_state(s);
    if item.id == "rename-instance" {
        let return_target = Some(target.clone().unwrap_or_else(|| theme::TRIGGER.to_owned()));
        if !super::tab_rename::open_active_with_return_focus(s, return_target, tx) {
            restore_focus(target, tx);
        }
    } else if item.id == "cleanup-blank-sessions" {
        let return_target = Some(target.clone().unwrap_or_else(|| theme::TRIGGER.to_owned()));
        if !super::blank_cleanup::open_confirm(s, return_target, tx) {
            restore_focus(target, tx);
        }
    } else if item.id == "close-instance" {
        let return_target = target.clone();
        restore_focus(target, tx);
        super::temporary::set_pending_return_focus(s, return_target);
        commands::execute(s, item.id, tx);
        super::temporary::clear_pending_return_focus(s);
    } else {
        restore_focus(target, tx);
        commands::execute(s, item.id, tx);
    }
    tx.instant();
    true
}

fn execute_selected(s: &mut State, tx: &mut Tx) -> bool {
    let items = visible_commands(s);
    let Some(index) = resolved_selection(&items, s.command_palette.selected_id) else {
        return false;
    };
    let item = &items[index];
    if item.disabled {
        return false;
    }
    let id = item.id;
    let target = take_closed_state(s);
    if id == "rename-instance" {
        let return_target = Some(target.clone().unwrap_or_else(|| theme::TRIGGER.to_owned()));
        if !super::tab_rename::open_active_with_return_focus(s, return_target, tx) {
            restore_focus(target, tx);
        }
    } else if id == "cleanup-blank-sessions" {
        let return_target = Some(target.clone().unwrap_or_else(|| theme::TRIGGER.to_owned()));
        if !super::blank_cleanup::open_confirm(s, return_target, tx) {
            restore_focus(target, tx);
        }
    } else if id == "close-instance" {
        let return_target = target.clone();
        restore_focus(target, tx);
        super::temporary::set_pending_return_focus(s, return_target);
        commands::execute(s, id, tx);
        super::temporary::clear_pending_return_focus(s);
    } else {
        restore_focus(target, tx);
        commands::execute(s, id, tx);
    }
    tx.instant();
    true
}

fn is_plain_text_key(event: &KeyEvent) -> bool {
    matches!(event.key, Key::Text(_))
        && !event.mods.ctrl
        && !event.mods.cmd
        && !event.mods.alt
        && !event.mods.logo
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) || is_composing(s) || blocked_by_higher_modal(s) {
        return false;
    }
    if event.key == Key::Escape && event.mods == Mods::default() {
        if !tx.key_repeat() {
            close(s, tx);
        }
        return true;
    }
    if event.mods == Mods::default() {
        match event.key {
            Key::Down => {
                move_selection(s, 1, tx);
                return true;
            }
            Key::Up => {
                move_selection(s, -1, tx);
                return true;
            }
            Key::Home => {
                select_edge(s, false, tx);
                return true;
            }
            Key::End => {
                select_edge(s, true, tx);
                return true;
            }
            Key::Enter if tx.focused() != Some(CLOSE_KEY) => {
                if !tx.key_repeat() {
                    execute_selected(s, tx);
                }
                return true;
            }
            _ => {}
        }
    }
    if !is_plain_text_key(event)
        && settings::match_shortcut(s, event, tx, |matches| {
            matches("open-command-palette").then_some(())
        })
        .is_some()
    {
        if !tx.key_repeat() {
            close(s, tx);
        }
        return true;
    }
    false
}
