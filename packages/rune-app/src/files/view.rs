use super::{document::Format, presentation::Kind};
use crate::{
    State, components::button_tx, screen, strings::t, window_control::scoped_close_button,
};
use rune::{El, text};
use rune_theme_codenomad::{
    Space, document_reader as theme,
    layout::{self, Layout},
};

mod actions;
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
    let scope = s.files.as_ref().map(|ui| ui.document.scope());
    screen::action_tx(&s.input_scope, move |s, tx| {
        if let Some(ui) = &mut s.files {
            if scope == Some(ui.document.scope()) {
                run(ui, tx);
            }
        }
    })
}
fn reader_action(
    s: &State,
    key: &str,
    label: &str,
    disabled: bool,
    run: fn(&mut super::Ui, &mut rune::Tx),
) -> El {
    let control = button_tx(key, label, disabled, document_action_tx(s, run));
    if disabled {
        return control;
    }
    activate_enter(control, document_action_tx(s, run))
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
pub fn body(s: &State, history: El, expanded: bool) -> El {
    let Some(ui) = &s.files else {
        return history;
    };
    let main = theme::pages(history, super::has_preview(s).then(|| reader(s)));
    let drawer = ui.drawer();
    theme::split(
        main,
        (!ui.shell_managed && drawer.pinned).then(|| tree(s, drawer.width, false)),
        drawer.width,
        expanded,
    )
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
        if !ui.shell_managed && drawer.pinned {
            width - drawer.width
        } else {
            width
        }
    });
    let mut actions = vec![reader_action(
        s,
        "file-refresh",
        t("instanceShell.rightPanel.actions.refresh"),
        ui.reader.busy() || ui.document.pending() || ui.document.dirty(),
        |ui, _| ui.refresh_document(ui.document.scope()),
    )];
    let mut content_view = rune::el();
    if let Some(kind) = ui.presentation.kind {
        content_view = match kind {
            Kind::Binary => text(t("filesPanel.binary")).pad(Space::Md),
            Kind::Image => match ui.presentation.image.as_ref() {
                Some(image) if image.error().is_some() => {
                    text(t("filesPanel.binary")).pad(Space::Md)
                }
                Some(image) => theme::image(image, &target.path),
                None => text(t("instanceInfo.loading")).pad(Space::Md),
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
                            if !ui.presentation.source {
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
                    actions.push(
                        theme::wrap_button(
                            dark,
                            t(if ui.presentation.wrap {
                                "instanceShell.filesShell.disableWordWrap"
                            } else {
                                "instanceShell.filesShell.enableWordWrap"
                            }),
                            ui.presentation.wrap,
                            document_action_tx(s, |ui, _| {
                                ui.presentation.wrap = !ui.presentation.wrap
                            }),
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
                            let unwrapped = ui.presentation.unwrapped_blocks.clone();
                            let input_scope = s.input_scope.clone();
                            let revision = ui.document.revision();
                            rune::col().pad(Space::Lg).child(theme::markdown(
                                dark,
                                text,
                                t("markdown.mermaid.diagram"),
                                document_link(s),
                                move |index, _| !unwrapped.contains(&index),
                                move |code| {
                                    code_controls(dark, &input_scope, scope, revision, code)
                                },
                            ))
                        },
                    )
                    .key("file-rendered-scroll")
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
