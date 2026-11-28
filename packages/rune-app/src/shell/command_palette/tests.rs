use super::*;
use crate::{
    Phase, Screen, State,
    backend::Backend,
    catalog::{Project, Session},
    gallery::shell::fixture,
    init, settings, strings, workspace,
};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
}

fn primary_mods(shift: bool) -> Mods {
    Mods {
        ctrl: !cfg!(target_os = "macos"),
        cmd: true,
        logo: cfg!(target_os = "macos"),
        shift,
        alt: false,
    }
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    settle(rt);
    rt.key_up(event);
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key: {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn focused_key(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key)
}

fn focused_path_contains(rt: &Runtime<State>, fragment: &str) -> bool {
    rt.elements()
        .into_iter()
        .any(|el| el.focused && el.path.contains(fragment))
}

fn workspace_state(tabs: usize) -> State {
    let mut s = init();
    fixture(&mut s);
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    workspace::opened(&mut s, &project);
    let bound = Backend {
        workspace: project.id.clone(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    workspace::bound(&mut s, &bound);
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    for i in 1..tabs {
        rt.update(|s, tx| {
            workspace::new_tab(s, tx);
            let next = Project {
                id: format!("project-{i}"),
                path: format!("/repo-{i}"),
                temporary: false,
            };
            if let Some(l) = s.screen.launcher_mut() {
                l.project = Some(next.clone());
                l.sessions = vec![
                    Session {
                        id: format!("session-{i}-a"),
                        title: format!("Session {i}A"),
                    },
                    Session {
                        id: format!("session-{i}-b"),
                        title: format!("Session {i}B"),
                    },
                ];
            }
            workspace::opened(s, &next);
        });
    }
    rt.update(|s, tx| workspace::select(s, "tab-0", tx));
    rt.state
}

fn runtime(s: State) -> Runtime<State> {
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    settle(&mut rt);
    rt
}

#[test]
fn shortcut_trigger_escape_close_and_focus_restoration_work() {
    let mut rt = runtime(workspace_state(2));

    // Accessible header trigger exposes label, shortcut tooltip, and expanded state.
    let trigger = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(theme::TRIGGER))
        .expect("header trigger button");
    assert_eq!(trigger.label.as_deref(), Some("Open command palette"));
    assert!(
        trigger
            .help
            .as_deref()
            .is_some_and(|h| h.contains("Open command palette") && h.contains('('))
    );
    assert_eq!(trigger.expanded, Some(false));

    // Focus a prior control, then open with default Mod+Shift+P.
    rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    assert!(rt.find("command-palette").is_some());
    assert!(focused_path_contains(&rt, FIELD));

    // Other shell shortcuts (Mod+]) are blocked while palette is open.
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    send_key(&mut rt, Key::Command(']'), primary_mods(false));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    assert!(is_open(&rt.state));

    // Pressing open-command-palette again toggles it closed and restores prior focus.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!is_open(&rt.state));
    assert!(rt.find("command-palette").is_none());
    assert_eq!(focused_key(&rt).as_deref(), Some("sessions-panel-toggle"));

    // Click trigger to open, then Escape to close and restore focus to trigger.
    click(&mut rt, theme::TRIGGER);
    assert!(is_open(&rt.state));
    let trigger_open = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(theme::TRIGGER))
        .unwrap();
    assert_eq!(trigger_open.expanded, Some(true));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(focused_key(&rt).as_deref(), Some(theme::TRIGGER));

    // Open via trigger, close via close button in the top search toolbar.
    click(&mut rt, theme::TRIGGER);
    assert!(is_open(&rt.state));
    click(&mut rt, CLOSE_KEY);
    assert!(!is_open(&rt.state));

    // Open via trigger, close via outside backdrop click.
    click(&mut rt, theme::TRIGGER);
    assert!(is_open(&rt.state));
    rt.pointer_down(10.0, 10.0);
    rt.pointer_up(10.0, 10.0);
    settle(&mut rt);
    assert!(!is_open(&rt.state));

    // Custom shortcut override and explicit empty disable.
    settings::fixture_shortcuts(
        &rt.state,
        json!({
            "open-command-palette": [{"key": "f2"}]
        }),
    );
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!is_open(&rt.state));
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(!is_open(&rt.state));

    settings::fixture_shortcuts(
        &rt.state,
        json!({
            "open-command-palette": []
        }),
    );
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(!is_open(&rt.state));
}

#[test]
fn filtering_grouping_shortcut_badges_and_empty_state_match_solid() {
    let mut rt = runtime(workspace_state(2));
    settings::fixture_shortcuts(
        &rt.state,
        json!({
            "new-instance": [{"key": "f8"}],
            "close-instance": []
        }),
    );

    strings::with_locale("en", || {
        let all = visible_commands(&rt.state);
        assert!(!all.is_empty());
        // Categories follow Solid order: Instance -> Session -> InputFocus -> System.
        let categories: Vec<_> = all.iter().map(|c| c.category).collect();
        let mut sorted = categories.clone();
        sorted.sort();
        assert_eq!(categories, sorted);

        // Shortcut badge reflects override and empty disable.
        let new_inst = all.iter().find(|c| c.id == "new-instance").unwrap();
        assert_eq!(new_inst.shortcut(&rt.state).as_deref(), Some("F8"));
        let close_inst = all.iter().find(|c| c.id == "close-instance").unwrap();
        assert_eq!(close_inst.shortcut(&rt.state), None);

        // Case-insensitive filtering by label, description, localized keyword, and category.
        let by_label = commands::filter("NEXT TAB", all.clone());
        assert_eq!(
            by_label.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec!["next-instance"]
        );

        let by_description = commands::filter("PARENT SESSION", all.clone());
        assert!(by_description.iter().any(|c| c.id == "new-session"));
        assert!(by_description.iter().any(|c| c.id == "close-session"));

        let by_keyword = commands::filter("RESET", all.clone());
        assert_eq!(
            by_keyword.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec!["clear-input"]
        );

        let by_category = commands::filter("session", all);
        assert!(by_category.iter().any(|c| c.id == "new-session"));
        assert!(by_category.iter().any(|c| c.id == "close-session"));
    });

    // Empty state renders localized message with `{query}`.
    click(&mut rt, theme::TRIGGER);
    rt.paste("zzz-no-match");
    settle(&mut rt);
    let a11y = rt.accessibility_json().to_string();
    assert!(a11y.contains("No commands found for \\\"zzz-no-match\\\""));
}

#[test]
fn keyboard_navigation_wraps_and_executes_real_commands_with_guards() {
    let mut rt = runtime(workspace_state(2));
    rt.state.draft = TextEdit::new("hello draft");
    rt.state.phase = Phase::Ready;

    // Open palette and verify ArrowDown/ArrowUp wrap + Home/End jump.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    let ids: Vec<&'static str> = strings::with_locale("en", || {
        visible_commands(&rt.state)
            .into_iter()
            .map(|c| c.id)
            .collect()
    });
    assert!(ids.len() >= 5);

    send_key(&mut rt, Key::Up, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, ids.last().copied());
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, ids.first().copied());
    send_key(&mut rt, Key::End, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, ids.last().copied());
    send_key(&mut rt, Key::Home, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, ids.first().copied());

    // Filter to "Next Tab" and press Enter -> switches active tab and closes palette.
    rt.paste("Next Tab");
    settle(&mut rt);
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);

    // Switch back to tab 0, execute "Clear Input" -> clears draft.
    rt.update(|s, tx| workspace::select(s, "tab-0", tx));
    settle(&mut rt);
    rt.state.draft = TextEdit::new("draft to clear");
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("clear input");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(rt.state.draft.text.is_empty());

    // With empty draft, "Clear Input" is disabled and Enter does NOT close or execute.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("clear input");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));

    // Toggle left panel from command palette.
    assert!(rt.state.shell.visible(0));
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("Left panel");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(!rt.state.shell.visible(0));

    // Open Notification History from command palette and keep focus on its close control.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("Notification History");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(crate::shell::notifications::history_open(&rt.state));
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("notification-history-close")
    );
}

#[test]
fn guards_block_opening_during_modals_auth_and_ime_composition() {
    let mut rt = runtime(workspace_state(1));
    let backend = Backend {
        workspace: "proj".into(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    crate::timeline::search::fixture_scope_open(&mut rt.state, Some(backend), false);

    // Executing "Search session history" opens History Search and focuses its query field.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("Search session history");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(crate::timeline::search::is_open(&rt.state));
    assert!(focused_path_contains(&rt, "history-search-query"));
    crate::timeline::search::close(&mut rt.state);
    settle(&mut rt);

    // Blocked when another modal (Notification History) is open.
    rt.update(|s, tx| crate::shell::notifications::open_history(s, tx));
    settle(&mut rt);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());

    // Blocked when composer draft is IME-composing.
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    rt.ime(rune::edit::Ime::Preedit("ni".into(), None, Vec::new()));
    settle(&mut rt);
    assert!(rt.state.draft.is_composing());
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!is_open(&rt.state));
    rt.ime(rune::edit::Ime::Preedit(String::new(), None, Vec::new()));
    settle(&mut rt);
    assert!(!rt.state.draft.is_composing());

    // Blocked when launcher requires authentication.
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.authentication_required = true;
    }
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(!is_open(&rt.state));
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.authentication_required = false;
    }

    // While open, IME preedit in the palette search input prevents Escape/Enter interception.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    rt.ime(rune::edit::Ime::Preedit("ni".into(), None, Vec::new()));
    settle(&mut rt);
    assert!(is_composing(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(is_open(&rt.state));
    rt.ime(rune::edit::Ime::Preedit(String::new(), None, Vec::new()));
    settle(&mut rt);
    assert!(!is_composing(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
}

#[test]
fn non_english_locale_filters_and_executes_localized_commands() {
    fn french(s: &State, cx: &mut Cx<State>) -> El {
        strings::with_locale("fr", || crate::view(s, cx))
    }
    let mut rt = Runtime::new(
        workspace_state(2),
        french,
        (1400.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("fr", || crate::shell::keys(s, event, tx)));
    settle(&mut rt);

    let next_tab_fr = strings::with_locale("fr", || strings::t("commands.nextInstance.label"));
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    rt.paste(next_tab_fr);
    settle(&mut rt);
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
}

#[test]
fn scope_renewal_auth_trigger_attachments_floating_focus_and_rebound_nav_are_safe() {
    let mut rt = runtime(workspace_state(2));
    rt.state.draft = TextEdit::new("tab-0 draft");
    rt.state
        .composer
        .draft
        .attachments
        .push(crate::composer::draft::Attachment::Path("README.md".into()));

    // 1. Background tab switch / scope renewal dismisses open palette so Enter cannot wipe new tab's draft.
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    rt.paste("clear input");
    settle(&mut rt);
    rt.update(|s, tx| workspace::select(s, "tab-1", tx));
    settle(&mut rt);
    assert!(!is_open(&rt.state));
    rt.state.draft = TextEdit::new("tab-1 protected draft");
    send_key(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "tab-1 protected draft");

    // Return to tab 0: Clear Input clears text via undoable edit while preserving attachments.
    rt.update(|s, tx| workspace::select(s, "tab-0", tx));
    settle(&mut rt);
    assert_eq!(rt.state.draft.text, "tab-0 draft");
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    rt.paste("clear input");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(rt.state.draft.text.is_empty());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    // Attachment-only draft keeps Clear Input disabled.
    strings::with_locale("en", || {
        let items = visible_commands(&rt.state);
        assert!(
            items
                .iter()
                .find(|c| c.id == "clear-input")
                .unwrap()
                .disabled
        );
    });

    // 2. Trigger action (toggle/open) refuses to open when authentication_required is set.
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.authentication_required = true;
    }
    rt.update(|s, tx| toggle(s, tx));
    settle(&mut rt);
    assert!(!is_open(&rt.state));
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.authentication_required = false;
    }

    // 3. creation_uncertain disables new-session in the palette.
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.creation_uncertain = true;
    }
    strings::with_locale("en", || {
        let items = visible_commands(&rt.state);
        assert!(
            items
                .iter()
                .find(|c| c.id == "new-session")
                .unwrap()
                .disabled
        );
    });
    if let Screen::Chat { launcher: Some(l) } = &mut rt.state.screen {
        l.creation_uncertain = false;
    }

    // 4. Rebinding open-command-palette to ArrowDown still lets ArrowDown navigate inside the open palette.
    settings::fixture_shortcuts(
        &rt.state,
        json!({
            "open-command-palette": [{"key": "ArrowDown"}]
        }),
    );
    send_key(&mut rt, Key::Down, Mods::default());
    assert!(is_open(&rt.state));
    let before = rt.state.command_palette.selected_id;
    send_key(&mut rt, Key::Down, Mods::default());
    assert!(is_open(&rt.state));
    assert_ne!(rt.state.command_palette.selected_id, before);
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));

    // 5. Opening from a floating drawer restores focus to the drawer toggle instead of an unmounted row.
    settings::fixture_shortcuts(&rt.state, json!({}));
    rt.set_viewport((390.0, 900.0), 1.0);
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.floating_sessions().is_some());
    rt.update(|_, tx| tx.focus("session-session", true));
    settle(&mut rt);
    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    assert!(rt.state.shell.floating_sessions().is_none());
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(focused_key(&rt).as_deref(), Some("sessions-panel-toggle"));
}

fn find_a11y_by_name<'a>(node: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    if node.get("name").and_then(|v| v.as_str()) == Some(name) {
        return Some(node);
    }
    node.get("children")?
        .as_array()?
        .iter()
        .find_map(|child| find_a11y_by_name(child, name))
}

fn search_active_descendant(rt: &Runtime<State>) -> Option<String> {
    let tree = rt.accessibility_json();
    let placeholder = strings::with_locale("en", || strings::t("commandPalette.searchPlaceholder"));
    let input =
        find_a11y_by_name(&tree, placeholder).expect("palette search input in accessibility tree");
    input
        .get("activeDescendant")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

#[test]
fn keyboard_navigation_scrolls_list_updates_active_descendant_and_rename_falls_back_to_trigger() {
    // 1. Overflowing viewport: keyboard navigation reveals selected rows inside command-palette-list
    //    and keeps the search field's accessibility activeDescendant in sync.
    let mut rt = runtime(workspace_state(2));
    rt.set_viewport((1400.0, 260.0), 1.0);
    settle(&mut rt);

    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    let items = strings::with_locale("en", || visible_commands(&rt.state));
    assert!(
        items.len() >= 8,
        "expected enough palette commands to overflow a compact viewport"
    );
    let first_id = items[0].id;
    let second_id = items[1].id;
    let last_id = items.last().unwrap().id;
    let first_key = item_key(first_id);
    let second_key = item_key(second_id);
    let last_key = item_key(last_id);

    let list_el = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(theme::LIST))
        .expect("palette list viewport");
    let first_el = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(first_key.as_str()))
        .expect("first command row");
    let last_el_before = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(last_key.as_str()))
        .expect("last command row");
    assert!(
        first_el.visible[3] > 0.0,
        "first row must be visible on open"
    );
    assert!(
        last_el_before.visible[3] <= 0.0,
        "last row must initially overflow below the compact palette list"
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(first_key.as_str()),
        "search field must expose initial selected row as activeDescendant"
    );

    // ArrowDown updates activeDescendant to the second row.
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, Some(second_id));
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(second_key.as_str()),
        "ArrowDown must update activeDescendant"
    );

    // End reveals the last row inside the list viewport and updates activeDescendant.
    send_key(&mut rt, Key::End, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, Some(last_id));
    let last_el_after_end = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(last_key.as_str()))
        .expect("last command row after End");
    assert!(
        last_el_after_end.visible[3] > 0.0
            && last_el_after_end.visible[1] >= list_el.rect[1] - 1.0
            && last_el_after_end.visible[1] + last_el_after_end.visible[3]
                <= list_el.rect[1] + list_el.rect[3] + 1.0,
        "End must scroll the last row into the palette list viewport (visible={:?}, list={:?})",
        last_el_after_end.visible,
        list_el.rect
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(last_key.as_str()),
        "End must update activeDescendant to the last row"
    );

    // Home scrolls back to the top and updates activeDescendant to the first row.
    send_key(&mut rt, Key::Home, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, Some(first_id));
    let first_el_after_home = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(first_key.as_str()))
        .expect("first command row after Home");
    assert!(
        first_el_after_home.visible[3] > 0.0,
        "Home must scroll the first row back into view"
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(first_key.as_str())
    );

    // ArrowUp wraps to the last row and scrolls it into view; ArrowDown wraps back to the first.
    send_key(&mut rt, Key::Up, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, Some(last_id));
    let last_el_after_wrap = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(last_key.as_str()))
        .expect("last command row after ArrowUp wrap");
    assert!(
        last_el_after_wrap.visible[3] > 0.0,
        "ArrowUp wrap must reveal the last row"
    );
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(rt.state.command_palette.selected_id, Some(first_id));
    let first_el_after_wrap = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(first_key.as_str()))
        .expect("first command row after ArrowDown wrap");
    assert!(
        first_el_after_wrap.visible[3] > 0.0,
        "ArrowDown wrap must reveal the first row"
    );

    // Empty search results clear activeDescendant.
    rt.paste("zzzz-no-command-match");
    settle(&mut rt);
    assert_eq!(
        search_active_descendant(&rt),
        None,
        "empty search results must clear activeDescendant"
    );
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));

    // 2. Opening rename-instance from the palette with no prior focus falls back to theme::TRIGGER
    //    both via Enter (execute_selected) and via row click (execute_by_id).
    let mut rt_enter = runtime(workspace_state(2));
    assert_eq!(focused_key(&rt_enter), None);
    send_key(&mut rt_enter, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt_enter.state));
    rt_enter.paste("rename instance");
    settle(&mut rt_enter);
    send_key(&mut rt_enter, Key::Enter, Mods::default());
    assert!(!is_open(&rt_enter.state));
    assert!(crate::shell::tab_rename::is_open(&rt_enter.state));
    send_key(&mut rt_enter, Key::Escape, Mods::default());
    assert!(!crate::shell::tab_rename::is_open(&rt_enter.state));
    assert_eq!(
        focused_key(&rt_enter).as_deref(),
        Some(theme::TRIGGER),
        "rename-instance executed by Enter without prior focus must restore focus to theme::TRIGGER"
    );

    let mut rt_click = runtime(workspace_state(2));
    assert_eq!(focused_key(&rt_click), None);
    send_key(&mut rt_click, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt_click.state));
    rt_click.paste("rename instance");
    settle(&mut rt_click);
    click(&mut rt_click, &item_key("rename-instance"));
    assert!(!is_open(&rt_click.state));
    assert!(crate::shell::tab_rename::is_open(&rt_click.state));
    send_key(&mut rt_click, Key::Escape, Mods::default());
    assert!(!crate::shell::tab_rename::is_open(&rt_click.state));
    assert_eq!(
        focused_key(&rt_click).as_deref(),
        Some(theme::TRIGGER),
        "rename-instance executed by click without prior focus must restore focus to theme::TRIGGER"
    );
}

#[test]
fn stationary_pointer_over_scrolling_list_does_not_override_keyboard_selection() {
    let mut rt = runtime(workspace_state(2));
    rt.set_viewport((1400.0, 260.0), 1.0);
    settle(&mut rt);

    send_key(&mut rt, Key::Command('p'), primary_mods(true));
    assert!(is_open(&rt.state));
    let items = strings::with_locale("en", || visible_commands(&rt.state));
    assert!(items.len() >= 8);
    let enabled: Vec<_> = items.iter().filter(|item| !item.disabled).collect();
    assert!(enabled.len() >= 4);
    let first_id = items[0].id;
    let second_id = enabled[1].id;
    let last_id = items.last().unwrap().id;
    let first_key = item_key(first_id);
    let second_key = item_key(second_id);
    let last_key = item_key(last_id);

    // Move the pointer onto the second enabled row: real pointer movement selects it.
    let (px, py) = rt
        .find(&second_key)
        .expect("second enabled command row visible");
    rt.pointer_move(px, py);
    settle(&mut rt);
    assert_eq!(rt.state.command_palette.selected_id, Some(second_id));
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(second_key.as_str())
    );

    // Keep the pointer stationary over the list and press End to scroll past the fold.
    // Let Rune's scroll glide finish and re-evaluate hover under the stationary pointer.
    send_key(&mut rt, Key::End, Mods::default());
    for _ in 0..45 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(
        rt.state.command_palette.selected_id,
        Some(last_id),
        "scroll-retargeted hover under a stationary pointer must not overwrite End selection"
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(last_key.as_str()),
        "activeDescendant must stay on the keyboard-selected row after scroll settles"
    );

    // A duplicate pointer event at the exact same coordinates must still not steal selection.
    rt.pointer_move(px, py);
    settle(&mut rt);
    assert_eq!(rt.state.command_palette.selected_id, Some(last_id));

    // Genuine pointer movement onto a scrolled-in enabled row re-enables hover selection.
    let scrolled_enabled = enabled
        .iter()
        .rev()
        .find(|item| {
            item.id != last_id
                && item.id != second_id
                && rt.elements().into_iter().any(|el| {
                    el.key.as_deref() == Some(item_key(item.id).as_str()) && el.visible[3] > 4.0
                })
        })
        .expect("another enabled row visible after End");
    let scrolled_key = item_key(scrolled_enabled.id);
    let (mx, my) = rt.find(&scrolled_key).expect("scrolled enabled row center");
    rt.pointer_move(mx, my);
    settle(&mut rt);
    assert_eq!(
        rt.state.command_palette.selected_id,
        Some(scrolled_enabled.id),
        "moving the pointer after scrolling to End must select the row under the moved cursor"
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(scrolled_key.as_str())
    );

    // Press Home while the pointer rests stationary: selection must stay on the first row.
    send_key(&mut rt, Key::Home, Mods::default());
    for _ in 0..45 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(
        rt.state.command_palette.selected_id,
        Some(first_id),
        "stationary pointer must not override Home selection after scrolling back to top"
    );
    assert_eq!(
        search_active_descendant(&rt).as_deref(),
        Some(first_key.as_str())
    );
}
