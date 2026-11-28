use super::*;
use crate::settings::responsive::SECTION_PICKER_TRIGGER_KEY;
use rune::{Env, Key, KeyEvent, Mods, Runtime};

fn fixture_runtime_locale(
    viewport: (f32, f32),
    dark: bool,
    locale: &'static str,
) -> Runtime<Window> {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.fixture_locale(locale);
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut rt = Runtime::new(state, view, viewport, Env::new(dark, 1.0));
    rt.on_key = lifecycle::spec().on_key;
    rt.frame(0.0);
    rt.frame(0.02);
    rt.frame(0.02);
    rt
}

fn fixture_runtime(viewport: (f32, f32), dark: bool) -> Runtime<Window> {
    fixture_runtime_locale(viewport, dark, "en")
}

fn click_key(rt: &mut Runtime<Window>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("expected clickable element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.frame(0.02);
}

fn press_key(rt: &mut Runtime<Window>, key: Key) {
    rt.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    rt.frame(0.02);
}

fn focused_key(rt: &Runtime<Window>) -> Option<String> {
    fn find_focused(tree: &serde_json::Value) -> Option<String> {
        if tree["states"]
            .as_array()
            .is_some_and(|states| states.iter().any(|s| s == "focused"))
            && let Some(key) = tree["key"].as_str()
        {
            return Some(key.to_string());
        }
        tree["children"].as_array()?.iter().find_map(find_focused)
    }
    find_focused(&rt.accessibility_json())
}

#[test]
fn narrow_compact_bar_opens_directly_on_general_and_switches_sections_via_picker() {
    for dark in [false, true] {
        for (w, h) in [(411.0, 890.0), (360.0, 800.0)] {
            let mut rt = fixture_runtime((w, h), dark);
            assert!(rt.state.is_narrow(), "expected narrow mode at {w}x{h}");
            assert_eq!(rt.state.section, Section::General);
            assert!(rt.find("settings-compact-bar").is_some());
            assert!(rt.find(SECTION_PICKER_TRIGGER_KEY).is_some());
            assert!(rt.find("settings-close").is_some());
            assert!(rt.find("general").is_some());
            assert!(rt.find("settings-section-picker-list").is_none());

            for (nav_key, pane_key, expected_section) in [
                ("settings-voice", "voice", Section::Voice),
                ("settings-providers", "providers", Section::Providers),
                ("settings-remote", "remote", Section::Remote),
                ("settings-general", "general", Section::General),
            ] {
                click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
                assert!(rt.state.narrow.picker_open());
                assert!(rt.find("settings-section-picker-list").is_some());
                click_key(&mut rt, nav_key);
                assert_eq!(rt.state.section, expected_section);
                assert!(!rt.state.narrow.picker_open());
                assert!(rt.find("settings-section-picker-list").is_none());
                assert!(rt.find(pane_key).is_some());
                assert_eq!(
                    focused_key(&rt).as_deref(),
                    Some(SECTION_PICKER_TRIGGER_KEY),
                    "selecting {pane_key} must return focus to the section picker trigger"
                );
            }
        }
    }
}

#[test]
fn narrow_rtl_hebrew_compact_bar_switches_sections_and_closes_picker_on_escape() {
    for dark in [false, true] {
        for (w, h) in [(411.0, 890.0), (360.0, 800.0)] {
            let mut rt = fixture_runtime_locale((w, h), dark, "he");
            assert!(rt.state.is_narrow());
            assert!(rt.find("settings-compact-bar").is_some());
            assert!(rt.find("general").is_some());

            click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
            assert!(rt.state.narrow.picker_open());
            click_key(&mut rt, "settings-remote");
            assert_eq!(rt.state.section, Section::Remote);
            assert!(!rt.state.narrow.picker_open());
            assert!(rt.find("remote").is_some());

            click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
            assert!(rt.state.narrow.picker_open());
            press_key(&mut rt, Key::Escape);
            assert!(!rt.state.narrow.picker_open());
            assert!(!rt.state.closing);
            assert_eq!(
                focused_key(&rt).as_deref(),
                Some(SECTION_PICKER_TRIGGER_KEY)
            );
        }
    }
}

#[test]
fn narrow_escape_closes_section_picker_before_closing_preferences() {
    let mut rt = fixture_runtime((411.0, 890.0), true);
    assert!(!rt.state.narrow.picker_open());

    click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
    assert!(rt.state.narrow.picker_open());

    // First Escape closes the compact section picker and restores focus to the trigger.
    press_key(&mut rt, Key::Escape);
    assert!(!rt.state.narrow.picker_open());
    assert!(!rt.state.closing);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some(SECTION_PICKER_TRIGGER_KEY)
    );

    // Second Escape requests closing Preferences.
    press_key(&mut rt, Key::Escape);
    assert!(rt.state.closing);
}

#[test]
fn narrow_ime_vertical_shrink_preserves_open_section() {
    let mut rt = fixture_runtime((411.0, 890.0), false);
    click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
    click_key(&mut rt, "settings-providers");
    assert_eq!(rt.state.section, Section::Providers);
    assert!(rt.find("providers").is_some());

    // Soft keyboard reducing viewport height vertically preserves the active section.
    rt.set_viewport((411.0, 500.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert!(rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Providers);
    assert!(rt.find("providers").is_some());

    rt.set_viewport((411.0, 890.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::Providers);
    assert!(rt.find("providers").is_some());
}

#[test]
fn narrow_wide_resize_round_trip_and_desktop_breakpoint_preserve_active_section() {
    // Desktop 1100x760, 760x560, and 600x700 keep the split layout without compact bar.
    for (w, h) in [(1100.0, 760.0), (760.0, 560.0), (600.0, 700.0)] {
        let rt = fixture_runtime((w, h), false);
        assert!(!rt.state.is_narrow(), "{w}x{h} must stay wide");
        assert!(rt.find("settings-compact-bar").is_none());
        assert!(rt.find("settings-general").is_some());
        assert!(rt.find("general").is_some());
    }

    // 599 pt crosses into narrow mode.
    let rt_599 = fixture_runtime((599.0, 700.0), false);
    assert!(rt_599.state.is_narrow(), "599pt must be narrow");
    assert!(rt_599.find("settings-compact-bar").is_some());

    // Round-trip: narrow -> pick Voice -> widen -> Voice stays active -> narrow -> Voice stays active.
    let mut rt = fixture_runtime((411.0, 890.0), false);
    click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
    click_key(&mut rt, "settings-voice");
    assert_eq!(rt.state.section, Section::Voice);

    rt.set_viewport((900.0, 760.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert!(!rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Voice);
    assert!(rt.find("settings-compact-bar").is_none());
    assert!(rt.find("voice").is_some());

    rt.set_viewport((411.0, 890.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert!(rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Voice);
    assert!(rt.find("settings-compact-bar").is_some());
    assert!(rt.find("voice").is_some());
}

#[test]
fn open_remote_and_open_providers_switch_section_and_respect_dirty_guards() {
    // 1. Fresh narrow window with open_section = Remote opens directly on Remote.
    let mut rt = fixture_runtime((411.0, 890.0), false);
    rt.state.shared.borrow_mut().open_section = Some(Section::Remote);
    rt.update(|s, tx| {
        lifecycle::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::Remote);
    assert!(!rt.state.narrow.picker_open());
    assert!(rt.find("remote").is_some());

    // 2. Requesting Providers while on Remote switches directly to Providers.
    rt.state.shared.borrow_mut().open_section = Some(Section::Providers);
    rt.update(|s, tx| {
        lifecycle::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::Providers);
    assert!(rt.find("providers").is_some());

    // 3. Switch to General and create an unsaved palette draft.
    click_key(&mut rt, SECTION_PICKER_TRIGGER_KEY);
    click_key(&mut rt, "settings-general");
    assert_eq!(rt.state.section, Section::General);
    click_key(&mut rt, "palette-new");
    assert!(rt.state.general.dirty());

    // 4. Requesting Remote while General has unsaved draft prompts discard instead of losing edits.
    rt.state.shared.borrow_mut().open_section = Some(Section::Remote);
    rt.update(|s, tx| {
        lifecycle::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::General);
    assert_eq!(rt.state.pending_section, Some(Section::Remote));
    assert!(rt.find("file-decision-cancel").is_some());
    assert!(rt.find("file-decision-confirm").is_some());

    // Cancel preserves draft on General.
    click_key(&mut rt, "file-decision-cancel");
    assert_eq!(rt.state.section, Section::General);
    assert!(rt.state.general.dirty());
    assert!(rt.state.pending_section.is_none());

    // Request again and confirm discard -> enters Remote.
    rt.state.shared.borrow_mut().open_section = Some(Section::Remote);
    rt.update(|s, tx| {
        lifecycle::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
    click_key(&mut rt, "file-decision-confirm");
    assert_eq!(rt.state.section, Section::Remote);
    assert!(!rt.state.general.dirty());
    assert!(rt.find("remote").is_some());

    // 5. Unavailable section request falls back cleanly to Section::General without crashing.
    rt.state.shared.borrow_mut().open_section = Some(Section::ConfigFiles);
    rt.update(|s, tx| {
        lifecycle::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::General);
    assert!(rt.find("general").is_some());
}

#[test]
fn settings_open_remote_public_entrypoint_is_callable_and_safe() {
    let mut app = crate::init();
    let woken = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let woken_flag = woken.clone();
    {
        let mut prefs = app.settings.shared.borrow_mut();
        prefs.fixture_locale("en");
        prefs.window_wake = Some(std::sync::Arc::new(move || {
            woken_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
    }
    crate::settings::open_remote(&mut app);
    assert_eq!(
        app.settings.shared.borrow().open_section,
        Some(Section::Remote)
    );
    let _keep_alive = app
        .settings
        .window
        .as_ref()
        .map(|(_, token, _)| token.clone());
    app.settings.shared.borrow_mut().open_section = None;
    crate::settings::open_remote(&mut app);
    assert_eq!(
        app.settings.shared.borrow().open_section,
        Some(Section::Remote)
    );
    assert!(woken.load(std::sync::atomic::Ordering::SeqCst));
    crate::settings::close(&mut app);
}
