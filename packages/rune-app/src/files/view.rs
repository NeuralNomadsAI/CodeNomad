use super::{document::Format, presentation::Kind};
use crate::{State, components::button, screen, strings::t, window_control::scoped_close_button};
use rune::{El, text};
use rune_theme_codenomad::{
    Space, document_reader as theme,
    layout::{self, Layout},
    workspace_tree::{self, icons},
};

pub fn toggle(s: &State) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    let drawer = ui.drawer();
    button(
        "files-toggle",
        t(if !drawer.room && !ui.panel {
            "filesPanel.widenWindow"
        } else if ui.panel {
            "instanceShell.filesShell.hideFiles"
        } else {
            "instanceShell.filesShell.showFiles"
        }),
        ui.stopped || (!drawer.room && !ui.panel),
        screen::action(&s.input_scope, |s| {
            if let Some(ui) = &mut s.files {
                if ui.panel || ui.drawer().room {
                    ui.show(!ui.panel);
                }
            }
        }),
    )
    .expanded(drawer.pinned)
}
fn document_action(s: &State, run: fn(&mut super::Ui)) -> impl Fn(&mut State) + 'static {
    let scope = s.files.as_ref().map(|ui| ui.document.scope());
    screen::action(&s.input_scope, move |s| {
        if let Some(ui) = &mut s.files {
            if scope == Some(ui.document.scope()) {
                run(ui);
            }
        }
    })
}
fn document_link(s: &State) -> impl Fn(&mut State, &str, &mut rune::Tx) + 'static {
    let input_scope = s.input_scope.clone();
    let document = s
        .files
        .as_ref()
        .map(|ui| (ui.document.scope(), ui.document.revision()));
    move |s, url, tx| {
        if s.current_scope(&input_scope)
            && let Some(ui) = s.files.as_ref().filter(|ui| {
                !ui.stopped
                    && !ui.presentation.source
                    && document == Some((ui.document.scope(), ui.document.revision()))
                    && ui.reader.target().is_some()
            })
        {
            ui.reader_link(url, tx);
        }
    }
}
pub fn body(s: &State, history: El, expanded: bool) -> El {
    let Some(ui) = &s.files else {
        return history;
    };
    let main = theme::pages(history, ui.reader.target().is_some().then(|| reader(s)));
    let drawer = ui.drawer();
    theme::split(main, drawer.pinned.then(|| tree(s)), drawer.width, expanded)
        .key("files-host")
        .on_layout_tx({
            let scope = s.input_scope.clone();
            move |s: &mut State, rect, tx| {
                if s.current_scope(&scope) {
                    if let Some(ui) = &mut s.files {
                        ui.resize(rect[2], tx);
                    }
                }
            }
        })
}
pub(crate) fn reader(s: &State) -> El {
    layout::with_source_palette(|| reader_content(s))
}

fn reader_content(s: &State) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    let Some(target) = ui.reader.target() else {
        return rune::el();
    };
    let dark = layout::dark();
    let scope = ui.document.scope();
    let drawer = ui.drawer();
    let view_width = ui.host_width.map(|width| {
        if drawer.pinned {
            width - drawer.width
        } else {
            width
        }
    });
    let mut actions = vec![button(
        "file-refresh",
        t("instanceShell.rightPanel.actions.refresh"),
        ui.reader.busy() || ui.document.pending() || ui.document.dirty(),
        document_action(s, |ui| ui.refresh_document(ui.document.scope())),
    )];
    let mut content_view = rune::el();
    if let Some(kind) = ui.presentation.kind {
        content_view = match kind {
            Kind::Binary => text(t("filesPanel.binary")).pad(Space::Md),
            Kind::Image { .. } => match ui.presentation.image.as_ref() {
                Some(image) if image.error().is_some() => {
                    text(t("filesPanel.binary")).pad(Space::Md)
                }
                Some(image) => theme::image(image, &target.path),
                None => text(t("instanceInfo.loading")).pad(Space::Md),
            },
            Kind::Text(format) => {
                let text = ui.document.edit().text.as_str();
                if format != Format::Source {
                    actions.push(button(
                        "file-source-toggle",
                        t(if !ui.presentation.source {
                            "instanceShell.filesShell.showSource"
                        } else if format == Format::Mermaid {
                            "markdown.mermaid.preview"
                        } else {
                            "instanceShell.filesShell.previewMarkdown"
                        }),
                        false,
                        document_action(s, |ui| ui.presentation.source = !ui.presentation.source),
                    ));
                }
                let source = ui.presentation.source || format == Format::Source;
                if source {
                    actions.push(
                        theme::wrap_button(
                            dark,
                            t(if ui.presentation.wrap {
                                "instanceShell.filesShell.disableWordWrap"
                            } else {
                                "instanceShell.filesShell.enableWordWrap"
                            }),
                            ui.presentation.wrap,
                            document_action(s, |ui| ui.presentation.wrap = !ui.presentation.wrap),
                        )
                        .key("file-wrap"),
                    );
                    theme::source_view(
                        dark,
                        theme::source(
                            dark,
                            &target.path,
                            text,
                            ui.presentation.wrap,
                            view_width.map(|width| theme::source_width(dark, width)),
                        ),
                        ui.presentation.wrap,
                    )
                } else {
                    theme::rendered_viewport(
                        dark,
                        if format == Format::Mermaid {
                            theme::mermaid_frame(
                                dark,
                                theme::mermaid(dark, text)
                                    .map(|diagram| diagram.label(t("markdown.mermaid.diagram")))
                                    .unwrap_or_else(|| {
                                        theme::mermaid_error(
                                            dark,
                                            t("markdown.mermaid.failed"),
                                            text,
                                        )
                                    }),
                            )
                        } else {
                            rune::col().pad(Space::Lg).child(theme::markdown(
                                dark,
                                text,
                                t("markdown.mermaid.diagram"),
                                document_link(s),
                            ))
                        },
                    )
                    .key("file-rendered-scroll")
                    .on_key(|_: &mut State, key, tx| {
                        if matches!(&key.key, rune::Key::Text(text) if text == " ")
                            && !key.mods.alt
                            && !key.mods.ctrl
                            && !key.mods.cmd
                            && !key.mods.logo
                        {
                            tx.scroll_page(
                                "file-rendered-scroll",
                                if key.mods.shift { -1 } else { 1 },
                            );
                            return true;
                        }
                        false
                    })
                }
            }
        };
    }
    let input_scope = s.input_scope.clone();
    actions.push(scoped_close_button(
        &ui.reader_close,
        "file-close",
        dark,
        Some(t("gitPanel.backChat")),
        move |s: &mut State| {
            s.files
                .as_mut()
                .filter(|ui| ui.document.scope() == scope)
                .map(|ui| &mut ui.reader_close)
        },
        screen::action_tx(&input_scope, move |s, tx| {
            if let Some(ui) = &mut s.files {
                if scope == ui.document.scope() {
                    ui.close_reader();
                    ui.reading.restore(tx);
                }
            }
        }),
    ));
    let readonly =
        (!matches!(ui.presentation.kind, Some(Kind::Text(_)))).then(|| t("filesPanel.readOnly"));
    theme::surface(dark)
        .key(format!("file-reader-{scope}"))
        .role("region")
        .label(t("filesPanel.viewer"))
        .child(theme::header(
            &target.path,
            &target.directory,
            readonly,
            actions,
        ))
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
                    icon: row_icon(&row.entry.name, row.expanded),
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

fn row_icon(name: &str, expanded: Option<bool>) -> &'static rune::Icon {
    if let Some(expanded) = expanded {
        return if expanded {
            &icons::FOLDER_OPEN
        } else {
            &icons::FOLDER
        };
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "avif") => {
            &icons::IMAGE
        }
        Some("md" | "mdx" | "txt" | "rst") => &icons::FILE_TEXT,
        Some(
            "ts" | "tsx" | "js" | "jsx" | "json" | "yaml" | "yml" | "css" | "html" | "py" | "rs"
            | "sh",
        ) => &icons::FILE_CODE,
        _ => &icons::FILE,
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
