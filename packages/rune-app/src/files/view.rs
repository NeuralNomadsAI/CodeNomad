use super::document::{Content, Format, content};
use crate::{State, screen, strings::t};
use rune::{El, text};
use rune_theme_codenomad::{
    Space, TextRole, document_reader as theme,
    layout::{self, Layout},
    workspace_tree::{self, icons},
};

pub fn toggle(s: &State) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    crate::launcher_view::button(
        "files-toggle",
        t(if ui.panel {
            "instanceShell.filesShell.hideFiles"
        } else {
            "instanceShell.filesShell.showFiles"
        }),
        ui.stopped,
    )
    .expanded(ui.panel)
    .on_press(screen::action(&s.input_scope, |s| {
        if let Some(ui) = &mut s.files {
            ui.show(!ui.panel);
        }
    }))
}
pub fn body(s: &State, history: El) -> El {
    let Some(ui) = &s.files else {
        return history;
    };
    let main = if ui.reader.target().is_some() {
        reader(s)
    } else {
        history
    };
    theme::split(main, ui.panel.then(|| tree(s)))
}
fn reader(s: &State) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    let Some(target) = ui.reader.target() else {
        return rune::el();
    };
    let dark = layout::dark();
    let scope = ui.document.scope();
    let mut actions = theme::actions_row().child(
        crate::launcher_view::button(
            "file-refresh",
            t("instanceShell.rightPanel.actions.refresh"),
            ui.reader.busy() || ui.document.pending() || ui.document.dirty(),
        )
        .on_press(screen::action(&s.input_scope, move |s| {
            if let Some(ui) = &mut s.files {
                ui.refresh_document(scope);
            }
        })),
    );
    let mut content_view = rune::el();
    if let Some(preview) = ui.reader.preview() {
        content_view = match content(&target.path, &preview.bytes) {
            Content::Binary => text(t("filesPanel.binary")).pad(Space::Md),
            Content::Image(mime) => match ui.presentation.image.as_ref() {
                Some(image) if image.error().is_some() => {
                    text(t("filesPanel.binary")).pad(Space::Md)
                }
                Some(image) => theme::image(image, &target.path, mime == "image/svg+xml"),
                None => text(t("instanceInfo.loading")).pad(Space::Md),
            },
            Content::Text { format, .. } => {
                let text = ui.document.edit().text.as_str();
                if format != Format::Source {
                    actions = actions.child(
                        crate::launcher_view::button(
                            "file-source-toggle",
                            t(if !ui.presentation.source {
                                "instanceShell.filesShell.showSource"
                            } else if format == Format::Mermaid {
                                "markdown.mermaid.preview"
                            } else {
                                "instanceShell.filesShell.previewMarkdown"
                            }),
                            false,
                        )
                        .on_press(screen::action(
                            &s.input_scope,
                            move |s| {
                                if let Some(ui) = &mut s.files {
                                    if ui.document.scope() == scope {
                                        ui.presentation.source = !ui.presentation.source;
                                    }
                                }
                            },
                        )),
                    );
                }
                let source = ui.presentation.source || format == Format::Source;
                if source {
                    actions = actions.child(
                        crate::launcher_view::button(
                            "file-wrap",
                            t(if ui.presentation.wrap {
                                "instanceShell.filesShell.disableWordWrap"
                            } else {
                                "instanceShell.filesShell.enableWordWrap"
                            }),
                            false,
                        )
                        .checked(ui.presentation.wrap)
                        .on_press(screen::action(
                            &s.input_scope,
                            move |s| {
                                if let Some(ui) = &mut s.files {
                                    if ui.document.scope() == scope {
                                        ui.presentation.wrap = !ui.presentation.wrap;
                                    }
                                }
                            },
                        )),
                    );
                    theme::viewport(
                        theme::source(dark, &target.path, text, ui.presentation.wrap),
                        ui.presentation.wrap,
                    )
                } else {
                    theme::viewport(
                        if format == Format::Mermaid {
                            theme::mermaid(dark, text)
                                .map(|diagram| diagram.label(t("markdown.mermaid.diagram")))
                                .unwrap_or_else(|| {
                                    rune::col()
                                        .child(
                                            rune::text(t("markdown.mermaid.failed")).role("alert"),
                                        )
                                        .child(theme::source(dark, &target.path, text, true))
                                })
                        } else {
                            theme::markdown(dark, text, t("markdown.mermaid.diagram"))
                        },
                        true,
                    )
                }
            }
        };
    }
    actions = actions.child(
        crate::launcher_view::button("file-close", t("gitPanel.backChat"), false).on_press(
            screen::action(&s.input_scope, move |s| {
                if let Some(ui) = &mut s.files {
                    if ui.document.scope() == scope {
                        ui.close_reader();
                    }
                }
            }),
        ),
    );
    theme::surface(dark)
        .key(format!("file-reader-{scope}"))
        .role("region")
        .label(t("filesPanel.viewer"))
        .child(theme::header(&target.path, &target.directory, actions))
        .child(
            text(t("filesPanel.readOnly"))
                .text_role(TextRole::Small)
                .pad(Space::Sm),
        )
        .children(
            ui.reader
                .error()
                .map(|error| text(error).role("alert").pad(Space::Md)),
        )
        .children(
            (ui.reader.busy() && ui.reader.preview().is_none()).then(|| {
                text(t("instanceInfo.loading"))
                    .role("status")
                    .pad(Space::Md)
            }),
        )
        .child(content_view.remaining())
}

fn tree(s: &State) -> El {
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
            .on_press(screen::action(&scope, {
                let path = path.clone();
                move |s| {
                    if let Some(ui) = &mut s.files {
                        ui.open(path.clone());
                    }
                }
            }))
        });
        tree = tree.child(
            workspace_tree::row(
                dark,
                rune_theme_codenomad::catalogue::direction(crate::strings::locale()) == "rtl",
                workspace_tree::Row {
                    label: &row.entry.name,
                    depth: row.depth as u32,
                    selected: ui.tree.selected() == Some(path.as_str()),
                    expanded: row.expanded,
                    icon: if row.expanded == Some(true) {
                        &icons::FOLDER_OPEN
                    } else if folder {
                        &icons::FOLDER
                    } else {
                        &icons::FILE
                    },
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
                move |s: &mut State, key, tx| {
                    s.current_scope(&scope)
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
        tree = tree.child(text(error).role("alert")).child(
            crate::launcher_view::button(
                &format!("file-retry-{path}"),
                t("instanceShell.rightPanel.actions.refresh"),
                false,
            )
            .on_press(screen::action(&scope, move |s| {
                if let Some(ui) = &mut s.files {
                    ui.refresh(Some(&path));
                }
            })),
        );
    }
    theme::surface(dark)
        .key("files-panel")
        .child(
            text(ui.tree.directory())
                .text_role(TextRole::Label)
                .pad(Space::Sm),
        )
        .child(theme::viewport(tree, true))
        .children(
            ui.tree
                .busy(".")
                .then(|| text(t("instanceInfo.loading")).role("status")),
        )
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
