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
                && super::keys(s, key, tx)
        }
    };
    let navigation_blocked = !workspace::input_ready(s) || crate::agent::navigation_blocked(s);
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
            .build(kit(layout::dark()))
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
    let mut header = shell::header(
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
                .disabled(disabled)
                .on_press_tx(screen::action_tx(scope, |s, tx| {
                    if let Some(l) = s.screen.launcher_mut() {
                        l.show_title = true;
                        tx.focus_when_shown("session-title", true);
                    }
                }))
                .build(kit(layout::dark()))
                .key("session-new"),
            shell::control(&SEARCH, t("sessionList.filter.ariaLabel"), touch)
                .expanded(l.show_search)
                .on_press_tx(screen::action_tx(scope, |s, tx| {
                    if let Some(l) = s.screen.launcher_mut() {
                        l.show_search = !l.show_search;
                        if l.show_search {
                            tx.focus_when_shown("session-search", true);
                        } else {
                            l.search = rune::edit::TextEdit::new("");
                        }
                    }
                }))
                .build(kit(layout::dark()))
                .key("session-search-toggle"),
        ],
    );
    if l.show_search {
        header = col().full_width().child(header).child(
            hinted_field(&l.search, t("sessionList.filter.placeholder"))
                .label(t("sessionList.filter.ariaLabel"))
                .on_edit(screen::edit(scope, Editor::Search))
                .on_key(editor_keys.clone())
                .build(field_kit(layout::dark()))
                .key("session-search"),
        );
    }
    let filter = l.search.text.to_lowercase();
    let selected = workspace::active_session(s);
    let mut items = col().full_width().role("list").label(title).focus_group();
    for session in l
        .sessions
        .iter()
        .filter(|s| s.title.to_lowercase().contains(&filter))
    {
        let id = session.id.clone();
        let title = if session.title.is_empty() {
            t("sessionList.session.untitled")
        } else {
            &session.title
        };
        let key = format!("session-{id}");
        items = items.child(
            shell::session_row(
                title,
                selected == Some(id.as_str()),
                disabled,
                screen::action_tx(scope, move |s, tx| {
                    launcher::choose(s, id.clone(), tx);
                }),
            )
            .key(key),
        );
    }
    let mut items = col().full_width().child(items);
    if l.sessions.is_empty() && !l.pending {
        items = items.child(text(t("rune.empty_sessions")).pad(Space::Sm));
    }
    if l.next.is_some() {
        items = items.child(button(
            "more-sessions",
            t("rune.more"),
            disabled || l.sessions.len() >= launcher::MAX_BROWSED_SESSIONS,
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
    let mut pane = col().full_width().full_height().child(header);
    if l.show_title || s.screen.is_launcher() {
        pane = pane.child(
            col()
                .pad(Space::Sm)
                .separate(Space::Xs)
                .child(
                    hinted_field(&l.title, t("rune.session_title"))
                        .label(t("rune.session_title"))
                        .on_edit(screen::edit(scope, Editor::Title))
                        .on_key(editor_keys)
                        .on_submit(screen::action_tx(scope, launcher::create))
                        .build(field_kit(layout::dark()))
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
