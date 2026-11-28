use super::{can_send, picker::Item, send};
use crate::{Phase, State, platform, screen, strings::t};
use rune::{El, Key, KeyEvent, Tx, col, text};
use rune_theme_codenomad::{
    Space, attachment, kit,
    layout::{self, Layout},
};

pub fn view(
    s: &State,
    bounds: rune_theme_codenomad::interruption::SessionLayout,
    caret_pins: crate::chat::ComposerCaretPins,
    worktree: Option<El>,
    more: El,
) -> El {
    let scope = s.input_scope.clone();
    let stop = s.phase == Phase::Streaming && s.agent.is_some();
    let editor = editor(s, bounds, caret_pins);
    let retry = s.reader.as_ref().is_some_and(|reader| reader.can_retry());
    let mut actions = layout::action_row()
        .children(worktree)
        .children(
            crate::git::placement_hold(s)
                .is_some_and(|hold| hold.answered)
                .then(|| {
                    crate::components::button_tx(
                        "placement-retry",
                        t("sessionList.loadError.retry"),
                        s.screen.launcher().is_some_and(|launcher| launcher.pending),
                        screen::action_tx(&scope, |s, _| crate::launcher::placement::retry(s)),
                    )
                }),
        )
        .children(
            (s.can_older || retry || s.history_error && s.phase != Phase::Failed).then(|| {
                rune_theme_codenomad::shell::older_button(
                    t(if s.paging {
                        "rune.loading"
                    } else if s.history_error {
                        "sessionList.loadError.retry"
                    } else {
                        "rune.older"
                    }),
                    s.paging
                        || s.phase == Phase::Failed
                        || !retry && (s.phase.reconnecting() || s.stream_offline),
                    screen::action_tx(
                        &scope,
                        if retry {
                            crate::chat::reader::retry
                        } else {
                            crate::request_older
                        },
                    ),
                )
            }),
        )
        .child(more)
        .child(
            layout::button_tx(
                t("promptInput.overlay.send"),
                !can_send(s),
                screen::action_tx(&scope, super::actions::send_button),
            )
            .key("send"),
        );
    if stop {
        actions = actions.child(
            layout::button(
                t("promptInput.stopSession.ariaLabel"),
                s.agent.as_ref().is_some_and(|a| a.stopping),
                screen::action(&scope, |s| {
                    if let Some(agent) = &mut s.agent {
                        agent.stop();
                    }
                }),
            )
            .key("composer-stop"),
        );
    }
    let mut body = col()
        .key("session-composer")
        .role("group")
        .label(t("rune.prompt"))
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .children(crate::shell::status_permissions::confirmation(s))
        .child(col().content_direction().child(editor));
    let pasted = std::cell::OnceCell::new();
    let mut attachments = s
        .composer
        .draft
        .attachments
        .iter()
        .enumerate()
        .filter(|(_, part)| {
            let super::draft::Attachment::Pasted { id, .. } = part else {
                return true;
            };
            pasted
                .get_or_init(|| {
                    super::long_paste::active_tokens(&s.draft)
                        .map(|(_, id)| id)
                        .collect::<std::collections::BTreeSet<_>>()
                })
                .contains(id)
        })
        .peekable();
    if attachments.peek().is_some() {
        let mut chips = layout::action_row().key("composer-attachments");
        for (index, item) in attachments {
            use super::draft::Attachment;
            use rune_theme_codenomad::workspace_tree::icons;
            let (label, glyph) = match item {
                Attachment::Pasted { id, .. } => (
                    format!("{} #{id}", t("messagePart.pastedText.summary")),
                    Some(&icons::FILE_TEXT),
                ),
                Attachment::Agent(name) => (format!("@{name}"), None),
                Attachment::Skill { name, .. } => (name.clone(), None),
                Attachment::Project {
                    name, directory, ..
                } => (
                    name.clone(),
                    Some(if *directory {
                        &icons::FOLDER
                    } else {
                        &icons::FILE
                    }),
                ),
                Attachment::Path(path) => (path.clone(), Some(&icons::FILE_TEXT)),
                Attachment::Device { name, token, .. } => {
                    (token.as_ref().unwrap_or(name).clone(), Some(&icons::FILE))
                }
            };
            let captured = item.clone();
            let remove = layout::button_tx(
                t("sessionView.attachments.removeAriaLabel"),
                false,
                screen::action_tx(&scope, move |s, tx| {
                    if s.composer.draft.attachments.get(index) == Some(&captured) {
                        s.composer.draft.remove(&mut s.draft, index);
                        changed(s, tx);
                        tx.focus("composer", false);
                    }
                }),
            )
            .key(format!("remove-{index}"));
            chips = chips.child(
                attachment::chip(&label, glyph, Some(remove)).key(format!("attachment-{index}")),
            );
        }
        body = body.child(chips);
    }
    if s.composer.picker.command_unavailable(&s.draft.text) {
        actions = actions.child(
            layout::button(
                t("rune.refresh"),
                false,
                screen::action(&scope, |s| {
                    s.composer.picker.refresh_commands(&s.reads, &s.wake);
                }),
            )
            .key("refresh-command-catalogue"),
        );
    }
    if s.composer.attachments_missing {
        actions = actions.child(
            layout::button_tx(
                t("rune.attachments_keep_text"),
                false,
                screen::action_tx(&scope, |s, tx| {
                    s.composer.attachments_missing = false;
                    s.composer
                        .draft
                        .attachments
                        .retain(|part| matches!(part, super::draft::Attachment::Pasted { .. }));
                    crate::workspace::draft_changed(s, tx);
                }),
            )
            .key("keep-draft-text")
            .description_static(t("rune.attachments_missing")),
        );
    }
    body.child(actions)
        .children(
            s.composer
                .device
                .notice
                .as_ref()
                .map(|notice| text(notice).role("alert")),
        )
        .children(
            s.composer
                .attachments_missing
                .then(|| text(t("rune.attachments_missing")).role("alert")),
        )
        .children(
            s.composer
                .send_error
                .then(|| text(t("promptInput.send.errorTitle")).role("alert")),
        )
        .children(
            (s.composer.unconfirmed_id().is_some() || super::actions::command_held(s))
                .then(|| text(t("missionsPanel.action.requestUpdateUncertain")).role("alert")),
        )
}

fn editor(
    s: &State,
    bounds: rune_theme_codenomad::interruption::SessionLayout,
    caret_pins: crate::chat::ComposerCaretPins,
) -> El {
    let locked = s.composer.editing_locked();
    #[cfg(not(target_arch = "wasm32"))]
    let input_key = "input";
    #[cfg(target_arch = "wasm32")]
    let input_key = format!("input-{}", s.web_composer_input_epoch);
    let input = layout::composer_input(&s.draft, t("promptInput.placeholder.default"))
        .key(input_key)
        .label(t("rune.prompt"));
    let scroll = s.tool_diff_preferences.composer_scroll.clone();
    if locked {
        return layout::composer_field(
            input.disabled(true),
            bounds,
            false,
            move |y, max| {
                scroll.set((y, max));
            },
            None,
            None,
        )
        .key("composer");
    }
    let scope = s.input_scope.clone();
    let key_scope = scope.clone();
    let paste_scope = scope.clone();
    let input = input
        .on_edit(screen::edit(&scope, screen::Editor::Composer))
        .on_input_change(screen::action_tx(&scope, changed))
        .on_input_key(move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && key(s, event, tx)
        })
        .on_input_paste(move |s: &mut State, content, tx| {
            if !s.current_scope(&paste_scope) || s.composer.editing_locked() {
                return true;
            }
            #[cfg(target_arch = "wasm32")]
            if platform::device_picker::paste(s, content) {
                return true;
            }
            #[cfg(not(target_arch = "wasm32"))]
            if !content.files().is_empty() || content.image().is_some() && content.text().is_empty()
            {
                return true;
            }
            super::long_paste::paste(s, content.text(), tx)
        });
    #[cfg(not(target_arch = "wasm32"))]
    let input = {
        let physical_scope = scope.clone();
        let menu_scope = scope.clone();
        let menu_look = layout::popup_menu_look();
        input
            .on_physical_input(move |s: &mut State, event, tx| {
                s.current_scope(&physical_scope) && super::clipboard::physical(s, event, tx)
            })
            .on_secondary_press(move |s: &mut State, point, tx| {
                if s.current_scope(&menu_scope) {
                    super::clipboard::menu(s, (point.x, point.y), menu_look.clone(), tx);
                }
            })
            .on_drop_files(move |s: &mut State, paths, _| {
                if s.current_scope(&scope) {
                    platform::device_picker::drop_files(s, paths);
                }
            })
    };
    layout::composer_field(
        input,
        bounds,
        s.draft.focused,
        move |y, max| {
            scroll.set((y, max));
        },
        caret_pins.inner,
        caret_pins.stack,
    )
    .key("composer")
    .drawn_rect_into(&s.tool_diff_preferences.composer_bounds)
    .on_layout_tx(|s: &mut State, rect, tx| {
        if !s.screen.is_launcher() {
            crate::chat::ToolDiffPreferences::composer_field_layout(s, rect, tx);
        } else {
            tx.live_only();
        }
    })
}

pub fn overlays(s: &State, layer: &mut Vec<El>) {
    let picker = &s.composer.picker;
    if !picker.open() {
        return;
    }
    let scope = s.input_scope.clone();
    let click_scope = scope.clone();
    let hover_scope = scope.clone();
    let generation = picker.generation;
    let items = picker
        .entries
        .iter()
        .map(|item| (item.label().to_owned(), item.description().to_owned()));
    layout::suggestion_list(
        "prompt-picker",
        "composer",
        t(if picker.slash() {
            "unifiedPicker.title.command"
        } else {
            "unifiedPicker.title.mention"
        }),
        t(if picker.loading() {
            "unifiedPicker.loading.searching"
        } else if picker.error() {
            "promptInput.skills.error"
        } else {
            "unifiedPicker.empty"
        }),
        picker.selected,
        items,
    )
    .on_close(screen::action(&scope, |s| {
        s.composer.picker.close(&s.draft.text)
    }))
    .on_active(move |s: &mut State, index| {
        if s.current_scope(&hover_scope) {
            s.composer.picker.activate(index, generation);
        }
    })
    .on_choose(move |s: &mut State, id, tx| {
        if s.current_scope(&click_scope)
            && generation == s.composer.picker.generation
            && let Ok(index) = id.parse()
        {
            choose(s, tx, index, false, false);
        }
    })
    .build(&kit(layout::dark()), layer);
}

pub(super) fn changed(s: &mut State, tx: &mut Tx) {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(read) = &s.composer.device.clipboard {
        read.set(false);
    }
    s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
    crate::workspace::draft_changed(s, tx);
}

fn choose(s: &mut State, tx: &mut Tx, index: usize, tab: bool, path_only: bool) {
    let adds_part = s.composer.picker.attachments_supported()
        && match s.composer.picker.entries.get(index) {
            Some(Item::File(_)) => !tab,
            Some(Item::Agent(_) | Item::Skill(_)) => true,
            _ => false,
        };
    if adds_part && s.composer.draft.active_count(&s.draft) >= super::draft::MAX_PARTS {
        layout::announce_polite(tx, t("promptInput.attachFiles.errorTitle"));
        return;
    }
    let previous = adds_part.then(|| (s.draft.clone(), s.composer.draft.clone()));
    if s.composer
        .picker
        .choose(&mut s.draft, &mut s.composer.draft, index, tab, path_only)
    {
        if let Some((edit, draft)) = previous
            && !crate::workspace::attachment_draft_admissible(s)
        {
            s.draft = edit;
            s.composer.draft = draft;
            s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
            layout::announce_polite(tx, t("promptInput.attachFiles.errorTitle"));
            return;
        }
        if tab && s.composer.picker.open() {
            changed(s, tx);
        } else {
            crate::workspace::draft_changed(s, tx);
        }
    }
}

fn key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    use super::shortcuts::Action;
    #[cfg(not(target_arch = "wasm32"))]
    if event.edit_command() == Some('v') {
        super::clipboard::request(s, tx);
        return true;
    }
    if event.key == Key::Enter && s.composer.device.busy() {
        return true;
    }
    if event.key == Key::Enter
        && tx.key_repeat()
        && (s.composer.picker.open() || s.composer.picker.selected_command(&s.draft.text).is_some())
    {
        return true;
    }
    if matches!(event.key, Key::Backspace | Key::Delete)
        && s.composer
            .draft
            .delete_mention(&mut s.draft, event.key == Key::Backspace)
    {
        changed(s, tx);
        return true;
    }
    if s.composer.picker.open() {
        if s.composer.picker.key(&s.draft.text, event, tx) {
            return true;
        }
        if matches!(event.key, Key::Enter | Key::Tab) {
            if !(event.mods.alt || event.mods.ctrl || event.mods.cmd || event.mods.logo) {
                choose(
                    s,
                    tx,
                    s.composer.picker.selected,
                    event.key == Key::Tab,
                    event.key == Key::Enter && event.mods.shift,
                );
            }
            return true;
        }
    }
    if event.mods == rune::Mods::default()
        && event.key == Key::Escape
        && s.composer.recall.is_some()
        && !s.composer.device.busy()
    {
        super::recall::restore(s);
        s.composer.picker.reset();
        return true;
    }
    for (action, older) in [(Action::PreviousPrompt, true), (Action::NextPrompt, false)] {
        if action.matches(s, event, tx) && super::recall::step(s, older, false, tx) {
            return true;
        }
    }
    if Action::Clear.matches(s, event, tx) {
        super::menu::clear(s, tx);
        true
    } else if Action::Alternate.matches(s, event, tx) {
        send(s, tx, true);
        true
    } else if event.key == Key::Enter && event.mods == rune::Mods::default() {
        send(s, tx, false);
        true
    } else {
        super::menu::jump_key(s, event, tx)
    }
}
