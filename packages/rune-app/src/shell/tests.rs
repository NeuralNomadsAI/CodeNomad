use crate::{State, gallery::shell::fixture, init, strings};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
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
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("{key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

#[test]
fn right_panel_selects_files_and_restores_its_focus_on_shrink() {
    let mut state = init();
    fixture(&mut state);
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    state.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut state, &project);
    let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "right-panel-tab-1");
    assert!(crate::workspace::files_tab(&rt.state));
    rt.update(|_, tx| tx.focus("right-panel-tab-1", true));
    settle(&mut rt);
    rt.set_viewport((580.0, 900.0), 1.0);
    settle(&mut rt);
    assert!(rt.find("right-panel").is_none());
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.focused && e.key.as_deref() == Some("right-panel-toggle"))
    );
    rt.set_viewport((1400.0, 900.0), 1.0);
    settle(&mut rt);
    assert!(rt.find("right-panel-tab-1").is_some());
    assert!(crate::workspace::files_tab(&rt.state));
    click(&mut rt, "right-panel-tab-0");
    assert!(!crate::workspace::files_tab(&rt.state));
}

#[test]
fn a_large_session_catalogue_mounts_only_visible_rows_but_search_reaches_the_tail() {
    let mut state = init();
    fixture(&mut state);
    state.screen.launcher_mut().unwrap().sessions = (0..2_100)
        .map(|i| crate::catalog::Session {
            id: format!("catalogue-{i}"),
            title: format!("Row {i:04}"),
        })
        .collect();
    let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    assert!(rt.find("session-catalogue-0").is_some());
    assert!(rt.find("session-catalogue-2099").is_none());
    assert!(
        rt.elements()
            .iter()
            .filter(|e| e
                .key
                .as_deref()
                .is_some_and(|key| key.starts_with("session-catalogue-")))
            .count()
            < 100
    );
    click(&mut rt, "session-search-toggle");
    click(&mut rt, "session-search");
    rt.paste("Row 2099");
    settle(&mut rt);
    assert!(rt.find("session-catalogue-2099").is_some());
}

#[test]
fn fixed_toggles_keep_their_positions_and_drawers_retrace_on_resize() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (1400.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let left = rt.find("sessions-panel-toggle").unwrap();
    let right = rt.find("right-panel-toggle").unwrap();
    assert!(rt.find("session-session").is_some());
    assert!(rt.find("right-panel").is_some());
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("session-session").is_none());
    assert_eq!(rt.find("sessions-panel-toggle"), Some(left));
    assert_eq!(rt.find("right-panel-toggle"), Some(right));
    click(&mut rt, "sessions-panel-toggle");
    for (width, panels) in [
        (1000.0, [true, true]),
        (930.0, [true, true]),
        (929.0, [true, false]),
        (610.0, [true, false]),
        (609.0, [false, false]),
        (390.0, [false, false]),
        (610.0, [true, false]),
        (930.0, [true, true]),
        (1400.0, [true, true]),
    ] {
        rt.set_viewport((width, 900.0), 1.0);
        settle(&mut rt);
        assert_eq!(
            [
                rt.find("session-session").is_some(),
                rt.find("right-panel").is_some()
            ],
            panels,
            "width {width}"
        );
        assert_eq!(rt.find("sessions-panel-toggle"), Some(left));
        assert_eq!(
            rt.find("right-panel-toggle"),
            Some((right.0 + width - 1400.0, right.1))
        );
    }
}

#[test]
fn floating_drawers_are_exclusive_and_escape_leaves_the_docked_choice() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (390.0, 900.0), Env::new(true, 1.0));
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("session-session").is_some());
    click(&mut rt, "right-panel-toggle");
    assert!(rt.find("session-session").is_none());
    assert!(rt.find("right-panel").is_some());
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(rt.find("right-panel").is_none());
    rt.set_viewport((1400.0, 900.0), 1.0);
    settle(&mut rt);
    assert!(rt.find("session-session").is_some() && rt.find("right-panel").is_some());
}

#[test]
fn a_floating_right_panel_docks_when_the_left_panel_makes_room() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (800.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "right-panel-toggle");
    assert!(rt.find("right-panel").is_some());
    assert!(rt.find("right-panel-resize").is_none());
    click(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("sessions-panel").is_none());
    assert!(rt.find("right-panel-resize").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("\"key\":\"composer\"")
    );
}

#[test]
fn both_grips_resize_in_the_correct_direction_in_both_locales() {
    for (render, rtl) in [
        (english as fn(&State, &mut Cx<State>) -> El, false),
        (hebrew, true),
    ] {
        let mut state = init();
        fixture(&mut state);
        let mut rt = Runtime::new(state, render, (1600.0, 900.0), Env::new(false, 1.0));
        settle(&mut rt);
        let x = |rt: &Runtime<State>, key| rt.find(key).unwrap().0;
        assert_eq!(
            x(&rt, "sessions-panel-toggle") > x(&rt, "right-panel-toggle"),
            rtl
        );
        for (panel, grip, left) in [
            ("sessions-panel", "sessions-panel-resize", true),
            ("right-panel", "right-panel-resize", false),
        ] {
            let width = |rt: &Runtime<State>| {
                rt.elements()
                    .into_iter()
                    .find(|e| e.key.as_deref() == Some(panel))
                    .unwrap()
                    .rect[2]
            };
            let before = width(&rt);
            let (x, y) = rt.find(grip).unwrap();
            if left {
                assert_eq!(x > 700.0, rtl);
            }
            let dx = if left != rtl { 100.0 } else { -100.0 };
            rt.pointer_down(x, y);
            settle(&mut rt);
            rt.pointer_move(x + dx, 20.0);
            settle(&mut rt);
            assert!((width(&rt) - before - 100.0).abs() < 1.0, "{panel}");
            rt.pointer_up(x + dx, 20.0);
            settle(&mut rt);
            assert!((width(&rt) - before - 100.0).abs() < 1.0);
        }
    }
}

#[test]
fn compressed_grip_starts_at_its_presented_width_and_accepts_keyboard() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (700.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let width = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("sessions-panel"))
            .unwrap()
            .rect[2]
    };
    assert_eq!(width(&rt), 310.0);
    let (x, y) = rt.find("sessions-panel-resize").unwrap();
    rt.pointer_down(x, y);
    settle(&mut rt);
    rt.pointer_move(x - 20.0, y);
    settle(&mut rt);
    rt.pointer_up(x - 20.0, y);
    settle(&mut rt);
    assert_eq!(width(&rt), 290.0);
    rt.update(|_, tx| tx.focus("sessions-panel-resize", true));
    settle(&mut rt);
    rt.key(KeyEvent {
        key: Key::Left,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(width(&rt) < 290.0);
}

#[test]
fn session_search_keeps_the_pressed_control_when_the_field_mounts() {
    let mut state = init();
    fixture(&mut state);
    state.screen.launcher_mut().unwrap().show_title = true;
    let mut rt = Runtime::new(state, english, (600.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    let key = "session-search-toggle";
    let path = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|element| element.key.as_deref() == Some(key))
            .unwrap()
            .path
    };
    let before = path(&rt, key);
    let create = path(&rt, "create-session");
    let (x, y) = rt.find(key).unwrap();
    rt.pointer_down(x, y);
    rt.update(|s, _| s.screen.launcher_mut().unwrap().show_search = true);
    rt.frame(0.02);
    assert!(rt.find("session-search").is_some());
    let after = path(&rt, key);
    assert_eq!(path(&rt, "create-session"), create);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(
        !rt.state.screen.launcher().unwrap().show_search,
        "pointer release was lost after reparenting: {before} → {after}"
    );
    assert_eq!(before, after);
}

#[test]
fn resizing_out_of_room_returns_focus_from_the_search_editor() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (1000.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "session-search-toggle");
    assert!(rt.find("session-search").is_some());
    assert!(rt.find("session-title").is_none());
    assert!(
        !rt.elements()
            .iter()
            .any(|element| element.focused && element.path.contains("/session-search/"))
    );
    click(&mut rt, "session-search");
    assert!(
        rt.elements()
            .iter()
            .any(|element| element.focused && element.path.contains("/session-search/"))
    );
    rt.set_viewport((600.0, 900.0), 1.0);
    settle(&mut rt);
    assert!(
        rt.elements()
            .iter()
            .any(|element| element.focused
                && element.key.as_deref() == Some("sessions-panel-toggle"))
    );
}

#[test]
fn escape_from_the_search_editor_closes_its_floating_panel() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (600.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    click(&mut rt, "sessions-panel-toggle");
    click(&mut rt, "session-search-toggle");
    click(&mut rt, "session-search");
    for shift in [false, true] {
        let event = KeyEvent {
            key: Key::Function(6),
            mods: Mods {
                shift,
                ..Mods::default()
            },
        };
        rt.key(event.clone());
        settle(&mut rt);
        assert!(
            rt.elements()
                .iter()
                .any(|element| element.focused && element.path.contains("/session-search/"))
        );
        rt.key_up(event);
    }
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(rt.find("session-search").is_none());
    assert!(
        rt.elements()
            .iter()
            .any(|element| element.focused
                && element.key.as_deref() == Some("sessions-panel-toggle"))
    );
}

#[test]
fn enter_activates_a_panel_toggle() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (600.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
    settle(&mut rt);
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(rt.find("session-session").is_some());
}

#[test]
fn keyboard_focus_wraps_at_the_visible_floating_drawer_edges() {
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, english, (600.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let focused = |rt: &Runtime<State>, key| {
        rt.elements()
            .iter()
            .any(|e| e.focused && e.key.as_deref() == Some(key))
    };
    for (toggle, last) in [
        ("sessions-panel-toggle", "refresh-sessions"),
        ("right-panel-toggle", "right-panel-tab-0"),
    ] {
        if !rt
            .state
            .shell
            .visible(usize::from(toggle == "right-panel-toggle"))
        {
            click(&mut rt, toggle);
        }
        rt.update(|_, tx| tx.focus("sessions-panel-toggle", true));
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods {
                shift: true,
                ..Mods::default()
            },
        });
        settle(&mut rt);
        assert!(focused(&rt, last));
        rt.key_up(KeyEvent {
            key: Key::Tab,
            mods: Mods {
                shift: true,
                ..Mods::default()
            },
        });
        rt.key(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(focused(&rt, "sessions-panel-toggle"));
        rt.key_up(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
    }
}

#[test]
fn tab_after_a_background_click_returns_to_the_floating_drawer() {
    fn render(s: &State, cx: &mut Cx<State>) -> El {
        use rune_theme_codenomad::layout::Layout;
        rune::col()
            .full_width()
            .full_height()
            .child(crate::components::button(
                "outside",
                "Outside",
                false,
                |_| {},
            ))
            .child(english(s, cx).remaining())
    }
    let mut state = init();
    fixture(&mut state);
    let mut rt = Runtime::new(state, render, (600.0, 900.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    click(&mut rt, "right-panel-toggle");
    rt.pointer_down(300.0, 500.0);
    rt.pointer_up(300.0, 500.0);
    settle(&mut rt);
    rt.key(KeyEvent {
        key: Key::Tab,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(
        rt.elements()
            .iter()
            .any(|e| e.key.as_deref() == Some("right-panel-toggle") && e.focused)
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn direct_authentication_dialog_keeps_shell_paths_on_show_and_hide() {
    let mut state = init();
    fixture(&mut state);
    state.screen = crate::Screen::Chat { launcher: None };
    let mut rt = Runtime::new(state, english, (1000.0, 900.0), Env::new(false, 1.0));
    settle(&mut rt);
    let path = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|element| element.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("{key}"))
            .path
    };
    let keys = ["session-shell", "conversation-draft", "composer"];
    let before: Vec<_> = keys.iter().map(|key| path(&rt, key)).collect();
    assert!(rt.find("direct-recovery-dialog").is_none());
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    rt.update(|s, _| {
        crate::chat::authentication::expired(
            s,
            codenomad_client::transport::Authentication {
                backend,
                confirmed: true,
            },
        );
    });
    settle(&mut rt);
    assert!(rt.find("direct-recovery-dialog").is_some());
    assert_eq!(
        keys.iter().map(|key| path(&rt, key)).collect::<Vec<_>>(),
        before
    );
    rt.update(|s, _| {
        s.direct_authentication = Default::default();
    });
    settle(&mut rt);
    assert!(rt.find("direct-recovery-dialog").is_none());
    assert_eq!(
        keys.iter().map(|key| path(&rt, key)).collect::<Vec<_>>(),
        before
    );
}

#[test]
fn notification_bubbles_keep_their_path_across_composer_overlays() {
    let mut state = init();
    fixture(&mut state);
    let (commands, _receiver) = codenomad_client::bounded(1);
    state.commands = Some(commands);
    crate::settings::notification_fixture(&state);
    crate::settings::notification_test_config(
        &state,
        serde_json::json!({"settings":{"notificationRouting":{
            "settings":{"screen":true,"history":true,"system":false}
        }}}),
    );
    state.notifications.record();
    crate::shell::notifications::emit_outcome(
        &mut state,
        crate::shell::notifications::Category::Settings,
        None,
        "Write failed",
        true,
    );
    let mut rt = Runtime::new(state, english, (1000.0, 900.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        crate::shell::notifications::poll(s, tx);
    });
    settle(&mut rt);
    let path = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|element| element.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("{key}"))
            .path
    };
    let before = path(&rt, "notification-bubbles");
    let before_dismiss = path(&rt, "notification-dismiss-0");
    assert!(!rt.state.composer.picker.open());
    rt.update(|_, tx| tx.focus("composer", false));
    settle(&mut rt);
    rt.paste("/");
    settle(&mut rt);
    assert!(rt.state.composer.picker.open());
    assert!(rt.elements().iter().any(|e| e.role == "listbox"));
    assert_eq!(path(&rt, "notification-bubbles"), before);
    assert_eq!(path(&rt, "notification-dismiss-0"), before_dismiss);
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(!rt.state.composer.picker.open());
    assert_eq!(path(&rt, "notification-bubbles"), before);
    assert_eq!(path(&rt, "notification-dismiss-0"), before_dismiss);
}

#[test]
fn topbar_shows_three_icon_actions_on_desktop_and_touch_and_gates_remote_by_capability() {
    fn french(s: &State, cx: &mut Cx<State>) -> El {
        strings::with_locale("fr", || crate::view(s, cx))
    }
    let locales: [(&str, fn(&State, &mut Cx<State>) -> El); 3] =
        [("en", english), ("fr", french), ("he", hebrew)];
    for dark in [false, true] {
        for touch in [false, true] {
            for (locale, render_fn) in locales {
                let mut state = init();
                fixture(&mut state);
                state.shell.touch_override = touch;
                let project = state.screen.launcher().unwrap().project.clone().unwrap();
                state.workspace = Some(crate::workspace::Ui::new());
                crate::workspace::opened(&mut state, &project);
                let size = if touch {
                    (390.0, 844.0)
                } else {
                    (1400.0, 900.0)
                };
                let mut rt = Runtime::new(state, render_fn, size, Env::new(dark, 1.0));
                settle(&mut rt);

                let elements = rt.elements();
                let find_el = |key: &str| {
                    elements
                        .iter()
                        .find(|e| e.key.as_deref() == Some(key))
                        .unwrap_or_else(|| {
                            panic!("missing {key} (dark={dark}, touch={touch}, locale={locale})")
                        })
                };
                let new_btn = find_el("project-tabs-new");
                let settings = find_el("open-preferences");
                let bell = find_el("notification-history-toggle");
                let remote = find_el("open-remote-control");
                let expected_side = if touch { 44.0 } else { new_btn.rect[2] };
                assert!(expected_side > 0.0 && new_btn.rect[2] == new_btn.rect[3]);
                for el in [settings, bell, remote] {
                    assert_eq!(el.rect[2], expected_side);
                    assert_eq!(el.rect[3], expected_side);
                    assert!(el.rect[0] >= 0.0 && el.rect[0] + el.rect[2] <= size.0);
                }
                let expected_settings =
                    strings::with_locale(locale, || strings::t("settings.title"));
                let expected_settings_help =
                    strings::with_locale(locale, || strings::t("settings.open.title"));
                let expected_bell =
                    strings::with_locale(locale, || strings::t("toastHistory.title"));
                let expected_remote =
                    strings::with_locale(locale, || strings::t("instanceTabs.remote.ariaLabel"));
                let expected_remote_help =
                    strings::with_locale(locale, || strings::t("instanceTabs.remote.title"));
                assert_eq!(settings.label.as_deref(), Some(expected_settings));
                assert_eq!(settings.help.as_deref(), Some(expected_settings_help));
                assert_eq!(bell.label.as_deref(), Some(expected_bell));
                assert_eq!(remote.label.as_deref(), Some(expected_remote));
                assert_eq!(remote.help.as_deref(), Some(expected_remote_help));
                assert!(
                    !elements
                        .iter()
                        .any(|e| e.text.as_deref() == Some(expected_settings)),
                    "topbar Settings must be an icon button without text label ({locale})"
                );
                let rtl = rune_theme_codenomad::catalogue::direction(locale) == "rtl";
                if rtl {
                    assert!(settings.rect[0] > bell.rect[0] && bell.rect[0] > remote.rect[0]);
                } else {
                    assert!(settings.rect[0] < bell.rect[0] && bell.rect[0] < remote.rect[0]);
                }

                // Clicking the bell toggles notification history and active expanded state.
                click(&mut rt, "notification-history-toggle");
                assert!(crate::shell::notifications::history_open(&rt.state));
                click(&mut rt, "notification-history-close");
                assert!(!crate::shell::notifications::history_open(&rt.state));
            }
        }
    }

    // Attested backend capabilities gate the Remote Control icon like Solid hostSupports().
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        let attest_with = |caps_json: &'static str| -> crate::backend::Backend {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let handle = thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let body = format!(
                        r#"{{"serverId":"srv-topbar","apiContract":1,"capabilities":{caps_json}}}"#
                    );
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                }
            });
            let backend =
                crate::backend::Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let ok = crate::platform::block_on(backend.attest_server()).is_ok();
            let _ = handle.join();
            assert!(ok);
            backend
        };

        for (caps, expected_visible) in [(r#"[]"#, false), (r#"["remote-control"]"#, true)] {
            let backend = attest_with(caps);
            let mut state = init();
            fixture(&mut state);
            state.screen.launcher_mut().unwrap().connection = Some(backend);
            let project = state.screen.launcher().unwrap().project.clone().unwrap();
            state.workspace = Some(crate::workspace::Ui::new());
            crate::workspace::opened(&mut state, &project);
            let mut rt = Runtime::new(state, english, (1200.0, 800.0), Env::new(false, 1.0));
            settle(&mut rt);
            assert!(rt.find("open-preferences").is_some());
            assert!(rt.find("notification-history-toggle").is_some());
            assert_eq!(rt.find("open-remote-control").is_some(), expected_visible);
        }
    }
}
