use super::{Preferences, Window, layout, t, text};
use crate::settings::shortcuts::{FILE_SAVE, binding_label, conflict_label, record};
use rune::{El, Key};
use serde_json::{Value, json};

pub(super) const EDIT: &str = "settings-file-save-edit";

pub(super) fn view(window: &Window, prefs: &Preferences) -> El {
    let overrides = prefs.shortcut(FILE_SAVE);
    let binding = binding_label(overrides);
    let disabled = !prefs.can_retry()
        || prefs.saved(super::Owner::Config).is_none()
        || prefs.file_save_pending();
    let recording = window.recording_shortcut && !disabled;
    let edit = layout::button(
        t(if recording {
            "hotkeys.capture"
        } else {
            "hotkeys.edit"
        }),
        disabled,
        |s: &mut Window| s.recording_shortcut = !s.recording_shortcut,
    )
    .key(EDIT)
    .on_key(move |s: &mut Window, event, tx| {
        if !recording || tx.focused() != Some(EDIT) {
            return false;
        }
        if tx.key_repeat() {
            return true;
        }
        if event.key == Key::Escape {
            s.recording_shortcut = false;
        } else if event.key == Key::Tab && !event.mods.ctrl && !event.mods.alt && !event.mods.logo {
            s.recording_shortcut = false;
            return false;
        } else if let Some(binding) = record(event, tx) {
            s.recording_shortcut = false;
            s.shared.borrow_mut().stage_file_save(binding);
        }
        true
    });
    let controls = layout::action_row()
        .child(text(t("hotkeys.action.file-save")))
        .child(text(if binding.is_empty() {
            t("hotkeys.empty")
        } else {
            &binding
        }))
        .child(edit)
        .child(layout::button(
            t("hotkeys.clear"),
            disabled || binding.is_empty(),
            |s: &mut Window| {
                s.recording_shortcut = false;
                s.shared.borrow_mut().stage_file_save(json!([]));
            },
        ))
        .child(layout::button(
            t("hotkeys.reset"),
            disabled || overrides.is_none(),
            |s: &mut Window| {
                s.recording_shortcut = false;
                s.shared.borrow_mut().stage_file_save(Value::Null);
            },
        ));
    let conflicts = conflict_label(prefs);
    if conflicts.is_empty() {
        controls
    } else {
        rune::col().child(controls).child(
            text(
                t("hotkeys.conflict")
                    .replace("{shortcut}", &binding)
                    .replace(
                        "{actions}",
                        &conflicts.into_iter().map(t).collect::<Vec<_>>().join(", "),
                    ),
            )
            .role("status"),
        )
    }
}
