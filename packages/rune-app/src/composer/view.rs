use super::{can_send, send};
use crate::{Phase, State, screen, strings::t};
use rune::{El, Key, KeyEvent, Tx, col, text};
use rune_theme_codenomad::{
    Space, attachment, field_kit, kit,
    layout::{self, Layout},
};

pub fn view(s: &State) -> El {
    let scope = s.input_scope.clone();
    let edit_scope = scope.clone();
    let stop = s.phase == Phase::Streaming && s.agent.is_some();
    let editor = layout::composer_field(&s.draft, t("promptInput.placeholder.default"))
        .label(t("rune.prompt"))
        .on_edit(screen::edit(&scope, screen::Editor::Composer))
        .on_change(screen::action_tx(&scope, changed))
        .on_key(move |s: &mut State, event, tx| s.current_scope(&edit_scope) && key(s, event, tx))
        .build(field_kit(layout::dark()))
        .key("composer");
    let mut actions = layout::action_row().child(
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
    body.child(actions)
        .children(
            s.composer
                .send_error
                .then(|| text(t("promptInput.send.errorTitle")).role("alert")),
        )
        .children(
            (s.composer.unconfirmed.is_some() || s.composer.command_unconfirmed)
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
        } else if picker.error {
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
        if s.current_scope(&hover_scope)
            && generation == s.composer.picker.generation
            && index < s.composer.picker.entries.len()
        {
            s.composer.picker.selected = index;
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

fn changed(s: &mut State, tx: &mut Tx) {
    s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
    crate::workspace::draft_changed(s, tx);
}

fn choose(s: &mut State, tx: &mut Tx, index: usize, tab: bool, path_only: bool) {
    if s.composer
        .picker
        .choose(&mut s.draft, &mut s.composer.draft, index, tab, path_only)
    {
        if tab && s.composer.picker.open() {
            changed(s, tx);
        } else {
            crate::workspace::draft_changed(s, tx);
        }
    }
}

fn key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
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
