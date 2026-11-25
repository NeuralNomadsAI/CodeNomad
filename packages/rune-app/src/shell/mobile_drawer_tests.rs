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
    rt.update(|_, tx| tx.focus("right-panel-toggle", true));
    settle(&mut rt);

    press_key(&mut rt, Key::Tab, false);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some("right-panel-tab-1"),
        "Tab from right-panel-toggle must enter the floating right panel instead of jumping back to sessions-panel-toggle"
    );

    // Keep tabbing through Files controls to confirm git-worktree-trigger is reachable.
    let mut reached_worktree = false;
    for _ in 0..8 {
        press_key(&mut rt, Key::Tab, false);
        if focused_key(&rt).as_deref() == Some("git-worktree-trigger") {
            reached_worktree = true;
            break;
        }
    }
    assert!(
        reached_worktree,
        "Tab must reach git-worktree-trigger inside floating right panel"
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
            .measure_with_screen(390.0, 350.0, true, Some(false), tx)
    });
    assert!(
        rt.state.shell.has_floating() && rt.state.shell.visible(0),
        "vertical-only IME shrink must preserve portrait and keep floating drawer open even if screen.orientation reports landscape"
    );

    // Genuine rotation changes width as well as orientation -> closes floating drawer without opening docked panels.
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(844.0, 240.0, true, Some(false), tx)
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
            .measure_with_screen(1366.0, 500.0, true, Some(false), tx)
    });
    assert!(rt.state.shell.visible(0) && rt.state.shell.visible(1));
    rt.update(|s, tx| {
        s.shell
            .measure_with_screen(1024.0, 600.0, true, Some(true), tx)
    });
    assert!(
        !rt.state.shell.visible(0) && !rt.state.shell.visible(1),
        "rotating from landscape to portrait with IME open must switch to portrait when screen.orientation changes"
    );
}
