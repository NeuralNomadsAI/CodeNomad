use crate::{
    Phase, State,
    components::{button, button_tx},
    launcher,
    screen::{self, Editor},
    strings::t,
    workspace,
};
use rune::{El, ScrollSpec, col};
use rune_theme_codenomad::{
    Space, attachment, field_kit, git_panel, kit,
    layout::{self, Layout, hinted_field},
    shell::{
        self,
        icons::{BACK, FORWARD, PLUS, SEARCH},
    },
};

fn active_session_status(s: &State) -> Option<&'static str> {
    if s.screen.is_launcher() {
        return None;
    }
    if s.agent.as_ref().is_some_and(|a| !a.permissions.is_empty()) {
        Some(t("sessionList.status.needsPermission"))
    } else if s.agent.as_ref().is_some_and(|a| !a.forms.is_empty()) {
        Some(t("sessionList.status.needsInput"))
    } else if s.phase.reconnecting() {
        // Shortcut: `State` does not yet expose per-session API retry metadata, so transport
        // reconnection uses `Retrying` with the same precedence over `Working` as Solid.
        Some(t("sessionList.status.retrying"))
    } else if s.phase == Phase::Streaming || s.agent.as_ref().is_some_and(|a| a.online && a.running)
    {
        Some(t("sessionList.status.working"))
    } else {
        None
    }
}

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
                .help(t("sessionList.filter.open"))
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
        git_panel::context()
            .key("session-search-bar")
            .role("group")
            .label(name)
            .child(
                hinted_field(&l.search, t("sessionList.filter.placeholder"))
                    .label(name)
                    .input_mode(rune::InputMode::Search)
                    .autofill(rune::Autofill::Off)
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
    // Resolve localized labels before entering `transcript_rows`: its deferred row builder runs
    // during layout after `strings::with_locale` restores the thread-local locale.
    let untitled = t("sessionList.session.untitled");
    let active_status = active_session_status(s);
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
                untitled
            } else {
                &session.title
            };
            let id = session.id.clone();
            let selected = workspace::active_session(s) == Some(id.as_str());
            let mut row_el = shell::session_row(
                title,
                selected,
                disabled,
                screen::action_tx(&s.input_scope, move |s, tx| {
                    launcher::choose(s, id.clone(), tx)
                }),
            )
            .content_direction()
            .help(title);
            if selected && let Some(status) = active_status {
                row_el = row_el.description(status).child(
                    attachment::status_badge(status).key(format!("session-status-{}", session.id)),
                );
            }
            row_el
        },
    )
    .role("list")
    .label(title)
    .focus_group();
    let mut items = col().full_width().child(items);
    if remote_search && l.search_results.pending() {
        items = items
            .child(git_panel::note(t("rune.loading"), "status").key("sessions-search-loading"));
    } else if remote_search && l.search_results.failed || !searching && l.linked.failed {
        items =
            items.child(git_panel::note(t("rune.list_error"), "alert").key("sessions-list-error"));
    } else if searching && count == 0 {
        items = items.child(
            git_panel::note(t("unifiedPicker.empty"), "status").key("sessions-search-empty"),
        );
    } else if !searching && count == 0 && (l.pending || l.linked.pending()) && l.error.is_none() {
        items = items.child(
            git_panel::note(t("sessionList.loading.initial"), "status").key("sessions-loading"),
        );
    } else if !searching && count == 0 && l.error.is_none() {
        items =
            items.child(git_panel::note(t("rune.empty_sessions"), "status").key("sessions-empty"));
    }
    if let Some(error) = l.error {
        items = items.child(git_panel::note(t(error), "alert").key("sessions-error"));
    }
    let mut footer = layout::action_row().pad(Space::Sm).key("sessions-footer");
    if !remote_search && l.next.is_some() {
        footer = footer.child(button(
            "more-sessions",
            t("rune.more"),
            disabled || !l.can_page(),
            screen::action(scope, |s| launcher::list(s, true)),
        ));
    }
    footer = footer.child(button(
        "refresh-sessions",
        t(if l.error.is_some() {
            "sessionList.loadError.retry"
        } else {
            "rune.refresh"
        }),
        !workspace::input_ready(s),
        screen::action(scope, |s| launcher::list(s, false)),
    ));
    items = items.child(footer);
    let mut pane = col()
        .full_width()
        .full_height()
        .key("sessions-sidebar-body");
    if floating {
        // Shortcut: `crates/` is out of scope for this branch; across all CodeNomad palettes
        // `surface-canvas` and `surface-overlay` both resolve to `surface-shade-strong`.
        // Upgrade path: replace with a dedicated `Layout::overlay_surface()` in `rune-theme-codenomad`.
        pane = pane.reading_surface();
    }
    pane = pane.child(header.key("sessions-toolbar")).children(search);
    if l.show_title || s.screen.is_launcher() {
        pane = pane.child(
            git_panel::context()
                .key("session-create-form")
                .child(
                    hinted_field(&l.title, t("rune.session_title"))
                        .label(t("rune.session_title"))
                        .autofill(rune::Autofill::Off)
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
    let list_scroll = s.tool_diff_preferences.session_list_scroll.clone();
    pane.child(crate::chat::reading::track_other_scroller_hover(
        col()
            .full_width()
            .remaining()
            .key("session-list")
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .on_scroll_offset(move |at| {
                list_scroll.set((at.offset[1], at.max[1]));
            })
            .child(items),
        crate::chat::reading::HOVER_SESSION_LIST,
    ))
}

#[cfg(test)]
mod visual_parity_tests {
    use crate::{
        Phase, State,
        agent_api::{Form, FormOwner, Permission},
        backend::Backend,
        catalog::Session,
        gallery::shell::fixture,
        init, strings, workspace,
    };
    use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, edit::TextEdit};
    use rune_theme_codenomad::{field_kit, kit};
    use serde_json::Value;

    fn english(s: &State, cx: &mut Cx<State>) -> El {
        strings::with_locale("en", || crate::view(s, cx))
    }

    fn english_shell(s: &State, cx: &mut Cx<State>) -> El {
        strings::with_locale("en", || crate::shell::view(s, cx, |_, _| rune::col()))
    }

    fn hebrew(s: &State, cx: &mut Cx<State>) -> El {
        strings::with_locale("he", || crate::view(s, cx))
    }

    fn settle(rt: &mut Runtime<State>) {
        for _ in 0..8 {
            rt.frame(1.0 / 60.0);
        }
    }

    fn click(rt: &mut Runtime<State>, key: &str) {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        settle(rt);
    }

    fn find_node<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
        if value.get("key").and_then(Value::as_str) == Some(key) {
            return Some(value);
        }
        if let Some(children) = value.get("children").and_then(Value::as_array) {
            for child in children {
                if let Some(found) = find_node(child, key) {
                    return Some(found);
                }
            }
        }
        None
    }

    fn test_backend(project_id: &str, session_id: &str) -> Backend {
        Backend {
            workspace: project_id.into(),
            session: session_id.into(),
            ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
        }
    }

    fn ready_agent(state: &State, project_id: &str, session_id: &str) -> crate::agent::Ui {
        let mut ui = crate::agent::Ui::new(crate::agent::start(
            test_backend(project_id, session_id),
            state.wake.clone(),
        ));
        ui.fixture_ready();
        ui
    }

    fn ready_project_state() -> State {
        let mut state = init();
        fixture(&mut state);
        let project = state.screen.launcher().unwrap().project.clone().unwrap();
        let backend = test_backend(&project.id, "session");
        let mut ui = workspace::Ui::new();
        ui.mark_ready();
        state.workspace = Some(ui);
        workspace::opened(&mut state, &project);
        let _ = workspace::bound(&mut state, &backend);
        let launcher = state.screen.launcher_mut().unwrap();
        launcher.sessions = vec![
            Session {
                id: "session".into(),
                title: "Active conversation with a very long title for truncation tooltip".into(),
            },
            Session {
                id: "second".into(),
                title: String::new(),
            },
        ];
        state
    }

    #[test]
    fn sidebar_surfaces_search_semantics_and_header_order_match_solid_in_light_and_dark() {
        for dark in [false, true] {
            let mut state = ready_project_state();
            state.screen.launcher_mut().unwrap().show_search = true;
            let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(dark, 1.0));
            settle(&mut rt);

            let elements = rt.elements();
            let panel = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("sessions-panel"))
                .expect("docked sessions-panel");
            let body = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("sessions-sidebar-body"))
                .expect("docked sessions-sidebar-body");
            let search_bar = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("session-search-bar"))
                .expect("session-search-bar");
            let search_field = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("session-search"))
                .expect("session-search");

            assert_eq!(panel.fill, kit(dark).c.layer_01);
            assert_eq!(
                body.fill.a, 0.0,
                "docked sidebar body should inherit surface-secondary from sessions-panel"
            );
            assert_eq!(search_field.fill, field_kit(dark).c.bg_base);
            assert!(
                search_field.rect[0] > search_bar.rect[0],
                "search bar must pad the search field away from panel edges"
            );
            assert!(
                search_field.rect[2] > 0.0 && search_field.rect[3] > 0.0,
                "search field must have non-zero bounds"
            );

            let new_btn = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("session-new"))
                .expect("session-new");
            let search_btn = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("session-search-toggle"))
                .expect("session-search-toggle");
            let back_btn = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("sessionList.history.back"))
                .expect("back button");
            let forward_btn = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("sessionList.history.forward"))
                .expect("forward button");
            assert!(
                back_btn.rect[0] < forward_btn.rect[0]
                    && forward_btn.rect[0] < new_btn.rect[0]
                    && new_btn.rect[0] < search_btn.rect[0],
                "header must place Back/Forward before centered title and New/Search trailing in LTR: back={} forward={} new={} search={}",
                back_btn.rect[0],
                forward_btn.rect[0],
                new_btn.rect[0],
                search_btn.rect[0]
            );

            let mut floating_state = ready_project_state();
            floating_state.screen.launcher_mut().unwrap().show_search = true;
            let mut floating_rt =
                Runtime::new(floating_state, english, (390.0, 844.0), Env::new(dark, 1.0));
            settle(&mut floating_rt);
            click(&mut floating_rt, "sessions-panel-toggle");
            assert!(floating_rt.state.shell.has_floating() && floating_rt.state.shell.visible(0));

            let floating_els = floating_rt.elements();
            let floating_body = floating_els
                .iter()
                .find(|el| el.key.as_deref() == Some("sessions-sidebar-body"))
                .expect("floating sessions-sidebar-body");
            let floating_search = floating_els
                .iter()
                .find(|el| el.key.as_deref() == Some("session-search"))
                .expect("floating session-search");
            assert_eq!(floating_body.fill, kit(dark).c.layer_02);
            assert_eq!(floating_search.fill, field_kit(dark).c.bg_base);
        }
    }

    #[test]
    fn sidebar_rtl_mirrors_header_actions_and_preserves_keyboard_and_untitled_fallback() {
        let state = ready_project_state();
        let mut rt = Runtime::new(state, hebrew, (1400.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let search_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("session-search-toggle"))
            .expect("rtl session-search-toggle");
        let new_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("session-new"))
            .expect("rtl session-new");
        let forward_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("sessionList.history.forward"))
            .expect("rtl forward");
        let back_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("sessionList.history.back"))
            .expect("rtl back");
        assert!(
            search_btn.rect[0] < new_btn.rect[0]
                && new_btn.rect[0] < forward_btn.rect[0]
                && forward_btn.rect[0] < back_btn.rect[0],
            "RTL header must mirror Back/Forward leading and New/Search trailing: search={} new={} forward={} back={}",
            search_btn.rect[0],
            new_btn.rect[0],
            forward_btn.rect[0],
            back_btn.rect[0]
        );

        let tree = rt.accessibility_json();
        let second = find_node(&tree, "session-second").expect("untitled session node");
        assert_eq!(
            second["name"],
            strings::with_locale("he", || crate::strings::t("sessionList.session.untitled")),
            "untitled session must expose Hebrew fallback name: {second}"
        );
    }

    #[test]
    fn sidebar_empty_no_match_loading_and_error_states_have_clean_roles() {
        let mut empty = ready_project_state();
        empty.screen.launcher_mut().unwrap().sessions.clear();
        let mut rt = Runtime::new(empty, english, (1400.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let empty_node = find_node(&tree, "sessions-empty").expect("empty sessions note");
        assert_eq!(empty_node["role"], "status");
        assert!(find_node(&tree, "sessions-search-empty").is_none());

        let mut no_match = ready_project_state();
        {
            let l = no_match.screen.launcher_mut().unwrap();
            l.show_search = true;
            l.search = TextEdit::new("zzzz-no-such-session");
        }
        let mut rt = Runtime::new(no_match, english, (1400.0, 900.0), Env::new(true, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let no_match_node =
            find_node(&tree, "sessions-search-empty").expect("no-match search note");
        assert_eq!(no_match_node["role"], "status");
        assert_eq!(no_match_node["name"], "No results found");
        assert!(find_node(&tree, "sessions-empty").is_none());

        let mut loading = ready_project_state();
        {
            let l = loading.screen.launcher_mut().unwrap();
            l.sessions.clear();
            l.pending = true;
        }
        let mut rt = Runtime::new(
            loading,
            english_shell,
            (1400.0, 900.0),
            Env::new(false, 1.0),
        );
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let loading_node = find_node(&tree, "sessions-loading").expect("initial loading note");
        assert_eq!(loading_node["role"], "status");
        assert_eq!(loading_node["name"], "Loading sessions…");
        assert!(find_node(&tree, "sessions-empty").is_none());

        let mut errored = ready_project_state();
        {
            let l = errored.screen.launcher_mut().unwrap();
            l.sessions.clear();
            l.error = Some("sessionList.reload.error");
        }
        let mut rt = Runtime::new(errored, english, (1400.0, 900.0), Env::new(true, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let err_node = find_node(&tree, "sessions-error").expect("sessions error alert");
        assert_eq!(err_node["role"], "alert");
        assert!(find_node(&tree, "sessions-empty").is_none());
        let retry = find_node(&tree, "refresh-sessions").expect("retry button");
        assert_eq!(retry["name"], "Retry");
    }

    #[test]
    fn sidebar_active_session_exposes_live_status_badge_and_keeps_keyboard_navigation() {
        let mut working = ready_project_state();
        working.phase = Phase::Streaming;
        let mut rt = Runtime::new(working, english, (1400.0, 900.0), Env::new(true, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let badge = find_node(&tree, "session-status-session").expect("working status badge");
        assert_eq!(badge["role"], "status");
        assert_eq!(badge["name"], "Working");

        let mut retrying = ready_project_state();
        retrying.phase = Phase::Reconnecting;
        let project_id = retrying
            .screen
            .launcher()
            .unwrap()
            .project
            .as_ref()
            .unwrap()
            .id
            .clone();
        let mut running_agent = ready_agent(&retrying, &project_id, "session");
        running_agent.online = true;
        running_agent.running = true;
        retrying.agent = Some(running_agent);
        let mut rt = Runtime::new(retrying, english, (1400.0, 900.0), Env::new(true, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let badge = find_node(&tree, "session-status-session").expect("retrying status badge");
        assert_eq!(badge["role"], "status");
        assert_eq!(badge["name"], "Retrying");

        let mut perm = ready_project_state();
        perm.phase = Phase::Streaming;
        let project_id = perm
            .screen
            .launcher()
            .unwrap()
            .project
            .as_ref()
            .unwrap()
            .id
            .clone();
        let mut agent = ready_agent(&perm, &project_id, "session");
        agent.permissions.push(Permission {
            tool: None,
            id: "perm-1".into(),
            action: "bash".into(),
            resources: vec![],
            message: String::new(),
            supported: true,
        });
        perm.agent = Some(agent);
        let mut rt = Runtime::new(perm, english, (1400.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let badge = find_node(&tree, "session-status-session").expect("permission status badge");
        assert_eq!(badge["role"], "status");
        assert_eq!(badge["name"], "Needs Permission");

        let mut question = ready_project_state();
        let project_id = question
            .screen
            .launcher()
            .unwrap()
            .project
            .as_ref()
            .unwrap()
            .id
            .clone();
        let mut agent = ready_agent(&question, &project_id, "session");
        agent.forms.push(Form {
            id: "form-1".into(),
            owner: FormOwner::Session,
            title: "Choose".into(),
            fields: vec![],
            tool: None,
            infer_websearch: false,
        });
        question.agent = Some(agent);
        let mut rt = Runtime::new(question, english, (1400.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let badge = find_node(&tree, "session-status-session").expect("input status badge");
        assert_eq!(badge["role"], "status");
        assert_eq!(badge["name"], "Needs Input");

        rt.update(|_, tx| tx.focus("session-session", true));
        settle(&mut rt);
        let down = KeyEvent {
            key: Key::Down,
            mods: Mods::default(),
        };
        rt.key(down.clone());
        settle(&mut rt);
        rt.key_up(down);
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.focused && el.key.as_deref() == Some("session-second")),
            "Down arrow in session list focus group must reach the next session row"
        );
    }
}
