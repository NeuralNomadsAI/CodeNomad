use crate::{
    Message, Phase, Screen, State,
    backend::Backend,
    catalog::Project,
    composer::draft::Attachment,
    launcher::Launcher,
    strings::t,
    workspace::{self, NO_SESSION_DRAFT_ID, Tab, Ui},
};
use rune::{Env, Key, KeyEvent, Mods, Runtime, edit::TextEdit};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

struct MockServer {
    base: String,
    stop: Arc<AtomicBool>,
    created: Arc<AtomicUsize>,
    prompts: Arc<Mutex<Vec<Value>>>,
    shells: Arc<Mutex<Vec<Value>>>,
    commands: Arc<Mutex<Vec<Value>>>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn spawn_mock_server(fail_create: bool) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    listener.set_nonblocking(true).expect("nonblocking");
    let addr = listener.local_addr().expect("local addr");
    let stop = Arc::new(AtomicBool::new(false));
    let created = Arc::new(AtomicUsize::new(0));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let shells = Arc::new(Mutex::new(Vec::new()));
    let commands = Arc::new(Mutex::new(Vec::new()));

    let stop_bg = stop.clone();
    let created_bg = created.clone();
    let prompts_bg = prompts.clone();
    let shells_bg = shells.clone();
    let commands_bg = commands.clone();
    std::thread::spawn(move || {
        while !stop_bg.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let stop_req = stop_bg.clone();
                    let created_req = created_bg.clone();
                    let prompts_req = prompts_bg.clone();
                    let shells_req = shells_bg.clone();
                    let commands_req = commands_bg.clone();
                    std::thread::spawn(move || {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let Some((method, path, body)) = read_http_request(&mut stream) else {
                            return;
                        };
                        handle_request(
                            &mut stream,
                            &method,
                            &path,
                            &body,
                            fail_create,
                            &stop_req,
                            &created_req,
                            &prompts_req,
                            &shells_req,
                            &commands_req,
                        );
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    MockServer {
        base: format!("http://{addr}"),
        stop,
        created,
        prompts,
        shells,
        commands,
    }
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
    }
    let header_text = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = header_text.lines();
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let content_length = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while buf.len() < header_end + content_length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = buf[header_end..buf.len().min(header_end + content_length)].to_vec();
    Some((method, path, body))
}

fn write_json(stream: &mut std::net::TcpStream, status: &str, value: &Value) {
    let body = serde_json::to_vec(value).expect("serialize json");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&body);
}

#[allow(clippy::too_many_arguments)]
fn handle_request(
    stream: &mut std::net::TcpStream,
    method: &str,
    path: &str,
    body: &[u8],
    fail_create: bool,
    stop: &AtomicBool,
    created: &AtomicUsize,
    prompts: &Mutex<Vec<Value>>,
    shells: &Mutex<Vec<Value>>,
    commands: &Mutex<Vec<Value>>,
) {
    let path_only = path.split('?').next().unwrap_or(path);
    if method == "POST" && path_only == "/workspaces/ws-1/instance/api/session" {
        created.fetch_add(1, Ordering::SeqCst);
        if fail_create {
            write_json(
                stream,
                "400 Bad Request",
                &json!({"error": "cannot create session"}),
            );
            return;
        }
        write_json(
            stream,
            "200 OK",
            &json!({
                "data": {
                    "id": "ses-auto-1",
                    "title": "",
                    "location": {"directory": "/repo"}
                }
            }),
        );
        return;
    }
    if method == "GET" && path_only == "/workspaces/ws-1/instance/api/session/ses-auto-1" {
        write_json(
            stream,
            "200 OK",
            &json!({
                "data": {
                    "id": "ses-auto-1",
                    "title": "",
                    "location": {"directory": "/repo"},
                    "listWorktreeSlug": "root",
                    "time": {"created": 1, "busy": 0, "idle": 1}
                }
            }),
        );
        return;
    }
    if method == "POST" && path_only == "/api/workspaces/ws-1/session-history/window" {
        write_json(
            stream,
            "200 OK",
            &json!({
                "status": "window",
                "messages": [],
                "older": null,
                "newer": null,
                "latest": true,
                "userFiles": "reference-v1"
            }),
        );
        return;
    }
    if method == "POST" && path_only == "/workspaces/ws-1/instance/api/session/ses-auto-1/prompt" {
        if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
            prompts.lock().unwrap().push(parsed);
        }
        write_json(stream, "200 OK", &json!({"data": {"id": "msg-confirmed"}}));
        return;
    }
    if method == "POST" && path_only == "/workspaces/ws-1/instance/api/session/ses-auto-1/shell" {
        if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
            shells.lock().unwrap().push(parsed);
        }
        let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    if method == "GET" && path_only == "/workspaces/ws-1/instance/api/command" {
        // Delay slightly so history finishes first, verifying slash commands wait for the catalogue.
        std::thread::sleep(Duration::from_millis(60));
        write_json(
            stream,
            "200 OK",
            &json!({
                "location": {"directory": "/repo"},
                "data": [{"name": "compact", "description": "Compact conversation"}]
            }),
        );
        return;
    }
    if method == "POST" && path_only == "/workspaces/ws-1/instance/api/session/ses-auto-1/command" {
        if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
            commands.lock().unwrap().push(parsed);
        }
        let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes());
        return;
    }
    if path_only.starts_with("/api/events") {
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        if stream.write_all(headers.as_bytes()).is_err() {
            return;
        }
        let connected = format!(
            "data: {}\n\n",
            json!({"type":"instance.eventStatus","instanceId":"ws-1","status":"connected"})
        );
        if stream.write_all(connected.as_bytes()).is_err() || stream.flush().is_err() {
            return;
        }
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    if path_only == "/api/auth/status" {
        write_json(stream, "200 OK", &json!({"authenticated": true}));
        return;
    }
    if method == "GET" && path_only == "/api/workspaces" {
        write_json(
            stream,
            "200 OK",
            &json!([{"id": "ws-1", "path": "/repo", "status": "ready"}]),
        );
        return;
    }
    if method == "GET" && path_only == "/api/config/app" {
        write_json(stream, "200 OK", &json!({"settings": {}}));
        return;
    }
    if method == "GET" && path_only == "/api/storage/state/ui" {
        write_json(stream, "200 OK", &json!({}));
        return;
    }
    write_json(stream, "200 OK", &json!({"data": []}));
}

fn no_session_project_runtime(base: Option<&str>) -> Runtime<State> {
    let mut s = crate::init();
    let mut launcher = Launcher::fixture();
    if let Some(base) = base {
        launcher.connection = Some(Backend::unauthenticated(base).expect("mock backend"));
    }
    let project = Project {
        id: "ws-1".into(),
        path: "/repo".into(),
        temporary: false,
    };
    launcher.project = Some(project.clone());
    s.screen = Screen::Launcher(Box::new(launcher));
    let mut ui = Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    workspace::opened(&mut s, &project);
    let mut rt = Runtime::new(s, crate::view, (1024.0, 760.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    rt.frame(0.02);
    rt
}

fn find_node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| find_node(child, key))
}

fn find_label(rt: &Runtime<State>, key: &str) -> Option<String> {
    let tree = rt.accessibility_json();
    find_node(&tree, key)
        .and_then(|n| n["name"].as_str())
        .map(str::to_owned)
}

#[test]
fn project_without_session_renders_branded_empty_state_and_composer_with_no_session_draft() {
    let mut rt = no_session_project_runtime(None);

    assert_eq!(
        find_label(&rt, "branded-empty-logo").as_deref(),
        Some(t("messageSection.empty.logoAlt"))
    );
    assert_eq!(
        find_label(&rt, "branded-empty-brand-title").as_deref(),
        Some(t("messageSection.empty.brandTitle"))
    );
    assert_eq!(
        find_label(&rt, "branded-empty-title").as_deref(),
        Some(t("messageSection.empty.title"))
    );
    assert_eq!(
        find_label(&rt, "branded-empty-description").as_deref(),
        Some(t("instanceShell.empty.description"))
    );
    assert_eq!(
        find_label(&rt, "branded-empty-tip-palette").as_deref(),
        Some(t("messageSection.empty.tips.commandPalette"))
    );
    assert_eq!(
        find_label(&rt, "branded-empty-tip-codebase").as_deref(),
        Some(t("messageSection.empty.tips.askAboutCodebase"))
    );
    assert!(rt.find("branded-empty-tip-at").is_some());
    assert!(rt.find("session-composer").is_some());
    assert!(rt.find("input").is_some());

    // Typing into the no-session composer persists under NO_SESSION_DRAFT_ID.
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);
    let ev = KeyEvent {
        key: Key::Text("First draft".into()),
        mods: Mods::default(),
    };
    rt.key(ev.clone());
    rt.key_up(ev);
    rt.frame(0.02);

    assert_eq!(rt.state.draft.text, "First draft");
    let snap = rt.state.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(tab) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        tab.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("First draft")
    );
}

#[test]
fn empty_active_session_renders_branded_empty_state_only_when_loaded_and_empty() {
    let mut s = crate::init();
    s.phase = Phase::Ready;
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    rt.frame(0.02);

    assert_eq!(
        find_label(&rt, "branded-empty-description").as_deref(),
        Some(t("messageSection.empty.description"))
    );
    assert!(rt.find("branded-empty-logo").is_some());

    // Hidden while loading, errored, paging/has_more, or once messages exist.
    rt.update(|s, _| s.phase = Phase::Loading);
    rt.frame(0.02);
    assert!(rt.find("branded-empty-state").is_none());

    rt.update(|s, _| {
        s.phase = Phase::Ready;
        s.history_error = true;
    });
    rt.frame(0.02);
    assert!(rt.find("branded-empty-state").is_none());

    rt.update(|s, _| {
        s.history_error = false;
        s.can_older = true;
    });
    rt.frame(0.02);
    assert!(rt.find("branded-empty-state").is_none());

    rt.update(|s, _| {
        s.can_older = false;
        s.messages.push(
            Message {
                id: "m1".into(),
                role: "user".into(),
                body: "Hello".into(),
                completed: true,
                usage: None,
                parts: vec![],
            }
            .into(),
        );
        s.revision += 1;
    });
    rt.frame(0.02);
    assert!(rt.find("branded-empty-state").is_none());
}

#[test]
fn first_prompt_from_no_session_creates_one_session_and_sends_prompt_with_attachments() {
    let server = spawn_mock_server(false);
    let mut rt = no_session_project_runtime(Some(&server.base));

    rt.update(|s, tx| {
        s.draft = TextEdit::new("Explain this module");
        assert!(s.composer.draft.attach(Attachment::Device {
            name: "notes.txt".into(),
            mime: "text/plain".into(),
            bytes: Arc::from(b"hello".as_slice()),
            token: None,
        }));
        workspace::draft_changed(s, tx);
    });
    rt.frame(0.02);

    // Double submission must not create a second session or flash a send error.
    rt.update(|s, tx| {
        crate::composer::send(s, tx, false);
        crate::composer::send(s, tx, false);
    });
    rt.frame(0.02);
    assert!(!rt.state.composer.send_error);
    assert!(find_node(&rt.accessibility_json(), "composer-send-error").is_none());

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        rt.frame(0.02);
        if !server.prompts.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(server.created.load(Ordering::SeqCst), 1);
    assert!(!rt.state.screen.is_launcher());
    assert_eq!(workspace::active_session(&rt.state), Some("ses-auto-1"));
    let sent = server.prompts.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["text"], "Explain this module");
    assert_eq!(
        sent[0]["files"].as_array().map(Vec::len),
        Some(1),
        "expected attachment to survive auto-session creation"
    );
}

#[test]
fn failed_auto_session_creation_preserves_draft_and_shows_error() {
    let server = spawn_mock_server(true);
    let mut rt = no_session_project_runtime(Some(&server.base));

    rt.update(|s, tx| {
        s.draft = TextEdit::new("Keep this draft");
        workspace::draft_changed(s, tx);
    });
    rt.frame(0.02);

    rt.update(|s, tx| crate::composer::send(s, tx, false));
    rt.frame(0.02);

    let mut now = 0.05;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        rt.frame(now);
        now += 0.05;
        if rt.state.composer.send_error
            && find_node(&rt.accessibility_json(), "composer-send-error").is_some()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    rt.update(|_, _| {});
    rt.frame(now);
    assert_eq!(server.created.load(Ordering::SeqCst), 1);
    assert!(rt.state.screen.is_launcher());
    assert!(rt.state.composer.send_error);
    assert_eq!(rt.state.draft.text, "Keep this draft");
    let tree = rt.accessibility_json();
    let send_err = find_node(&tree, "composer-send-error").unwrap_or_else(|| {
        let project_present = rt
            .state
            .screen
            .launcher()
            .is_some_and(|l| l.project.is_some());
        let auth_req = rt
            .state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required);
        let has_composer = find_node(&tree, "session-composer").is_some();
        panic!(
            "missing composer-send-error (project={project_present}, auth_req={auth_req}, has_composer={has_composer})"
        );
    });
    assert_eq!(send_err["role"], "alert");
    assert_eq!(
        send_err["name"].as_str(),
        Some(t("promptInput.send.errorTitle"))
    );
    let snap = rt.state.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(tab) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        tab.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("Keep this draft")
    );
}

#[test]
fn shell_command_from_no_session_creates_session_and_dispatches_shell() {
    let server = spawn_mock_server(false);
    let mut rt = no_session_project_runtime(Some(&server.base));

    rt.update(|s, tx| {
        s.composer.shell_mode = true;
        s.draft = TextEdit::new("echo hello");
        workspace::draft_changed(s, tx);
    });
    rt.frame(0.02);

    rt.update(|s, tx| crate::composer::send(s, tx, false));
    rt.frame(0.02);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        rt.frame(0.02);
        if !server.shells.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(server.created.load(Ordering::SeqCst), 1);
    assert!(!rt.state.screen.is_launcher());
    let sent = server.shells.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["command"], "echo hello");
}

#[test]
fn slash_command_from_no_session_waits_for_catalogue_and_dispatches_command() {
    let server = spawn_mock_server(false);
    let mut rt = no_session_project_runtime(Some(&server.base));

    rt.update(|s, tx| {
        s.draft = TextEdit::new("/compact now");
        workspace::draft_changed(s, tx);
    });
    rt.frame(0.02);

    rt.update(|s, tx| crate::composer::send(s, tx, false));
    rt.frame(0.02);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        rt.frame(0.02);
        if !server.commands.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(server.created.load(Ordering::SeqCst), 1);
    assert!(!rt.state.screen.is_launcher());
    assert!(server.prompts.lock().unwrap().is_empty());
    let sent = server.commands.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["name"], "compact");
    assert_eq!(sent[0]["text"], "now");
}
