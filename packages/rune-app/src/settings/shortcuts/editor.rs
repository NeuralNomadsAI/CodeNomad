use super::{Preferences, catalog, record, reserved};
use crate::strings::t;
use rune::{El, Key, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
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
        .child(chrome::input_action_row(
            layout::hinted_field(filter, t("hotkeys.filter"))
                .label(t("hotkeys.filter"))
                .input_mode(rune::InputMode::Search)
                .on_edit(filter_edit)
                .build(&field_kit(layout::dark()))
                .on_input_change(move |s: &mut S, _| {
                    if let Some((recording, capture)) = access(s) {
                        *recording = false;
                        capture.refused = false;
                    }
                })
                .key("hotkey-filter"),
            layout::button(t("hotkeys.resetAll"), locked, move |s: &mut S| {
                if let Some((recording, capture)) = access(s) {
                    *recording = false;
                    capture.refused = false;
                    reset.borrow_mut().reset_shortcuts();
                }
            })
            .key("hotkey-reset-all"),
        ))
        .children(
            prefs
                .shortcut_failed(None)
                .then(|| chrome::palette::save_error(t("hotkeys.saveFailed"))),
        )
        .children(prefs.shortcuts_failed().then(|| {
            layout::action_row().child(layout::button(
                t("sessionList.loadError.retry"),
                locked,
                move |_: &mut S| retry.borrow_mut().retry_shortcuts(),
            ))
        }));
    if rows.is_empty() {
        view = view.child(
            text(t("hotkeys.noResults"))
                .text_role(TextRole::Small)
                .role("status"),
        );
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
    let row_composer_scope = row.scope == "composer";
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
        } else if reserved::blocks_recording(event, tx.key_base(), row_composer_scope) {
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
    let mut extra: Vec<El> = warnings
        .iter()
        .map(|message| {
            text(message)
                .text_role(TextRole::Small)
                .role("status")
                .wrap()
        })
        .collect();
    if editing && refused {
        extra.push(chrome::palette::save_error(t("hotkeys.reserved")));
    }
    if failed {
        extra.push(chrome::palette::save_error(t("hotkeys.saveFailed")));
    }
    let actions = if row.active {
        vec![
            edit,
            layout::button(
                t("hotkeys.reset"),
                disabled || !row.overridden,
                mutate(Value::Null),
            ),
        ]
    } else {
        Vec::new()
    };
    let (description, help) = if !row.active {
        let why = t("hotkeys.unavailable");
        let description = if warnings.is_empty() {
            why.to_owned()
        } else {
            format!("{why} · {}", warnings.join(" · "))
        };
        (Some(description), Some(why))
    } else if !warnings.is_empty() {
        (Some(warnings.join(" · ")), None)
    } else {
        (None, None)
    };
    chrome::shortcut_row(
        format!("shortcut-{id}"),
        &row.label,
        &row.binding,
        t("hotkeys.empty"),
        t("hotkeys.clear"),
        !row.active || disabled || row.binding.is_empty(),
        mutate(json!([])),
        actions,
        extra,
        description,
        help,
    )
}

fn conflict(key: &str, names: &str) -> String {
    t("hotkeys.conflict")
        .replace("{shortcut}", key)
        .replace("{actions}", names)
}

#[cfg(test)]
#[test]
fn shortcuts_toolbar_expands_filter_beside_reset_in_both_themes() {
    struct Harness {
        dark: bool,
        shared: Rc<RefCell<Preferences>>,
        filter: TextEdit,
        recording: bool,
        capture: Capture,
    }
    for dark in [false, true] {
        let shared = Rc::new(RefCell::new(Preferences::default()));
        {
            let mut prefs = shared.borrow_mut();
            prefs.fixture();
            prefs.fixture_locale("en");
        }
        let mut rt = rune::Runtime::new(
            Harness {
                dark,
                shared,
                filter: TextEdit::default(),
                recording: false,
                capture: Capture::default(),
            },
            |s, cx| {
                rune_theme_codenomad::settings::render(cx, s.dark, None, |_| {
                    crate::strings::with_locale("en", || {
                        view(
                            &s.shared,
                            &s.filter,
                            |s: &mut Harness| &mut s.filter,
                            s.recording,
                            &s.capture,
                            |s: &mut Harness| Some((&mut s.recording, &mut s.capture)),
                        )
                    })
                })
            },
            (720.0, 640.0),
            rune::Env::new(dark, 1.0),
        );
        rt.frame(0.02);
        let filter_rect = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some("hotkey-filter"))
            .expect("hotkey filter present")
            .rect;
        let reset_rect = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some("hotkey-reset-all"))
            .expect("reset all button present")
            .rect;
        assert!(
            filter_rect[2] > 300.0,
            "dark={dark}: expected filter to expand across toolbar, got width={}",
            filter_rect[2]
        );
        assert!(
            filter_rect[0] + filter_rect[2] <= reset_rect[0] + 1.0,
            "dark={dark}: expected filter ({filter_rect:?}) left of reset ({reset_rect:?})"
        );
        assert!(
            (filter_rect[1] - reset_rect[1]).abs() < 12.0,
            "dark={dark}: expected filter and reset on one toolbar row"
        );
    }
}
