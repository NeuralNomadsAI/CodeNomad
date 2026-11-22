mod panels;
mod right_panel;
mod sidebar;

use crate::{Phase, Screen, State, launcher_view, strings::t, workspace};
use rune::{Cx, El, Tx, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};

pub(crate) use panels::Panels;

pub fn view(
    s: &State,
    cx: &mut Cx<State>,
    conversation: impl FnOnce(&State, &mut Cx<State>) -> El,
) -> El {
    let mut root = col().full_width().full_height().reading_surface();
    if crate::platform::titlebar::available() {
        root = root.child(crate::platform::titlebar::view(cx));
    }
    if let Some(ui) = &s.workspace {
        root = root.child(workspace::strip(s, cx));
        if let Some(error) = workspace::status(s) {
            root = root.child(
                layout::action_row()
                    .pad(Space::Sm)
                    .child(text(t(error)).role("alert"))
                    .child(launcher_view::button_tx(
                        "workspace-retry",
                        t("sessionList.loadError.retry"),
                        false,
                        crate::screen::action_tx(&s.input_scope, workspace::retry),
                    )),
            );
        }
        let body = body(s, cx, conversation).key(format!("tab-body-{}", ui.active_key()));
        root.child(body.remaining())
    } else {
        root.child(body(s, cx, conversation).remaining())
    }
}

fn body(
    s: &State,
    cx: &mut Cx<State>,
    conversation: impl FnOnce(&State, &mut Cx<State>) -> El,
) -> El {
    let has_project = s.screen.launcher().is_some_and(|l| l.project.is_some());
    let body = match &s.screen {
        Screen::Launcher(_) if !has_project => return launcher_view::view(s),
        Screen::Launcher(_) => {
            rune_theme_codenomad::shell::empty_conversation(t("instanceShell.empty.title"))
        }
        Screen::Chat { .. } => conversation(s, cx),
    };
    panels::view(s, cx.touch_controls(), has_project, body)
}

fn connection(s: &State) -> &'static str {
    t(match s.phase {
        Phase::Loading | Phase::Reconnecting => "instanceShell.connection.connecting",
        Phase::Ready | Phase::Streaming => "instanceShell.connection.connected",
        Phase::Failed => "instanceShell.connection.disconnected",
    })
}

pub fn keys(s: &mut State, event: &rune::KeyEvent, tx: &mut Tx) -> bool {
    use rune::{Key, Mods};
    if tx.key_repeat() {
        return false;
    }
    if event.mods == Mods::default() {
        return match event.key {
            Key::Escape => s.shell.close_floating(tx),
            Key::Function(11) if crate::platform::titlebar::available() => {
                tx.toggle_full_screen();
                true
            }
            _ => false,
        };
    }
    if !event.mods.ctrl || event.mods.alt || event.mods.shift {
        return false;
    }
    match event.key {
        Key::Command('n') if workspace::can_new(s) => workspace::new_tab(s, tx),
        Key::Command('w') => {
            let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) else {
                return false;
            };
            workspace::close(s, &key, tx);
        }
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests;
