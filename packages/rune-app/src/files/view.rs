use super::{document::Format, presentation::Kind};
use crate::{State, components::button_tx, screen, strings::t};
use rune::El;
use rune_theme_codenomad::{
    Space, document_reader as theme, git_panel,
    layout::{self, Layout},
};

mod actions;
pub(super) use actions::poll_notices;
mod editor;
mod tree;
pub(super) use actions::Actions;
pub(super) use actions::poll as poll_actions;
pub(crate) use tree::tree;

pub fn toggle(s: &State) -> El {
    let Some(ui) = &s.files else {
        return rune::el();
    };
    if ui.shell_managed {
        return rune::el();
    }
    let drawer = ui.drawer();
    let disabled = ui.stopped || (!drawer.room && !ui.panel);
    let toggle = std::rc::Rc::new(screen::action_tx(&s.input_scope, |s, _| {
        if let Some(ui) = &mut s.files {
            if ui.panel || ui.drawer().room {
                ui.show(!ui.panel);
            }
        }
    }));
    let press = toggle.clone();
    let control = button_tx(
        "files-toggle",
        t(if !drawer.room && !ui.panel {
            "filesPanel.widenWindow"
        } else if ui.panel {
            "instanceShell.filesShell.hideFiles"
        } else {
            "instanceShell.filesShell.showFiles"
        }),
        disabled,
        move |s, tx| press(s, tx),
    )
    .expanded(drawer.pinned);
    if disabled {
        control
    } else {
        activate_enter(control, move |s, tx| toggle(s, tx))
    }
}
fn document_action_tx(
    s: &State,
    run: impl Fn(&mut super::Ui, &mut rune::Tx) + 'static,
) -> impl Fn(&mut State, &mut rune::Tx) + 'static {
    document_state_action_tx(s, move |s, tx| {
        if let Some(ui) = &mut s.files {
            run(ui, tx);
        }
    })
}

fn document_state_action_tx(
    s: &State,
    run: impl Fn(&mut State, &mut rune::Tx) + 'static,
) -> impl Fn(&mut State, &mut rune::Tx) + 'static {
    let scope = s.files.as_ref().map(|ui| ui.document.scope());
    screen::action_tx(&s.input_scope, move |s, tx| {
        if s.files
            .as_ref()
            .is_some_and(|ui| scope == Some(ui.document.scope()))
        {
            run(s, tx);
        }
    })
}

#[cfg(target_arch = "wasm32")]
fn refresh_browser_file_wrap(s: &mut State) {
    if let Some(wrap) = crate::platform::storage::browser_file_wrap() {
        s.shell.file_wrap = wrap;
    }
}
fn reader_action(
    s: &State,
    key: &str,
    label: &str,
    disabled: bool,
    run: fn(&mut super::Ui, &mut rune::Tx),
) -> El {
    git_panel::toolbar_button(label, disabled, document_action_tx(s, run)).key(key)
}
fn activate_enter(control: El, enter: impl Fn(&mut State, &mut rune::Tx) + 'static) -> El {
    control.on_key(move |s: &mut State, key, tx| {
        if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
            return false;
        }
        if !tx.key_repeat() {
            enter(s, tx);
        }
        true
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
pub(crate) fn reader(s: &State) -> El {
    layout::with_source_palette(|| reader_content(s))
}

pub(crate) fn in_shell(s: &State) -> El {
    let scope = s.input_scope.clone();
    reader(s)
        .remaining()
        .on_layout_tx(move |s: &mut State, [_, _, width, _], tx| {
            if s.current_scope(&scope)
                && width.is_finite()
                && width > 0.0
                && let Some(files) = &mut s.files
                && files.reader_width != Some(width)
            {
                files.reader_width = Some(width);
                tx.instant();
            }
        })
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
    let view_width = ui.reader_width.or_else(|| {
        ui.host_width.map(|width| {
            if !ui.shell_managed && drawer.pinned {
                width - drawer.width
            } else {
                width
            }
        })
    });
    let mut actions = vec![reader_action(
        s,
        "file-refresh",
        t("instanceShell.rightPanel.actions.refresh"),
        ui.reader.busy() || ui.document.pending(),
        |ui, _| ui.refresh_document(ui.document.scope()),
    )];
    let mut content_view = rune::el();
    let kind = ui.document_kind();
    if let Some(kind) = kind {
        content_view = match kind {
            Kind::Binary => git_panel::note(t("filesPanel.binary"), "status"),
            Kind::Image => match ui.presentation.image.as_ref() {
                Some(image) if image.error().is_some() => {
                    git_panel::note(t("filesPanel.binary"), "status")
                }
                Some(image) if image.is_ready() => theme::image(image, &target.path),
                _ => git_panel::note(t("instanceInfo.loading"), "status"),
            },
            Kind::Text(format) => {
                let text = ui.document.edit().text.as_str();
                if format != Format::Source {
                    actions.push(reader_action(
                        s,
                        "file-source-toggle",
                        t(if !ui.presentation.source {
                            "instanceShell.filesShell.showSource"
                        } else if format == Format::Mermaid {
                            "markdown.mermaid.preview"
                        } else {
                            "instanceShell.filesShell.previewMarkdown"
                        }),
                        false,
                        |ui, tx| {
                            ui.presentation.source = !ui.presentation.source;
                            if ui.presentation.source {
                                ui.pictures.suspend();
                            } else {
                                tx.scroll_to_y(
                                    "file-rendered-scroll",
                                    ui.presentation.rendered_scroll.get(),
                                );
                            }
                        },
                    ));
                }
                let source = ui.presentation.source || format == Format::Source;
                if source {
                    let wrap = crate::workspace::file_wrap(s);
                    let field = editor::source(s, ui, &target.path, view_width, &mut actions);
                    actions.push(
                        theme::wrap_button(
                            dark,
                            t(if wrap {
                                "instanceShell.filesShell.disableWordWrap"
                            } else {
                                "instanceShell.filesShell.enableWordWrap"
                            }),
                            wrap,
                            document_state_action_tx(s, |s, _| {
                                crate::workspace::toggle_file_wrap(s)
                            }),
                        )
                        .key("file-wrap"),
                    );
                    field.unwrap_or_else(|| {
                        theme::source_view(
                            dark,
                            theme::source(
                                dark,
                                &target.path,
                                text,
                                wrap,
                                view_width.map(|width| theme::source_width(dark, width)),
                            ),
                            wrap,
                        )
                    })
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
                            let unwrapped = ui.presentation.unwrapped_blocks.clone();
                            let input_scope = s.input_scope.clone();
                            let revision = ui.document.revision();
                            let pictures = ui.pictures.shown.clone();
                            rune::col()
                                .full_width()
                                .pad(Space::Lg)
                                .child(theme::markdown(
                                    dark,
                                    text,
                                    t("markdown.mermaid.diagram"),
                                    document_link(s),
                                    move |index, _| !unwrapped.contains(&index),
                                    move |code| {
                                        code_controls(dark, &input_scope, scope, revision, code)
                                    },
                                    move |source| pictures.get(source).cloned(),
                                ))
                        },
                    )
                    .key("file-rendered-scroll")
                    .on_layout_tx({
                        let arm = document_action_tx(s, |ui, tx| {
                            if !ui.presentation.source {
                                ui.document.restore_source_scroll();
                            }
                            tx.live_only();
                        });
                        move |s, _, tx| arm(s, tx)
                    })
                    .on_scroll_offset({
                        let offset = ui.presentation.rendered_scroll.clone();
                        move |scroll| offset.set(scroll.offset[1] as f32)
                    })
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
    let close = std::rc::Rc::new(document_state_action_tx(s, |s, tx| {
        if let Some(ui) = &mut s.files {
            ui.close_reader();
            crate::chat::reading::restore_position(s, tx);
        }
    }));
    let close_press = close.clone();
    actions.push(
        activate_enter(
            git_panel::toolbar_icon_button(
                &git_panel::CLOSE,
                t("gitPanel.backChat"),
                false,
                None,
                move |s, tx| close_press(s, tx),
            ),
            move |s, tx| close(s, tx),
        )
        .key("file-close"),
    );
    let read_only = !matches!(kind, Some(Kind::Text(_))) || !ui.document.editable();
    let status = match (ui.document.dirty(), read_only) {
        (true, true) => Some(format!(
            "{} · {}",
            t("settings.configFiles.state.unsaved"),
            t("filesPanel.readOnly")
        )),
        (true, false) => Some(t("settings.configFiles.state.unsaved").into()),
        (false, true) => Some(t("filesPanel.readOnly").into()),
        (false, false) => None,
    };
    let error = if ui.document.project_error() {
        Some(t("directoryBrowser.load.errorFallback").into())
    } else {
        match ui.document.error() {
            Some(conflict @ super::document::store::Error::Conflict(_)) => {
                Some(super::errors::format_save_error(&conflict))
            }
            save_error => ui
                .reader
                .error()
                .map(super::errors::format_preview_error)
                .or_else(|| save_error.map(|error| super::errors::format_save_error(&error))),
        }
    };
    theme::surface(dark)
        .key(format!("file-reader-{scope}"))
        .role("region")
        .label(t("filesPanel.viewer"))
        .child(theme::header(
            &target.path,
            &target.directory,
            status.as_deref(),
            actions,
        ))
        .children(error.map(|message| {
            rune::col()
                .full_width()
                .child(git_panel::note(message, "alert"))
                .child(layout::action_row().pad(Space::Md).child(reader_action(
                    s,
                    "file-error-refresh",
                    t("instanceShell.rightPanel.actions.refresh"),
                    ui.reader.busy() || ui.document.pending(),
                    |ui, _| ui.refresh_document(ui.document.scope()),
                )))
        }))
        .children(
            ui.document
                .not_retained()
                .then(|| git_panel::note(t("filesPanel.draftLimit"), "alert")),
        )
        .children(
            (ui.reader.busy() && ui.reader.preview().is_none())
                .then(|| git_panel::note(t("instanceInfo.loading"), "status")),
        )
        .child(content_view.remaining())
        .children(editor::decision(s, ui))
}

fn code_controls(
    dark: bool,
    input_scope: &std::rc::Rc<()>,
    scope: u64,
    revision: u64,
    code: &theme::CodeFrame<'_>,
) -> El {
    let index = code.index;
    let wrap = theme::wrap_button(
        dark,
        t(if code.wrapped {
            "markdown.codeBlock.wrap.disable"
        } else {
            "markdown.codeBlock.wrap.enable"
        }),
        code.wrapped,
        screen::action_tx(input_scope, move |s, _| {
            if let Some(ui) = current_markdown(s, scope, revision) {
                let overrides = &mut ui.presentation.unwrapped_blocks;
                if !overrides.remove(&index) {
                    overrides.insert(index);
                }
            }
        }),
    )
    .key(format!("file-code-wrap-{index}"));
    let text = code.source.to_owned();
    let copy = theme::code_copy(
        dark,
        t("markdown.codeBlock.copy.label"),
        screen::action_tx(input_scope, move |s, tx| {
            if current_markdown(s, scope, revision).is_some() {
                crate::chat::tools::children::note_clipboard_write();
                tx.copy(text.clone());
            }
        }),
    )
    .key(format!("file-code-copy-{index}"));
    theme::code_header(dark, code.language.unwrap_or_default(), wrap, copy)
}
fn current_markdown(s: &mut State, scope: u64, revision: u64) -> Option<&mut super::Ui> {
    s.files.as_mut().filter(|ui| {
        !ui.stopped
            && !ui.presentation.source
            && ui.presentation.kind == Some(Kind::Text(Format::Markdown))
            && ui.document.scope() == scope
            && ui.document.revision() == revision
    })
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
