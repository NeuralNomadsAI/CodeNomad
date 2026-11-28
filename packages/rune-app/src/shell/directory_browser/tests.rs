use super::*;
use crate::{
    State, backend::Backend, catalog::Project, gallery::shell::fixture, init, shell, strings,
    workspace,
};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;
use std::{
    cell::RefCell,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn french(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("fr", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.update(|s, tx| {
            let _ = shell::poll(s, tx);
        });
        rt.frame(1.0 / 60.0);
    }
}

fn wait_until(rt: &mut Runtime<State>, predicate: impl Fn(&Runtime<State>) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        rt.update(|s, tx| {
            let _ = shell::poll(s, tx);
        });
        rt.frame(1.0 / 60.0);
        if predicate(rt) {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("condition not met before timeout");
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

fn decode_query_path(target: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    for pair in query.split('&') {
        if let Some(raw) = pair.strip_prefix("path=") {
            let mut out = Vec::new();
            let bytes = raw.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%'
                    && i + 2 < bytes.len()
                    && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
                    && let Ok(byte) = u8::from_str_radix(hex, 16)
                {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
                i += 1;
            }
            return String::from_utf8(out).ok();
        }
    }
    None
}

fn spawn_filesystem_server(
    handler: impl Fn(Option<&str>) -> (u16, serde_json::Value) + Send + Sync + 'static,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let handler = Arc::new(handler);
    thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let handler = handler.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else {
                    return;
                };
                if n == 0 {
                    return;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                let target = first_line.split_whitespace().nth(1).unwrap_or("/");
                let path = decode_query_path(target);
                let (status, body) = handler(path.as_deref());
                let json = body.to_string();
                let reason = if status == 200 { "OK" } else { "Error" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                );
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
    format!("http://{addr}/")
}

fn state_with_backend(base: &str, view: fn(&State, &mut Cx<State>) -> El) -> Runtime<State> {
    let mut s = init();
    fixture(&mut s);
    let backend = Backend::unauthenticated(base).expect("loopback backend");
    if let Some(l) = s.screen.launcher_mut() {
        l.connection = Some(backend);
        l.project = Some(Project {
            id: "project-0".into(),
            path: "/work/alpha".into(),
            temporary: false,
        });
    }
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    workspace::opened(&mut s, &project);
    let mut rt = Runtime::new(s, view, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    settle(&mut rt);
    rt
}

fn fs_reply(
    current: &str,
    parent: Option<&str>,
    home: Option<&str>,
    path_kind: &str,
    entries: serde_json::Value,
) -> (u16, serde_json::Value) {
    (
        200,
        json!({
            "metadata": {
                "scope": "unrestricted",
                "currentPath": current,
                "displayPath": current,
                "parentPath": parent,
                "homePath": home,
                "pathKind": path_kind,
            },
            "entries": entries,
        }),
    )
}

#[test]
fn browse_sort_navigate_parent_home_direct_path_and_select_callback() {
    let base = spawn_filesystem_server(|path| match path {
        None | Some("/home/dev") => fs_reply(
            "/home/dev",
            Some("/home"),
            Some("/home/dev"),
            "absolute",
            json!([
                { "name": "zeta", "path": "/home/dev/zeta", "type": "directory" },
                { "name": "Alpha", "path": "/home/dev/Alpha", "type": "directory" },
                { "name": "readme.md", "path": "/home/dev/readme.md", "type": "file" }
            ]),
        ),
        Some("/home/dev/Alpha") => fs_reply(
            "/home/dev/Alpha",
            Some("/home/dev"),
            Some("/home/dev"),
            "absolute",
            json!([
                { "name": "nested", "path": "/home/dev/Alpha/nested", "type": "directory" }
            ]),
        ),
        Some("/home") => fs_reply(
            "/home",
            Some("/"),
            Some("/home/dev"),
            "absolute",
            json!([
                { "name": "dev", "path": "/home/dev", "type": "directory" }
            ]),
        ),
        Some("/custom/repo") => fs_reply(
            "/custom/repo",
            Some("/custom"),
            Some("/home/dev"),
            "absolute",
            json!([]),
        ),
        _ => (404, json!({ "error": "not found" })),
    });

    let mut rt = state_with_backend(&base, english);
    let chosen: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let chosen_cb = chosen.clone();

    rt.update(|s, tx| {
        assert!(open_with_callback(
            s,
            Some("/nonexistent/seed".into()),
            Some("project-tabs-new".into()),
            Some(Rc::new(move |_, path, _| {
                *chosen_cb.borrow_mut() = Some(path);
            })),
            tx,
        ));
    });

    // Initial seed 404s -> falls back to default server listing (/home/dev) and sorts folders.
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/home/dev"
    });
    assert_eq!(
        rt.state
            .shell
            .directory_browser
            .folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Alpha", "zeta"]
    );
    // Home button is disabled while already at home.
    let home_btn = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(HOME_BUTTON))
        .expect("home button");
    assert!(!home_btn.focusable);

    // Click first sorted folder ("Alpha").
    click(&mut rt, &folder_row_key(0));
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/home/dev/Alpha"
    });

    // Parent button navigates up to /home/dev, then up again to /home.
    click(&mut rt, PARENT_BUTTON);
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/home/dev"
    });
    click(&mut rt, UP_ROW);
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/home"
    });

    // Home button returns to /home/dev.
    click(&mut rt, HOME_BUTTON);
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/home/dev"
    });

    // Direct path entry + Enter navigates to /custom/repo (empty folder state).
    rt.update(|s, _| set_path_input_for_test(s, "/custom/repo"));
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/custom/repo"
    });
    assert!(rt.state.shell.directory_browser.folders.is_empty());

    // Confirming opens /custom/repo through callback and closes dialog.
    click(&mut rt, OPEN_BUTTON);
    assert!(!is_open(&rt.state));
    assert_eq!(chosen.borrow().as_deref(), Some("/custom/repo"));
}

#[test]
fn keyboard_navigation_escape_restore_focus_and_error_retry_work() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_srv = attempts.clone();
    let base = spawn_filesystem_server(move |path| match path {
        None => {
            if attempts_srv.fetch_add(1, Ordering::SeqCst) == 0 {
                (500, json!({ "error": "boom" }))
            } else {
                fs_reply(
                    "/srv",
                    Some("/"),
                    Some("/srv"),
                    "absolute",
                    json!([
                        { "name": "app", "path": "/srv/app", "type": "directory" },
                        { "name": "docs", "path": "/srv/docs", "type": "directory" }
                    ]),
                )
            }
        }
        Some("/srv/app") => fs_reply(
            "/srv/app",
            Some("/srv"),
            Some("/srv"),
            "absolute",
            json!([]),
        ),
        _ => (404, json!({ "error": "missing" })),
    });

    let mut rt = state_with_backend(&base, english);
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.project = None;
            l.folder = TextEdit::new("");
        }
        tx.focus("project-tabs-new", true);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        assert!(open(s, None, tx));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && rt.state.shell.directory_browser.error.is_some()
    });
    assert!(rt.find(RETRY_BUTTON).is_some());

    // Retry loads /srv cleanly.
    click(&mut rt, RETRY_BUTTON);
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading() && current_path_for_test(&rt.state) == "/srv"
    });

    // ArrowDown twice selects "app" (0 = Parent "..", 1 = "app"), Enter navigates into /srv/app.
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(
        rt.state.shell.directory_browser.selected,
        Some(RowSelection::Parent)
    );
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(
        rt.state.shell.directory_browser.selected,
        Some(RowSelection::Folder(0))
    );
    send_key(&mut rt, Key::Enter, Mods::default());
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/srv/app"
    });

    // Escape closes dialog and restores focus to trigger.
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!is_open(&rt.state));
    let focused = rt
        .elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key);
    assert_eq!(focused.as_deref(), Some("project-tabs-new"));
}

#[test]
fn drives_root_disables_open_and_connection_change_closes_dialog() {
    let base = spawn_filesystem_server(|_| {
        fs_reply(
            "drives",
            None,
            Some("C:\\Users\\Dev"),
            "drives",
            json!([
                { "name": "C:\\", "path": "C:\\", "type": "directory" },
                { "name": "D:\\", "path": "D:\\", "type": "directory" }
            ]),
        )
    });

    let mut rt = state_with_backend(&base, french);
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("fr", || crate::shell::keys(s, event, tx)));
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.project = None;
            l.folder = TextEdit::new("");
        }
        assert!(open(s, None, tx));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && rt.state.shell.directory_browser.folders.len() == 2
    });
    assert_eq!(current_path_for_test(&rt.state), "");
    let open_btn = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(OPEN_BUTTON))
        .expect("open button");
    assert!(!open_btn.focusable);

    // Connection generation bump (reconnect / auth reset) dismisses dialog safely.
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.connection_generation += 1;
        }
    });
    settle(&mut rt);
    assert!(!is_open(&rt.state));
}

#[test]
fn confirming_already_open_folder_switches_to_existing_tab() {
    let base = spawn_filesystem_server(|_| {
        fs_reply(
            "/work/beta",
            Some("/work"),
            Some("/work"),
            "absolute",
            json!([]),
        )
    });
    let mut rt = state_with_backend(&base, english);
    // Open a second tab for /work/beta, then switch back to tab 0 (/work/alpha).
    rt.update(|s, tx| {
        workspace::new_tab(s, tx);
        let beta = Project {
            id: "project-1".into(),
            path: "/work/beta".into(),
            temporary: false,
        };
        if let Some(l) = s.screen.launcher_mut() {
            l.project = Some(beta.clone());
        }
        workspace::opened(s, &beta);
        workspace::select_index(s, 0, tx);
    });
    settle(&mut rt);
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 0);

    rt.update(|s, tx| {
        assert!(open(s, Some("/work/beta".into()), tx));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work/beta"
    });
    click(&mut rt, OPEN_BUTTON);
    assert!(!is_open(&rt.state));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_index(), 1);
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
}

#[test]
fn command_palette_browse_directories_opens_dialog_and_restores_focus() {
    let base = spawn_filesystem_server(|_| {
        fs_reply("/work", Some("/"), Some("/work"), "absolute", json!([]))
    });
    let mut rt = state_with_backend(&base, english);
    rt.update(|s, tx| {
        tx.focus("command-palette-toggle", true);
        shell::command_palette::open(s, tx);
        s.command_palette.query_for_test("Go to a folder");
    });
    settle(&mut rt);
    click(&mut rt, "command-palette-item-browse-directories");
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

fn path_input_is_focused(rt: &Runtime<State>) -> bool {
    rt.elements().into_iter().any(|el| {
        el.focused && (el.key.as_deref() == Some(PATH_FOCUS) || el.path.ends_with(PATH_FOCUS))
    })
}

#[test]
fn path_input_keeps_focus_after_loads_and_preserves_typing_in_flight() {
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
    let entered_tx = Arc::new(std::sync::Mutex::new(entered_tx));
    let base = spawn_filesystem_server(move |path| match path {
        Some("/work/slow") => {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3));
            fs_reply(
                "/work/slow",
                Some("/work"),
                Some("/work"),
                "absolute",
                json!([]),
            )
        }
        Some("/work/sub") => fs_reply(
            "/work/sub",
            Some("/work"),
            Some("/work"),
            "absolute",
            json!([]),
        ),
        _ => fs_reply(
            "/work",
            Some("/"),
            Some("/work"),
            "absolute",
            json!([
                { "name": "sub", "path": "/work/sub", "type": "directory" }
            ]),
        ),
    });

    let mut rt = state_with_backend(&base, english);
    rt.update(|s, tx| {
        assert!(open(s, Some("/work".into()), tx));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work"
    });
    assert!(
        path_input_is_focused(&rt),
        "path input must keep focus after initial folder load"
    );

    // Navigate via keyboard (Down selects parent `..`, Down selects `sub`, Enter navigates).
    send_key(&mut rt, Key::Down, Mods::default());
    send_key(&mut rt, Key::Down, Mods::default());
    send_key(&mut rt, Key::Enter, Mods::default());
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work/sub"
    });
    assert!(
        path_input_is_focused(&rt),
        "path input must keep focus after keyboard folder navigation"
    );

    // Start a slow load and edit the path while it is in flight; response must not clobber typing.
    rt.update(|s, tx| {
        navigate(s, Some("/work/slow".into()), tx);
    });
    entered_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("slow request entered");
    rt.update(|s, _| {
        set_path_input_for_test(s, "/work/user-typed");
    });
    let _ = release_tx.send(());
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work/slow"
    });
    assert_eq!(
        rt.state.shell.directory_browser.path_input.text,
        "/work/user-typed"
    );
    assert!(path_input_is_focused(&rt));
}

#[test]
fn stale_responses_are_fenced_and_auth_or_failed_open_handled() {
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
    let entered_tx = Arc::new(std::sync::Mutex::new(entered_tx));
    let base = spawn_filesystem_server(move |path| match path {
        Some("/work/slow") => {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3));
            fs_reply(
                "/work/slow",
                Some("/work"),
                Some("/work"),
                "absolute",
                json!([]),
            )
        }
        Some("/work/fast") => fs_reply(
            "/work/fast",
            Some("/work"),
            Some("/work"),
            "absolute",
            json!([]),
        ),
        _ => fs_reply("/work", Some("/"), Some("/work"), "absolute", json!([])),
    });

    let mut rt = state_with_backend(&base, english);
    rt.update(|s, tx| {
        assert!(open_with_return_focus(
            s,
            Some("/work/slow".into()),
            Some("project-tabs-new".into()),
            tx
        ));
    });
    entered_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("slow request started");

    // Supersede `/work/slow` with `/work/fast`.
    rt.update(|s, tx| {
        navigate(s, Some("/work/fast".into()), tx);
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work/fast"
    });
    // Release the older `/work/slow` response and confirm it cannot overwrite `/work/fast`.
    let _ = release_tx.send(());
    thread::sleep(Duration::from_millis(50));
    settle(&mut rt);
    assert_eq!(current_path_for_test(&rt.state), "/work/fast");

    // authentication_required dismisses the dialog cleanly on poll.
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = true;
        }
    });
    settle(&mut rt);
    assert!(!is_open(&rt.state));

    // When opening a folder fails (e.g. MAX_TABS reached), confirming restores focus.
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        while s
            .workspace
            .as_ref()
            .is_some_and(|ui| ui.tab_count() < workspace::MAX_TABS_LIMIT)
        {
            let i = s.workspace.as_ref().unwrap().tab_count();
            workspace::new_tab(s, tx);
            let filler = Project {
                id: format!("filler-{i}"),
                path: format!("/work/filler-{i}"),
                temporary: false,
            };
            workspace::opened(s, &filler);
        }
        workspace::select_index(s, 0, tx);
        assert!(open_with_return_focus(
            s,
            Some("/work/fast".into()),
            Some("project-tabs-new".into()),
            tx
        ));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && current_path_for_test(&rt.state) == "/work/fast"
    });
    click(&mut rt, OPEN_BUTTON);
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
    assert_eq!(focused.as_deref(), Some("project-tabs-new"));
}

#[test]
fn windows_drive_parent_navigation_and_normalize_folder_key() {
    let base = spawn_filesystem_server(|path| match path {
        Some("C:\\") => fs_reply(
            "C:\\",
            Some("drives"),
            Some("C:\\Users\\Dev"),
            "absolute",
            json!([{ "name": "Users", "path": "C:\\Users", "type": "directory" }]),
        ),
        _ => fs_reply(
            "drives",
            None,
            Some("C:\\Users\\Dev"),
            "drives",
            json!([
                { "name": "C:\\", "path": "C:\\", "type": "directory" },
                { "name": "D:\\", "path": "D:\\", "type": "directory" }
            ]),
        ),
    });

    let mut rt = state_with_backend(&base, english);
    rt.update(|s, tx| {
        assert!(open(s, Some("C:\\".into()), tx));
    });
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading() && current_path_for_test(&rt.state) == "C:\\"
    });
    click(&mut rt, PARENT_BUTTON);
    wait_until(&mut rt, |rt| {
        !rt.state.shell.directory_browser.is_loading()
            && rt.state.shell.directory_browser.folders.len() == 2
    });
    assert_eq!(current_path_for_test(&rt.state), "");
    let open_btn = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(OPEN_BUTTON))
        .expect("open button");
    assert!(!open_btn.focusable);

    assert_eq!(normalize_folder_key("C:"), "c:\\");
    assert_eq!(normalize_folder_key("C:/"), "c:\\");
    assert_eq!(normalize_folder_key("C:\\"), "c:\\");
    assert_eq!(
        normalize_folder_key("C:/Users/Dev/"),
        normalize_folder_key("c:\\users\\dev")
    );
    assert_eq!(
        normalize_folder_key("\\\\Server\\Share\\Repo\\"),
        "\\\\server\\share\\repo"
    );
    assert_eq!(normalize_folder_key("/"), "/");
    assert_eq!(normalize_folder_key("///"), "/");
    assert_eq!(normalize_folder_key("/tmp/foo\\bar/"), "/tmp/foo\\bar");
    assert_ne!(
        normalize_folder_key("/tmp/Foo\\Bar"),
        normalize_folder_key("/tmp/foo\\bar")
    );
}
