//! Unit tests for Home launcher fidelity items A3, A6, A14, and A15.
use crate::{
    Screen, State,
    backend::Backend,
    catalog::Project,
    init,
    launcher::{Launcher, clone_dialog, recent},
    settings, strings, workspace,
};
use rune::{Env, Runtime};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

fn english(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing launcher control {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn settle(rt: &mut Runtime<State>) {
    rt.frame(0.0);
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
}

fn wait_until_locale(
    rt: &mut Runtime<State>,
    locale: &'static str,
    label: &str,
    mut pred: impl FnMut(&State) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pred(&rt.state) {
        assert!(Instant::now() < deadline, "timeout waiting for {label}");
        rt.update(|s, tx| {
            let _ = strings::with_locale(locale, || crate::poll(s, 0.0, tx));
        });
        rt.frame(1.0 / 60.0);
        thread::sleep(Duration::from_millis(5));
    }
    settle(rt);
}

fn wait_until(rt: &mut Runtime<State>, label: &str, pred: impl FnMut(&State) -> bool) {
    wait_until_locale(rt, "en", label, pred);
}

fn connected_state(backend: Backend) -> State {
    let mut s = init();
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let mut l = Launcher::fixture();
    l.connection = Some(backend);
    l.server_id = Some("srv-test".into());
    s.screen = Screen::Launcher(Box::new(l));
    s
}

struct MockCloneServer {
    base: String,
    clone_requests: Arc<Mutex<Vec<serde_json::Value>>>,
    workspace_requests: Arc<Mutex<Vec<serde_json::Value>>>,
    fail_conflict: Arc<AtomicBool>,
    fail_unavailable: Arc<AtomicBool>,
    fail_server_error: Arc<AtomicBool>,
    hold_clone: Arc<AtomicBool>,
    clone_arrived: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Drop for MockCloneServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let addr = self
            .base
            .trim_start_matches("http://")
            .trim_end_matches('/');
        let _ = std::net::TcpStream::connect(addr);
    }
}

impl MockCloneServer {
    fn start(advertise_clone: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}/");
        let clone_requests = Arc::new(Mutex::new(Vec::new()));
        let workspace_requests = Arc::new(Mutex::new(Vec::new()));
        let fail_conflict = Arc::new(AtomicBool::new(false));
        let fail_unavailable = Arc::new(AtomicBool::new(false));
        let fail_server_error = Arc::new(AtomicBool::new(false));
        let hold_clone = Arc::new(AtomicBool::new(false));
        let clone_arrived = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let cr = clone_requests.clone();
        let wr = workspace_requests.clone();
        let fc = fail_conflict.clone();
        let fu = fail_unavailable.clone();
        let fs = fail_server_error.clone();
        let hc = hold_clone.clone();
        let ca = clone_arrived.clone();
        let st = stop.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if st.load(Ordering::SeqCst) {
                    break;
                }
                let cr = cr.clone();
                let wr = wr.clone();
                let fc = fc.clone();
                let fu = fu.clone();
                let fs = fs.clone();
                let hc = hc.clone();
                let ca = ca.clone();
                let st_inner = st.clone();
                thread::spawn(move || {
                    let mut stream = stream;
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let mut header_end = 0usize;
                    loop {
                        match stream.read(&mut tmp) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                buf.extend_from_slice(&tmp[..n]);
                                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    header_end = pos + 4;
                                    break;
                                }
                            }
                        }
                    }
                    if header_end == 0 {
                        return;
                    }
                    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                    let content_len = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while buf.len() < header_end + content_len {
                        match stream.read(&mut tmp) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let first = head.lines().next().unwrap_or("");
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or("");
                    let path = parts.next().unwrap_or("");
                    let body_end = (header_end + content_len).min(buf.len());
                    let body_str = String::from_utf8_lossy(&buf[header_end..body_end]);
                    let (status, body) = match (method, path) {
                    ("GET", p) if p.starts_with("/api/meta") => {
                        let caps = if advertise_clone {
                            json!(["workspace-clone", "temporary-workspaces"])
                        } else {
                            json!(["temporary-workspaces"])
                        };
                        (
                            "200 OK",
                            json!({
                                "serverId": "srv-clone",
                                "apiContract": 1,
                                "serverVersion": "1.2.0",
                                "capabilities": caps,
                                "ui": { "version": "1.2.0", "source": "bundled" }
                            })
                            .to_string(),
                        )
                    }
                    ("GET", p) if p.starts_with("/api/storage/config/ui") => (
                        "200 OK",
                        json!({ "settings": {} }).to_string(),
                    ),
                    ("GET", p) if p.starts_with("/api/filesystem") => (
                        "200 OK",
                        json!({
                            "entries": [
                                {"name": "clones", "path": "/Users/alice/clones", "type": "directory"}
                            ],
                            "metadata": {
                                "scope": "unrestricted",
                                "currentPath": "/Users/alice/clones",
                                "rootPath": "/Users/alice",
                                "homePath": "/Users/alice",
                                "displayPath": "/Users/alice/clones",
                                "pathKind": "absolute",
                                "parentPath": "/Users/alice"
                            }
                        })
                        .to_string(),
                    ),
                    ("POST", "/api/workspaces/clone") => {
                        let parsed: serde_json::Value =
                            serde_json::from_str(&body_str).unwrap_or(json!({}));
                        cr.lock().unwrap().push(parsed.clone());
                        ca.store(true, Ordering::SeqCst);
                        let wait_end = Instant::now() + Duration::from_secs(5);
                        while hc.load(Ordering::SeqCst)
                            && !st_inner.load(Ordering::SeqCst)
                            && Instant::now() < wait_end
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        if fs.load(Ordering::SeqCst) {
                            ("500 Internal Server Error", String::new())
                        } else if fu.load(Ordering::SeqCst) {
                            ("503 Service Unavailable", "{}".to_owned())
                        } else if fc.load(Ordering::SeqCst) {
                            (
                                "409 Conflict",
                                json!({ "error": "Destination folder already exists." }).to_string(),
                            )
                        } else {
                            let dest = parsed
                                .get("destinationPath")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("/Users/alice/clones/demo");
                            (
                                "200 OK",
                                json!({ "path": dest, "branch": "main" }).to_string(),
                            )
                        }
                    }
                    ("POST", "/api/workspaces") => {
                        let parsed: serde_json::Value =
                            serde_json::from_str(&body_str).unwrap_or(json!({}));
                        wr.lock().unwrap().push(parsed.clone());
                        let dest = parsed
                            .get("path")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("/Users/alice/clones/demo");
                        (
                            "200 OK",
                            json!({
                                "id": "ws-cloned",
                                "location": { "directory": dest },
                                "temporary": false,
                                "requestId": parsed.get("requestId")
                            })
                            .to_string(),
                        )
                    }
                    ("GET", p) if p.contains("/worktrees") => (
                        "200 OK",
                        json!({ "repository": "git", "worktrees": [] }).to_string(),
                    ),
                    ("GET", p) if p.contains("/instance/api/location") => (
                        "200 OK",
                        json!({ "directory": "/Users/alice/clones/demo", "project": { "id": null } })
                            .to_string(),
                    ),
                    ("GET", p) if p.contains("/instance/api/session") => (
                        "200 OK",
                        json!({ "data": [], "next": null }).to_string(),
                    ),
                    _ => ("200 OK", json!({}).to_string()),
                };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                });
            }
        });
        Self {
            base,
            clone_requests,
            workspace_requests,
            fail_conflict,
            fail_unavailable,
            fail_server_error,
            hold_clone,
            clone_arrived,
            stop,
        }
    }
}

#[test]
fn a14_recent_tabs_excludes_unlisted_server_projects_and_keeps_persisted_open_badge() {
    let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let mut s = connected_state(backend);
    let alpha = Project {
        id: "p-alpha".into(),
        path: "/Users/alice/work/alpha".into(),
        temporary: false,
    };
    let synthetic = Project {
        id: "p-synthetic".into(),
        path: "/tmp/synthetic".into(),
        temporary: false,
    };
    if let Some(l) = s.screen.launcher_mut() {
        l.projects = vec![alpha.clone(), synthetic];
        l.project = Some(alpha.clone());
    }
    workspace::opened(&mut s, &alpha);
    settings::fixture_state(
        &mut s,
        json!({
            "recentFolders": [
                { "path": "/Users/alice/work/alpha", "lastAccessed": 2_000_000_000_000u64 },
                { "path": "/Users/alice/work/beta", "lastAccessed": 1_900_000_000_000u64 }
            ]
        }),
    );

    let mut rt = Runtime::new(s, english, (1120.0, 800.0), Env::new(true, 1.0));
    rt.update(workspace::new_tab);
    settle(&mut rt);

    let entries = recent::collect_recent_entries(&rt.state);
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["/Users/alice/work/alpha", "/Users/alice/work/beta"],
        "A14: server-only project 'synthetic' must not appear in Recent tabs"
    );
    assert!(rt.find("project-p-synthetic").is_none());
    assert!(rt.find("project-p-alpha").is_some());
    assert!(
        rt.find(&recent::open_badge_key("/Users/alice/work/alpha"))
            .is_some(),
        "A10/A14: persisted open tab keeps its OPEN badge"
    );
}

#[test]
fn a3_home_browse_card_hides_folder_field_and_opens_directory_browser() {
    let server = MockCloneServer::start(false);
    let backend = Backend::unauthenticated(&server.base).unwrap();
    let mut rt = Runtime::new(
        connected_state(backend),
        english,
        (1120.0, 800.0),
        Env::new(true, 1.0),
    );
    settle(&mut rt);

    assert!(rt.find("folder-path").is_none());
    assert!(rt.find("open-folder").is_none());
    assert!(rt.find("browse").is_some());

    rt.update(|s, tx| {
        assert!(crate::shell::directory_browser::open_with_return_focus(
            s,
            None,
            Some("browse".into()),
            tx
        ));
    });
    wait_until(&mut rt, "directory browser listing", |s| {
        crate::shell::directory_browser::is_open(s)
    });
    assert!(rt.find("directory-browser-path").is_some());
    assert!(rt.find("directory-browser-open").is_some());
}

#[test]
fn a6_clone_button_capability_gate_and_clone_modal_flow() {
    // 1. Without workspace-clone capability, button is hidden.
    let no_clone_srv = MockCloneServer::start(false);
    let no_clone_backend = Backend::unauthenticated(&no_clone_srv.base).unwrap();
    let rt_handle = tokio::runtime::Runtime::new().unwrap();
    let _ = rt_handle.block_on(no_clone_backend.attest_server());
    assert!(!no_clone_backend.client.supports("workspace-clone"));
    let mut hidden_rt = Runtime::new(
        connected_state(no_clone_backend),
        english,
        (1120.0, 800.0),
        Env::new(true, 1.0),
    );
    settle(&mut hidden_rt);
    assert!(
        hidden_rt.find(clone_dialog::TRIGGER_KEY).is_none(),
        "Clone button must stay hidden when server does not advertise workspace-clone"
    );

    // 2. With workspace-clone capability, button shows top-right and full clone flow works.
    let srv = MockCloneServer::start(true);
    let backend = Backend::unauthenticated(&srv.base).unwrap();
    let _ = rt_handle.block_on(backend.attest_server());
    assert!(backend.client.supports("workspace-clone"));

    let mut s = connected_state(backend);
    settings::fixture_state(
        &mut s,
        json!({
            "recentFolders": [
                { "path": "/Users/alice/work/alpha", "lastAccessed": 2_000_000_000_000u64 }
            ]
        }),
    );

    let mut rt = Runtime::new(s, english, (1120.0, 800.0), Env::new(true, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    settle(&mut rt);

    // Trigger and temporary-tab actions are mounted when capabilities are advertised.
    assert!(rt.find(clone_dialog::TRIGGER_KEY).is_some());
    assert!(rt.find("new-temporary-tab").is_some());

    // Open modal, verify Escape closes it and restores focus to the trigger, then reopen.
    tap(&mut rt, clone_dialog::TRIGGER_KEY);
    settle(&mut rt);
    assert!(clone_dialog::is_open(&rt.state));
    let esc = rune::KeyEvent {
        key: rune::Key::Escape,
        mods: rune::Mods::default(),
    };
    rt.key(esc.clone());
    settle(&mut rt);
    rt.key_up(esc);
    settle(&mut rt);
    assert!(!clone_dialog::is_open(&rt.state));
    let mut focused_after_esc = None;
    rt.update(|_, tx| focused_after_esc = tx.focused().map(str::to_owned));
    assert_eq!(
        focused_after_esc.as_deref(),
        Some(clone_dialog::TRIGGER_KEY)
    );

    // Reopen modal for full validation + clone submission flow.
    tap(&mut rt, clone_dialog::TRIGGER_KEY);
    settle(&mut rt);
    assert!(clone_dialog::is_open(&rt.state));
    assert!(rt.find(clone_dialog::REPO_URL_FIELD).is_some());
    assert!(rt.find(clone_dialog::DEST_PATH_FIELD).is_some());
    assert!(rt.find(clone_dialog::BROWSE_BUTTON).is_some());
    assert!(rt.find(clone_dialog::CLEANUP_CHECKBOX).is_some());

    // Empty submit surfaces localized required error without sending HTTP.
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    settle(&mut rt);
    let a11y = rt.accessibility_json().to_string();
    let expected_required = strings::with_locale("en", || {
        strings::t("folderSelection.clone.dialog.errorRequired")
    });
    assert!(
        a11y.contains(expected_required),
        "Empty submit must show required error ({expected_required}): {a11y}"
    );
    assert!(srv.clone_requests.lock().unwrap().is_empty());

    // Typing repository URL auto-suggests destination under recent parent `/Users/alice/work`.
    tap(&mut rt, clone_dialog::REPO_URL_FIELD);
    rt.paste("https://github.com/NeuralNomadsAI/demo.git");
    settle(&mut rt);
    let dest_a11y = rt.accessibility_json().to_string();
    assert!(
        dest_a11y.contains("/Users/alice/work/demo"),
        "Repository URL must auto-suggest destination inside recent parent: {dest_a11y}"
    );

    // Browsing destination via directory_browser updates parent and keeps repo folder name.
    rt.update(clone_dialog::browse_destination_in_dialog);
    wait_until(&mut rt, "clone destination directory browser", |s| {
        crate::shell::directory_browser::is_open(s)
    });
    assert!(
        clone_dialog::is_open(&rt.state),
        "Clone dialog stays open underneath directory browser"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while rt.find("directory-browser-row-0").is_none() {
        assert!(
            Instant::now() < deadline,
            "timeout waiting for directory browser listing"
        );
        rt.update(|s, tx| {
            let _ = crate::poll(s, 0.0, tx);
        });
        rt.frame(1.0 / 60.0);
        thread::sleep(Duration::from_millis(5));
    }
    settle(&mut rt);
    tap(&mut rt, "directory-browser-open");
    settle(&mut rt);
    assert!(!crate::shell::directory_browser::is_open(&rt.state));
    assert!(clone_dialog::is_open(&rt.state));
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("/Users/alice/clones/demo"),
        "Selecting parent in directory browser must update destination path"
    );

    // Toggle cleanup checkbox and verify 409 Conflict surfaces server error cleanly.
    tap(&mut rt, clone_dialog::CLEANUP_CHECKBOX);
    settle(&mut rt);
    srv.fail_conflict.store(true, Ordering::SeqCst);
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    wait_until(&mut rt, "409 conflict settled", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| !l.clone_dialog.is_busy())
    });
    assert!(clone_dialog::is_open(&rt.state));
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Destination folder already exists."),
        "409 conflict message must be shown in modal"
    );

    // Retry with 200 OK: closes modal and opens cloned workspace.
    srv.fail_conflict.store(false, Ordering::SeqCst);
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    wait_until(&mut rt, "clone success and workspace open", |s| {
        !clone_dialog::is_open(s)
            && s.screen
                .launcher()
                .is_some_and(|l| l.project.is_some() && !l.pending)
    });

    let sent = srv.clone_requests.lock().unwrap();
    let last = sent.last().expect("clone POST payload");
    assert_eq!(
        last["repositoryUrl"],
        "https://github.com/NeuralNomadsAI/demo.git"
    );
    assert_eq!(last["destinationPath"], "/Users/alice/clones/demo");
    assert_eq!(last["cleanup"], true);

    let opened = srv.workspace_requests.lock().unwrap();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["path"], "/Users/alice/clones/demo");
    assert_eq!(
        rt.state
            .screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .map(|p| p.path.as_str()),
        Some("/Users/alice/clones/demo")
    );
}

fn french(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
    strings::with_locale("fr", || crate::view(s, cx))
}

#[test]
fn a6_ime_higher_modal_french_errors_and_dismissable_clone_across_renewal() {
    let srv = MockCloneServer::start(true);
    let backend = Backend::unauthenticated(&srv.base).unwrap();
    let rt_tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _ = rt_tokio.block_on(backend.attest_server()).unwrap();

    let mut s = connected_state(backend);
    if let Some(l) = s.screen.launcher_mut() {
        l.server_id = Some("srv-clone".into());
    }
    settings::fixture_state(&mut s, json!({}));
    let mut rt = Runtime::new(s, french, (1120.0, 800.0), Env::new(true, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("fr", || crate::shell::keys(s, event, tx)));
    let hydrate_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        rt.update(|s, tx| {
            let _ = strings::with_locale("fr", || crate::poll(s, 0.0, tx));
        });
        rt.frame(1.0 / 60.0);
        if rt.find("preferences-bootstrap").is_none()
            && rt.find(clone_dialog::TRIGGER_KEY).is_some()
        {
            break;
        }
        assert!(
            Instant::now() < hydrate_deadline,
            "timeout waiting for French home hydration"
        );
        thread::sleep(Duration::from_millis(5));
    }
    settle(&mut rt);

    let esc = rune::KeyEvent {
        key: rune::Key::Escape,
        mods: rune::Mods::default(),
    };

    // 1. Escape during IME composition must not close the clone modal.
    tap(&mut rt, clone_dialog::TRIGGER_KEY);
    settle(&mut rt);
    assert!(clone_dialog::is_open(&rt.state));
    clone_dialog::fixture_preedit(&mut rt.state, "ni");
    rt.key(esc.clone());
    settle(&mut rt);
    rt.key_up(esc.clone());
    settle(&mut rt);
    assert!(
        clone_dialog::is_open(&rt.state),
        "Escape during IME composition must leave clone modal open"
    );
    clone_dialog::fixture_preedit(&mut rt.state, "");
    settle(&mut rt);

    // 2. Escape when directory_browser is open on top closes only directory_browser.
    rt.update(clone_dialog::browse_destination_in_dialog);
    wait_until(&mut rt, "directory browser over clone modal", |s| {
        crate::shell::directory_browser::is_open(s)
    });
    rt.key(esc.clone());
    settle(&mut rt);
    rt.key_up(esc.clone());
    settle(&mut rt);
    assert!(!crate::shell::directory_browser::is_open(&rt.state));
    assert!(
        clone_dialog::is_open(&rt.state),
        "Closing directory browser with Escape must keep clone modal open underneath"
    );

    // 3. Detail-less 503 and 500 in locale "fr" render French fallback with zero English strings.
    tap(&mut rt, clone_dialog::REPO_URL_FIELD);
    rt.paste("https://github.com/NeuralNomadsAI/demo.git");
    settle(&mut rt);
    tap(&mut rt, clone_dialog::DEST_PATH_FIELD);
    rt.paste("/Users/alice/clones/demo");
    settle(&mut rt);

    let french_fallback = strings::with_locale("fr", || strings::t("rune.open_error"));

    srv.fail_unavailable.store(true, Ordering::SeqCst);
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    wait_until_locale(&mut rt, "fr", "503 unavailable settled", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| !l.clone_dialog.is_busy())
    });
    let a11y_503 = rt.accessibility_json().to_string();
    assert!(
        a11y_503.contains(french_fallback),
        "503 error must render French fallback ({french_fallback}): {a11y_503}"
    );
    assert!(!a11y_503.contains("workspace cloning unavailable"));

    srv.fail_unavailable.store(false, Ordering::SeqCst);
    srv.fail_server_error.store(true, Ordering::SeqCst);
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    wait_until_locale(&mut rt, "fr", "500 server error settled", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| !l.clone_dialog.is_busy())
    });
    let a11y_500 = rt.accessibility_json().to_string();
    assert!(
        a11y_500.contains(french_fallback),
        "500 error must render French fallback ({french_fallback}): {a11y_500}"
    );
    assert!(!a11y_500.contains("HTTP 500"));

    // 4. Escape closes modal while clone is in-flight, and same-server renewal + completion still opens workspace.
    srv.fail_server_error.store(false, Ordering::SeqCst);
    srv.hold_clone.store(true, Ordering::SeqCst);
    srv.clone_arrived.store(false, Ordering::SeqCst);
    tap(&mut rt, clone_dialog::SUBMIT_BUTTON);
    let arrived_deadline = Instant::now() + Duration::from_secs(5);
    while !srv.clone_arrived.load(Ordering::SeqCst) {
        assert!(
            Instant::now() < arrived_deadline,
            "clone POST never reached mock server"
        );
        thread::sleep(Duration::from_millis(5));
    }

    // Dismissing via Escape while clone is running closes the dialog and restores focus without trapping Home.
    rt.key(esc.clone());
    settle(&mut rt);
    rt.key_up(esc);
    settle(&mut rt);
    assert!(
        !clone_dialog::is_open(&rt.state),
        "Escape during in-flight clone must close modal instead of trapping Home"
    );
    let mut focused_after_busy_esc = None;
    rt.update(|_, tx| focused_after_busy_esc = tx.focused().map(str::to_owned));
    assert_eq!(
        focused_after_busy_esc.as_deref(),
        Some(clone_dialog::TRIGGER_KEY)
    );

    // Managed renewal with a fresh Backend for the same server_id increments connection_generation.
    let renewed = Backend::unauthenticated(&srv.base).unwrap();
    let _ = rt_tokio.block_on(renewed.attest_server()).unwrap();
    let gen_before = rt
        .state
        .screen
        .launcher()
        .map(|l| l.connection_generation())
        .unwrap();
    rt.update(|s, tx| {
        crate::launcher::apply_connected(s, renewed, None, "srv-clone".into(), None, tx);
    });
    settle(&mut rt);
    let gen_after = rt
        .state
        .screen
        .launcher()
        .map(|l| l.connection_generation())
        .unwrap();
    assert_ne!(gen_before, gen_after);

    // Release the clone response and verify the cloned workspace still opens cleanly.
    srv.hold_clone.store(false, Ordering::SeqCst);
    wait_until(&mut rt, "clone completes after dismiss + renewal", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.project.is_some() && !l.pending)
    });
    assert_eq!(
        rt.state
            .screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .map(|p| p.path.as_str()),
        Some("/Users/alice/clones/demo")
    );
}
