use super::{Preferences, catalog, record, reserved};
use crate::strings::t;
use rune::{El, Key, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

type Access<S> = fn(&mut S) -> Option<(&mut bool, &mut Capture)>;

#[derive(Default)]
pub(in crate::settings) struct Capture {
    target: Option<String>,
    refused: bool,
    announced: Option<&'static str>,
}

impl Capture {
    pub fn target(&self, recording: bool) -> Option<&str> {
        self.target.as_deref().filter(|_| recording)
    }

    pub fn poll(&mut self, recording: &mut bool, prefs: &Preferences, tx: &mut rune::Tx) -> bool {
        let ended = *recording && tx.focused() != self.target.as_deref();
        if ended {
            *recording = false;
            self.refused = false;
        }
        if !prefs.shortcuts_pending()
            && let Some(id) = self.announced.take()
        {
            #[cfg(target_arch = "wasm32")]
            if !prefs.shortcut_failed(Some(id))
                && let Some(row) = catalog::rows(prefs, "")
                    .into_iter()
                    .find(|row| row.id == id)
                && !row.conflicts.is_empty()
            {
                let warnings: Vec<_> = row
                    .conflicts
                    .iter()
                    .map(|(key, names)| conflict(key, names))
                    .collect();
                layout::announce_polite(tx, warnings.join(" · "));
            }
            #[cfg(not(target_arch = "wasm32"))]
            let _ = id;
        }
        ended
    }
}

pub(in crate::settings) fn view<S: 'static>(
    shared: &Rc<RefCell<Preferences>>,
    filter: &TextEdit,
    filter_edit: fn(&mut S) -> &mut TextEdit,
    recording: bool,
    capture: &Capture,
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
    let retry = shared.clone();
    let mut view = col()
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::action_row()
                .child(
                    layout::hinted_field(filter, t("hotkeys.filter"))
                        .label(t("hotkeys.filter"))
                        .on_edit(filter_edit)
                        .build(&field_kit(layout::dark()))
                        .on_input_change(move |s: &mut S, _| {
                            if let Some((recording, capture)) = access(s) {
                                *recording = false;
                                capture.refused = false;
                            }
                        })
                        .key("hotkey-filter"),
                )
                .child(layout::button(
                    t("hotkeys.resetAll"),
                    locked,
                    move |s: &mut S| {
                        if let Some((recording, capture)) = access(s) {
                            *recording = false;
                            capture.refused = false;
                            reset.borrow_mut().reset_shortcuts();
                        }
                    },
                )),
        )
        .children(
            prefs
                .shortcut_failed(None)
                .then(|| text(t("hotkeys.saveFailed")).role("alert")),
        )
        .children(prefs.shortcuts_failed().then(|| {
            layout::button(
                t("sessionList.loadError.retry"),
                locked,
                move |_: &mut S| retry.borrow_mut().retry_shortcuts(),
            )
        }));
    if rows.is_empty() {
        view = view.child(text(t("hotkeys.noResults")));
    }
    view.children(rows.into_iter().map(|row| {
        let failed = prefs.shortcut_failed(Some(row.id));
        row_view(
            row,
            shared,
            capture.target(recording),
            capture.refused,
            row_locked,
            failed,
            access,
        )
    }))
}

fn row_view<S: 'static>(
    row: catalog::Row,
    shared: &Rc<RefCell<Preferences>>,
    recording: Option<&str>,
    refused: bool,
    locked: bool,
    failed: bool,
    access: Access<S>,
) -> El {
    let id = row.id;
    let edit_key = format!("settings-{id}-edit");
    let disabled = locked || !row.active;
    let editing = recording == Some(edit_key.as_str()) && !disabled;
    let prefs = shared.clone();
    let press_key = edit_key.clone();
    let key_target = edit_key.clone();
    let edit = layout::button_tx(
        t(if editing {
            "hotkeys.capture"
        } else {
            "hotkeys.edit"
        }),
        disabled,
        move |s: &mut S, tx| {
            if let Some((recording, capture)) = access(s) {
                *recording = !*recording || capture.target.as_deref() != Some(press_key.as_str());
                capture.target = Some(press_key.clone());
                capture.refused = false;
                if *recording {
                    tx.focus(&press_key, true);
                }
            }
        },
    )
    .key(edit_key)
    .on_key(move |s: &mut S, event, tx| {
        let Some((recording, capture)) = access(s) else {
            return false;
        };
        if disabled
            || !*recording
            || capture.target.as_deref() != Some(key_target.as_str())
            || tx.focused() != Some(key_target.as_str())
        {
            return false;
        }
        if tx.key_repeat() {
            return true;
        }
        if event.key == Key::Escape {
            *recording = false;
            capture.refused = false;
        } else if event.key == Key::Tab
            && !event.mods.ctrl
            && !event.mods.alt
            && !event.mods.logo
            && !event.mods.cmd
        {
            *recording = false;
            capture.refused = false;
            return false;
        } else if reserved::blocks_recording(event, tx.key_base()) {
            capture.refused = true;
            #[cfg(target_arch = "wasm32")]
            layout::announce_alert(tx, t("hotkeys.reserved"));
        } else if let Some(binding) = record(event, tx) {
            *recording = false;
            capture.refused = false;
            capture.announced = Some(id);
            prefs.borrow_mut().stage_shortcut(id, binding);
        }
        true
    });
    let mutate = |value: Value| {
        let prefs = shared.clone();
        move |s: &mut S| {
            if let Some((recording, capture)) = access(s) {
                *recording = false;
                capture.refused = false;
                capture.announced = Some(id);
                prefs.borrow_mut().stage_shortcut(id, value.clone());
            }
        }
    };
    let warnings: Vec<_> = row
        .conflicts
        .iter()
        .map(|(key, names)| conflict(key, names))
        .collect();
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
        .children(
            warnings
                .iter()
                .map(|message| text(message).role("status").wrap()),
        )
        .children((editing && refused).then(|| text(t("hotkeys.reserved")).role("alert").wrap()))
        .children(failed.then(|| text(t("hotkeys.saveFailed")).role("alert").wrap()));
    if !warnings.is_empty() {
        group = group.description(warnings.join(" · "));
    }
    if !row.active {
        let why = t("hotkeys.unavailable");
        let description = if warnings.is_empty() {
            why.to_owned()
        } else {
            format!("{why} · {}", warnings.join(" · "))
        };
        group = group.help(why).description(description);
    }
    chrome::card(group)
}

fn conflict(key: &str, names: &str) -> String {
    t("hotkeys.conflict")
        .replace("{shortcut}", key)
        .replace("{actions}", names)
}
