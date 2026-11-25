use crate::{
    State,
    components::{button, button_tx},
    launcher,
    screen::{self, Editor},
    strings::t,
    workspace,
};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, field_kit, kit,
    layout::{self, Layout, hinted_field},
    shell::{
        self,
        icons::{BACK, FORWARD, PLUS, SEARCH},
    },
};

fn session_rows(
    l: &launcher::Launcher,
    remote_search: bool,
) -> (&[crate::catalog::Session], &[crate::catalog::Session]) {
    if remote_search {
        (&l.search_results.rows, &[])
    } else {
        (&l.sessions, l.linked.rows.as_slice())
    }
}

fn session_row(
    l: &launcher::Launcher,
    remote_search: bool,
    index: usize,
) -> Option<&crate::catalog::Session> {
    let (first, linked) = session_rows(l, remote_search);
    if index < first.len() {
        first.get(index)
    } else {
        linked.get(index - first.len())
    }
}

fn visible_indices(l: &launcher::Launcher) -> (bool, Vec<usize>) {
    let searching = l.show_search && !l.search.text.trim().is_empty();
    let remote_search = cfg!(target_arch = "wasm32") && searching;
    let (first, linked) = session_rows(l, remote_search);
    let filter = if l.show_search {
        l.search.text.trim().to_lowercase()
    } else {
        String::new()
    };
    let mut seen = std::collections::HashSet::new();
    let indices = first
        .iter()
        .chain(linked)
        .enumerate()
        .filter_map(|(index, row)| {
            ((remote_search || filter.is_empty() || row.title.to_lowercase().contains(&filter))
                && seen.insert(row.id.as_str()))
            .then_some(index)
        })
        .collect();
    (remote_search, indices)
}

pub(super) fn visible_session_ids(l: &launcher::Launcher) -> Vec<String> {
    let (remote_search, indices) = visible_indices(l);
    indices
        .into_iter()
        .filter_map(|index| session_row(l, remote_search, index).map(|row| row.id.clone()))
        .collect()
}

pub fn view(s: &State, touch: bool, rtl: bool, floating: bool) -> El {
    let Some(l) = s.screen.launcher() else {
        return col();
    };
    let scope = &s.input_scope;
    let editor_keys = {
        let scope = scope.clone();
        move |s: &mut State, key: &rune::KeyEvent, tx: &mut rune::Tx| {
            s.current_scope(&scope)
                && matches!(key.key, rune::Key::Escape | rune::Key::Function(6))
                && super::panel_keys(s, key, tx)
        }
    };
    let navigation_blocked = !launcher::can_change_session(s);
    let disabled = l.pending || navigation_blocked;
    let title = t("sessionList.header.title");
    let visit = |back| {
        let (key, help) = if back {
            ("sessionList.history.back", "sessionList.history.backTitle")
        } else {
            (
                "sessionList.history.forward",
                "sessionList.history.forwardTitle",
            )
        };
        let available = !navigation_blocked && launcher::can_visit(s, back);
        let visit_scope = scope.clone();
        shell::control(if back != rtl { &BACK } else { &FORWARD }, t(key), touch)
            .help(t(help))
            .disabled(!available)
            .on_press(screen::action(scope, move |s| launcher::visit(s, back)))
            .build(&kit(layout::dark()))
            .key(key)
            .on_key(move |s: &mut State, event, tx| {
                if available && event.key == rune::Key::Enter && event.mods == rune::Mods::default()
                {
                    if !tx.key_repeat() && s.current_scope(&visit_scope) {
                        launcher::visit(s, back);
                    }
                    true
                } else {
                    false
                }
            })
    };
    let header = shell::header(
        true,
        floating,
        touch,
        [
            visit(true),
            visit(false),
            shell::spacer(),
            shell::panel_title(title).role("heading"),
            shell::spacer(),
            shell::control(&PLUS, t("sessionList.actions.newSession.ariaLabel"), touch)
                .help(crate::settings::with_shortcut_label_excluding(
                    s,
                    t("sessionList.actions.newSession.title"),
                    "session-new",
                    if crate::timeline::search::available(s) {
                        &["session-search"]
                    } else {
                        &[]
                    },
                ))
                .disabled(disabled || l.creation_uncertain || crate::git::placement_unconfirmed(s))
                .on_press_tx(screen::action_tx(scope, |s, _| {
                    launcher::create_blank(s);
                }))
                .build(&kit(layout::dark()))
                .key("session-new"),
            shell::control(&SEARCH, t("sessionList.filter.ariaLabel"), touch)
                .expanded(l.show_search)
                .on_press(screen::action(scope, |s| {
                    if let Some(l) = s.screen.launcher_mut() {
                        l.show_search = !l.show_search;
                        if !l.show_search {
                            l.search = rune::edit::TextEdit::new("");
                        }
                    }
                }))
                .build(&kit(layout::dark()))
                .key("session-search-toggle"),
        ],
    );
    let search = l.show_search.then(|| {
        let name = t("sessionList.filter.ariaLabel");
        col().full_width().role("group").label(name).child(
            hinted_field(&l.search, t("sessionList.filter.placeholder"))
                .label(name)
                .on_edit(screen::edit(scope, Editor::Search))
                .on_key(editor_keys.clone())
                .build(&field_kit(layout::dark()))
                .key("session-search"),
        )
    });
    let searching = l.show_search && !l.search.text.trim().is_empty();
    let (remote_search, filtered) = visible_indices(l);
    let filtered = std::rc::Rc::new(filtered);
    let count = filtered.len();
    let for_key = filtered.clone();
    let items = layout::transcript_rows(
        count,
        move |s: &State, i| {
            s.screen
                .launcher()
                .and_then(|l| session_row(l, remote_search, for_key[i]))
                .map_or_else(
                    || std::borrow::Cow::Owned(format!("row-{i}")),
                    |row| std::borrow::Cow::Owned(format!("session-{}", row.id)),
                )
        },
        move |s: &State, i| {
            let Some(session) = s
                .screen
                .launcher()
                .and_then(|l| session_row(l, remote_search, filtered[i]))
            else {
                return rune::el();
            };
            let title = if session.title.is_empty() {
                t("sessionList.session.untitled")
            } else {
                &session.title
            };
            let id = session.id.clone();
            shell::session_row(
                title,
                workspace::active_session(s) == Some(id.as_str()),
                disabled,
                screen::action_tx(&s.input_scope, move |s, tx| {
                    launcher::choose(s, id.clone(), tx)
                }),
            )
        },
    )
    .role("list")
    .label(title)
    .focus_group();
    let mut items = col().full_width().child(items);
    if remote_search && l.search_results.pending() {
        items = items.child(text(t("rune.loading")).role("status"));
    } else if remote_search && l.search_results.failed || !searching && l.linked.failed {
        items = items.child(text(t("rune.list_error")).role("alert"));
    } else if !searching && count == 0 && !l.pending && !l.linked.pending() {
        items = items.child(text(t("rune.empty_sessions")).pad(Space::Sm));
    }
    if !remote_search && l.next.is_some() {
        items = items.child(button(
            "more-sessions",
            t("rune.more"),
            disabled || !l.can_page(),
            screen::action(scope, |s| launcher::list(s, true)),
        ));
    }
    if let Some(error) = l.error {
        items = items.child(text(t(error)).role("alert"));
    }
    items = items.child(button(
        "refresh-sessions",
        t(if l.error.is_some() {
            "sessionList.loadError.retry"
        } else {
            "rune.refresh"
        }),
        !workspace::input_ready(s),
        screen::action(scope, |s| launcher::list(s, false)),
    ));
    let mut pane = col()
        .full_width()
        .full_height()
        .child(header.key("sessions-toolbar"))
        .children(search);
    if l.show_title || s.screen.is_launcher() {
        pane = pane.child(
            col()
                .key("session-create-form")
                .pad(Space::Sm)
                .separate(Space::Xs)
                .child(
                    hinted_field(&l.title, t("rune.session_title"))
                        .label(t("rune.session_title"))
                        .on_edit(screen::edit(scope, Editor::Title))
                        .on_key(editor_keys)
                        .on_submit(screen::action_tx(scope, launcher::create))
                        .build(&field_kit(layout::dark()))
                        .key("session-title"),
                )
                .child(button_tx(
                    "create-session",
                    t("rune.create"),
                    disabled || l.creation_uncertain || l.title.text.trim().is_empty(),
                    screen::action_tx(scope, launcher::create),
                )),
        );
    }
    pane.child(
        col()
            .full_width()
            .remaining()
            .key("session-list")
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(items),
    )
}
