use crate::{State, components::button, screen, strings::t};
use rune::{El, text};
use rune_theme_codenomad::{
    Space, document_reader as theme,
    layout::{self, Layout},
    workspace_tree,
};

pub(crate) fn tree(s: &State) -> El {
    layout::with_source_palette(|| tree_content(s))
}

fn open_workspace(s: &mut State, path: String) {
    if let Some(ui) = &mut s.files {
        ui.open(path);
    }
}

fn tree_content(s: &State) -> El {
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
        .full_width()
        .role("tree")
        .label(t("filesPanel.workspace"));
    for row in &ui.rows {
        let path = row.entry.path.clone();
        let folder = row.expanded.is_some();
        let actions = (!folder).then(|| {
            theme::eye(
                dark,
                &format!("{} · {}", t("filesPanel.viewer"), path),
                ui.stopped,
                screen::action(&scope, {
                    let path = path.clone();
                    move |s| open_workspace(s, path.clone())
                }),
            )
            .key(format!("file-eye-{path}"))
            .on_key(|_: &mut State, key, _| {
                matches!(
                    key.key,
                    rune::Key::Up
                        | rune::Key::Down
                        | rune::Key::Left
                        | rune::Key::Right
                        | rune::Key::Home
                        | rune::Key::End
                )
            })
        });
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
    for (path, error) in ui.tree.errors() {
        let path = path.clone();
        tree = tree.child(text(error).role("alert")).child(button(
            &format!("file-retry-{path}"),
            t("instanceShell.rightPanel.actions.refresh"),
            ui.stopped,
            screen::action(&scope, move |s| {
                if let Some(ui) = &mut s.files {
                    ui.refresh(Some(&path));
                }
            }),
        ));
    }
    let directory = ui.tree.directory();
    let name = directory
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(directory);
    let contents = workspace_tree::workspace_body(
        workspace_tree::root(dark, name, directory).key("file-tree-root"),
        tree,
        ui.tree.busy(".").then(|| {
            text(t("instanceInfo.loading"))
                .role("status")
                .pad(Space::Md)
        }),
    );
    theme::surface(dark)
        .key("files-panel")
        .child(theme::viewport(contents, true))
}
