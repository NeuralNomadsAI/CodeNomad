use super::*;
use crate::{
    Screen, State,
    backend::Backend,
    catalog::{Project, Session},
    gallery::shell::fixture,
    init, settings,
    shell::{command_palette, notifications},
    strings, workspace,
};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..6 {
        rt.frame(1.0 / 60.0);
    }
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    settle(rt);
    rt.key_up(event);
}

struct MockCleanupServer {
    backend: Backend,
    addr: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for MockCleanupServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl MockCleanupServer {
    fn start(handler: impl Fn(&str) -> (u16, Value) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else {
                    continue;
                };
                if n == 0 {
                    continue;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("").to_owned();
                seen.lock().unwrap().push(first.clone());
                let (status, body) = handler(&first);
                let payload = body.to_string();
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        Self {
            backend,
            addr,
            stop,
            requests,
            handle: Some(handle),
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn cleanup_runtime(
    backend: Backend,
    sessions: Vec<Session>,
    active_session: Option<&str>,
) -> Runtime<State> {
    let mut s = init();
    fixture(&mut s);
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let project = Project {
        id: "ws-clean".into(),
        path: "/repo".into(),
        temporary: false,
    };
    {
        let l = s.screen.launcher_mut().unwrap();
        l.connection = Some(backend.clone());
        l.project = Some(project.clone());
        l.sessions = sessions;
    }
    workspace::opened(&mut s, &project);
    if let Some(active) = active_session {
        let bound = Backend {
            workspace: project.id.clone(),
            session: active.into(),
            ..backend.clone()
        };
        workspace::bound(&mut s, &bound);
    } else {
        s.screen = match std::mem::replace(&mut s.screen, Screen::Chat { launcher: None }) {
            Screen::Chat { launcher: Some(l) } | Screen::Launcher(l) => Screen::Launcher(l),
            other => other,
        };
    }
    settings::notification_fixture_for(
        &s,
        backend,
        json!({"settings": {
            "notificationRouting": {"sessions": {"screen": true, "history": true, "system": false}},
            "hotkeyOverrides": {"cleanup-blank-sessions": [{"key": "f8"}]}
        }}),
    );
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    settle(&mut rt);
    rt
}

fn drive_cleanup(rt: &mut Runtime<State>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let mut active = false;
        rt.update(|s, tx| {
            let _ = strings::with_locale("en", || poll(s, tx));
            let _ = strings::with_locale("en", || notifications::poll(s, tx));
            let _ = strings::with_locale("en", || notifications::poll_app_notices(s, 1.0, tx));
            active = s.blank_cleanup.is_sweeping();
        });
        settle(rt);
        if !active {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    rt.update(|s, tx| {
        let _ = strings::with_locale("en", || notifications::poll(s, tx));
        let _ = strings::with_locale("en", || notifications::poll_app_notices(s, 1.0, tx));
    });
    settle(rt);
}

#[test]
fn command_palette_and_shortcut_open_confirm_and_cancel_safely() {
    let server = MockCleanupServer::start(|_| (200, json!({})));
    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_active".into(),
                title: "Active".into(),
            },
            Session {
                id: "ses_blank".into(),
                title: "Blank".into(),
            },
        ],
        Some("ses_active"),
    );

    // Command palette exposes cleanup-blank-sessions when a project is open.
    assert_eq!(
        command_palette::item_disabled(&rt.state, "cleanup-blank-sessions"),
        Some(false)
    );

    // Custom shortcut opens confirmation dialog with Cancel focused.
    let trigger = rune_theme_codenomad::shell::command_palette::TRIGGER;
    rt.update(move |_, tx| tx.focus(trigger, true));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(is_open(&rt.state));
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(theme::DIALOG) && el.role == "alertdialog")
    );
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(theme::CANCEL) && el.focused)
    );

    // Outside backdrop click does not dismiss (matches Solid dismissible: false).
    rt.pointer_down(8.0, 8.0);
    rt.pointer_up(8.0, 8.0);
    settle(&mut rt);
    assert!(is_open(&rt.state));

    // Escape is consumed without dismissing (matches Solid dismissible: false).
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(is_open(&rt.state));

    // Pressing Enter on default Cancel focus cancels instead of confirming destructively.
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(server.requests().is_empty());
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(trigger) && el.focused)
    );

    // Executing from Command Palette also opens confirmation; Enter on Cancel restores focus.
    rt.update(|s, tx| command_palette::open(s, tx));
    settle(&mut rt);
    assert!(command_palette::is_open(&rt.state));
    rt.state.command_palette.query_for_test("scrub");
    settle(&mut rt);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!command_palette::is_open(&rt.state));
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert!(server.requests().is_empty());
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(trigger) && el.focused)
    );
}

#[test]
fn confirmed_cleanup_deletes_verified_blank_sessions_protects_work_and_emits_toast() {
    let server = MockCleanupServer::start(|first| {
        if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/") {
            return (200, json!({"deleted": true}));
        }
        if first.contains("/api/session/ses_non_empty/message?") {
            return (200, json!({"data": [{"id": "msg-1"}], "cursor": {}}));
        }
        if first.contains("/message?") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_blank_1 HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_blank_1", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
            );
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_blank_2 HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_blank_2", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 2}}}),
            );
        }
        if first.contains("/inbox") {
            return (200, json!({"data": []}));
        }
        if first.contains("parentID=") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.contains("/api/session/active") {
            return (200, json!({"data": {}}));
        }
        (404, json!({}))
    });

    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_active".into(),
                title: "Active".into(),
            },
            Session {
                id: "ses_draft".into(),
                title: "Draft".into(),
            },
            Session {
                id: "ses_cn_schedule_1".into(),
                title: "Schedule".into(),
            },
            Session {
                id: "ses_non_empty".into(),
                title: "Used".into(),
            },
            Session {
                id: "ses_blank_1".into(),
                title: "Blank 1".into(),
            },
            Session {
                id: "ses_blank_2".into(),
                title: "Blank 2".into(),
            },
        ],
        Some("ses_active"),
    );

    // Save a local draft on ses_draft so it is locally protected.
    let draft_backend = Backend {
        workspace: "ws-clean".into(),
        session: "ses_draft".into(),
        ..server.backend.clone()
    };
    let active_backend = Backend {
        workspace: "ws-clean".into(),
        session: "ses_active".into(),
        ..server.backend.clone()
    };
    let _ = workspace::bound(&mut rt.state, &draft_backend);
    rt.state.draft = rune::edit::TextEdit::new("unsent text");
    workspace::capture(&mut rt.state);
    let _ = workspace::bound(&mut rt.state, &active_backend);

    // Trigger via shortcut, Tab to Continue, press Enter.
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(is_open(&rt.state));
    send_key(&mut rt, Key::Tab, Mods::default());
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some(theme::CONFIRM) && el.focused)
    );
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));

    drive_cleanup(&mut rt);

    let remaining: Vec<_> = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .sessions
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(
        remaining,
        vec![
            "ses_active",
            "ses_draft",
            "ses_cn_schedule_1",
            "ses_non_empty"
        ]
    );

    let seen = server.requests();
    assert!(!seen.iter().any(|r| r.contains("ses_active")));
    assert!(!seen.iter().any(|r| r.contains("ses_draft")));
    assert!(!seen.iter().any(|r| r.contains("ses_cn_schedule_1")));
    assert!(
        !seen
            .iter()
            .any(|r| r.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_non_empty"))
    );
    assert!(
        seen.iter()
            .any(|r| r.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_blank_1"))
    );
    assert!(
        seen.iter()
            .any(|r| r.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_blank_2"))
    );

    // Rendered toast bubble matches Solid's pluralized cleanup message.
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.text.as_deref() == Some("Cleaned up 2 blank sessions")),
        "expected cleanup toast in rendered elements"
    );
}

#[test]
fn route_unavailable_degrades_gracefully_and_stops_sweep() {
    let server = MockCleanupServer::start(|first| {
        if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/") {
            return (404, json!({"error": "Not Found"}));
        }
        if first.contains("/message?") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_blank_1 HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_blank_1", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
            );
        }
        if first.contains("/inbox") {
            return (200, json!({"data": []}));
        }
        if first.contains("parentID=") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.contains("/api/session/active") {
            return (200, json!({"data": {}}));
        }
        (404, json!({}))
    });

    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_blank_1".into(),
                title: "Blank 1".into(),
            },
            Session {
                id: "ses_blank_2".into(),
                title: "Blank 2".into(),
            },
        ],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });
    drive_cleanup(&mut rt);

    // Stopped immediately on 404 without preflighting ses_blank_2 and surfaced an error notice.
    let seen = server.requests();
    assert!(!seen.iter().any(|r| r.contains("ses_blank_2")));
    assert_eq!(rt.state.screen.launcher().unwrap().sessions.len(), 2);
    assert!(
        !rt.elements()
            .iter()
            .any(|el| el.text.as_deref().is_some_and(|t| t.contains("Cleaned up")))
    );
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.text.as_deref() == Some("Unavailable")),
        "expected unavailable notice when cleanup route returns 404/501"
    );
}

#[test]
fn preflight_404_on_deleted_session_skips_candidate_and_continues_sweep() {
    let server = MockCleanupServer::start(|first| {
        if first.contains("ses_gone") {
            return (
                404,
                json!({"_tag": "SessionNotFoundError", "sessionID": "ses_gone"}),
            );
        }
        if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_blank_2") {
            return (200, json!({"deleted": true}));
        }
        if first.contains("/message?") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_blank_2 HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_blank_2", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
            );
        }
        if first.contains("/inbox") {
            return (200, json!({"data": []}));
        }
        if first.contains("parentID=") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.contains("/api/session/active") {
            return (200, json!({"data": {}}));
        }
        (404, json!({}))
    });

    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_gone".into(),
                title: "Gone".into(),
            },
            Session {
                id: "ses_blank_2".into(),
                title: "Blank 2".into(),
            },
        ],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
        // Simulate catalogue pagination ("More sessions") bumping catalogue_generation mid-sweep.
        if let Some(l) = s.screen.launcher_mut() {
            l.catalogue_generation = l.catalogue_generation.wrapping_add(1);
        }
    });
    drive_cleanup(&mut rt);

    let seen = server.requests();
    assert!(
        seen.iter()
            .any(|r| r.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_blank_2")),
        "a SessionNotFoundError 404 or catalogue pagination must not abort the sweep"
    );
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.text.as_deref() == Some("Cleaned up 1 blank session")),
        "expected cleanup toast after skipping missing session"
    );
}

#[test]
fn unauthorized_response_triggers_auth_recovery_and_cancels_sweep() {
    let server = MockCleanupServer::start(|_| (401, json!({"error": "Authentication required"})));
    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_blank_1".into(),
                title: "Blank 1".into(),
            },
            Session {
                id: "ses_blank_2".into(),
                title: "Blank 2".into(),
            },
        ],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });
    drive_cleanup(&mut rt);

    assert!(rt.state.screen.launcher().unwrap().authentication_required);
    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(!server.requests().iter().any(|r| r.contains("ses_blank_2")));
}

#[test]
fn mid_preflight_local_draft_blocks_delete_dispatch() {
    let server = MockCleanupServer::start(|first| {
        if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/") {
            return (200, json!({"deleted": true}));
        }
        if first.contains("/message?") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_race HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_race", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
            );
        }
        if first.contains("/inbox") {
            return (200, json!({"data": []}));
        }
        if first.contains("parentID=") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.contains("/api/session/active") {
            return (200, json!({"data": {}}));
        }
        (404, json!({}))
    });

    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![Session {
            id: "ses_race".into(),
            title: "Race".into(),
        }],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });

    // Immediately make ses_race active before poll processes Verified(Ok(true)).
    let race_backend = Backend {
        workspace: "ws-clean".into(),
        session: "ses_race".into(),
        ..server.backend.clone()
    };
    workspace::bound(&mut rt.state, &race_backend);

    drive_cleanup(&mut rt);

    assert!(
        !server
            .requests()
            .iter()
            .any(|r| r.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_race")),
        "delete must not be dispatched after session became active mid-preflight"
    );
    assert_eq!(rt.state.screen.launcher().unwrap().sessions.len(), 1);
}

#[test]
fn sessions_added_while_confirm_dialog_is_open_are_not_swept() {
    let server = MockCleanupServer::start(|first| {
        if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/") {
            return (200, json!({"deleted": true}));
        }
        if first.contains("/message?") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_before HTTP/") {
            return (
                200,
                json!({"data": {"id": "ses_before", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
            );
        }
        if first.contains("/inbox") {
            return (200, json!({"data": []}));
        }
        if first.contains("parentID=") {
            return (200, json!({"data": [], "cursor": {}}));
        }
        if first.contains("/api/session/active") {
            return (200, json!({"data": {}}));
        }
        (404, json!({}))
    });

    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![Session {
            id: "ses_before".into(),
            title: "Before".into(),
        }],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
    });
    // A blank session arrives while the confirmation dialog is open.
    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .sessions
        .push(Session {
            id: "ses_during_dialog".into(),
            title: "Created During Dialog".into(),
        });

    rt.update(|s, tx| confirm(s, tx));
    drive_cleanup(&mut rt);

    let remaining: Vec<_> = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .sessions
        .iter()
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(remaining, vec!["ses_during_dialog"]);
    assert!(
        !server
            .requests()
            .iter()
            .any(|r| r.contains("ses_during_dialog"))
    );
}

#[test]
fn server_503_outage_stops_sweep_immediately_without_touching_remaining_candidates() {
    let server = MockCleanupServer::start(|_| (503, json!({"error": "Unavailable"})));
    let mut rt = cleanup_runtime(
        server.backend.clone(),
        vec![
            Session {
                id: "ses_blank_1".into(),
                title: "Blank 1".into(),
            },
            Session {
                id: "ses_blank_2".into(),
                title: "Blank 2".into(),
            },
        ],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });
    drive_cleanup(&mut rt);

    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(can_start(&rt.state));
    let seen = server.requests();
    assert_eq!(seen.len(), 1);
    assert!(!seen.iter().any(|r| r.contains("ses_blank_2")));
}

#[test]
fn activating_session_during_inflight_preflight_aborts_http_request() {
    let (get_seen_tx, get_seen_rx) = std::sync::mpsc::channel::<()>();
    let (client_closed_tx, client_closed_rx) = std::sync::mpsc::channel::<bool>();
    let saw_post = Arc::new(AtomicBool::new(false));
    let saw_post_flag = saw_post.clone();
    let release = Arc::new(AtomicBool::new(false));
    let release_flag = release.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = thread::spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            let Ok(n) = stream.read(&mut buf) else {
                continue;
            };
            if n == 0 {
                continue;
            }
            let req = String::from_utf8_lossy(&buf[..n]);
            let first = req.lines().next().unwrap_or("");
            if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/") {
                saw_post_flag.store(true, Ordering::SeqCst);
            }
            if first.starts_with("GET /workspaces/ws-clean/instance/api/session/ses_abort HTTP/") {
                let _ = get_seen_tx.send(());
                // Observe the client dropping/closing the HTTP socket BEFORE any response is sent.
                let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
                let mut probe = [0u8; 16];
                let mut closed = false;
                let deadline = Instant::now() + Duration::from_secs(3);
                while !release_flag.load(Ordering::SeqCst) && Instant::now() < deadline {
                    match stream.read(&mut probe) {
                        Ok(0) => {
                            closed = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(err)
                            if matches!(
                                err.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(err)
                            if matches!(
                                err.kind(),
                                std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                                    | std::io::ErrorKind::BrokenPipe
                                    | std::io::ErrorKind::UnexpectedEof
                            ) =>
                        {
                            closed = true;
                            break;
                        }
                        Err(err) => {
                            panic!("unexpected socket read error while awaiting abort: {err}");
                        }
                    }
                }
                let _ = client_closed_tx.send(closed);
                continue;
            }
            let body = if first.contains("/message?") {
                json!({"data": [], "cursor": {}})
            } else {
                json!({})
            };
            let payload = body.to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
    let mut rt = cleanup_runtime(
        backend.clone(),
        vec![Session {
            id: "ses_abort".into(),
            title: "Abort".into(),
        }],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });

    // Wait until the preflight GET /session/ses_abort reaches the server and blocks.
    let mut saw_get = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if get_seen_rx.try_recv().is_ok() {
            saw_get = true;
            break;
        }
        rt.update(|s, tx| {
            let _ = strings::with_locale("en", || poll(s, tx));
        });
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        saw_get,
        "expected preflight GET /session/ses_abort to arrive"
    );

    // Bind ses_abort synchronously WITHOUT calling blank_cleanup::poll:
    // workspace::bound must cancel the in-flight HTTP preflight and never send POST.
    let bound = Backend {
        workspace: "ws-clean".into(),
        session: "ses_abort".into(),
        ..backend
    };
    workspace::bound(&mut rt.state, &bound);
    assert_eq!(
        client_closed_rx.recv_timeout(Duration::from_secs(3)),
        Ok(true),
        "expected in-flight preflight socket to close immediately on workspace::bound"
    );

    rt.update(|s, tx| {
        let _ = strings::with_locale("en", || poll(s, tx));
    });
    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(!saw_post.load(Ordering::SeqCst));
    assert_eq!(rt.state.screen.launcher().unwrap().sessions.len(), 1);
    assert!(
        !rt.elements()
            .iter()
            .any(|el| el.text.as_deref().is_some_and(|t| t.contains("Cleaned up")))
    );

    release.store(true, Ordering::SeqCst);
    stop.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(addr);
    let _ = handle.join();
}

#[test]
fn opening_session_during_inflight_delete_is_refused_and_preserves_post_outcome() {
    let (post_seen_tx, post_seen_rx) = std::sync::mpsc::channel::<()>();
    let release = Arc::new(AtomicBool::new(false));
    let release_flag = release.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = thread::spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            let Ok(n) = stream.read(&mut buf) else {
                continue;
            };
            if n == 0 {
                continue;
            }
            let req = String::from_utf8_lossy(&buf[..n]);
            let first = req.lines().next().unwrap_or("");
            if first.starts_with("POST /api/workspaces/ws-clean/session-cleanup/ses_del") {
                let _ = post_seen_tx.send(());
                let deadline = Instant::now() + Duration::from_secs(5);
                while !release_flag.load(Ordering::SeqCst) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                let payload = json!({"deleted": true}).to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                continue;
            }
            let body = if first.contains("/message?") {
                json!({"data": [], "cursor": {}})
            } else if first
                .starts_with("GET /workspaces/ws-clean/instance/api/session/ses_del HTTP/")
            {
                json!({"data": {"id": "ses_del", "projectID": "proj-1", "location": {"directory": "/repo"}, "time": {"updated": 1}}})
            } else if first.contains("/inbox") {
                json!({"data": []})
            } else if first.contains("parentID=") {
                json!({"data": [], "cursor": {}})
            } else if first.contains("/api/session/active") {
                json!({"data": {}})
            } else {
                json!({})
            };
            let payload = body.to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });

    let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
    let mut rt = cleanup_runtime(
        backend,
        vec![Session {
            id: "ses_del".into(),
            title: "Deleting".into(),
        }],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });

    // Advance preflight until the POST reaches the server and blocks.
    let mut saw_post = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if post_seen_rx.try_recv().is_ok() {
            saw_post = true;
            break;
        }
        rt.update(|s, tx| {
            let _ = strings::with_locale("en", || poll(s, tx));
        });
        thread::sleep(Duration::from_millis(10));
    }
    assert!(saw_post, "expected POST /session-cleanup/ses_del to arrive");

    // Attempting to open ses_del while its POST deletion is in flight must be refused
    // and must NOT abort or discard the server's POST response.
    assert!(is_deleting_session(&rt.state, "ws-clean", "ses_del"));
    rt.update(|s, tx| {
        crate::launcher::choose(s, "ses_del".into(), tx);
    });
    assert!(
        !rt.state.screen.launcher().unwrap().pending,
        "opening a session while its delete POST is in flight must be refused"
    );

    // Let the server finish deleting and confirm Rune processes the authoritative outcome.
    release.store(true, Ordering::SeqCst);
    drive_cleanup(&mut rt);
    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(rt.state.screen.launcher().unwrap().sessions.is_empty());
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.text.as_deref() == Some("Cleaned up 1 blank session")),
        "expected cleanup toast after in-flight delete settled"
    );

    stop.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(addr);
    let _ = handle.join();
}

#[test]
fn poll_preserves_received_401_even_if_session_becomes_protected() {
    let server = MockCleanupServer::start(|_| (401, json!({"error": "Unauthorized"})));
    let backend = server.backend.clone();
    let mut rt = cleanup_runtime(
        backend.clone(),
        vec![
            Session {
                id: "ses_auth_race".into(),
                title: "Auth Race".into(),
            },
            Session {
                id: "ses_never_called".into(),
                title: "Never".into(),
            },
        ],
        None,
    );

    rt.update(|s, tx| {
        assert!(open_confirm(s, None, tx));
        confirm(s, tx);
    });

    // Wait until the 401 response has been delivered into InFlight::rx before calling poll.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let ready = rt
            .state
            .blank_cleanup
            .sweep
            .as_ref()
            .and_then(|sweep| sweep.in_flight.as_ref())
            .is_some_and(|active| !active.rx.is_empty());
        if ready {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Protect ses_auth_race AFTER 401 arrived: abort_for_session + poll must still surface 401
    // and never advance to ses_never_called.
    let bound = Backend {
        workspace: "ws-clean".into(),
        session: "ses_auth_race".into(),
        ..backend
    };
    workspace::bound(&mut rt.state, &bound);
    rt.update(|s, tx| {
        let _ = strings::with_locale("en", || poll(s, tx));
    });
    assert!(!rt.state.blank_cleanup.is_sweeping());
    assert!(rt.state.screen.launcher().unwrap().authentication_required);
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|req| req.contains("ses_never_called")),
        "sweep must stop on 401 instead of advancing to ses_never_called"
    );
}
