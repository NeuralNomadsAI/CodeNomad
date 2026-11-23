use super::{can_send, device, picker::Item, send};
use crate::{Phase, State, platform, screen, strings::t};
use rune::{El, Key, KeyEvent, Tx, col, text};
use rune_theme_codenomad::{
    Space, attachment, kit,
    layout::{self, Layout},
};

pub fn view(s: &State, compact: bool) -> El {
    let scope = s.input_scope.clone();
    let edit_scope = scope.clone();
    let stop = s.phase == Phase::Streaming && s.agent.is_some();
    #[cfg(target_arch = "wasm32")]
    let editor = layout::composer_field(&s.draft, t("promptInput.placeholder.default"), compact)
        .label(t("rune.prompt"))
        .disabled(s.composer.pending())
        .on_edit(screen::edit(&scope, screen::Editor::Composer))
        .on_change(screen::action_tx(&scope, changed))
        .on_key(move |s: &mut State, event, tx| s.current_scope(&edit_scope) && key(s, event, tx))
        .build(rune_theme_codenomad::field_kit(layout::dark()))
        .key("composer");
    #[cfg(not(target_arch = "wasm32"))]
    let editor = {
        let paste_scope = scope.clone();
        let menu_scope = scope.clone();
        let drop_scope = scope.clone();
        let input = layout::native_composer_input(&s.draft, t("promptInput.placeholder.default"))
            .key("input")
            .label(t("rune.prompt"))
            .disabled(s.composer.pending())
            .on_edit(screen::edit(&scope, screen::Editor::Composer))
            .on_input_change(screen::action_tx(&scope, changed))
            .on_input_key(move |s: &mut State, event, tx| {
                s.current_scope(&edit_scope) && key(s, event, tx)
            })
            .on_physical_input(move |s: &mut State, event, tx| {
                s.current_scope(&paste_scope) && super::clipboard::physical(s, event, tx)
            })
            .on_input_paste(|_: &mut State, content, _| {
                // File/image reads must enter through the owned gesture, never by focus at delivery.
                !content.files().is_empty() || content.image().is_some()
            })
            .on_secondary_press(move |s: &mut State, point, tx| {
                if s.current_scope(&menu_scope) {
                    super::clipboard::menu(s, (point.x, point.y), tx);
                }
            })
            .on_drop_files(move |s: &mut State, paths, _| {
                if s.current_scope(&drop_scope) {
                    platform::device_picker::drop_files(s, paths);
                }
            });
        layout::native_composer_field(input, compact).key("composer")
    };
    let mut actions = layout::action_row()
        .children(
            (s.can_older || s.history_error && s.phase != Phase::Failed).then(|| {
                rune_theme_codenomad::shell::older_button(
                    t(if s.paging {
                        "rune.loading"
                    } else if s.history_error {
                        "sessionList.loadError.retry"
                    } else {
                        "rune.older"
                    }),
                    s.paging || matches!(s.phase, Phase::Reconnecting | Phase::Failed),
                    screen::action_tx(&scope, crate::request_older),
                )
            }),
        )
        .child(crate::components::button_tx(
            "latest",
            t("rune.latest"),
            false,
            screen::action_tx(&scope, crate::latest),
        ))
        .child(
            layout::button_tx(
                t("promptInput.overlay.send"),
                !can_send(s),
                screen::action_tx(&scope, |s, tx| send(s, tx, false)),
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
        .child(col().content_direction().child(editor));
    if !s.composer.draft.attachments.is_empty() {
        let mut chips = layout::action_row().key("composer-attachments");
        for (index, item) in s.composer.draft.attachments.iter().enumerate() {
            use super::draft::Attachment;
            use rune_theme_codenomad::workspace_tree::icons;
            let (label, glyph) = match item {
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
                t("attachmentChip.removeAriaLabel"),
                false,
                screen::action_tx(&scope, move |s, tx| {
                    if s.composer.draft.attachments.get(index) == Some(&captured) {
                        s.composer.draft.remove(&mut s.draft, index);
                        changed(s, tx);
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
    if !s.composer.picker.attachments_supported() {
        actions = actions.child(
            layout::button(
                t("promptInput.attachFiles.ariaLabel"),
                true,
                |_: &mut State| {},
            )
            .key("attachments-disabled")
            .description_static(t("rune.attachments_unavailable")),
        );
    } else {
        actions = actions.child(
            layout::button_tx(
                t("promptInput.attachFiles.ariaLabel"),
                !device::available(s) || s.composer.device.busy(),
                screen::action_tx(&scope, platform::device_picker::choose),
            )
            .key("attach-device-files"),
        );
    }
    if s.composer.attachments_missing {
        actions = actions.child(
            layout::button_tx(
                t("rune.attachments_keep_text"),
                false,
                screen::action_tx(&scope, |s, tx| {
                    s.composer.attachments_missing = false;
                    s.composer.draft.attachments.clear();
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
            (s.composer.unconfirmed_id().is_some() || s.composer.command_unconfirmed.is_some())
                .then(|| text(t("missionsPanel.action.requestUpdateUncertain")).role("alert")),
        )
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
    .build(kit(layout::dark()), layer);
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
    if adds_part && s.composer.draft.attachments.len() >= super::draft::MAX_PARTS {
        layout::announce_selection(tx, t("promptInput.attachFiles.errorTitle"));
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
            layout::announce_selection(tx, t("promptInput.attachFiles.errorTitle"));
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
    if event.key == Key::Enter && event.mods == rune::Mods::default() {
        send(s, tx, false);
        true
    } else if event.key == Key::Enter
        && (!cfg!(target_os = "macos")
            && event.mods.alt
            && !event.mods.ctrl
            && !event.mods.cmd
            && !event.mods.logo
            || event.mods.shift && event.mods.cmd && !event.mods.alt)
    {
        send(s, tx, true);
        true
    } else {
        false
    }
}
