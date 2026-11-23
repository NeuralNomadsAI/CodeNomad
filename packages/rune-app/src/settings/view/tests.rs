use super::*;
use rune::{Env, Runtime};
use serde_json::Value;

#[test]
fn contrast_control_changes_only_the_contrast_choice() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    state.shared.borrow_mut().backend =
        Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.set_system_increased_contrast(true);
    rt.frame(0.02);
    let tree = rt.accessibility_json();
    let group = node(&tree, "contrast-mode").unwrap();
    let off = node(group, "segment2").unwrap();
    let bounds = off["bounds"].as_array().unwrap();
    let center =
        |i: usize| (bounds[i].as_f64().unwrap() + bounds[i + 2].as_f64().unwrap() / 2.0) as f32;
    rt.pointer_down(center(0), center(1));
    rt.pointer_up(center(0), center(1));
    rt.frame(0.02);
    let prefs = rt.state.shared.borrow();
    assert_eq!(prefs.contrast(), "off");
    assert_eq!(prefs.mode_display(), "system");
    assert!(!super::super::effective_contrast(prefs.contrast(), true));
}

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
}

#[test]
fn settings_opencode_focus_refreshes_without_forcing_a_registry_recheck() {
    crate::platform::block_on(async {
        use std::time::Duration;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            time::timeout,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = crate::backend::Backend::unauthenticated(&format!(
            "http://{}/",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let state = Window {
            section: Section::OpenCode,
            ..Window::default()
        };
        state.shared.borrow_mut().fixture();
        state.shared.borrow_mut().backend = Some(backend);
        state.shared.borrow_mut().window_wake = Some(std::sync::Arc::new(|| {}));
        let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        rt.frame(0.0);
        rt.window_focus(false);
        rt.window_focus(true);
        rt.frame(0.02);
        let accept = || async {
            let mut socket = timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap()
                .0;
            let mut request = Vec::new();
            timeout(Duration::from_secs(3), async {
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                }
            })
            .await
            .unwrap();
            assert!(request.starts_with(b"GET /api/opencode/update HTTP/1.1\r\n"));
            socket
        };
        let mut first = accept().await;
        for _ in 0..2 {
            rt.window_focus(false);
            rt.window_focus(true);
            rt.frame(0.02);
        }
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        let body = r#"{"state":"ready","serviceState":"ready","currentVersion":"2.3.0"}"#;
        first
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            while !rt.state.opencode.poll() {
                crate::platform::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        rt.state.check_opencode(None);
        let _second = accept().await;
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn settings_shutdown_failure_warning_requires_visible_acknowledgement() {
    let mut runtime = Runtime::new("en", save_warning, (460.0, 150.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    let tree = runtime.accessibility_json().to_string();
    assert!(tree.contains("Could not save the preference."));
    assert!(tree.contains("\"role\":\"alert\""));
    assert!(tree.contains("\"name\":\"OK\""));
}

#[test]
fn settings_opencode_versions_and_fold_use_the_runtime() {
    let mut state = Window::default();
    state.shared.borrow_mut().fixture();
    state.opencode.fixture();
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let click = |rt: &mut Runtime<Window>, key| {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
    };
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Installed version")
    );
    click(&mut rt, "settings-opencode");
    let before = rt.accessibility_json().to_string();
    assert!(before.contains("2.3.0") && before.contains("2.2.5"));
    assert!(!before.contains("Minimum version"));
    click(&mut rt, "trigger");
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Minimum version")
    );
    click(&mut rt, "settings-general");
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Installed version")
    );
}

#[test]
fn settings_palette_selector_uses_active_appearance_and_returns_focus_on_escape() {
    for (dark, option, absent) in [(false, "Linen", "Basalt"), (true, "Basalt", "Linen")] {
        let state = Window::default();
        state.shared.borrow_mut().fixture();
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(dark, 1.0));
        runtime.frame(0.0);
        let tree = runtime.accessibility_json();
        assert_eq!(node(&tree, "locale-trigger").unwrap()["value"], "English");
        let (x, y) = runtime.find("palette-trigger").unwrap();
        runtime.pointer_down(x, y);
        runtime.pointer_up(x, y);
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        let list = node(&tree, "listbox").expect("open palette menu");
        assert!(list.to_string().contains(option));
        assert!(!list.to_string().contains(absent));
        runtime.key(rune::KeyEvent {
            key: rune::Key::Escape,
            mods: rune::Mods::default(),
        });
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        assert!(node(&tree, "listbox").is_none());
        let trigger = node(&tree, "palette-trigger").unwrap();
        assert!(trigger["states"].to_string().contains("collapsed"));
        assert!(trigger["states"].to_string().contains("focused"));
    }
}

#[test]
fn settings_palette_menu_tracks_effective_appearance_and_returns_keyboard_focus() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    let press = |rt: &mut Runtime<Window>, key| {
        let event = rune::KeyEvent {
            key,
            mods: rune::Mods::default(),
        };
        rt.key(event.clone());
        rt.key_up(event);
        rt.frame(0.02);
    };
    runtime.frame(0.0);
    runtime.update(|_, tx| tx.focus("palette-trigger", true));
    runtime.frame(0.02);
    press(&mut runtime, rune::Key::Enter);
    press(&mut runtime, rune::Key::Down);
    let tree = runtime.accessibility_json();
    let menu = node(&tree, "listbox").unwrap();
    assert!(menu.to_string().contains("Linen"));
    assert!(menu.to_string().contains("focused"));

    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
    runtime.frame(0.02);
    let tree_after_same_slot = runtime.accessibility_json();
    assert_eq!(node(&tree_after_same_slot, "listbox").unwrap(), menu);
    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("system"));
    runtime.set_system_dark(true);
    runtime.frame(0.02);
    let tree = runtime.accessibility_json();
    assert!(node(&tree, "listbox").is_none());
    assert!(
        node(&tree, "palette-trigger").unwrap()["states"]
            .to_string()
            .contains("focused")
    );
    press(&mut runtime, rune::Key::Enter);
    let tree = runtime.accessibility_json();
    assert!(
        node(&tree, "listbox")
            .unwrap()
            .to_string()
            .contains("Basalt")
    );
    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
    runtime.frame(0.02);
    assert!(node(&runtime.accessibility_json(), "listbox").is_none());
}

#[test]
fn settings_palette_pointer_release_cannot_commit_a_stale_system_slot() {
    for change_theme in [false, true] {
        let state = Window::default();
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend = Some(
            crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
                .unwrap(),
        );
        drop(prefs);
        let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
        runtime.frame(0.0);
        let (x, y) = runtime.find("palette-trigger").unwrap();
        runtime.pointer_down(x, y);
        runtime.pointer_up(x, y);
        runtime.frame(0.02);
        let (x, y) = runtime.find("option1").unwrap();
        runtime.pointer_down(x, y);
        runtime.frame(0.02);
        runtime.pointer_up(x, y);
        runtime.set_system_dark(change_theme);
        runtime.frame(0.02);
        let prefs = runtime.state.shared.borrow();
        assert_eq!(
            prefs.palette_display(false).unwrap().id == "light",
            change_theme
        );
        assert!(node(&runtime.accessibility_json(), "listbox").is_none());
    }
}

#[test]
fn settings_closed_palette_arrow_keeps_focus_and_advances_the_display() {
    let state = Window::default();
    let mut prefs = state.shared.borrow_mut();
    prefs.fixture();
    prefs.backend = Some(
        crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
            .unwrap(),
    );
    drop(prefs);
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(true, 1.0));
    runtime.frame(0.0);
    runtime.update(|_, tx| tx.focus("palette-trigger", true));
    runtime.frame(0.02);
    for name in ["Mist", "Slate", "Clay"] {
        let event = rune::KeyEvent {
            key: rune::Key::Down,
            mods: rune::Mods::default(),
        };
        runtime.key(event.clone());
        runtime.key_up(event);
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        let trigger = node(&tree, "palette-trigger").unwrap();
        assert_eq!(trigger["value"], name);
        assert!(trigger["states"].to_string().contains("focused"));
        assert!(node(&tree, "listbox").is_none());
    }
}

#[test]
fn settings_mode_keeps_keyboard_focus_while_the_choice_is_unconfirmed() {
    let state = Window::default();
    let mut prefs = state.shared.borrow_mut();
    prefs.fixture();
    prefs.backend = Some(
        crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
            .unwrap(),
    );
    drop(prefs);
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|_, tx| tx.focus("segment0", true));
    runtime.frame(0.02);
    for key in ["segment1", "segment2"] {
        let event = rune::KeyEvent {
            key: rune::Key::Right,
            mods: rune::Mods::default(),
        };
        runtime.key(event.clone());
        runtime.key_up(event);
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        assert!(
            node(&tree, key).unwrap()["states"]
                .to_string()
                .contains("focused")
        );
    }
    let prefs = runtime.state.shared.borrow();
    assert_eq!(prefs.mode(), "system");
    assert_eq!(prefs.mode_display(), "light");
    assert!(!prefs.palette_ready());
}

#[test]
fn settings_language_picker_opens_with_enter() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|_, tx| tx.focus("locale-trigger", true));
    runtime.frame(0.02);
    runtime.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    });
    runtime.frame(0.02);
    let tree = runtime.accessibility_json();
    assert!(
        node(&tree, "listbox")
            .unwrap()
            .to_string()
            .contains("Français")
    );
}

#[test]
fn conversation_preferences_show_the_tokens_choice_on_a_new_profile() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    runtime.frame(0.0);
    let (x, y) = runtime.find("settings-conversation").unwrap();
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    for _ in 0..8 {
        runtime.frame(0.02);
    }
    let tree = runtime.accessibility_json();
    let row = node(&tree, "usage-visibility-trigger").unwrap().to_string();
    assert!(row.contains("Tokens") && row.contains("Hidden"), "{row}");
}
