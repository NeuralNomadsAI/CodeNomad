use super::*;
use rune::{Env, Key, KeyEvent, Mods, Runtime};

fn fixture_runtime(viewport: (f32, f32), dark: bool) -> Runtime<Window> {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.fixture_locale("en");
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

fn assert_no_horizontal_overflow(rt: &Runtime<Window>, viewport_w: f32, context: &str) {
    let elements = rt.elements();
    for el in &elements {
        if el.rect[2] <= 0.0 || el.rect[3] <= 0.0 {
            continue;
        }
        assert!(
            el.rect[0] >= -1.0 && el.rect[0] + el.rect[2] <= viewport_w + 1.0,
            "{context}: element {:?} (key={:?}, path={}) overflowed {viewport_w}pt viewport: rect={:?}",
            el.role,
            el.key,
            el.path,
            el.rect,
        );
    }
}

#[test]
fn narrow_411_and_360_list_and_detail_have_no_horizontal_overflow_light_and_dark() {
    for dark in [false, true] {
        for (w, h) in [(411.0, 890.0), (360.0, 800.0)] {
            let mut rt = fixture_runtime((w, h), dark);
            assert!(rt.state.is_narrow(), "dark={dark} ({w}x{h}) must be narrow");
            assert_eq!(rt.state.narrow_view, NarrowView::List);

            // Narrow list mounts header + close button + full-width section list, no back button.
            assert!(rt.find("settings-narrow-list").is_some());
            assert!(rt.find("settings-close").is_some());
            assert!(rt.find("settings-narrow-back").is_none());

            let header = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some("settings-narrow-header"))
                .expect("narrow header");
            assert!(
                (header.rect[2] - w).abs() <= 1.0,
                "header must span full width {w}: {:?}",
                header.rect
            );
            assert_eq!(header.radius, 0.0, "header must keep square corners");

            let general_row = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some("settings-general"))
                .expect("settings-general row");
            assert!(
                general_row.rect[2] > w - 32.0,
                "narrow nav row must span viewport width instead of 260pt rail: {:?}",
                general_row.rect
            );
            assert_no_horizontal_overflow(&rt, w, &format!("list dark={dark} {w}x{h}"));

            // Open General, Voice (Dictée), and Providers (Fournisseurs) and verify full-width detail.
            for (nav_key, pane_key, expected_section) in [
                ("settings-general", "general", Section::General),
                ("settings-voice", "voice", Section::Voice),
                ("settings-providers", "providers", Section::Providers),
            ] {
                click_key(&mut rt, nav_key);
                assert_eq!(rt.state.section, expected_section);
                assert_eq!(rt.state.narrow_view, NarrowView::Detail);
                assert!(
                    rt.find("settings-narrow-list").is_none(),
                    "narrow list must unmount in detail view for {pane_key}"
                );
                assert!(
                    rt.find("settings-narrow-back").is_some(),
                    "back button must mount in detail view for {pane_key}"
                );
                assert_eq!(
                    focused_key(&rt).as_deref(),
                    Some("settings-narrow-back"),
                    "opening {pane_key} must focus the back button"
                );

                let pane = rt
                    .elements()
                    .into_iter()
                    .find(|el| el.key.as_deref() == Some(pane_key))
                    .unwrap_or_else(|| panic!("expected detail pane {pane_key}"));
                assert!(
                    (pane.rect[2] - w).abs() <= 1.0,
                    "{pane_key} detail pane must span full width {w} without 260pt rail: {:?}",
                    pane.rect
                );
                assert_no_horizontal_overflow(
                    &rt,
                    w,
                    &format!("detail {pane_key} dark={dark} {w}x{h}"),
                );

                // Back button returns to section list and restores focus to that section row.
                click_key(&mut rt, "settings-narrow-back");
                assert_eq!(rt.state.narrow_view, NarrowView::List);
                assert!(rt.find("settings-narrow-list").is_some());
                assert_eq!(
                    focused_key(&rt).as_deref(),
                    Some(nav_key),
                    "returning from {pane_key} must restore focus to {nav_key}"
                );
            }
        }
    }
}

#[test]
fn narrow_keyboard_arrows_stay_in_list_and_escape_returns_before_closing() {
    let mut rt = fixture_runtime((411.0, 890.0), true);
    assert_eq!(rt.state.narrow_view, NarrowView::List);

    rt.update(|_, tx| tx.focus("settings-general", true));
    rt.frame(0.02);
    assert_eq!(focused_key(&rt).as_deref(), Some("settings-general"));

    // ArrowDown navigates within the list without auto-opening a section.
    press_key(&mut rt, Key::Down);
    assert_eq!(rt.state.narrow_view, NarrowView::List);
    assert_eq!(focused_key(&rt).as_deref(), Some("settings-conversation"));
    assert_eq!(rt.state.section, Section::General);

    // Enter opens the focused section and moves focus to the back button.
    press_key(&mut rt, Key::Enter);
    assert_eq!(rt.state.section, Section::Conversation);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);
    assert_eq!(focused_key(&rt).as_deref(), Some("settings-narrow-back"));
    assert!(!rt.state.closing);

    // First Escape returns from Detail -> List and restores focus to the active section row.
    press_key(&mut rt, Key::Escape);
    assert_eq!(rt.state.narrow_view, NarrowView::List);
    assert!(!rt.state.closing);
    assert_eq!(focused_key(&rt).as_deref(), Some("settings-conversation"));

    // Second Escape from List requests closing the Preferences window.
    press_key(&mut rt, Key::Escape);
    assert!(rt.state.closing);
}

#[test]
fn narrow_ime_vertical_shrink_preserves_open_section_and_focus() {
    let mut rt = fixture_runtime((411.0, 890.0), false);
    click_key(&mut rt, "settings-providers");
    assert_eq!(rt.state.section, Section::Providers);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);
    assert_eq!(focused_key(&rt).as_deref(), Some("settings-narrow-back"));

    // Simulate soft keyboard / IME reducing viewport height vertically on Xiaomi 14.
    rt.set_viewport((411.0, 500.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);

    assert!(rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Providers);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);
    assert!(rt.find("settings-narrow-back").is_some());
    let pane = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("providers"))
        .expect("providers pane remains mounted under IME shrink");
    assert!((pane.rect[2] - 411.0).abs() <= 1.0);

    // Restoring full portrait height keeps the section open.
    rt.set_viewport((411.0, 890.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert_eq!(rt.state.section, Section::Providers);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);
}

#[test]
fn narrow_wide_resize_round_trip_preserves_active_section() {
    let mut rt = fixture_runtime((411.0, 890.0), true);
    click_key(&mut rt, "settings-voice");
    assert_eq!(rt.state.section, Section::Voice);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);

    // Widen to desktop / landscape: side-by-side nav + Voice pane without losing Voice.
    rt.set_viewport((1024.0, 768.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert!(!rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Voice);
    assert!(rt.find("settings-narrow-back").is_none());
    assert!(rt.find("settings-voice").is_some());
    assert!(rt.find("voice").is_some());

    // Switch to Providers while wide, then narrow back to phone portrait: Providers stays open in Detail.
    click_key(&mut rt, "settings-providers");
    assert_eq!(rt.state.section, Section::Providers);

    rt.set_viewport((411.0, 890.0), 1.0);
    rt.frame(0.02);
    rt.frame(0.02);
    assert!(rt.state.is_narrow());
    assert_eq!(rt.state.section, Section::Providers);
    assert_eq!(rt.state.narrow_view, NarrowView::Detail);
    assert!(rt.find("settings-narrow-back").is_some());
    assert!(rt.find("settings-narrow-list").is_none());
    let pane = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("providers"))
        .expect("providers pane stays open after wide -> narrow resize");
    assert!((pane.rect[2] - 411.0).abs() <= 1.0);
}
