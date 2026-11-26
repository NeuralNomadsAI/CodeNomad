use super::{
    TranscriptRow,
    conversation::{preset_label, row_label},
    transcript_preset::PRESETS,
};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use std::{
    cell::Cell,
    collections::BTreeMap,
    rc::{Rc, Weak},
};

const TRIGGER: &str = "transcript-filters-trigger";

mod sweep;

#[derive(Default)]
pub(super) struct Filters {
    scope: Option<Weak<()>>,
    preset_open: Cell<bool>,
    last_visible: BTreeMap<TranscriptRow, &'static str>,
    sweep: sweep::Sweep,
}

impl Filters {
    pub(super) fn is_open(&self, scope: &Rc<()>) -> bool {
        self.scope
            .as_ref()
            .is_some_and(|owner| owner.ptr_eq(&Rc::downgrade(scope)))
    }

    pub(super) fn close_preset_menu(&self) {
        self.preset_open.set(false);
    }
}

pub(crate) fn close(s: &mut State) {
    s.settings.transcript_filters = Filters::default();
}

pub(crate) fn trigger(s: &State, overlay: &mut Vec<El>, touch: bool) -> El {
    let scope = Rc::downgrade(&s.input_scope);
    let filters = &s.settings.transcript_filters;
    let open = filters.is_open(&s.input_scope);
    let label = t("transcriptFilters.title");
    if open {
        let prefs = s.settings.shared.borrow();
        let mut selects = Vec::new();
        let disabled = !prefs.transcript_ready();
        if disabled {
            filters.preset_open.set(false);
        }
        let labels = PRESETS.map(preset_label);
        let preset_open = filters.preset_open.get();
        let current = preset_label(prefs.transcript_preset_display());
        let preset = chrome::transcript_preset_picker(
            "filters-preset",
            t("settings.behavior.expansionPresets.ariaLabel"),
            &labels,
        )
        .current(Some(current))
        .disabled(disabled)
        .open(preset_open)
        .on_toggle(screen::action(&s.input_scope, move |s| {
            s.settings.transcript_filters.preset_open.set(!preset_open);
        }))
        .on_close(screen::action(&s.input_scope, |s| {
            s.settings.transcript_filters.preset_open.set(false);
        }))
        .on_choose(move |s: &mut State, label, _| {
            s.settings.transcript_filters.preset_open.set(false);
            if let Some(i) = labels.iter().position(|option| *option == label) {
                s.settings
                    .shared
                    .borrow_mut()
                    .set_transcript(None, PRESETS[i]);
            }
        });
        let key_scope = scope.clone();
        let body = col()
            .full_width()
            .pad(Space::Sm)
            .on_key(move |s: &mut State, event, tx| {
                if !key_scope.ptr_eq(&Rc::downgrade(&s.input_scope))
                    || disabled
                    || preset_open
                    || event.mods != rune::Mods::default()
                    || event.key != rune::Key::Enter
                    || tx.key_repeat()
                {
                    return false;
                }
                if tx.focused() != Some("filters-preset-trigger") {
                    return false;
                }
                s.settings.transcript_filters.preset_open.set(true);
                true
            })
            .children(prefs.transcript_error().map(|error| {
                layout::action_row()
                    .child(text(t(error)).role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        |s: &mut State| s.settings.shared.borrow_mut().retry_transcript(),
                    ))
            }))
            .child(chrome::build_picker(preset, &mut selects))
            .children(TranscriptRow::all().map(|row| {
                let title = row_label(row);
                let mode = filters
                    .sweep
                    .mode(row)
                    .unwrap_or_else(|| prefs.transcript_mode(row, true));
                let visible = mode != "hidden";
                let expanded = mode == "expanded";
                let visibility_name = if row == TranscriptRow::Groups {
                    t(if visible {
                        "transcriptFilters.toolGroups.disable"
                    } else {
                        "transcriptFilters.toolGroups.enable"
                    })
                    .to_owned()
                } else {
                    action_name(
                        if visible {
                            "transcriptFilters.hide"
                        } else {
                            "transcriptFilters.show"
                        },
                        title,
                    )
                };
                let expansion_name = action_name(
                    if expanded {
                        "transcriptFilters.collapse"
                    } else {
                        "transcriptFilters.expand"
                    },
                    title,
                );
                chrome::transcript_filter_row(
                    title,
                    (
                        &visibility_name,
                        visible,
                        screen::action_tx(&s.input_scope, move |s, _| {
                            sweep::click(s, row, false);
                        }),
                    ),
                    (
                        &expansion_name,
                        expanded,
                        screen::action_tx(&s.input_scope, move |s, _| {
                            sweep::click(s, row, true);
                        }),
                    ),
                    disabled,
                    t("commands.common.disabled"),
                    |button, expansion| {
                        if touch || disabled || expansion && !visible {
                            button
                        } else {
                            filters.sweep.control(s, row, expansion, button)
                        }
                    },
                )
                .key(format!("filters-{}", row.control_key()))
            }));
        overlay.push(chrome::transcript_popup(
            TRIGGER,
            label,
            body,
            &filters.sweep.viewport,
            |s: &mut State, _| close(s),
        ));
        overlay.extend(selects);
    }
    layout::button(
        label,
        false,
        screen::action(&s.input_scope, move |s| {
            s.settings.transcript_filters = Filters {
                scope: (!open).then(|| scope.clone()),
                ..Filters::default()
            }
        }),
    )
    .key(TRIGGER)
    .expanded(open)
}

fn action_name(key: &str, name: &str) -> String {
    catalogue::format(locale(), key, &[("name", name)])
}

#[cfg(test)]
#[test]
fn the_popup_uses_the_active_occurrence_and_dismisses_on_escape() {
    use rune::{Env, Key, KeyEvent, Runtime};
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 760.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    fn open(rt: &mut Runtime<State>) {
        let (x, y) = rt.find(TRIGGER).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert!(rt.find("transcript-filters").is_some());
        assert!(rt.find("filters-preset-trigger").is_some());
        let tree = rt.accessibility_json();
        fn find<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
            if node["key"] == key {
                return Some(node);
            }
            node["children"]
                .as_array()?
                .iter()
                .find_map(|child| find(child, key))
        }
        let preset = find(&tree, "filters-preset-trigger").unwrap();
        let expected_name =
            crate::strings::with_locale("en", || t("settings.behavior.expansionPresets.ariaLabel"));
        let expected = crate::strings::with_locale("en", || preset_label("balanced"));
        assert_eq!(preset["name"], expected_name);
        assert_eq!(preset["value"], expected);
    }
    open(&mut rt);
    let escape = KeyEvent {
        key: Key::Escape,
        mods: Default::default(),
    };
    rt.key(escape.clone());
    rt.key_up(escape);
    rt.frame(0.02);
    assert!(rt.find("transcript-filters").is_none());
    open(&mut rt);
    // Attach an enabled backend + snapshot, genuinely open the preset dropdown via click,
    // then verify a failed config read closes it and recovery keeps it closed.
    rt.update(|s, _| {
        let mut prefs = s.settings.shared.borrow_mut();
        prefs.fixture();
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:1").unwrap());
    });
    rt.frame(0.02);
    let (px, py) = rt.find("filters-preset-trigger").unwrap();
    rt.pointer_down(px, py);
    rt.pointer_up(px, py);
    rt.frame(0.02);
    assert!(
        rt.state.settings.transcript_filters.preset_open.get(),
        "clicking enabled filters-preset-trigger must open the menu"
    );
    rt.update(|s, _| {
        s.settings
            .shared
            .borrow_mut()
            .fixture_config_read_failed(true);
    });
    rt.frame(0.02);
    assert!(!rt.state.settings.transcript_filters.preset_open.get());
    rt.update(|s, _| {
        s.settings
            .shared
            .borrow_mut()
            .fixture_config_read_failed(false);
    });
    rt.frame(0.02);
    assert!(!rt.state.settings.transcript_filters.preset_open.get());
    // Pressing Enter while the preset trigger has keyboard focus opens the preset menu.
    rt.update(|_, tx| tx.focus("filters-preset-trigger", true));
    let enter = KeyEvent {
        key: Key::Enter,
        mods: Default::default(),
    };
    rt.key(enter.clone());
    rt.key_up(enter);
    rt.frame(0.02);
    assert!(
        rt.state.settings.transcript_filters.preset_open.get(),
        "pressing Enter on focused filters-preset-trigger must open the preset menu"
    );
    rt.update(|s, _| crate::chat::suspend(s));
    rt.frame(0.02);
    assert!(rt.find("transcript-filters").is_none());
}

#[cfg(test)]
#[test]
fn preset_exposes_accessible_value_and_escape_closes_list_before_popup() {
    use rune::{Env, Key, KeyEvent, Runtime};

    fn a11y_node<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if node["key"] == key {
            return Some(node);
        }
        node["children"]
            .as_array()?
            .iter()
            .find_map(|child| a11y_node(child, key))
    }

    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    {
        let mut prefs = s.settings.shared.borrow_mut();
        prefs.fixture();
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:1").unwrap());
    }
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 760.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);

    let (x, y) = rt.find(TRIGGER).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.find("transcript-filters").is_some());

    let expected_label =
        crate::strings::with_locale("en", || t("settings.behavior.expansionPresets.ariaLabel"));
    let balanced = crate::strings::with_locale("en", || preset_label("balanced"));
    let everything = crate::strings::with_locale("en", || preset_label("everything"));
    let custom = crate::strings::with_locale("en", || preset_label("custom"));

    // #1676: AccessKit and web mirror expose the clean label and current value separately.
    let assert_preset_a11y = |rt: &Runtime<State>, value: &str, open: bool| {
        let tree = rt.accessibility_json();
        let node = a11y_node(&tree, "filters-preset-trigger").expect("missing preset trigger");
        assert_eq!(node["role"], "combo-box");
        assert_eq!(node["name"], expected_label);
        assert_eq!(node["value"], value);
        let states = node["states"].to_string();
        assert!(
            states.contains(if open { "expanded" } else { "collapsed" }),
            "{states}"
        );

        let mirror: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
        let combo = mirror
            .iter()
            .find(|item| item["t"] == expected_label && item["o"] == "combobox")
            .unwrap_or_else(|| panic!("missing combobox in web mirror: {mirror:?}"));
        assert_eq!(combo["v"], value);
        assert_eq!(combo["x"], open);
    };

    assert_preset_a11y(&rt, balanced, false);

    // Open the preset dropdown list, then verify Escape closes only the list before the popup.
    let (px, py) = rt.find("filters-preset-trigger").unwrap();
    rt.pointer_down(px, py);
    rt.pointer_up(px, py);
    rt.frame(0.02);
    assert!(rt.state.settings.transcript_filters.preset_open.get());
    assert!(rt.find("filters-preset-content").is_some());
    assert_preset_a11y(&rt, balanced, true);

    let press_escape = |rt: &mut Runtime<State>| {
        let esc = KeyEvent {
            key: Key::Escape,
            mods: Default::default(),
        };
        rt.key(esc.clone());
        rt.key_up(esc);
        rt.frame(0.02);
    };

    // First Escape closes only the preset listbox and returns focus to the preset trigger.
    press_escape(&mut rt);
    assert!(!rt.state.settings.transcript_filters.preset_open.get());
    assert!(rt.find("filters-preset-content").is_none());
    assert!(
        rt.find("transcript-filters").is_some(),
        "first Escape must keep Message content popup open"
    );
    assert_preset_a11y(&rt, balanced, false);
    let after_list_esc = rt.accessibility_json();
    assert!(
        a11y_node(&after_list_esc, "filters-preset-trigger").unwrap()["states"]
            .to_string()
            .contains("focused"),
        "closing preset list with Escape must return focus to filters-preset-trigger"
    );

    // Selecting a preset updates the accessible value while keeping the popup open.
    let (px, py) = rt.find("filters-preset-trigger").unwrap();
    rt.pointer_down(px, py);
    rt.pointer_up(px, py);
    rt.frame(0.02);
    let everything_option = rt
        .elements()
        .into_iter()
        .find(|el| el.role == "option" && el.label.as_deref() == Some(everything))
        .expect("missing Everything preset option");
    let [ox, oy, ow, oh] = everything_option.rect;
    rt.pointer_down(ox + ow / 2.0, oy + oh / 2.0);
    rt.pointer_up(ox + ow / 2.0, oy + oh / 2.0);
    rt.frame(0.02);
    assert!(!rt.state.settings.transcript_filters.preset_open.get());
    assert!(rt.find("transcript-filters").is_some());
    assert_preset_a11y(&rt, everything, false);

    // A manual row change switches the accessible value to Custom without polluting the name.
    rt.update(|s, _| {
        s.settings
            .shared
            .borrow_mut()
            .set_transcript(Some(TranscriptRow::Diagnostics), "hidden");
    });
    rt.frame(0.02);
    assert_preset_a11y(&rt, custom, false);

    // Second Escape closes the Message content popup and returns focus to its trigger.
    press_escape(&mut rt);
    assert!(rt.find("transcript-filters").is_none());
    let after_popup_esc = rt.accessibility_json();
    assert!(
        a11y_node(&after_popup_esc, TRIGGER).unwrap()["states"]
            .to_string()
            .contains("focused"),
        "closing Message content popup with Escape must return focus to trigger"
    );

    // Consecutive Escapes right after keyboard-opening the preset list close the list first,
    // then the popup, returning focus at each step.
    let (x, y) = rt.find(TRIGGER).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.update(|_, tx| tx.focus("filters-preset-trigger", true));
    rt.frame(0.02);
    let enter = KeyEvent {
        key: Key::Enter,
        mods: Default::default(),
    };
    rt.key(enter.clone());
    rt.key_up(enter);
    rt.frame(0.02);
    assert!(rt.find("filters-preset-content").is_some());
    press_escape(&mut rt);
    assert!(rt.find("filters-preset-content").is_none());
    assert!(rt.find("transcript-filters").is_some());
    assert!(
        a11y_node(&rt.accessibility_json(), "filters-preset-trigger").unwrap()["states"]
            .to_string()
            .contains("focused")
    );
    press_escape(&mut rt);
    assert!(rt.find("transcript-filters").is_none());
    assert!(
        a11y_node(&rt.accessibility_json(), TRIGGER).unwrap()["states"]
            .to_string()
            .contains("focused")
    );
}
