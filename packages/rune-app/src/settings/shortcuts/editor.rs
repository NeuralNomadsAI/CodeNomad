use super::{FILE_SAVE, Preferences, catalog, record};
use crate::strings::t;
use rune::{El, Key, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

type Access<S> = fn(&mut S) -> Option<(&mut bool, &mut Option<&'static str>)>;

pub(in crate::settings) fn view<S: 'static>(
    shared: &Rc<RefCell<Preferences>>,
    filter: &TextEdit,
    filter_edit: fn(&mut S) -> &mut TextEdit,
    recording: Option<&str>,
    access: Access<S>,
) -> El {
    let prefs = shared.borrow();
    let locked = !prefs.can_retry()
        || prefs
            .saved(super::super::preferences::Owner::Config)
            .is_none()
        || prefs.shortcuts_pending();
    let row_locked = locked || prefs.resetting_shortcuts();
    let mut rows = catalog::rows(&prefs, &filter.text);
    rows.sort_by_key(|row| !row.active);
    let reset = shared.clone();
    let mut view = col()
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::action_row()
                .child(
                    layout::hinted_field(filter, t("hotkeys.filter"))
                        .label(t("hotkeys.filter"))
                        .on_edit(filter_edit)
                        .build(field_kit(layout::dark()))
                        .key("hotkey-filter"),
                )
                .child(layout::button(
                    t("hotkeys.resetAll"),
                    locked,
                    move |s: &mut S| {
                        if let Some((recording, _)) = access(s) {
                            *recording = false;
                            reset.borrow_mut().reset_shortcuts();
                        }
                    },
                )),
        )
        .children(
            prefs
                .shortcuts_failed()
                .then(|| text(t("hotkeys.saveFailed")).role("alert")),
        );
    if rows.is_empty() {
        view = view.child(text(t("hotkeys.noResults")));
    }
    view.children(
        rows.into_iter()
            .map(|row| row_view(row, shared, recording, row_locked, access)),
    )
}

fn row_view<S: 'static>(
    row: catalog::Row,
    shared: &Rc<RefCell<Preferences>>,
    recording: Option<&str>,
    locked: bool,
    access: Access<S>,
) -> El {
    let id = row.id;
    let edit_key = match id {
        FILE_SAVE => "settings-file-save-edit",
        "new-instance" => "settings-new-instance-edit",
        "close-instance" => "settings-close-instance-edit",
        _ => "settings-unavailable-shortcut",
    };
    let disabled = locked || !row.active;
    let editing = recording == Some(edit_key) && !disabled;
    let prefs = shared.clone();
    let edit = layout::button_tx(
        t(if editing {
            "hotkeys.capture"
        } else {
            "hotkeys.edit"
        }),
        disabled,
        move |s: &mut S, tx| {
            if let Some((recording, target)) = access(s) {
                *recording = !*recording || *target != Some(edit_key);
                *target = Some(edit_key);
                if *recording {
                    tx.focus(edit_key, true);
                }
            }
        },
    )
    .key(edit_key)
    .on_key(move |s: &mut S, event, tx| {
        let Some((recording, target)) = access(s) else {
            return false;
        };
        if disabled || !*recording || *target != Some(edit_key) || tx.focused() != Some(edit_key) {
            return false;
        }
        if tx.key_repeat() {
            return true;
        }
        if event.key == Key::Escape {
            *recording = false;
        } else if event.key == Key::Tab
            && !event.mods.ctrl
            && !event.mods.alt
            && !event.mods.logo
            && !event.mods.cmd
        {
            *recording = false;
            return false;
        } else if let Some(binding) = record(event, tx) {
            *recording = false;
            prefs.borrow_mut().stage_shortcut(id, binding);
        }
        true
    });
    let mutate = |value: Value| {
        let prefs = shared.clone();
        move |s: &mut S| {
            if let Some((recording, _)) = access(s) {
                *recording = false;
                prefs.borrow_mut().stage_shortcut(id, value.clone());
            }
        }
    };
    let mut group = col()
        .full_width()
        .role("group")
        .label(&row.label)
        .key(format!("shortcut-{id}"))
        .child(text(&row.label).wrap())
        .child(
            layout::action_row()
                .child(text(if row.binding.is_empty() {
                    t("hotkeys.empty")
                } else {
                    &row.binding
                }))
                .children(
                    row.active
                        .then(|| {
                            [
                                edit,
                                layout::button(
                                    t("hotkeys.clear"),
                                    disabled || row.binding.is_empty(),
                                    mutate(json!([])),
                                ),
                                layout::button(
                                    t("hotkeys.reset"),
                                    disabled || !row.overridden,
                                    mutate(Value::Null),
                                ),
                            ]
                        })
                        .into_iter()
                        .flatten(),
                ),
        )
        .children(row.conflicts.into_iter().map(|(binding, others)| {
            text(
                t("hotkeys.conflict")
                    .replace("{shortcut}", &binding)
                    .replace("{actions}", &others),
            )
            .role("status")
            .wrap()
        }));
    if !row.active {
        let why = t("hotkeys.unavailable");
        group = group.help(why).description(why);
    }
    chrome::card(group)
}
