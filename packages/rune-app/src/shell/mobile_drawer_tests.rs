use crate::{State, backend::Backend, gallery::shell::fixture, init, strings, workspace};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};

fn english_touch(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn touch_init() -> State {
    let mut state = init();
    state.shell.touch_override = true;
    state
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.update(|s, _| crate::shell::sync(s));
        rt.frame(1.0 / 60.0);
    }
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn press_key(rt: &mut Runtime<State>, key: Key, shift: bool) {
    let event = KeyEvent {
        key,
        mods: Mods {
            shift,
            ..Mods::default()
        },
    };
    rt.key(event.clone());
    settle(rt);
    rt.key_up(event);
}

fn focused_key(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|e| e.focused)
        .and_then(|e| e.key)
}

fn focus_inside(rt: &Runtime<State>, fragment: &str) -> bool {
    rt.elements()
        .iter()
        .any(|e| e.focused && e.path.contains(fragment))
}

fn project_state_with_git() -> State {
    let mut state = touch_init();
    fixture(&mut state);
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    state.workspace = Some(workspace::Ui::new());
    workspace::opened(&mut state, &project);
    let backend = Backend {
        workspace: project.id.clone(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    crate::git::connected(&mut state, &backend);
    crate::git::fixture_worktrees(&mut state);
    workspace::set_right_panel_tab(&mut state, workspace::RightPanelTab::Files);
    state
}

#[test]
fn portrait_start_keeps_landscape_closed_until_opened_while_landscape_tablet_remembers_both() {
    // Phone starting in portrait must not pop open docked drawers when rotated to landscape.
    let mut phone = touch_init();
    fixture(&mut phone);
    let mut rt = Runtime::new(phone, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));

    rt.set_viewport((844.0, 390.0), 1.0);
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "rotating a portrait-started phone to landscape must not open uninvited docked panels"
    );

    // Portrait tablet: open left docked, open right floating, rotate to landscape -> stays closed.
    let mut tablet = touch_init();
    fixture(&mut tablet);
    let mut rt = Runtime::new(tablet, english_touch, (768.0, 1024.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.visible(0) && !rt.state.shell.has_floating());
    click(&mut rt, "right-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
    rt.set_viewport((1024.0, 768.0), 1.0);
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1) && !rt.state.shell.has_floating(),
        "landscape must stay closed when started in portrait, even if a floating panel was open"
    );
    rt.set_viewport((768.0, 1024.0), 1.0);
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && !rt.state.shell.visible(1));

    // Landscape tablet starts docked, hides in portrait, remembers portrait choice independently.
    let mut landscape_tablet = touch_init();
    fixture(&mut landscape_tablet);
    let mut rt = Runtime::new(
        landscape_tablet,
        english_touch,
        (1366.0, 1024.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.set_viewport((1024.0, 1366.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.visible(0) && !rt.state.shell.visible(1));
    rt.set_viewport((1366.0, 1024.0), 1.0);
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.set_viewport((1024.0, 1366.0), 1.0);
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && !rt.state.shell.visible(1));
}

#[test]
fn keyboard_shrink_in_portrait_keeps_floating_drawer_and_search_focus_then_rotation_closes() {
    let mut state = touch_init();
    fixture(&mut state);
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    state.workspace = Some(workspace::Ui::new());
    workspace::opened(&mut state, &project);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    click(&mut rt, "sessions-panel-toggle");
    click(&mut rt, "session-search-toggle");
    click(&mut rt, "session-search");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(0));
    assert!(focus_inside(&rt, "/session-search/"));

    // Virtual keyboard opens in portrait: height shrinks below width while width stays 390.
    rt.set_viewport((390.0, 350.0), 1.0);
    settle(&mut rt);
    assert!(
        rt.state.shell.has_floating() && rt.state.shell.visible(0),
        "virtual keyboard shrink in portrait must not close the floating drawer"
    );
    assert!(
        focus_inside(&rt, "/session-search/"),
        "session-search must retain focus when the virtual keyboard opens"
    );

    // Genuine rotation to landscape while keyboard stays open closes the floating drawer and returns focus.
    rt.set_viewport((844.0, 240.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.has_floating() && !rt.state.shell.visible(0));
    assert_eq!(focused_key(&rt).as_deref(), Some("sessions-panel-toggle"));

    // Rotating back to portrait with keyboard still open recognizes portrait width again.
    rt.set_viewport((390.0, 350.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));

    // Near-square portrait with project tab bar (full window 390x410 is portrait even though shell height < 390).
    let mut near_square = touch_init();
    fixture(&mut near_square);
    let project = near_square
        .screen
        .launcher()
        .unwrap()
        .project
        .clone()
        .unwrap();
    near_square.workspace = Some(workspace::Ui::new());
    workspace::opened(&mut near_square, &project);
    let mut rt = Runtime::new(
        near_square,
        english_touch,
        (390.0, 410.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    rt.set_viewport((844.0, 390.0), 1.0);
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "near-square portrait start (390x410) must be recognized as portrait"
    );
}

#[test]
fn floating_right_panel_files_uses_full_floating_width() {
    let state = project_state_with_git();
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);

    click(&mut rt, "right-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
    let panel = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("right-panel"))
        .expect("right-panel mounted");
    let git_panel = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("git-panel"))
        .expect("git-panel mounted");
    assert!(
        (git_panel.rect[2] - panel.rect[2]).abs() <= 1.0,
        "floating git-panel width {} must fill floating right-panel width {}",
        git_panel.rect[2],
        panel.rect[2]
    );
}

#[test]
fn floating_right_panel_tab_reaches_panel_controls_and_wraps() {
    let state = project_state_with_git();
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    click(&mut rt, "right-panel-toggle");
    rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
    settle(&mut rt);

    // Shift+Tab from sessions-panel-toggle must wrap to the real last control in right-panel (Files), not the tab header or top bar.
    press_key(&mut rt, Key::Tab, true);
    assert!(
        focus_inside(&rt, "/right-panel/"),
        "Shift+Tab from sessions-panel-toggle must wrap into floating right-panel, got {:?}",
        focused_key(&rt)
    );
    assert_ne!(
        focused_key(&rt).as_deref(),
        Some("right-panel-tab-1"),
        "Shift+Tab must land on the last focusable Files control, not stop on the tab header"
    );

    // Forward Tab from that last control must wrap back to sessions-panel-toggle instead of escaping to the project tab bar.
    press_key(&mut rt, Key::Tab, false);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("sessions-panel-toggle"),
        "Tab from the last floating right-panel control must wrap back to sessions-panel-toggle"
    );

    // Tab forward all the way around, asserting every stop stays inside session-shell and visits right-panel-tab-1 and git-worktree-trigger.
    let mut reached_tab = false;
    let mut reached_worktree = false;
    let mut wrapped = false;
    for _ in 0..24 {
        press_key(&mut rt, Key::Tab, false);
        assert!(
            focus_inside(&rt, "/right-panel/")
                || matches!(
                    focused_key(&rt).as_deref(),
                    Some("sessions-panel-toggle" | "right-panel-toggle")
                ),
            "Tab escaped floating right drawer to {:?}",
            focused_key(&rt)
        );
        match focused_key(&rt).as_deref() {
            Some("right-panel-tab-1") => reached_tab = true,
            Some("git-worktree-trigger") => reached_worktree = true,
            Some("sessions-panel-toggle") => {
                wrapped = true;
                break;
            }
            _ => {}
        }
    }
    assert!(reached_tab, "Tab must enter right-panel-tab-1");
    assert!(
        reached_worktree,
        "Tab must reach git-worktree-trigger inside floating right panel"
    );
    assert!(
        wrapped,
        "Tab must wrap cleanly back to sessions-panel-toggle"
    );

    // Collapsed Status collapsible section (key "trigger" inside status-permissions) must also wrap cleanly.
    workspace::set_right_panel_tab(&mut rt.state, workspace::RightPanelTab::Status);
    let backend = Backend {
        workspace: "project".into(),
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    rt.state.status_permissions.fixture_bind(backend);
    settle(&mut rt);
    rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
    settle(&mut rt);
    press_key(&mut rt, Key::Tab, true);
    assert!(
        focus_inside(&rt, "/status-permissions/"),
        "Shift+Tab on collapsed Status section must reach status-permissions trigger, got {:?}",
        focused_key(&rt)
    );
    press_key(&mut rt, Key::Tab, false);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("sessions-panel-toggle"),
        "Tab from collapsed Status collapsible trigger must wrap back to sessions-panel-toggle"
    );
}

#[test]
fn escape_with_open_worktree_picker_in_floating_right_panel_closes_picker_only() {
    let state = project_state_with_git();
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    click(&mut rt, "right-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
    click(&mut rt, "git-worktree-trigger");
    assert!(crate::git::overlay_open(&rt.state));
    assert!(rt.find("option0").is_some());

    // Tab while the worktree Select is open must stay inside the Select modal, not jump to panel toggles.
    press_key(&mut rt, Key::Tab, false);
    assert!(
        crate::git::overlay_open(&rt.state)
            && !matches!(
                focused_key(&rt).as_deref(),
                Some("sessions-panel-toggle" | "right-panel-toggle")
            ),
        "Tab while worktree Select is open must remain inside the Select modal"
    );

    // First Escape closes only the worktree Select and keeps the floating right panel open.
    press_key(&mut rt, Key::Escape, false);
    assert!(
        !crate::git::overlay_open(&rt.state),
        "first Escape must close the open worktree Select"
    );
    assert!(
        rt.state.shell.has_floating() && rt.state.shell.visible(1),
        "first Escape must keep the floating right panel open"
    );
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("git-worktree-trigger"),
        "closing the worktree Select must return focus to its trigger"
    );

    // Second Escape closes the floating right panel and returns focus to its toggle.
    press_key(&mut rt, Key::Escape, false);
    assert!(!rt.state.shell.has_floating() && !rt.state.shell.visible(1));
    assert_eq!(focused_key(&rt).as_deref(), Some("right-panel-toggle"));

    // Reopen right panel + worktree picker, then rotate to landscape -> closes panel & picker and returns focus to toggle.
    click(&mut rt, "right-panel-toggle");
    click(&mut rt, "git-worktree-trigger");
    assert!(crate::git::overlay_open(&rt.state));
    rt.set_viewport((844.0, 390.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.has_floating() && !rt.state.shell.visible(1));
    assert!(!crate::git::overlay_open(&rt.state));
    assert_eq!(focused_key(&rt).as_deref(), Some("right-panel-toggle"));
}

#[test]
fn outside_top_bar_actions_dismiss_floating_drawer_without_stealing_focus() {
    let mut state = touch_init();
    fixture(&mut state);
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    state.workspace = Some(workspace::Ui::new());
    workspace::opened(&mut state, &project);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    click(&mut rt, "sessions-panel-toggle");
    click(&mut rt, "session-search-toggle");
    click(&mut rt, "session-search");
    assert!(rt.state.shell.has_floating());

    // Switching directly from floating left (with search focused) to floating right moves focus to right toggle.
    click(&mut rt, "right-panel-toggle");
    assert!(
        rt.state.shell.has_floating() && rt.state.shell.visible(1) && !rt.state.shell.visible(0)
    );
    assert_eq!(focused_key(&rt).as_deref(), Some("right-panel-toggle"));

    // Reopen left floating with search focused, then tap Notifications in top bar -> dismisses drawer without stealing focus.
    click(&mut rt, "sessions-panel-toggle");
    click(&mut rt, "session-search");
    assert!(rt.state.shell.has_floating());

    click(&mut rt, "notification-history-toggle");
    assert!(
        !rt.state.shell.has_floating(),
        "tapping a top-bar action outside the floating drawer must dismiss the floating drawer"
    );
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("notification-history-close")
    );
}

#[test]
fn screen_orientation_change_on_vertical_ime_shrink_does_not_flip_portrait() {
    let mut state = touch_init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);

    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(0));

    // Simulate a browser/emulator flipping screen.orientation to landscape when IME shrinks height below width.
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(390.0, 350.0, true, Some(false), tx);
    });
    assert!(
        rt.state.shell.has_floating() && rt.state.shell.visible(0),
        "vertical-only IME shrink must preserve portrait and keep floating drawer open even if screen.orientation reports landscape"
    );

    // Genuine rotation changes width as well as orientation -> closes floating drawer without opening docked panels.
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(844.0, 240.0, true, Some(false), tx);
    });
    assert!(
        !rt.state.shell.has_floating() && !rt.state.shell.visible(0) && !rt.state.shell.visible(1)
    );

    // Landscape-started tablet with IME open rotating to portrait with IME open uses screen.orientation change.
    let mut tablet = touch_init();
    fixture(&mut tablet);
    let mut rt = Runtime::new(
        tablet,
        english_touch,
        (1366.0, 1024.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1366.0, 500.0, true, Some(false), tx);
    });
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(true), tx);
    });
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "rotating from landscape to portrait with IME open must switch to portrait when screen.orientation changes"
    );
}

#[test]
fn landscape_tablet_rotating_with_ime_recovers_portrait_when_ime_closes_or_orientation_arrives() {
    // Sub-case 1: landscape tablet rotates with IME open while screen.orientation is unavailable, then IME closes.
    let mut tablet = touch_init();
    fixture(&mut tablet);
    let mut rt = Runtime::new(
        tablet,
        english_touch,
        (1366.0, 1024.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1366.0, 600.0, true, Some(false), tx);
    });
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(false), tx);
    });
    // Now keyboard closes at constant width 1024 (1024x1366 is unmistakably portrait).
    rt.update(|s, tx| {
        s.shell.measure_with_screen(1024.0, 1366.0, true, None, tx);
    });
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "closing IME at portrait aspect 1024x1366 must recover portrait and hide landscape panels"
    );

    // Sub-case 2: delayed screen.orientation=portrait arrives at constant width 1024x600.
    let mut tablet2 = touch_init();
    fixture(&mut tablet2);
    let mut rt = Runtime::new(
        tablet2,
        english_touch,
        (1366.0, 1024.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1366.0, 600.0, true, Some(false), tx);
    });
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(false), tx);
    });
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(true), tx);
    });
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "delayed screen.orientation=portrait at 1024x600 must recover portrait"
    );
}

#[test]
fn switching_pointer_to_touch_at_constant_viewport_recomputes_drawers() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english_touch, (768.0, 1024.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(
        rt.state.shell.visible(0),
        "mouse mode at 768x1024 starts with docked left panel"
    );

    // Switch convertible device from mouse to touch without resizing.
    rt.update(|s, _| s.shell.touch_override = true);
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "switching to touch at portrait 768x1024 must hide docked panels without waiting for a resize"
    );

    // Switch back from touch to mouse without resizing.
    rt.update(|s, _| s.shell.touch_override = false);
    settle(&mut rt);
    assert!(
        rt.state.shell.visible(0),
        "switching back to mouse at 768x1024 must restore docked left panel"
    );
}

#[test]
fn offline_git_worktree_picker_does_not_block_floating_drawer_escape() {
    let state = project_state_with_git();
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    click(&mut rt, "right-panel-toggle");
    click(&mut rt, "git-worktree-trigger");
    assert!(crate::git::overlay_open(&rt.state));

    // Connection drops while picker is open: Select hides its listbox because it is disabled.
    rt.update(|s, _| crate::git::online(s, false));
    settle(&mut rt);
    assert!(
        !crate::git::overlay_open(&rt.state),
        "offline hidden Git picker must not report overlay_open"
    );

    press_key(&mut rt, Key::Escape, false);
    assert!(
        !rt.state.shell.has_floating() && !rt.state.shell.visible(1),
        "Escape must close the floating right drawer once the hidden Git picker is cleared"
    );
    assert_eq!(focused_key(&rt).as_deref(), Some("right-panel-toggle"));
}

#[test]
fn rotating_from_portrait_floating_right_to_landscape_docked_closes_git_picker() {
    let state = project_state_with_git();
    let mut rt = Runtime::new(state, english_touch, (1024.0, 768.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));

    // Rotate to portrait 768x1024 (both hide), open left docked (260px), open right floating, open worktree picker.
    rt.set_viewport((768.0, 1024.0), 1.0);
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.visible(0) && !rt.state.shell.has_floating());
    click(&mut rt, "right-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
    click(&mut rt, "git-worktree-trigger");
    assert!(crate::git::overlay_open(&rt.state));
    assert!(rt.find("option0").is_some());

    // Rotate back to landscape 1024x768: right panel transitions directly from floating to docked.
    rt.set_viewport((1024.0, 768.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.has_floating() && rt.state.shell.visible(1));
    assert!(
        !crate::git::overlay_open(&rt.state) && rt.find("option0").is_none(),
        "rotating from floating right panel to docked landscape must close the anchored Git picker"
    );
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("right-panel-toggle"),
        "closing the floating drawer on rotation must return focus to right-panel-toggle"
    );
}

#[test]
fn git_changes_row_action_menu_closes_on_floating_to_docked_rotation_and_offline() {
    let path = "packages/rune-app/src/shell/mobile_drawers/very_long_nested_directory_name_to_trigger_compact_overflow_menu_on_tablet.rs";
    let trigger = format!("git-row-unstaged:menu:{path}:trigger");
    let item = format!("git-row-unstaged:menu:{path}:item:stage");

    // Sub-case 1: floating right panel -> open row action menu -> rotate to landscape docked.
    let mut state = project_state_with_git();
    crate::git::fixture_unstaged_change(&mut state, path);
    crate::git::set_mode(&mut state, crate::git::Mode::Changes);
    let mut rt = Runtime::new(state, english_touch, (1024.0, 768.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);

    rt.set_viewport((768.0, 1024.0), 1.0);
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    click(&mut rt, "right-panel-toggle");
    assert!(rt.state.shell.has_floating() && rt.state.shell.visible(1));
    click(&mut rt, &trigger);
    assert!(crate::git::overlay_open(&rt.state));
    assert!(
        rt.find(&item).is_some(),
        "precondition: row action menu item must be mounted while open"
    );

    rt.set_viewport((1024.0, 768.0), 1.0);
    rt.update(|s, tx| {
        crate::git::poll(s, 1.0, tx);
    });
    settle(&mut rt);
    assert!(
        !crate::git::overlay_open(&rt.state) && rt.find(&item).is_none(),
        "rotating from floating right panel to docked landscape must clear the rendered action_menu"
    );

    // Sub-case 2: floating right panel -> open row action menu -> connection drops offline.
    let mut state = project_state_with_git();
    crate::git::fixture_unstaged_change(&mut state, path);
    crate::git::set_mode(&mut state, crate::git::Mode::Changes);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    click(&mut rt, "right-panel-toggle");
    click(&mut rt, &trigger);
    assert!(crate::git::overlay_open(&rt.state) && rt.find(&item).is_some());

    rt.update(|s, tx| {
        crate::git::online(s, false);
        crate::git::poll(s, 1.0, tx);
    });
    settle(&mut rt);
    assert!(
        !crate::git::overlay_open(&rt.state) && rt.find(&item).is_none(),
        "going offline must clear the rendered Git row action_menu"
    );
}

#[test]
fn delayed_screen_orientation_change_event_remeasures_without_resize() {
    let mut tablet = touch_init();
    fixture(&mut tablet);
    let mut rt = Runtime::new(
        tablet,
        english_touch,
        (1366.0, 1024.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));

    // IME shrinks landscape height, then viewport narrows to 1024x600 while orientation still reads landscape.
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1366.0, 600.0, true, Some(false), tx);
    });
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(false), tx);
    });
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));

    // Delayed screen.orientation.change fires portrait with no viewport resize; shell::poll must remeasure.
    rt.update(|s, tx| {
        s.shell.test_orientation_pending = Some(Some(true));
        crate::shell::poll(s, tx);
    });
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "screen.orientation change event without viewport resize must recover portrait drawers"
    );
}

#[test]
fn portrait_start_memory_survives_pointer_round_trip_without_resize() {
    let mut state = touch_init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english_touch, (768.0, 1024.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));

    // Rotate to landscape in touch mode: stays closed because session started in portrait.
    rt.set_viewport((1024.0, 768.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.visible(0) && !rt.state.shell.visible(1));

    // Switch to pointer (mouse) at constant 1024x768: desktop mouse mode docks panels.
    rt.update(|s, _| s.shell.touch_override = false);
    settle(&mut rt);
    assert!(
        rt.state.shell.visible(0) && rt.state.shell.visible(1),
        "mouse mode at 1024x768 should dock panels normally"
    );

    // Switch back to touch at constant 1024x768: portrait-start memory must keep landscape drawers closed.
    rt.update(|s, _| s.shell.touch_override = true);
    settle(&mut rt);
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "returning to touch in landscape after a mouse round trip must preserve portrait-start memory"
    );
}

#[test]
fn rotating_while_notification_bubble_has_focus_keeps_bubble_focus() {
    let mut state = touch_init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.state.shell.has_floating());
    rt.update(|s, tx| {
        crate::settings::notification_fixture(s);
        crate::settings::notification_test_config(
            s,
            serde_json::json!({"settings":{"notificationRouting":{
                "settings":{"screen":true,"history":true,"system":false}
            }}}),
        );
        s.notifications.record();
        crate::shell::notifications::emit_outcome(
            s,
            crate::shell::notifications::Category::Settings,
            None,
            "Background notice",
            true,
        );
        crate::shell::notifications::poll(s, tx);
    });
    settle(&mut rt);
    assert!(
        rt.find("notification-text").is_some(),
        "precondition: notification bubble scroll area must be mounted"
    );
    click(&mut rt, "notification-text");
    assert_eq!(focused_key(&rt).as_deref(), Some("notification-text"));

    // Rotate phone to landscape: floating drawer closes, but focus must remain on the still-open bubble.
    rt.set_viewport((844.0, 390.0), 1.0);
    settle(&mut rt);
    assert!(!rt.state.shell.has_floating());
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("notification-text"),
        "closing a floating drawer on rotation must not steal focus from a notification bubble"
    );
}

#[test]
fn offline_during_session_placement_picker_returns_focus_to_composer() {
    let mut state = project_state_with_git();
    workspace::connected(&mut state);
    state.phase = crate::Phase::Ready;
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    let backend = Backend {
        workspace: project.id,
        session: "session".into(),
        ..Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    workspace::bound(&mut state, &backend);
    let mut agent = crate::agent::Ui::new(crate::agent::start(backend.clone(), state.wake.clone()));
    agent.fixture_ready();
    state.agent = Some(agent);
    crate::git::connected(&mut state, &backend);
    crate::git::fixture_worktrees(&mut state);
    let mut rt = Runtime::new(state, english_touch, (390.0, 844.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(
        crate::git::can_place(&rt.state),
        "precondition: session placement must be enabled before going offline"
    );
    rt.update(|s, _| crate::git::fixture_open_placement_picker(s));
    settle(&mut rt);
    assert!(crate::git::overlay_open(&rt.state));
    assert!(!focus_inside(&rt, "/composer/"));

    // Going offline disables placement; git::poll must close placement_picker and return focus to composer.
    rt.update(|s, tx| {
        crate::git::online(s, false);
        crate::git::poll(s, 1.0, tx);
    });
    settle(&mut rt);
    assert!(!crate::git::overlay_open(&rt.state));
    assert!(
        focus_inside(&rt, "/composer/"),
        "going offline while placement_picker is open must let git::poll return focus to composer, got {:?}",
        focused_key(&rt)
    );
}
