pub(crate) mod notifications;
mod panels;
pub(crate) mod render;
mod right_panel;
mod sidebar;

use crate::{Phase, Screen, State, components::button_tx, launcher_view, strings::t, workspace};
use rune::{Cx, El, Tx, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};

pub(crate) use panels::{Panels, toggle as toggle_panel};

pub fn view(
    s: &State,
    cx: &mut Cx<State>,
    conversation: impl FnOnce(&State, &mut Cx<State>) -> El,
) -> El {
    let mut root = col()
        .key("application-shell")
        .full_width()
        .full_height()
        .reading_surface();
    if crate::platform::titlebar::available() {
        root = root.child(crate::platform::titlebar::view(s, cx));
    }
    if let Some(ui) = &s.workspace {
        root = root.child(workspace::strip(s, cx).on_background_press_tx(Panels::dismiss_outside));
        if let Some(error) = workspace::status(s) {
            root = root.child(
                layout::action_row()
                    .pad(Space::Sm)
                    .child(text(t(error)).role("alert"))
                    .child(button_tx(
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
        root.child(
            rune::row()
                .child(crate::settings::direct_entry(s, cx.touch_controls()))
                .child(notifications::history_entry(s, cx.touch_controls())),
        )
        .child(body(s, cx, conversation).remaining())
    }
}

fn body(
    s: &State,
    cx: &mut Cx<State>,
    conversation: impl FnOnce(&State, &mut Cx<State>) -> El,
) -> El {
    if launcher_replaces_project(s) {
        return launcher_view::view(s);
    }
    let has_project = s.screen.launcher().is_some_and(|l| l.project.is_some());
    let body = match &s.screen {
        Screen::Launcher(_) if crate::git::has_preview(s) => crate::git::reader(s),
        Screen::Launcher(_) => {
            rune_theme_codenomad::shell::empty_conversation(t("instanceShell.empty.title"))
        }
        Screen::Chat { .. } => conversation(s, cx),
    };
    panels::view(s, cx.touch_controls(), has_project, body)
}

fn launcher_replaces_project(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|l| l.authentication_required)
        || matches!(&s.screen, Screen::Launcher(l) if l.project.is_none())
}

pub(crate) fn right_panel_visible(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return false;
    }
    !launcher_replaces_project(s)
        && s.screen.launcher().is_some_and(|l| l.project.is_some())
        && s.shell.visible(1)
}

pub fn reader(s: &State, history: impl FnOnce() -> El) -> El {
    if crate::git::has_preview(s) {
        crate::git::reader(s)
    } else if crate::files::has_preview(s) {
        crate::files::view::in_shell(s)
    } else {
        history()
    }
}

pub fn sync(s: &mut State) {
    crate::git::show(s, s.shell.visible(1) && workspace::files_tab(s));
}

fn connection(s: &State) -> &'static str {
    t(match s.phase {
        Phase::Loading | Phase::Reconnecting => "instanceShell.connection.connecting",
        Phase::Ready | Phase::Streaming => "instanceShell.connection.connected",
        Phase::Failed => "instanceShell.connection.disconnected",
        #[cfg(target_arch = "wasm32")]
        Phase::WorkspaceMissing => "instanceShell.connection.connecting",
        #[cfg(target_arch = "wasm32")]
        Phase::RestoreFailed => "rune.restore_error",
    })
}

pub fn keys(s: &mut State, event: &rune::KeyEvent, tx: &mut Tx) -> bool {
    use rune::{Key, Mods};
    if event.key == Key::Tab && !event.mods.ctrl && !event.mods.cmd && !event.mods.alt {
        return s.shell.wrap_floating_focus(event.mods.shift, tx);
    }
    if event.key == Key::Function(6) && s.shell.has_floating() {
        return !event.mods.ctrl && !event.mods.cmd && !event.mods.alt;
    }
    if tx.key_repeat() {
        return false;
    }
    if event.mods == Mods::default() {
        let handled = match event.key {
            Key::Escape if s.shell.close_floating(tx) => {
                if !s.shell.visible(1) {
                    crate::workspace::hide_missions(s);
                }
                true
            }
            Key::Escape if crate::git::has_preview(s) => {
                crate::git::close_preview(s);
                tx.instant();
                true
            }
            Key::Escape if crate::files::has_preview(s) && !s.screen.is_launcher() => {
                if let Some(files) = &mut s.files {
                    if files.document.confirmation().is_some() {
                        return false;
                    }
                    files.close_reader();
                }
                crate::chat::reading::restore_position(s, tx);
                true
            }
            Key::Function(11) if crate::platform::titlebar::available() => {
                tx.toggle_full_screen();
                true
            }
            _ => false,
        };
        if handled {
            return true;
        }
    }
    if crate::settings::matches_shortcut(s, "new-instance", event, tx, 'n') && workspace::can_new(s)
    {
        workspace::new_tab(s, tx);
    } else if crate::settings::matches_shortcut(s, "close-instance", event, tx, 'w') {
        let Some(key) = s.workspace.as_ref().map(|ui| ui.active_key().to_owned()) else {
            return false;
        };
        workspace::close(s, &key, tx);
    } else {
        return false;
    }
    true
}

#[cfg(test)]
mod tests;
