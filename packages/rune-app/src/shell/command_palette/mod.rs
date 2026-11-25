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

#[derive(Default)]
pub(crate) struct Palette {
    open: bool,
    query: TextEdit,
    selected_id: Option<&'static str>,
    return_focus: Option<String>,
    viewport: (f32, f32),
    close_control: WindowCloseState,
}

pub(crate) fn is_open(s: &State) -> bool {
    s.command_palette.open
}

pub(crate) fn is_composing(s: &State) -> bool {
    s.command_palette.open && s.command_palette.query.is_composing()
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.command_palette.viewport;
    if *viewport != (width, height) {
        *viewport = (width, height);
        if s.command_palette.open {
            tx.instant();
        }
        true
    } else {
        false
    }
}

pub(crate) fn open(s: &mut State, tx: &mut Tx) {
    if s.command_palette.open {
        return;
    }
    super::Panels::dismiss_outside(s, tx);
    let prior = tx.focused().map(str::to_owned);
    let palette = &mut s.command_palette;
    palette.open = true;
    palette.query = TextEdit::new("");
    palette.query.focused = true;
    palette.selected_id = None;
    palette.return_focus = prior;
    tx.focus_when_shown(FOCUS, true);
    tx.instant();
}

pub(crate) fn close(s: &mut State, tx: &mut Tx) {
    if !s.command_palette.open {
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
    let palette = &mut s.command_palette;
    palette.open = false;
    palette.query = TextEdit::new("");
    palette.selected_id = None;
    palette.close_control = WindowCloseState::default();
    palette.return_focus.take()
}

fn restore_focus(target: Option<String>, tx: &mut Tx) {
    let focus_target = target.as_deref().unwrap_or(theme::TRIGGER);
    tx.return_focus(focus_target, tx.focus_visible());
}

fn visible_commands(s: &State) -> Vec<commands::CommandItem> {
    commands::filter(&s.command_palette.query.text, commands::collect(s))
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

fn move_selection(s: &mut State, delta: isize) {
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
    s.command_palette.selected_id = Some(items[next].id);
}

fn select_edge(s: &mut State, end: bool) {
    let items = visible_commands(s);
    let target = if end { items.last() } else { items.first() };
    s.command_palette.selected_id = target.map(|item| item.id);
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
    restore_focus(target, tx);
    commands::execute(s, item.id, tx);
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
    restore_focus(target, tx);
    commands::execute(s, id, tx);
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

fn blocked_by_higher_modal(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if crate::chat::authentication::open(s) {
        return true;
    }
    false
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
    if event.mods == Mods::default() {
        match event.key {
            Key::Down => {
                move_selection(s, 1);
                return true;
            }
            Key::Up => {
                move_selection(s, -1);
                return true;
            }
            Key::Home => {
                select_edge(s, false);
                return true;
            }
            Key::End => {
                select_edge(s, true);
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
    false
}
