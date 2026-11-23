use super::{Preferences, Window, layout, t, text};
use crate::settings::shortcuts::{ACTIONS, FILE_SAVE, conflict_label, label_for, record};
use rune::{El, Key};
use serde_json::{Value, json};

pub(super) fn view(window: &Window, prefs: &Preferences) -> El {
    rune::col().children(ACTIONS.map(|(id, default, label)| row(window, prefs, id, default, label)))
}

fn row(
    window: &Window,
    prefs: &Preferences,
    id: &'static str,
    default: char,
    label: &'static str,
) -> El {
    let edit_key = match id {
        FILE_SAVE => "settings-file-save-edit",
        "new-instance" => "settings-new-instance-edit",
        _ => "settings-close-instance-edit",
    };
    let overrides = prefs.shortcut(id);
    let binding = label_for(overrides, default);
    let disabled = !prefs.can_retry()
        || prefs.saved(super::Owner::Config).is_none()
        || prefs.shortcut_pending(id);
    let recording =
        window.recording_shortcut && window.recording_target == Some(edit_key) && !disabled;
    let edit = layout::button(
        t(if recording {
            "hotkeys.capture"
        } else {
            "hotkeys.edit"
        }),
        disabled,
        move |s: &mut Window| {
            s.recording_shortcut = !s.recording_shortcut || s.recording_target != Some(edit_key);
            s.recording_target = Some(edit_key);
        },
    )
    .key(edit_key)
    .on_key(move |s: &mut Window, event, tx| {
        if !s.recording_shortcut
            || s.recording_target != Some(edit_key)
            || tx.focused() != Some(edit_key)
        {
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
            s.shared.borrow_mut().stage_shortcut(id, binding);
        }
        true
    });
    let controls = layout::action_row()
        .child(text(t(label)))
        .child(text(if binding.is_empty() {
            t("hotkeys.empty")
        } else {
            &binding
        }))
        .child(edit)
        .child(layout::button(
            t("hotkeys.clear"),
            disabled || binding.is_empty(),
            move |s: &mut Window| {
                s.recording_shortcut = false;
                s.shared.borrow_mut().stage_shortcut(id, json!([]));
            },
        ))
        .child(layout::button(
            t("hotkeys.reset"),
            disabled || overrides.is_none(),
            move |s: &mut Window| {
                s.recording_shortcut = false;
                s.shared.borrow_mut().stage_shortcut(id, Value::Null);
            },
        ));
    let conflicts = conflict_label(prefs, id, default);
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
