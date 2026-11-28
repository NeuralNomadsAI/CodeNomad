use crate::{State, components::button_tx, screen, strings::t};
use rune::{El, text};
use rune_theme_codenomad::{
    Space, document_reader as theme,
    layout::{self, Layout},
    workspace_tree,
};

pub(crate) fn tree(s: &State, width: f32, touch: bool) -> El {
    layout::with_source_palette(|| tree_content(s, width, touch))
}

fn tree_content(s: &State, width: f32, touch: bool) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    let dark = layout::dark();
    let scope = s.input_scope.clone();
    let rtl = rune_theme_codenomad::catalogue::direction(crate::strings::locale()) == "rtl";
    let tab_stop = ui
        .tree
        .selected()
        .filter(|path| ui.rows.iter().any(|row| row.entry.path == *path))
        .or_else(|| ui.rows.first().map(|row| row.entry.path.as_str()));
    let mut tree = rune::col()
        .key("workspace-tree")
        .full_width()
        .role("tree")
        .focus_group()
        .label(t("filesPanel.workspace"));
    let mut overlays = Vec::new();
    for row in &ui.rows {
        let path = row.entry.path.clone();
        let folder = row.expanded.is_some();
        let legacy_eye = !ui.shell_managed && !folder;
        let actions = if ui.shell_managed {
            let (actions, popup) = super::actions::row(s, ui, row, width, touch);
            overlays.extend(popup);
            Some(actions)
        } else {
            legacy_eye.then(|| {
                let active = ui.previews(&path);
                let invoke = std::rc::Rc::new(screen::action_tx(&scope, {
                    let path = path.clone();
                    let directory = ui.tree.directory().to_owned();
                    move |s, tx| match s
                        .files
                        .as_mut()
                        .and_then(|ui| ui.toggle_preview(&directory, &path))
                    {
                        Some(true) => {
                            #[cfg(target_arch = "wasm32")]
                            super::refresh_browser_file_wrap(s);
                            crate::workspace::close_mission_reader(s);
                        }
                        Some(false) => crate::chat::reading::restore_position(s, tx),
                        _ => {}
                    }
                }));
                let click = invoke.clone();
                let disabled = ui.stopped;
                theme::eye(
                    dark,
                    &format!("{} · {}", t("filesPanel.viewer"), path),
                    disabled,
                    active,
                    move |s, tx| click(s, tx),
                )
                .key(format!("file-eye-{path}"))
                .on_key(move |s: &mut State, key, tx| match key.key {
                    rune::Key::Enter if !disabled && key.mods == rune::Mods::default() => {
                        if !tx.key_repeat() {
                            invoke(s, tx);
                        }
                        true
                    }
                    rune::Key::Up
                    | rune::Key::Down
                    | rune::Key::Left
                    | rune::Key::Right
                    | rune::Key::Home
                    | rune::Key::End => true,
                    _ => false,
                })
            })
        };
        tree = tree.child(
            workspace_tree::row(
                dark,
                rtl,
                workspace_tree::Row {
                    label: &row.entry.name,
                    depth: row.depth as u32,
                    selected: ui.tree.selected() == Some(path.as_str()),
                    expanded: row.expanded,
                    icon: workspace_tree::entry_icon(&row.entry.name, row.expanded),
                    busy: row.busy,
                    actions,
                },
            )
            .key(format!("file-row-{path}"))
            .tab_index(if tab_stop == Some(path.as_str()) {
                0
            } else {
                -1
            })
            .on_key({
                let scope = scope.clone();
                let path = path.clone();
                let row_key = format!("file-row-{path}");
                move |s: &mut State, key, tx| {
                    tx.focused() == Some(row_key.as_str())
                        && s.current_scope(&scope)
                        && s.files
                            .as_mut()
                            .is_some_and(|ui| ui.navigate(&path, &key.key, rtl, tx))
                }
            })
            .on_press(screen::action(&scope, move |s| {
                if let Some(ui) = &mut s.files {
                    ui.select(path.clone(), folder);
                }
            })),
        );
    }
    let mut status = Vec::new();
    if let Some((success, message)) = &ui.actions.notice {
        status.push(
            text(message)
                .role(if *success { "status" } else { "alert" })
                .pad(Space::Md),
        );
    }
    let directory = ui.tree.directory();
    let name = codenomad_client::server_path_basename(directory);
    for (path, error) in ui.listing_errors() {
        let message = super::super::errors::format_listing_error(path, name, error);
        let retry = std::rc::Rc::new(screen::action_tx(&scope, {
            let path = path.to_owned();
            let directory = directory.to_owned();
            move |s, _| {
                if let Some(ui) = &mut s.files {
                    ui.retry_listing(&directory, &path);
                }
            }
        }));
        let press = retry.clone();
        status.push(text(message).role("alert"));
        let control = button_tx(
            &format!("file-retry-{path}"),
            t("instanceShell.rightPanel.actions.refresh"),
            ui.stopped,
            move |s, tx| press(s, tx),
        );
        status.push(if ui.stopped {
            control
        } else {
            super::activate_enter(control, move |s, tx| retry(s, tx))
        });
    }
    if ui.tree.busy(".") {
        status.push(
            text(t("instanceInfo.loading"))
                .role("status")
                .pad(Space::Md),
        );
    }
    let contents = workspace_tree::workspace_body(
        workspace_tree::root(dark, name, directory).key("file-tree-root"),
        tree,
        status,
    );
    let surface = rune::col()
        .full_width()
        .remaining()
        .reading_surface()
        .key("files-panel")
        .child(
            ui.tree_scroll
                .apply::<State>(theme::viewport(contents, true), "workspace-tree-scroll"),
        );
    workspace_tree::with_actions(surface, overlays).key(format!("workspace-checkout-{directory}"))
}
