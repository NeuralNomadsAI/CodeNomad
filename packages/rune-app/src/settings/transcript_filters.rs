use super::{
    TranscriptRow,
    conversation::{preset_label, row_label},
    preferences::Owner,
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
    collections::BTreeMap,
    rc::{Rc, Weak},
};

const TRIGGER: &str = "transcript-filters-trigger";

#[derive(Default)]
pub(super) struct Filters {
    scope: Option<Weak<()>>,
    preset_open: bool,
    last_visible: BTreeMap<TranscriptRow, &'static str>,
}

impl Filters {
    pub(super) fn is_open(&self, scope: &Rc<()>) -> bool {
        self.scope
            .as_ref()
            .is_some_and(|owner| owner.ptr_eq(&Rc::downgrade(scope)))
    }
}

pub(crate) fn close(s: &mut State) {
    s.settings.transcript_filters = Filters::default();
}

pub(crate) fn trigger(s: &State, overlay: &mut Vec<El>) -> El {
    let scope = Rc::downgrade(&s.input_scope);
    let filters = &s.settings.transcript_filters;
    let open = filters.is_open(&s.input_scope);
    let label = t("transcriptFilters.title");
    if open {
        let prefs = s.settings.shared.borrow();
        let mut selects = Vec::new();
        let disabled = prefs.saved(Owner::Config).is_none() || !prefs.can_retry();
        let labels = PRESETS.map(preset_label);
        let preset_open = filters.preset_open;
        let preset = chrome::transcript_preset_picker(
            "filters-preset",
            t("settings.behavior.expansionPresets.ariaLabel"),
            &labels,
        )
        .current(Some(preset_label(prefs.transcript_preset())))
        .disabled(disabled)
        .open(preset_open)
        .on_toggle(screen::action(&s.input_scope, move |s| {
            s.settings.transcript_filters.preset_open = !preset_open
        }))
        .on_close(screen::action(&s.input_scope, |s| {
            s.settings.transcript_filters.preset_open = false
        }))
        .on_choose(move |s: &mut State, label, _| {
            s.settings.transcript_filters.preset_open = false;
            if let Some(i) = labels.iter().position(|option| *option == label) {
                s.settings
                    .shared
                    .borrow_mut()
                    .set_transcript(None, PRESETS[i]);
            }
        });
        let body = col()
            .full_width()
            .pad(Space::Sm)
            .children(prefs.error().map(|error| {
                layout::action_row()
                    .child(text(t(error)).role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        |s: &mut State| s.settings.shared.borrow_mut().retry(),
                    ))
            }))
            .child(chrome::build_picker(preset, &mut selects))
            .children(TranscriptRow::all().map(|row| {
                let title = row_label(row);
                let mode = prefs.transcript_mode(row, true);
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
                            let last = &mut s.settings.transcript_filters.last_visible;
                            let next = if visible {
                                last.insert(row, mode);
                                "hidden"
                            } else {
                                last.get(&row).copied().unwrap_or("collapsed")
                            };
                            s.settings
                                .shared
                                .borrow_mut()
                                .set_transcript(Some(row), next);
                        }),
                    ),
                    (
                        &expansion_name,
                        expanded,
                        screen::action_tx(&s.input_scope, move |s, _| {
                            s.settings.shared.borrow_mut().set_transcript(
                                Some(row),
                                if expanded { "collapsed" } else { "expanded" },
                            );
                        }),
                    ),
                    disabled,
                )
                .key(format!("filters-{}", row.control_key()))
            }));
        overlay.push(chrome::transcript_popup(
            TRIGGER,
            label,
            body,
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
    rt.update(|s, _| crate::chat::suspend(s));
    rt.frame(0.02);
    assert!(rt.find("transcript-filters").is_none());
}
