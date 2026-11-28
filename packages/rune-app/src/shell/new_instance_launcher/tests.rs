use super::*;
use crate::{
    State, backend::Backend, catalog::Project, gallery::shell::fixture, init, platform, shell,
    strings, workspace,
};
use codenomad_client::bounded;
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.update(|s, tx| {
            let _ = shell::poll(s, tx);
        });
        rt.frame(1.0 / 60.0);
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

fn attested_backend(capabilities_json: &'static str) -> Backend {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 2048];
            let Ok(n) = stream.read(&mut buf) else {
                continue;
            };
            if n == 0 {
                continue;
            }
            let body = format!(
                r#"{{"serverId":"srv-launcher","apiContract":1,"capabilities":{capabilities_json}}}"#
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
    let attest = backend.clone();
    let (tx, rx) = bounded(1);
    platform::spawn(async move {
        let _ = tx.try_send(attest.attest_server().await.is_ok());
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(ok) = rx.try_recv() {
            assert!(ok, "mock server attestation failed");
            break;
        }
        assert!(Instant::now() < deadline, "timed out attesting mock server");
        thread::sleep(Duration::from_millis(5));
    }
    backend
}

fn workspace_runtime(with_temporary_capability: bool) -> Runtime<State> {
    let mut s = init();
    fixture(&mut s);
    let backend = if with_temporary_capability {
        attested_backend(r#"["temporary-workspaces"]"#)
    } else {
        Backend::unauthenticated("http://127.0.0.1:9/").unwrap()
    };
    if let Some(l) = s.screen.launcher_mut() {
        l.connection = Some(backend);
        l.project = Some(Project {
            id: "project-0".into(),
            path: "/repos/alpha".into(),
            temporary: false,
        });
        l.projects = vec![
            Project {
                id: "project-0".into(),
                path: "/repos/alpha".into(),
                temporary: false,
            },
            Project {
                id: "project-1".into(),
                path: "/repos/beta".into(),
                temporary: false,
            },
            Project {
                id: "project-2".into(),
                path: "/repos/gamma".into(),
                temporary: false,
            },
            Project {
                id: "project-tmp".into(),
                path: "/tmp/temp-session".into(),
                temporary: true,
            },
        ];
    }
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let alpha = s.screen.launcher().unwrap().project.clone().unwrap();
    workspace::opened(&mut s, &alpha);
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    // Add a second open tab for /repos/beta and switch back to tab 0 (/repos/alpha).
    rt.update(|s, tx| {
        workspace::new_tab(s, tx);
        let beta = Project {
            id: "project-1".into(),
            path: "/repos/beta".into(),
            temporary: false,
        };
        if let Some(l) = s.screen.launcher_mut() {
            l.project = Some(beta.clone());
        }
        workspace::opened(s, &beta);
        workspace::select_index(s, 0, tx);
    });
    settle(&mut rt);
    rt
}

#[test]
fn secondary_click_and_keyboard_on_new_tab_button_open_menu_and_restore_focus() {
    let mut rt = workspace_runtime(false);

    // Secondary click on an ordinary tab does not open NewInstanceLauncher.
    let (tx_tab, ty_tab) = rt.find("t-tab-0").expect("tab 0");
    rt.secondary_down(tx_tab, ty_tab);
    rt.secondary_up(tx_tab, ty_tab);
    settle(&mut rt);
    assert!(!is_open(&rt.state));

    // Secondary click on the `+` button opens NewInstanceLauncher.
    let (x, y) = rt.find(NEW_TAB_KEY).expect("new tab button");
    rt.secondary_down(x, y);
    rt.secondary_up(x, y);
    settle(&mut rt);
    assert!(is_open(&rt.state));

    // Escape closes and returns focus to `+`.
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    let focused = rt
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some(NEW_TAB_KEY));

    // Pressing Down, ContextMenu, or Shift+F10 while `+` is focused opens NewInstanceLauncher.
    send_key(&mut rt, Key::Down, Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));

    send_key(&mut rt, Key::ContextMenu, Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));

    send_key(
        &mut rt,
        Key::Function(10),
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    let focused = rt
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some(NEW_TAB_KEY));
}

#[test]
fn lists_deduplicated_recents_filters_and_switches_to_open_tab() {
    let mut rt = workspace_runtime(false);
    rt.update(|s, tx| {
        assert!(open(s, tx));
    });
    settle(&mut rt);

    // Search field uses Search input mode and disables autofill.
    assert_eq!(view::QUERY_INPUT_MODE, rune::InputMode::Search);
    assert_eq!(view::QUERY_AUTOFILL, rune::Autofill::Off);

    // Excludes temporary project and deduplicates open tabs against launcher projects.
    let (entries, has_any) = filtered_entries(&rt.state);
    assert!(has_any);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "/repos/alpha");
    assert_eq!(entries[0].open_tab_index, Some(0));
    assert_eq!(entries[1].path, "/repos/beta");
    assert_eq!(entries[1].open_tab_index, Some(1));
    assert_eq!(entries[2].path, "/repos/gamma");
    assert_eq!(entries[2].open_tab_index, None);

    // Non-matching filter shows no-match empty state.
    rt.update(|s, _| set_query_for_test(s, "does-not-exist"));
    settle(&mut rt);
    let (none, has_any) = filtered_entries(&rt.state);
    assert!(has_any);
    assert!(none.is_empty());

    // Filtering for "beta" and pressing Enter switches to existing tab 1 without creating a 3rd tab.
    rt.update(|s, _| set_query_for_test(s, "beta"));
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
}

#[test]
fn browse_action_hands_off_to_directory_browser_and_temporary_button_respects_capability() {
    let mut rt_without_temp = workspace_runtime(false);
    rt_without_temp.update(|s, tx| {
        assert!(open_with_return_focus(s, Some(NEW_TAB_KEY.into()), tx));
    });
    settle(&mut rt_without_temp);
    assert!(rt_without_temp.find(BROWSE_BUTTON).is_some());
    assert!(rt_without_temp.find(TEMPORARY_BUTTON).is_none());

    // Clicking Browse closes NewInstanceLauncher and opens DirectoryBrowserDialog.
    click(&mut rt_without_temp, BROWSE_BUTTON);
    assert!(!is_open(&rt_without_temp.state));
    assert!(shell::directory_browser::is_open(&rt_without_temp.state));

    // Escape from DirectoryBrowserDialog returns focus to `+`.
    send_key(&mut rt_without_temp, Key::Escape, Mods::default());
    assert!(!shell::directory_browser::is_open(&rt_without_temp.state));
    let focused = rt_without_temp
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some(NEW_TAB_KEY));

    // When backend advertises temporary-workspaces, temporary button is shown and enabled.
    let mut rt_with_temp = workspace_runtime(true);
    rt_with_temp.update(|s, tx| {
        assert!(open(s, tx));
    });
    settle(&mut rt_with_temp);
    let temp_btn = rt_with_temp
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(TEMPORARY_BUTTON))
        .expect("temporary button");
    assert!(temp_btn.focusable);
}

#[test]
fn command_palette_recent_tabs_opens_new_instance_launcher() {
    let mut rt = workspace_runtime(false);
    rt.update(|s, tx| {
        tx.focus("command-palette-toggle", true);
        shell::command_palette::open(s, tx);
    });
    settle(&mut rt);
    click(&mut rt, "command-palette-item-recent-tabs");
    assert!(is_open(&rt.state));
    assert!(!shell::command_palette::is_open(&rt.state));

    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    let focused = rt
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some("command-palette-toggle"));
}

#[test]
fn failed_open_restores_focus_and_auth_or_reconnect_dismisses_menu() {
    let mut rt = workspace_runtime(false);
    rt.update(|s, tx| {
        while s
            .workspace
            .as_ref()
            .is_some_and(|ui| ui.tab_count() < workspace::MAX_TABS_LIMIT)
        {
            let i = s.workspace.as_ref().unwrap().tab_count();
            workspace::new_tab(s, tx);
            let filler = Project {
                id: format!("filler-{i}"),
                path: format!("/repos/filler-{i}"),
                temporary: false,
            };
            workspace::opened(s, &filler);
        }
        workspace::select_index(s, 0, tx);
        assert!(open_with_return_focus(s, Some(NEW_TAB_KEY.into()), tx));
    });
    settle(&mut rt);
    rt.update(|s, _| {
        set_query_for_test(s, "gamma");
    });
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(
        rt.state.screen.launcher().and_then(|l| l.error),
        Some("rune.open_error")
    );
    let focused = rt
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some(NEW_TAB_KEY));

    // Authentication expiration dismisses NewInstanceLauncher.
    rt.update(|s, tx| {
        assert!(open(s, tx));
    });
    settle(&mut rt);
    assert!(is_open(&rt.state));
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = true;
        }
    });
    settle(&mut rt);
    assert!(!is_open(&rt.state));

    // Connection generation bump dismisses NewInstanceLauncher.
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        assert!(open(s, tx));
    });
    settle(&mut rt);
    assert!(is_open(&rt.state));
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.connection_generation += 1;
        }
    });
    settle(&mut rt);
    assert!(!is_open(&rt.state));
}
