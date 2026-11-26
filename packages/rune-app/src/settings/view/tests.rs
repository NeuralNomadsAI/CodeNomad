use super::*;
mod palettes_startup;
use rune::{Env, Runtime};
use serde_json::Value;

#[test]
fn unsupported_advanced_switch_is_disabled_with_keyboard_help() {
    fn find_switch(tree: &Value) -> Option<&Value> {
        if tree["role"] == "switch" && tree["name"] == "Hold long assistant replies" {
            return Some(tree);
        }
        tree["children"].as_array()?.iter().find_map(find_switch)
    }

    let state = Window {
        section: Section::Advanced,
        ..Window::default()
    };
    let mut prefs = state.shared.borrow_mut();
    prefs.fixture();
    prefs.fixture_locale("en");
    prefs.backend = Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    drop(prefs);
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let tree = rt.accessibility_json();
    let switch = find_switch(&tree).unwrap();
    assert!(
        switch["states"]
            .as_array()
            .unwrap()
            .contains(&Value::from("disabled"))
    );
    rt.update(|_, tx| tx.focus("advanced-help-holdLongAssistantReplies", true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text(" ".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(rt.state.advanced_help == Some(crate::settings::advanced::Toggle::LongReplies));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_second_launch_advanced_switch_is_enabled_and_stages_change() {
    fn find_switch(tree: &Value) -> Option<&Value> {
        if tree["role"] == "switch" && tree["name"] == "Focus existing window on second launch" {
            return Some(tree);
        }
        tree["children"].as_array()?.iter().find_map(find_switch)
    }

    let state = Window {
        section: Section::Advanced,
        ..Window::default()
    };
    let mut prefs = state.shared.borrow_mut();
    prefs.fixture();
    prefs.fixture_locale("en");
    prefs.backend = Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    drop(prefs);
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let tree = rt.accessibility_json();
    let switch = find_switch(&tree).unwrap();
    let states = switch["states"].as_array().unwrap();
    assert!(!states.contains(&Value::from("disabled")));
    assert!(!states.contains(&Value::from("checked")));

    rt.state
        .shared
        .borrow_mut()
        .set_advanced_toggle(crate::settings::advanced::Toggle::SecondLaunch, true);
    assert!(
        rt.state
            .shared
            .borrow()
            .advanced_pending(crate::settings::advanced::Toggle::SecondLaunch)
    );
}

#[test]
fn keyboard_shortcuts_records_the_focused_save_binding() {
    let mut state = Window {
        section: Section::Shortcuts,
        ..Window::default()
    };
    state.shortcut_filter.replace_text("Save file");
    state.shared.borrow_mut().fixture();
    state.shared.borrow_mut().fixture_locale("en");
    state.shared.borrow_mut().backend =
        Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.02);
    let click_edit = |rt: &mut Runtime<Window>| {
        let (x, y) = rt.find("settings-file-save-edit").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert!(rt.state.recording_shortcut);
    };
    click_edit(&mut rt);
    rt.key(rune::KeyEvent {
        key: rune::Key::Escape,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.recording_shortcut);
    assert!(!rt.state.shared.borrow().file_save_pending());
    click_edit(&mut rt);
    rt.window_focus(false);
    rt.frame(0.02);
    rt.window_focus(true);
    rt.frame(0.02);
    assert!(!rt.state.recording_shortcut);
    // Newly wired shell shortcuts have unique edit keys and can record bindings too.
    rt.update(|s, _| s.shortcut_filter.replace_text("Previous app tab"));
    rt.frame(0.02);
    let (x, y) = rt.find("settings-instance-prev-edit").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.state.recording_shortcut);
    rt.key(rune::KeyEvent {
        key: rune::Key::Escape,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.recording_shortcut);
    rt.update(|s, _| s.shortcut_filter.replace_text("Save file"));
    rt.frame(0.02);

    click_edit(&mut rt);
    rt.key(rune::KeyEvent {
        key: rune::Key::Function(8),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.recording_shortcut);
    assert!(rt.state.shared.borrow().file_save_pending());
}

#[test]
fn stats_tab_mounts_without_opening_a_project() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let (x, y) = rt.find("settings-stats").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(rt.state.section == Section::Stats);
    let tree = rt.accessibility_json().to_string();
    let expected = crate::strings::with_locale(
        rt.state
            .shared
            .borrow()
            .locale()
            .unwrap_or_else(crate::strings::locale),
        || t("settings.usage.noProject"),
    );
    assert!(tree.contains(expected), "{tree}");
    assert!(rt.find("stats-refresh").is_none());
    assert!(rt.find("stats-period").is_none());
}

#[test]
fn notifications_tab_mounts_the_routing_table_and_the_focused_switch() {
    let state =
        Window::default().with_notification_permission(notification_settings::Permission::Granted);
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    assert!(node(&rt.accessibility_json(), "updates-system").is_none());
    let (x, y) = rt.find("settings-notifications").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    let tree = rt.accessibility_json();
    let system = node(&tree, "updates-system").unwrap();
    assert_eq!(system["role"], "check-box");
    assert!(system["states"].to_string().contains("\"checked\""));
    assert_eq!(
        node(&tree, "notifications-allow-focused").unwrap()["role"],
        "switch"
    );
}

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

fn listbox(tree: &Value) -> Option<&Value> {
    if tree["role"] == "list-box" {
        return Some(tree);
    }
    tree["children"].as_array()?.iter().find_map(listbox)
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
        let list = listbox(&tree).expect("open palette menu");
        assert!(list.to_string().contains(option));
        assert!(!list.to_string().contains(absent));
        runtime.key(rune::KeyEvent {
            key: rune::Key::Escape,
            mods: rune::Mods::default(),
        });
        runtime.frame(0.02);
        let tree = runtime.accessibility_json();
        assert!(listbox(&tree).is_none());
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
    let menu = listbox(&tree).unwrap();
    assert!(menu.to_string().contains("Linen"));
    assert!(menu.to_string().contains("focused"));

    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
    runtime.frame(0.02);
    let tree_after_same_slot = runtime.accessibility_json();
    assert_eq!(listbox(&tree_after_same_slot).unwrap(), menu);
    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("system"));
    runtime.set_system_dark(true);
    runtime.frame(0.02);
    let tree = runtime.accessibility_json();
    assert!(listbox(&tree).is_none());
    assert!(
        node(&tree, "palette-trigger").unwrap()["states"]
            .to_string()
            .contains("focused")
    );
    press(&mut runtime, rune::Key::Enter);
    let tree = runtime.accessibility_json();
    assert!(listbox(&tree).unwrap().to_string().contains("Basalt"));
    runtime.update(|s, _| s.shared.borrow_mut().fixture_mode("light"));
    runtime.frame(0.02);
    assert!(listbox(&runtime.accessibility_json()).is_none());
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
        assert!(listbox(&runtime.accessibility_json()).is_none());
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
        assert!(listbox(&tree).is_none());
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
    assert!(listbox(&tree).unwrap().to_string().contains("Français"));
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

#[test]
fn pending_permissions_keep_tab_focus_and_refuse_new_selections() {
    const KEY: &str = "new-conversation-permissions-trigger";
    let state = Window::default();
    let mut prefs = state.shared.borrow_mut();
    prefs.fixture_locale("en");
    prefs.backend = Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    drop(prefs);
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    rt.update(|_, tx| tx.focus(KEY, true));
    rt.frame(0.02);
    let focused = |rt: &Runtime<Window>| {
        let a11y = rt.accessibility_json();
        node(&a11y, KEY).unwrap()["states"]
            .to_string()
            .contains("focused")
    };
    assert!(focused(&rt));
    rt.update(|s, _| {
        s.shared
            .borrow_mut()
            .set_new_conversation_permissions("supervised")
    });
    rt.frame(0.02);
    assert!(focused(&rt));
    let trigger = rt
        .elements()
        .into_iter()
        .find(|entry| entry.key.as_deref() == Some(KEY))
        .unwrap();
    assert!(trigger.focusable);

    let press = |rt: &mut Runtime<Window>, key| {
        rt.key(rune::KeyEvent {
            key,
            mods: Default::default(),
        });
        rt.frame(0.02);
    };
    press(&mut rt, rune::Key::Tab);
    assert!(!focused(&rt));
    rt.key(rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods {
            shift: true,
            ..Default::default()
        },
    });
    rt.frame(0.02);
    assert!(
        focused(&rt),
        "Tab navigation still includes the pending control"
    );
    press(&mut rt, rune::Key::Enter);
    press(&mut rt, rune::Key::Down);
    let (x, y) = rt.find(KEY).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(listbox(&rt.accessibility_json()).is_none());
    assert_eq!(
        rt.state.shared.borrow().new_conversation_permissions(),
        "autonomous"
    );
}

#[test]
fn behavior_permissions_picker_steps_closed_without_opening_popup() {
    const KEY: &str = "new-conversation-permissions-trigger";
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture_locale("en");
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    rt.update(|_, tx| tx.focus(KEY, true));
    rt.frame(0.02);
    assert!(
        !rt.state
            .shared
            .borrow()
            .new_conversation_permissions_pending()
    );
    rt.key(rune::KeyEvent {
        key: rune::Key::Down,
        mods: Default::default(),
    });
    rt.frame(0.02);
    assert!(listbox(&rt.accessibility_json()).is_none());
    assert!(
        rt.state
            .shared
            .borrow()
            .new_conversation_permissions_pending()
    );
}

#[test]
fn native_preferences_close_requires_discard_consent_from_both_paths() {
    let shared = Rc::new(RefCell::new(Preferences::default()));
    shared.borrow_mut().fixture_locale("en");
    let request = Rc::new(CloseRequest::default());
    let mut state = Window::new(shared.clone(), Rc::new(Cell::new(false)))
        .with_close_request(request.clone(), None);
    state.memory_editor.fixture_dirty();
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    // This is the same request the main-window Settings button enqueues.
    request.requested.set(true);
    runtime.update(|s, tx| {
        spec().poll.unwrap()(s, 0.0, tx);
    });
    runtime.frame(0.02);
    assert!(runtime.state.confirm_close.is_some());
    assert!(runtime.find("file-decision-cancel").is_some());
    let (x, y) = runtime.find("file-decision-cancel").unwrap();
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    runtime.frame(0.02);
    assert!(runtime.state.confirm_close.is_none() && runtime.state.memory_editor.has_unsaved());
    // Rune calls its OS close hook after hiding; the draft is held until the parent reopens.
    assert!(runtime.state.retain_editor_on_native_close());
    let editor = request.reopen.borrow_mut().take().unwrap();
    let restored =
        Window::new(shared, Rc::new(Cell::new(false))).with_close_request(request, Some(editor));
    assert!(restored.confirm_close.is_some() && restored.memory_editor.has_unsaved());
    let mut runtime = Runtime::new(restored, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    runtime.frame(0.02);
    let (x, y) = runtime.find("file-decision-confirm").unwrap();
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    runtime.frame(0.02);
    assert!(!runtime.state.memory_editor.has_unsaved());
}

#[test]
fn general_behavior_renders_six_checkboxes_natively_and_hides_keep_awake_on_web() {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture_locale("en");
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let tree = rt.accessibility_json();
    let expected = [
        (
            "behavior-showMessageTimeline",
            "Show the message timeline",
            true,
        ),
        (
            "behavior-scrollControlsInTimelineCorner",
            "Put the first/latest message arrows under the timeline",
            false,
        ),
        ("behavior-diffViewMode", "Split tool-call diffs", true),
        (
            "behavior-autoExpandActiveSubsessions",
            "Automatically expand subsessions",
            true,
        ),
        ("behavior-followUpBehavior", "Queue sent prompts", false),
        (
            "behavior-keepComputerAwake",
            "Keep the computer awake while CodeNomad is running",
            false,
        ),
    ];
    for (key, name, checked) in expected {
        let checkbox = node(&tree, key).unwrap_or_else(|| panic!("missing {key}"));
        assert_eq!(checkbox["role"], "check-box");
        assert_eq!(checkbox["name"], name);
        let states = checkbox["states"].as_array().unwrap();
        assert_eq!(
            states.contains(&Value::from("checked")),
            checked,
            "{key}: {states:?}"
        );
    }
    assert!(node(&tree, "behavior-help-autoExpandActiveSubsessions").is_some());
    assert!(node(&tree, "behavior-help-newConversationPermissions").is_some());
    assert!(node(&tree, "behavior-help-keepComputerAwake").is_some());

    rt.update(|_, tx| tx.focus("behavior-showMessageTimeline", true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text(" ".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json();
    let timeline = node(&tree, "behavior-showMessageTimeline").unwrap();
    let states = timeline["states"].as_array().unwrap();
    assert!(
        states.contains(&Value::from("focused")),
        "pending toggle keeps focus: {states:?}"
    );
    assert!(
        states.contains(&Value::from("checked")),
        "authoritative value stays checked until confirmed: {states:?}"
    );
    assert!(rt.state.shared.borrow().general_toggle_pending(
        super::super::preferences::behavior::GeneralToggle::MessageTimeline
    ));
    rt.key(rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Tab,
        mods: rune::Mods {
            shift: true,
            ..Default::default()
        },
    });
    rt.frame(0.02);
    let tree = rt.accessibility_json();
    let states = node(&tree, "behavior-showMessageTimeline").unwrap()["states"]
        .as_array()
        .unwrap();
    assert!(
        states.contains(&Value::from("focused")),
        "Tab navigation still includes the pending checkbox: {states:?}"
    );
    let revision_before = rt.state.shared.borrow().revision;
    rt.key(rune::KeyEvent {
        key: rune::Key::Text(" ".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(
        rt.state.shared.borrow().revision,
        revision_before,
        "a second press while pending must not restage the toggle"
    );

    struct WebCard {
        shared: Rc<RefCell<Preferences>>,
        behavior: super::super::behavior::General,
    }
    let shared = Rc::new(RefCell::new(Preferences::default()));
    {
        let mut prefs = shared.borrow_mut();
        prefs.fixture_locale("en");
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut web_rt = Runtime::new(
        WebCard {
            shared,
            behavior: Default::default(),
        },
        |s, cx| {
            let prefs = s.shared.borrow();
            render_with(cx, &prefs, false, false, |_| {
                let mut layers = Vec::new();
                s.behavior
                    .view(&s.shared, false, &mut layers, |s: &mut WebCard| {
                        &mut s.behavior
                    })
                    .children(layers)
            })
        },
        chrome::WINDOW_SIZE,
        Env::new(false, 1.0),
    );
    web_rt.frame(0.0);
    let web_tree = web_rt.accessibility_json();
    for (key, _, _) in &expected[..5] {
        assert!(node(&web_tree, key).is_some(), "web missing {key}");
    }
    assert!(node(&web_tree, "new-conversation-permissions-trigger").is_some());
    assert!(
        node(&web_tree, "behavior-keepComputerAwake").is_none(),
        "keepComputerAwake must stay native-only"
    );
    assert!(
        !web_tree
            .to_string()
            .contains("Keep the computer awake while CodeNomad is running")
    );
}

#[test]
fn conversation_preferences_render_presets_headers_and_all_21_rows_in_solid_order() {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    let mut rt = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    rt.frame(0.0);
    let (x, y) = rt.find("settings-conversation").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    let tree = rt.accessibility_json();
    let mut headings = Vec::new();
    let mut columns = Vec::new();
    let mut rowheaders = Vec::new();
    let mut presets = Vec::new();
    fn collect(
        node: &serde_json::Value,
        headings: &mut Vec<String>,
        columns: &mut Vec<String>,
        rowheaders: &mut Vec<String>,
        presets: &mut Vec<(String, bool)>,
    ) {
        let role = node["role"].as_str().unwrap_or_default();
        let name = node["name"].as_str().unwrap_or_default();
        match role {
            "heading" if !name.is_empty() => headings.push(name.to_owned()),
            "column-header" => columns.push(name.to_owned()),
            "row-header" => rowheaders.push(name.to_owned()),
            "button" if matches!(name, "Nothing" | "Minimal" | "Balanced" | "Everything") => {
                let checked = node["states"]
                    .as_array()
                    .is_some_and(|states| states.iter().any(|s| s == "checked"));
                presets.push((name.to_owned(), checked));
            }
            _ => {}
        }
        if let Some(children) = node["children"].as_array() {
            for child in children {
                collect(child, headings, columns, rowheaders, presets);
            }
        }
    }
    collect(
        &tree,
        &mut headings,
        &mut columns,
        &mut rowheaders,
        &mut presets,
    );
    assert!(
        headings.iter().any(|h| h == "Transcript detail presets"),
        "missing presets card heading: {headings:?}"
    );
    assert_eq!(columns, vec!["Item", "Default state"]);
    assert_eq!(
        presets,
        vec![
            ("Nothing".to_owned(), false),
            ("Minimal".to_owned(), false),
            ("Balanced".to_owned(), true),
            ("Everything".to_owned(), false),
        ]
    );
    let expected_rows = vec![
        "thinking",
        "Diagnostic",
        "Input",
        "Tokens",
        "System",
        "Tool groups",
        "shell",
        "read",
        "write",
        "edit",
        "patch",
        "webfetch",
        "websearch",
        "glob",
        "grep",
        "subagent",
        "execute",
        "skill",
        "question",
        "invalid",
        "Other",
    ];
    assert_eq!(rowheaders, expected_rows);
    let groups_key = "transcript-toolGroupVisibility-trigger";
    let groups_node = node(&tree, groups_key).unwrap();
    assert_eq!(groups_node["role"], "combo-box");
    let groups_row = groups_node.to_string();
    assert!(
        groups_row.contains("Tool groups") && groups_row.contains("Collapsed"),
        "{groups_row}"
    );
    assert_eq!(
        node(&tree, "transcript-read-trigger").unwrap()["role"],
        "combo-box"
    );
    // Enter opens the focused row picker and Tool groups offers Disabled.
    rt.update(|_, tx| tx.focus(groups_key, true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(
        rt.state.transcript_picker.get(),
        Some(super::super::TranscriptRow::Groups)
    );
    let open_tree = rt.accessibility_json().to_string();
    assert!(
        open_tree.contains("Disabled"),
        "Tool groups must offer Disabled"
    );
    // A failed authoritative config read dismisses the open picker modal so Retry stays unobstructed.
    rt.update(|s, _| {
        s.shared.borrow_mut().fixture_config_read_failed(true);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.transcript_picker.get(), None);
    rt.update(|s, _| {
        s.shared.borrow_mut().fixture_config_read_failed(false);
    });
    rt.frame(0.02);
    assert_eq!(rt.state.transcript_picker.get(), None);

    // ArrowRight on focused Balanced preset button must NOT activate or stage a preset change,
    // while Enter on focused Minimal preset button DOES activate Minimal.
    rt.update(|_, tx| tx.focus("transcript-preset-2", true));
    rt.frame(0.02);
    let balanced_rev = rt.state.shared.borrow().revision;
    rt.key(rune::KeyEvent {
        key: rune::Key::Right,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(rt.state.shared.borrow().revision, balanced_rev);
    assert_eq!(rt.state.shared.borrow().transcript_preset(), "balanced");

    rt.update(|_, tx| tx.focus("transcript-preset-1", true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(rt.state.shared.borrow().revision > balanced_rev);
    assert_eq!(
        rt.state
            .shared
            .borrow()
            .transcript_mode(super::super::TranscriptRow::Diagnostics, true),
        "collapsed"
    );

    // Reopen, then ConnectionLost (mark_transport_lost) clears the open picker and disables controls
    // until a post-outage config read revalidates authority.
    rt.update(|_, tx| tx.focus(groups_key, true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(
        rt.state.transcript_picker.get(),
        Some(super::super::TranscriptRow::Groups)
    );
    rt.update(|s, _| {
        s.shared.borrow_mut().mark_transport_lost();
    });
    rt.frame(0.02);
    assert_eq!(rt.state.transcript_picker.get(), None);
    assert!(!rt.state.shared.borrow().transcript_ready());
    assert_eq!(
        rt.state.shared.borrow().transcript_error(),
        Some("rune.connect_error")
    );
    let offline_tree = rt.accessibility_json().to_string();
    assert!(
        offline_tree.contains("\"role\":\"alert\"") && offline_tree.contains("Connection failed"),
        "transport_lost must render the connection error alert in Chat: {offline_tree}"
    );
    assert!(
        offline_tree.contains("\"name\":\"Retry\",\"role\":\"button\""),
        "transport_lost must render the Retry button in Chat: {offline_tree}"
    );

    // Preset grid reflows from 4 columns on wide Chat container (1100px window) to 2×2 on narrow
    // Chat container (760px window, where sidebar shrinks Chat below 42rem / 672px).
    let preset_rect = |rt: &rune::Runtime<Window>, key: &str| {
        rt.elements()
            .iter()
            .find(|node| node.key.as_deref() == Some(key))
            .unwrap()
            .rect
    };
    let b0_wide = preset_rect(&rt, "transcript-preset-0");
    let b2_wide = preset_rect(&rt, "transcript-preset-2");
    assert!(
        (b0_wide[1] - b2_wide[1]).abs() < 1.0,
        "wide Chat container must place all 4 presets on one row: {b0_wide:?} vs {b2_wide:?}"
    );
    rt.set_viewport((760.0, 560.0), 1.0);
    for _ in 0..3 {
        rt.frame(0.02);
    }
    let b0_narrow = preset_rect(&rt, "transcript-preset-0");
    let b2_narrow = preset_rect(&rt, "transcript-preset-2");
    assert!(
        b2_narrow[1] > b0_narrow[1] + b0_narrow[3] * 0.5,
        "narrow Chat container (<672px) must fold presets into a 2×2 grid: {b0_narrow:?} vs {b2_narrow:?}"
    );
}
