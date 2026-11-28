use crate::{
    Phase, State,
    components::{button, button_tx},
    launcher,
    screen::{self, Editor},
    shell::notifications::{self, Category},
    strings::t,
    workspace,
};
use rune::{El, ScrollSpec, Tx, col};
use rune_theme_codenomad::{
    Space,
    action_menu::{self, Item, Menu},
    field_kit, git_panel, kit,
    layout::{self, Layout, hinted_field},
    shell::{
        self,
        icons::{BACK, COPY, FORWARD, PLUS, ROTATE_CW, SEARCH},
        notices::sidebar as theme,
    },
};
use std::rc::Rc;

fn session_menu_state(s: &mut State) -> Option<&mut action_menu::State<State>> {
    s.screen.launcher_mut().map(|l| &mut l.session_menu)
}

fn session_menu_key(id: &str) -> String {
    format!("session-actions-{id}")
}

fn copy_session_id(s: &mut State, id: &str, tx: &mut Tx) {
    tx.copy(id.to_owned());
    notifications::emit(s, Category::Copy, None, t("sessionList.copyId.success"));
}

fn build_session_menu(
    scope: &Rc<()>,
    session_id: &str,
    disabled: bool,
    more_label: &'static str,
    copy_label: &'static str,
    reload_label: &'static str,
) -> Rc<Menu<State>> {
    let copy_id = session_id.to_owned();
    let mut copy_item = Item::new(
        "copy-id",
        copy_label,
        screen::action_tx(scope, move |s, tx| copy_session_id(s, &copy_id, tx)),
    );
    copy_item.icon = Some(Rc::new(|| theme::menu_icon(&COPY)));
    copy_item.select_before_close = true;

    let reload_id = session_id.to_owned();
    let mut reload_item = Item::new(
        "reload",
        reload_label,
        screen::action_tx(scope, move |s, tx| {
            launcher::reload_session(s, reload_id.clone(), tx)
        }),
    );
    reload_item.icon = Some(Rc::new(|| theme::menu_icon(&ROTATE_CW)));
    reload_item.disabled = disabled;
    reload_item.select_before_close = true;

    let mut menu = Menu::new(
        &session_menu_key(session_id),
        more_label,
        vec![Rc::new(copy_item), Rc::new(reload_item)],
    );
    let open_id = session_id.to_owned();
    let change_scope = scope.clone();
    menu.on_open_change = Some(Rc::new(move |s, open, _| {
        if !s.current_scope(&change_scope) {
            return;
        }
        if let Some(l) = s.screen.launcher_mut() {
            if open {
                l.open_session_menu = Some(open_id.clone());
            } else if l.open_session_menu.as_deref() == Some(open_id.as_str()) {
                l.open_session_menu = None;
            }
        }
    }));
    Rc::new(menu)
}

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
            theme::title(title),
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
    let filtered = Rc::new(filtered);
    let count = filtered.len();
    let for_key = filtered.clone();
    let compact_actions = touch || floating;
    let menu_viewport = if s.shell.width() > 0.0 {
        s.shell.width()
    } else if s.window_size[0] > 0.0 {
        s.window_size[0]
    } else {
        411.0
    };
    // Resolve localized labels before entering `transcript_rows`: its deferred row builder runs
    // during layout after `strings::with_locale` restores the thread-local locale.
    let untitled = t("sessionList.session.untitled");
    let more_label = t("messageItem.actions.more");
    let copy_label = t("sessionList.actions.copyId.title");
    let reload_label = t("sessionList.actions.reload.title");
    let active_status = active_session_status(s);
    let row_ids: Rc<Vec<String>> = Rc::new(
        filtered
            .iter()
            .filter_map(|&idx| session_row(l, remote_search, idx).map(|r| r.id.clone()))
            .collect(),
    );
    let nav_ids = row_ids.clone();
    let items = layout::transcript_rows(
        count,
        move |s: &State, i| {
            s.screen
                .launcher()
                .and_then(|l| session_row(l, remote_search, for_key[i]))
                .map_or_else(
                    || std::borrow::Cow::Owned(format!("row-{i}")),
                    |row| std::borrow::Cow::Owned(format!("session-row-{}", row.id)),
                )
        },
        move |s: &State, i| {
            let Some(l) = s.screen.launcher() else {
                return rune::el();
            };
            let Some(session) = session_row(l, remote_search, filtered[i]) else {
                return rune::el();
            };
            let title = if session.title.is_empty() {
                untitled
            } else {
                &session.title
            };
            let id = session.id.clone();
            let selected = workspace::active_session(s) == Some(id.as_str());
            let row_key = format!("session-{id}");
            let status_badge = selected
                .then_some(active_status)
                .flatten()
                .map(|status| (status, format!("session-status-{id}")));
            let (inline_actions, overflow_trigger) = if compact_actions {
                let menu = build_session_menu(
                    &s.input_scope,
                    &id,
                    disabled,
                    more_label,
                    copy_label,
                    reload_label,
                );
                let (trigger, _) = action_menu::view(
                    &l.session_menu,
                    session_menu_state,
                    menu,
                    theme::overflow_trigger(more_label, touch),
                    menu_viewport,
                );
                (Vec::new(), Some(trigger))
            } else {
                let copy_id = id.clone();
                let reload_id = id.clone();
                let actions = vec![
                    theme::row_action(
                        &format!("session-copy-{id}"),
                        &COPY,
                        copy_label,
                        false,
                        screen::action_tx(&s.input_scope, move |s, tx| {
                            copy_session_id(s, &copy_id, tx)
                        }),
                    ),
                    theme::row_action(
                        &format!("session-reload-{id}"),
                        &ROTATE_CW,
                        reload_label,
                        disabled,
                        screen::action_tx(&s.input_scope, move |s, tx| {
                            launcher::reload_session(s, reload_id.clone(), tx)
                        }),
                    ),
                ];
                (actions, None)
            };
            theme::session_row(
                &row_key,
                title,
                selected,
                disabled,
                i + 1 == count,
                false,
                touch,
                status_badge,
                inline_actions,
                overflow_trigger,
                screen::action_tx(&s.input_scope, move |s, tx| {
                    launcher::choose(s, id.clone(), tx)
                }),
            )
            .content_direction()
        },
    )
    .role("list")
    .label(title)
    .focus_group()
    .on_key(move |_: &mut State, event, tx| {
        if event.mods != rune::Mods::default() || nav_ids.is_empty() {
            return false;
        }
        let delta = match event.key {
            rune::Key::Down => 1_isize,
            rune::Key::Up => -1_isize,
            _ => return false,
        };
        let Some(focused) = tx.focused() else {
            return false;
        };
        let Some(current_id) = focused.strip_prefix("session-") else {
            return false;
        };
        let Some(pos) = nav_ids.iter().position(|id| id == current_id) else {
            return false;
        };
        let next = pos.saturating_add_signed(delta);
        if next < nav_ids.len() && next != pos {
            tx.focus(format!("session-{}", nav_ids[next]), true);
            true
        } else {
            false
        }
    });
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
    let show_more = !remote_search && l.next.is_some();
    let show_retry = l.error.is_some();
    if show_more || show_retry {
        let mut footer = layout::action_row().pad(Space::Sm).key("sessions-footer");
        if show_more {
            footer = footer.child(button(
                "more-sessions",
                t("rune.more"),
                disabled || !l.can_page(),
                screen::action(scope, |s| launcher::list(s, true)),
            ));
        }
        if show_retry {
            footer = footer.child(button(
                "refresh-sessions",
                t("sessionList.loadError.retry"),
                !workspace::input_ready(s),
                screen::action(scope, |s| launcher::list(s, false)),
            ));
        }
        items = items.child(footer);
    }
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
    if l.show_title {
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
    let open_menu_overlay = compact_actions
        .then(|| l.open_session_menu.as_deref())
        .flatten()
        .filter(|id| row_ids.iter().any(|visible| visible == id))
        .and_then(|id| {
            let menu =
                build_session_menu(scope, id, disabled, more_label, copy_label, reload_label);
            let (_, surface) = action_menu::view(
                &l.session_menu,
                session_menu_state,
                menu,
                theme::overflow_trigger(more_label, touch),
                menu_viewport,
            );
            surface
        });
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
    .children(open_menu_overlay)
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

    #[test]
    fn sidebar_b3_b4_c4_hides_permanent_form_and_refresh_and_exposes_desktop_and_phone_actions() {
        // B4 + B3: when no session is selected, neither the permanent create form nor the
        // permanent Refresh button is rendered, and the header renders uppercase SESSIONS.
        let mut launcher_state = ready_project_state();
        launcher_state.show_launcher();
        let mut rt = Runtime::new(
            launcher_state,
            english,
            (1280.0, 800.0),
            Env::new(true, 1.0),
        );
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        settle(&mut rt);

        assert!(
            rt.find("session-create-form").is_none() && rt.find("session-title").is_none(),
            "B4: permanent create form must stay hidden when no session is selected"
        );
        assert!(
            rt.find("refresh-sessions").is_none(),
            "B3: permanent Refresh button must not render outside error states"
        );
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.text.as_deref() == Some("SESSIONS")),
            "B3: sidebar section heading must render uppercase SESSIONS"
        );
        // Desktop inline Copy ID action copies the session id to the clipboard.
        click(&mut rt, "session-copy-session");
        assert_eq!(
            clipboard.text().map(|s| s.to_string()).as_deref(),
            Some("session")
        );

        // C4: at phone width 411x914, the full-screen floating drawer renders a visible `...`
        // overflow button on every row and opens the session action menu on tap.
        let phone_state = ready_project_state();
        let mut phone_rt = Runtime::new(phone_state, english, (411.0, 914.0), Env::new(true, 1.0));
        let phone_clip = rune::clipboard::memory();
        phone_rt.use_clipboard(&phone_clip);
        settle(&mut phone_rt);
        click(&mut phone_rt, "sessions-panel-toggle");

        assert!(phone_rt.find("session-create-form").is_none());
        assert!(phone_rt.find("refresh-sessions").is_none());
        assert!(
            phone_rt.find("session-actions-session:trigger").is_some()
                && phone_rt.find("session-actions-second:trigger").is_some(),
            "C4: every row in the phone drawer must expose a visible overflow actions trigger"
        );
        click(&mut phone_rt, "session-actions-second:trigger");
        assert!(
            phone_rt.find("session-actions-second:menu").is_some(),
            "C4: tapping the row overflow trigger must open the session actions menu"
        );
        click(&mut phone_rt, "session-actions-second:item:copy-id");
        assert_eq!(
            phone_clip.text().map(|s| s.to_string()).as_deref(),
            Some("second")
        );
        assert!(
            phone_rt.find("session-actions-second:menu").is_none(),
            "activating a menu item must close the session action menu"
        );
    }
}
