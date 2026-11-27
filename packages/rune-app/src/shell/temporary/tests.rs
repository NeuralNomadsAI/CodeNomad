use super::*;
use crate::{
    Screen, State,
    backend::Backend,
    catalog::{Project, Session},
    init,
    launcher::Launcher,
    shell::command_palette,
    strings, workspace,
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

struct MockReply {
    status: &'static str,
    body: String,
}

struct MockServer {
    backend: Backend,
    addr: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl MockServer {
    fn start(replies: Vec<MockReply>) -> Self {
        Self::start_with_caps(replies, r#"["temporary-workspaces"]"#)
    }

    fn start_with_caps(replies: Vec<MockReply>, capabilities_json: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let meta_body = format!(
            r#"{{"serverId":"srv-temp","apiContract":1,"capabilities":{capabilities_json}}}"#
        );
        let mut queue = VecDeque::from(replies);
        let handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let header_end;
                loop {
                    match stream.read(&mut tmp) {
                        Ok(0) | Err(_) => {
                            header_end = buf.len();
                            break;
                        }
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
                    continue;
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
                let request_line = head.lines().next().unwrap_or("").to_owned();
                let end = (header_end + content_len).min(buf.len());
                let body = String::from_utf8_lossy(&buf[header_end..end]).into_owned();
                let method = request_line.split_whitespace().next().unwrap_or("");
                let path = request_line.split_whitespace().nth(1).unwrap_or("");
                let is_tracked = (method == "POST"
                    && (path == "/api/workspaces/temporary"
                        || path == "/api/workspaces/temporary/abandon"
                        || path == "/api/workspaces"
                        || (path.starts_with("/api/workspaces/")
                            && (path.ends_with("/keep") || path.ends_with("/discard")))))
                    || (method == "GET" && path == "/api/workspaces/temporary")
                    || (method == "DELETE"
                        && path.starts_with("/api/workspaces/")
                        && !path.contains("/creation/"))
                    || (method == "GET" && path.contains("/instance/api/session"));
                let reply = if is_tracked {
                    seen.lock()
                        .unwrap()
                        .push((request_line.clone(), body.clone()));
                    let mut reply = queue.pop_front().unwrap_or(MockReply {
                        status: "204 No Content",
                        body: String::new(),
                    });
                    if method == "POST"
                        && path == "/api/workspaces"
                        && reply.status.starts_with("200")
                        && let Ok(req_json) = serde_json::from_str::<serde_json::Value>(&body)
                        && let Some(req_id) = req_json["requestId"].as_str()
                        && let Ok(mut resp_json) =
                            serde_json::from_str::<serde_json::Value>(&reply.body)
                        && let Some(obj) = resp_json.as_object_mut()
                    {
                        obj.insert("requestId".into(), json!(req_id));
                        reply.body = resp_json.to_string();
                    }
                    reply
                } else if path.starts_with("/api/meta") {
                    MockReply {
                        status: "200 OK",
                        body: meta_body.clone(),
                    }
                } else if path.starts_with("/api/storage/config/ui") {
                    MockReply {
                        status: "200 OK",
                        body: r#"{"settings":{"locale":"en","hotkeyOverrides":{"new-temporary-instance":[{"key":"t","alt":true}]}}}"#.into(),
                    }
                } else if path.starts_with("/api/storage/state/ui") {
                    MockReply {
                        status: "200 OK",
                        body: r#"{"state":{}}"#.into(),
                    }
                } else if path.contains("/worktrees") {
                    MockReply {
                        status: "200 OK",
                        body: r#"{"repository":"git","worktrees":[]}"#.into(),
                    }
                } else {
                    MockReply {
                        status: "204 No Content",
                        body: String::new(),
                    }
                };
                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    reply.body.len(),
                    reply.body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        let attest_backend = backend.clone();
        let (done_tx, done_rx) = bounded(1);
        platform::spawn(async move {
            let _ = done_tx.try_send(attest_backend.attest_server().await.is_ok());
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(ok) = done_rx.try_recv() {
                assert!(ok, "mock server attestation failed");
                break;
            }
            assert!(Instant::now() < deadline, "timed out attesting mock server");
            thread::sleep(Duration::from_millis(5));
        }
        Self {
            backend,
            addr,
            stop,
            requests,
            handle: Some(handle),
        }
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.requests.lock().unwrap().clone()
    }
}

fn english(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn connected_runtime(backend: Backend) -> Runtime<State> {
    let mut s = init();
    let mut l = Launcher::fixture();
    l.connection = Some(backend);
    l.server_id = Some("srv-temp".into());
    s.screen = Screen::Launcher(l);
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let mut rt = Runtime::new(s, english, (1400.0, 900.0), Env::new(false, 1.0));
    rt.on_key =
        Some(|s, event, tx| strings::with_locale("en", || crate::shell::keys(s, event, tx)));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        rt.update(|s, tx| {
            let _ = crate::poll(s, 0.0, tx);
        });
        rt.frame(1.0 / 60.0);
        if rt.find("open-folder").is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for launcher shell to mount"
        );
        thread::sleep(Duration::from_millis(5));
    }
    settle(&mut rt);
    rt
}

fn settle(rt: &mut Runtime<State>) {
    rt.frame(0.0);
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
}

fn wait_until(rt: &mut Runtime<State>, mut pred: impl FnMut(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pred(&rt.state) {
        assert!(Instant::now() < deadline, "timed out waiting for state");
        rt.update(|s, tx| {
            let _ = crate::poll(s, 0.0, tx);
        });
        rt.frame(1.0 / 60.0);
        thread::sleep(Duration::from_millis(5));
    }
    settle(rt);
}

fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    rt.key(KeyEvent { key, mods });
    settle(rt);
}

fn focused_key(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| el.focused)
        .and_then(|el| el.key)
}

fn open_fixture_tab(
    rt: &mut Runtime<State>,
    id: &str,
    path: &str,
    temporary: bool,
    sessions: Vec<Session>,
) {
    let project = Project {
        id: id.into(),
        path: path.into(),
        temporary,
    };
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.project = Some(project.clone());
            l.sessions = sessions;
        }
        strings::with_locale("en", || workspace::opened(s, &project));
    });
    settle(rt);
}

#[test]
fn launcher_button_and_shortcut_create_temporary_tabs_with_dedup_and_marker() {
    let server =
        MockServer::start(vec![
        MockReply {
            status: "201 Created",
            body: r#"{"path":"/tmp/cn-temp-1","supportsCancelAndAbandon":true}"#.into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"id":"ws-temp-1","location":{"directory":"/tmp/cn-temp-1"},"temporary":true}"#
                .into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"data":[],"cursor":{}}"#.into(),
        },
        // Second temporary workspace in the same minute
        MockReply {
            status: "201 Created",
            body: r#"{"path":"/tmp/cn-temp-2","supportsCancelAndAbandon":true}"#.into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"id":"ws-temp-2","location":{"directory":"/tmp/cn-temp-2"},"temporary":true}"#
                .into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"data":[],"cursor":{}}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    assert!(
        rt.find("new-temporary-tab").is_some(),
        "launcher home must expose new-temporary-tab button"
    );

    // 1. Click launcher button
    tap(&mut rt, "new-temporary-tab");
    wait_until(&mut rt, |s| {
        workspace::active_temporary_workspace(s).is_some_and(|info| info.project.id == "ws-temp-1")
    });
    let first_name = workspace::active_workspace(&rt.state)
        .unwrap()
        .1
        .project_name
        .clone()
        .expect("temporary tab must receive localized name");
    assert!(
        first_name.contains("Temporary"),
        "expected localized temporary name, got {first_name:?}"
    );
    let items: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
    let temp_tab = items
        .iter()
        .find(|e| e["o"] == "tab" && e["t"] == first_name)
        .expect("rendered temporary tab");
    assert!(
        temp_tab["d"]
            .as_str()
            .is_some_and(|d| d.contains("Temporary")),
        "temporary tab must expose temporary aria description: {temp_tab}"
    );

    // 2. Trigger via shortcut override (Alt+T) -> creates second temporary tab with (2) suffix
    send_key(
        &mut rt,
        Key::Command('t'),
        Mods {
            alt: true,
            ..Mods::default()
        },
    );
    wait_until(&mut rt, |s| {
        workspace::active_temporary_workspace(s).is_some_and(|info| info.project.id == "ws-temp-2")
    });
    let second_name = workspace::active_workspace(&rt.state)
        .unwrap()
        .1
        .project_name
        .clone()
        .unwrap();
    if second_name.starts_with(&first_name) {
        assert_eq!(second_name, format!("{first_name} (2)"));
    } else {
        // Minute rolled over between tab 1 and tab 2; opening another temporary tab in the
        // same millisecond deterministically exercises the `(2)` dedup suffix.
        assert!(second_name.starts_with("Temporary"));
        rt.update(workspace::new_tab);
        open_fixture_tab(&mut rt, "ws-temp-3", "/tmp/cn-temp-3", true, vec![]);
        let third_name = workspace::active_workspace(&rt.state)
            .unwrap()
            .1
            .project_name
            .clone()
            .unwrap();
        assert_eq!(third_name, format!("{second_name} (2)"));
    }
}

#[test]
fn unavailable_server_degrades_gracefully_and_failed_open_abandons_folder() {
    let server = MockServer::start(vec![
        // 501 on create_temporary_folder -> graceful degradation, active tab untouched
        MockReply {
            status: "501 Not Implemented",
            body: String::new(),
        },
        // Second attempt: folder created, then POST /api/workspaces fails 400 -> abandon called
        MockReply {
            status: "201 Created",
            body: r#"{"path":"/tmp/cn-abandon","supportsCancelAndAbandon":true}"#.into(),
        },
        MockReply {
            status: "400 Bad Request",
            body: "Workspace directory is not authorized".into(),
        },
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-regular", "/repo/regular", false, vec![]);
    let tabs_before = rt.state.workspace.as_ref().unwrap().tab_count();

    rt.update(|s, tx| {
        assert!(strings::with_locale("en", || create(s, tx)));
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().tab_count(),
        tabs_before,
        "501 degradation must not open a stray blank tab"
    );
    assert_eq!(
        workspace::active_workspace(&rt.state).unwrap().1.folder,
        "/repo/regular"
    );

    // Second attempt: POST /api/workspaces fails -> abandon_temporary_folder called with path + requestId
    rt.update(|s, tx| {
        assert!(strings::with_locale("en", || create(s, tx)));
    });
    wait_until(&mut rt, |s| {
        !s.temporary.in_flight()
            && s.screen.launcher().is_some_and(|l| !l.pending)
            && server
                .requests()
                .iter()
                .any(|(req, _)| req == "POST /api/workspaces/temporary/abandon HTTP/1.1")
    });
    let abandon = server
        .requests()
        .into_iter()
        .find(|(req, _)| req == "POST /api/workspaces/temporary/abandon HTTP/1.1")
        .expect("abandon request");
    let body: serde_json::Value = serde_json::from_str(&abandon.1).unwrap();
    assert_eq!(body["path"], json!("/tmp/cn-abandon"));
    assert!(body["requestId"].as_str().is_some_and(|id| !id.is_empty()));
}

#[test]
fn untouched_temporary_tab_discards_silently_without_second_delete_and_opens_dialog_on_refusal() {
    let server = MockServer::start(vec![
        // 1. Untouched close -> quiet discard succeeds (NO DELETE after!)
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
        // 2. Untouched close -> server refuses temporary_not_empty -> restore & open choice dialog
        MockReply {
            status: "409 Conflict",
            body: r#"{"error":"temporary_not_empty"}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);
    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-a", "/tmp/cn-a", true, vec![]);
    let temp_a_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

    // Close untouched temp A -> yields immediately to ws-base, then finishes discard without DELETE
    rt.update(|s, tx| strings::with_locale("en", || workspace::close(s, &temp_a_key, tx)));
    assert_eq!(
        workspace::active_workspace(&rt.state).unwrap().1.folder,
        "/repo/base",
        "discard must yield active tab to neighbour before server reply"
    );
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 1);
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].0, "POST /api/workspaces/ws-temp-a/discard HTTP/1.1");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&reqs[0].1).unwrap(),
        json!({"onlyIfEmpty": true})
    );

    // Second untouched tab -> server refuses temporary_not_empty -> tab restored & dialog opened (no error!)
    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-b", "/tmp/cn-b", true, vec![]);
    let temp_b_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

    rt.update(|s, tx| strings::with_locale("en", || workspace::close(s, &temp_b_key, tx)));
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        temp_b_key,
        "refused quiet discard must restore tab in place"
    );
    assert!(
        is_open(&rt.state),
        "refused quiet discard must open Keep/Discard/Cancel dialog"
    );
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some(theme::CANCEL),
        "choice dialog must focus Cancel initially"
    );
    // Pressing Enter while Cancel is focused cancels without discarding!
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!is_open(&rt.state));
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
}

#[test]
fn non_empty_dialog_handles_keep_discard_refusal_and_standalone_palette_keep() {
    let server = MockServer::start(vec![
        // 1. Standalone Keep from command palette
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
        // 2. Dialog Discard refused with temporary_running -> restored in place with error
        MockReply {
            status: "409 Conflict",
            body: r#"{"error":"temporary_running"}"#.into(),
        },
        // 3. Dialog Keep -> succeeds, then ordinary release DELETE /api/workspaces/:id
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);

    // Open temporary tab 1 with a conversation -> keep-temporary-instance appears in command palette
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-keep-open",
        "/tmp/cn-keep-open",
        true,
        vec![Session {
            id: "s-1".into(),
            title: "Work".into(),
        }],
    );
    assert!(can_keep_active(&rt.state));
    assert_eq!(
        strings::with_locale("en", || command_palette::item_disabled(
            &rt.state,
            "keep-temporary-instance"
        )),
        Some(false)
    );
    rt.update(|s, tx| {
        assert!(strings::with_locale("en", || keep_active(s, tx)));
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert!(
        !workspace::active_workspace(&rt.state).unwrap().1.temporary,
        "standalone keep must clear temporary flag while keeping tab open"
    );
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);

    // Open temporary tab 2 with a conversation -> close opens dialog
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-dialog",
        "/tmp/cn-dialog",
        true,
        vec![Session {
            id: "s-2".into(),
            title: "Active".into(),
        }],
    );
    let dialog_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| strings::with_locale("en", || workspace::close(s, &dialog_key, tx)));
    settle(&mut rt);
    assert!(is_open(&rt.state));
    assert_eq!(focused_key(&rt).as_deref(), Some(theme::CANCEL));

    // Click Discard -> yields to neighbour, then temporary_running restores tab in place
    tap(&mut rt, theme::DISCARD);
    assert_ne!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        dialog_key,
        "explicit discard must yield active tab before awaiting server"
    );
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        dialog_key,
        "temporary_running refusal must restore tab in place"
    );
    assert!(workspace::active_workspace(&rt.state).unwrap().1.temporary);

    // Close again and choose Keep -> keeps folder on server and closes tab ordinarily
    rt.update(|s, tx| strings::with_locale("en", || workspace::close(s, &dialog_key, tx)));
    settle(&mut rt);
    assert!(is_open(&rt.state));
    tap(&mut rt, theme::KEEP);
    wait_until(&mut rt, |s| {
        !s.temporary.in_flight()
            && server
                .requests()
                .iter()
                .any(|(req, _)| req == "DELETE /api/workspaces/ws-temp-dialog HTTP/1.1")
    });
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
}

#[test]
fn stopped_and_temporary_changed_sync_tabs_without_second_delete_and_snapshot_persists_flag() {
    let server = MockServer::start(vec![]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);
    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-sync", "/tmp/cn-sync", true, vec![]);
    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-stop", "/tmp/cn-stop", true, vec![]);

    // 1. Snapshot persistence round-trips temporary: true and omits false
    let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    let encoded_bytes = workspace::encode(&snapshot).expect("encode snapshot");
    let encoded: serde_json::Value = serde_json::from_slice(&encoded_bytes).unwrap();
    assert!(encoded["session"]["tabs"][0].get("temporary").is_none());
    assert_eq!(encoded["session"]["tabs"][1]["temporary"], json!(true));
    assert_eq!(encoded["session"]["tabs"][2]["temporary"], json!(true));
    let decoded = workspace::decode(&encoded_bytes).expect("decode snapshot");
    match (&decoded.tabs[0], &decoded.tabs[1]) {
        (workspace::Tab::Workspace(base), workspace::Tab::Workspace(temp)) => {
            assert!(!base.temporary);
            assert!(temp.temporary);
        }
        other => panic!("unexpected tabs: {other:?}"),
    }
    // Non-boolean temporary field degrades to false without breaking restoration
    let mut non_bool = encoded;
    non_bool["session"]["tabs"][1]["temporary"] = json!("yes");
    let decoded_non_bool =
        workspace::decode(&serde_json::to_vec(&non_bool).unwrap()).expect("non-bool ignored");
    match &decoded_non_bool.tabs[1] {
        workspace::Tab::Workspace(w) => assert!(!w.temporary),
        other => panic!("unexpected tab: {other:?}"),
    }

    // 2. workspace.temporaryChanged clears kept tab's temporary flag
    rt.update(|s, _| {
        assert!(workspace::reconcile_temporary_folders(
            s,
            &["/tmp/cn-stop".into()]
        ));
    });
    let sync_snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    match &sync_snapshot.tabs[1] {
        workspace::Tab::Workspace(w) => assert!(!w.temporary),
        other => panic!("unexpected tab: {other:?}"),
    }

    // 3. workspace.stopped (deleted) detaches temporary tab locally WITHOUT calling DELETE,
    //    even when workspace.temporaryChanged arrives in the same poll!
    rt.update(|s, tx| {
        s.temporary
            .queue_stopped("ws-temp-stop".into(), true, false);
        s.temporary.queue_temporary_folders(vec![]);
        assert!(poll(s, tx));
    });
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
    assert!(
        server.requests().is_empty(),
        "workspace.stopped on temporary tab must not send DELETE: {:?}",
        server.requests()
    );
}

#[test]
fn missing_capability_hides_launcher_button_and_blocks_shortcut_and_palette() {
    let server = MockServer::start_with_caps(vec![], "[]");
    let mut rt = connected_runtime(server.backend.clone());
    assert!(
        rt.find("new-temporary-tab").is_none(),
        "launcher must hide new-temporary-tab when server omits temporary-workspaces capability"
    );
    assert!(!can_create(&rt.state));
    send_key(
        &mut rt,
        Key::Command('t'),
        Mods {
            alt: true,
            ..Mods::default()
        },
    );
    assert!(!rt.state.temporary.in_flight());
    assert!(server.requests().is_empty());
}

#[test]
fn discard_refusal_cancels_neighbour_restore_preserves_exit_snapshot_and_handles_401_and_not_found()
{
    let server = MockServer::start(vec![
        // 1. Discard ws-sib-1 -> 404 temporary_not_found (must NOT clear ws-sib-2's temporary mark)
        MockReply {
            status: "404 Not Found",
            body: r#"{"error":"temporary_not_found"}"#.into(),
        },
        // 2. Discard ws-sib-2 -> 401 Unauthorized (must restore without dialog and trigger auth)
        MockReply {
            status: "401 Unauthorized",
            body: r#"{"error":"Authentication required"}"#.into(),
        },
        // 3. Reconnect reconcile -> GET /api/workspaces/temporary returns [] -> clears mark
        MockReply {
            status: "200 OK",
            body: r#"{"folders":[]}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(
        &mut rt,
        "ws-sib-1",
        "/tmp/cn-sib",
        true,
        vec![Session {
            id: "s-1".into(),
            title: "One".into(),
        }],
    );
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-sib-2",
        "/tmp/cn-sib",
        true,
        vec![Session {
            id: "s-2".into(),
            title: "Two".into(),
        }],
    );
    let sib1_key = "tab-0".to_owned();
    let sib2_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

    // 1. Start explicit discard on sib-1; while in flight, snapshot_with_stashed still keeps it!
    rt.update(|s, tx| {
        strings::with_locale("en", || {
            open_dialog(s, &sib1_key, Some(format!("t-{sib1_key}")), tx);
            choose_discard(s, tx);
        });
    });
    assert!(rt.state.temporary.in_flight());
    let in_flight_snap = rt
        .state
        .workspace
        .as_ref()
        .unwrap()
        .snapshot_with_stashed(rt.state.temporary.stashed_for_snapshot());
    assert_eq!(
        in_flight_snap.tabs.len(),
        2,
        "exit snapshot during in-flight discard must retain stashed temporary tab"
    );
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    // temporary_not_found detaches only dead ws-sib-1 (no second DELETE) and keeps sibling ws-sib-2's temporary mark!
    let snap = rt.state.workspace.as_ref().unwrap().snapshot();
    assert_eq!(
        snap.tabs.len(),
        1,
        "temporary_not_found on discard must detach dead occurrence locally"
    );
    match &snap.tabs[0] {
        workspace::Tab::Workspace(w) => {
            assert!(
                w.temporary,
                "temporary_not_found on one tab must not strip temporary flag from sibling"
            );
        }
        other => panic!("unexpected sibling tab: {other:?}"),
    }
    assert!(
        server
            .requests()
            .iter()
            .all(|(req, _)| !req.starts_with("DELETE ")),
        "temporary_not_found detach must not send duplicate DELETE"
    );

    // 2. Discard on ws-sib-2 returns 401 -> restores tab without dialog and flags auth_required
    rt.update(|s, tx| {
        strings::with_locale("en", || {
            open_dialog(s, &sib2_key, Some(format!("t-{sib2_key}")), tx);
            choose_discard(s, tx);
        });
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert!(!is_open(&rt.state));
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| l.authentication_required),
        "HTTP 401 on discard must trigger authentication_required"
    );
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        sib2_key,
        "HTTP 401 must restore the stashed tab in place"
    );

    // 3. After re-auth, trigger_reconnect_reconcile fetches GET /api/workspaces/temporary and clears marks
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        trigger_reconnect_reconcile(s);
    });
    wait_until(&mut rt, |s| !workspace::has_temporary_tabs(s));
    assert!(
        server
            .requests()
            .iter()
            .any(|(req, _)| req == "GET /api/workspaces/temporary HTTP/1.1")
    );
}

#[test]
fn retained_stopped_preserves_drafts_and_discard_refusal_cancels_unopened_neighbour_restore() {
    let server = MockServer::start(vec![
        // 1. Discard returns 409 temporary_running while neighbour restore is pending
        MockReply {
            status: "409 Conflict",
            body: r#"{"error":"temporary_running"}"#.into(),
        },
        // 2. Selecting neighbour AFTER refusal must still trigger launcher::restore (no empty cache!)
        MockReply {
            status: "200 OK",
            body:
                r#"{"id":"ws-neigh","location":{"directory":"/repo/neighbour"},"temporary":false}"#
                    .into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"data":[],"cursor":{}}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    // Seed tab-0 as a genuine restored-but-unopened neighbour (Tab::Workspace with no binding/project/cache)
    // and tab-1 as the active open temporary workspace!
    let restored_snap = workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: Default::default(),
        file_wrap: None,
        tabs: vec![
            workspace::Tab::Workspace(workspace::Workspace {
                backend_id: Some("external".into()),
                server_id: Some("srv-temp".into()),
                folder: "/repo/neighbour".into(),
                project_name: None,
                temporary: false,
                occurrence: 1,
                workspace_id: None,
                active_session_id: None,
                drafts: Default::default(),
                attachment_drafts: Default::default(),
                attachment_parts: Default::default(),
                view: Default::default(),
            }),
            workspace::Tab::Blank,
        ],
        active: Some(1),
    };
    let encoded = workspace::encode(&restored_snap).unwrap();
    let decoded = workspace::decode(&encoded).unwrap();
    assert_eq!(decoded.tabs.len(), 2);
    // Open active temporary tab, then switch to test cancel_pending_restore + untouched neighbour
    open_fixture_tab(
        &mut rt,
        "ws-temp-focus",
        "/tmp/cn-focus",
        true,
        vec![Session {
            id: "s-f".into(),
            title: "Focus".into(),
        }],
    );
    let temp_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    // Simulate a pending restore tagged with the active tab intent; discard refusal must cancel it
    // without touching unrelated non-restore jobs.
    rt.update(|s, tx| {
        strings::with_locale("en", || {
            open_dialog(s, &temp_key, Some(format!("t-{temp_key}")), tx);
            choose_discard(s, tx);
        });
        let yield_key = s.workspace.as_ref().unwrap().active_key().to_owned();
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = true;
            l.pending_restore_intent = Some(yield_key);
        }
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert!(
        rt.state.screen.launcher().is_some_and(|l| !l.pending),
        "restore_stashed must cancel a pending neighbour restore matching active intent"
    );
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), temp_key);

    // Retained workspace.stopped (temporaryRetained: true) detaches tab without sending DELETE
    rt.update(|s, tx| {
        assert!(workspace::detach_stopped_temporary(
            s,
            "ws-temp-focus",
            true,
            true,
            tx
        ));
    });
    assert!(
        server
            .requests()
            .iter()
            .all(|(req, _)| !req.starts_with("DELETE "))
    );
}

#[test]
fn palette_toggle_focus_stashed_reconcile_device_attachment_404_and_auth_abandon() {
    let server = MockServer::start(vec![
        // 1. Discard 404 temporary_not_found on tab with device attachment -> restores tab!
        MockReply {
            status: "404 Not Found",
            body: r#"{"error":"temporary_not_found"}"#.into(),
        },
        // 2. Quiet discard 409 after reconcile_temporary_folders cleared stashed mark -> restores with temporary=false & no dialog!
        MockReply {
            status: "409 Conflict",
            body: r#"{"error":"temporary_not_empty"}"#.into(),
        },
        // 3. Create temporary folder succeeds AFTER cancel_for_auth -> queued until auth recovers, then abandoned!
        MockReply {
            status: "200 OK",
            body: r#"{"path":"/tmp/cn-auth-orphan","supportsCancelAndAbandon":true}"#.into(),
        },
        // 4. Abandon on renewed connection
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);

    // 1. Focus return preserves command-palette-toggle when cancelling dialog opened via palette
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-att",
        "/tmp/cn-att",
        true,
        vec![Session {
            id: "s-att".into(),
            title: "Attach".into(),
        }],
    );
    let att_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| {
        set_pending_return_focus(s, Some("command-palette-toggle".into()));
        strings::with_locale("en", || open_dialog(s, &att_key, None, tx));
    });
    assert!(is_open(&rt.state));
    assert_eq!(
        rt.state
            .temporary
            .dialog
            .as_ref()
            .and_then(|d| d.return_focus.as_deref()),
        Some("command-palette-toggle"),
        "command-palette-toggle must be preserved as return focus target"
    );
    rt.update(|s, tx| cancel(s, tx));
    assert!(!is_open(&rt.state));

    // 2. Attach a device file in composer draft; discard returning 404 must restore the tab instead of dropping it
    rt.update(|s, tx| {
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-att".into();
                b.session = "s-att".into();
                b
            })
            .unwrap();
        let _ = workspace::bound(s, &bound_backend);
        assert!(
            s.composer
                .draft
                .attach(crate::composer::draft::Attachment::Device {
                    name: "local.bin".into(),
                    mime: "application/octet-stream".into(),
                    bytes: std::sync::Arc::from(&b"hello-device"[..]),
                    token: None,
                })
        );
        workspace::capture(s);
        strings::with_locale("en", || {
            open_dialog(s, &att_key, Some(format!("t-{att_key}")), tx);
            choose_discard(s, tx);
        });
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        att_key,
        "404 temporary_not_found must restore a tab carrying in-memory device attachments"
    );
    assert_eq!(
        rt.state.composer.draft.inline_usage().0,
        1,
        "device attachment bytes must survive a 404 temporary_not_found discard"
    );

    // 3. Quiet discard + reconcile_temporary_folders during flight -> restored with temporary=false & no dialog
    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-rec", "/tmp/cn-rec", true, vec![]);
    let rec_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| {
        strings::with_locale("en", || workspace::close(s, &rec_key, tx));
        assert!(s.temporary.stashed_for_snapshot().is_some());
        assert!(workspace::reconcile_temporary_folders(
            s,
            &["/tmp/cn-att".into()]
        ));
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert!(!is_open(&rt.state));
    assert!(
        !workspace::active_workspace(&rt.state).unwrap().1.temporary,
        "stashed tab reconciled during discard must restore as ordinary non-temporary workspace"
    );

    // 4. cancel_for_auth while create is in flight -> drains into pending_abandons and abandons on renewed auth
    rt.update(|s, tx| {
        assert!(create(s, tx));
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = true;
        }
        s.temporary.cancel_for_auth();
    });
    wait_until(&mut rt, |s| !s.temporary.pending_abandons.is_empty());
    assert!(
        server
            .requests()
            .iter()
            .all(|(req, _)| req != "POST /api/workspaces/temporary/abandon HTTP/1.1"),
        "abandon must wait for renewed authentication instead of firing with expired cookie"
    );
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        assert!(poll(s, tx));
    });
    wait_until(&mut rt, |_| {
        server
            .requests()
            .iter()
            .any(|(req, _)| req == "POST /api/workspaces/temporary/abandon HTTP/1.1")
    });
}

#[test]
fn keep_then_close_aborts_detach_when_in_memory_draft_arrives_in_flight() {
    let server = MockServer::start(vec![
        MockReply {
            status: "200 OK",
            body: r#"{"ok":true}"#.into(),
        },
        MockReply {
            status: "200 OK",
            body: r#"{"ok":true}"#.into(),
        },
        MockReply {
            status: "404 Not Found",
            body: r#"{"error":"temporary_not_found"}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);

    // 1. Oversized (> 32,768 UTF-16) draft typed while POST /keep is in flight
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-keep",
        "/tmp/cn-keep-draft",
        true,
        vec![Session {
            id: "s-keep".into(),
            title: "Keep".into(),
        }],
    );
    let temp_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    let oversized = "x".repeat(32_769);
    rt.update(|s, tx| {
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-keep".into();
                b.session = "s-keep".into();
                b
            })
            .unwrap();
        let _ = workspace::bound(s, &bound_backend);
        s.draft.text = "short draft".into();
        workspace::capture(s);
        strings::with_locale("en", || {
            open_dialog(s, &temp_key, Some(format!("t-{temp_key}")), tx);
            choose_keep(s, tx);
        });
        assert!(s.temporary.keeping.is_some());
        s.draft.text = oversized.clone();
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        temp_key,
        "tab must stay open when an oversized draft makes close_blocked true during keep"
    );
    assert!(
        !workspace::active_workspace(&rt.state).unwrap().1.temporary,
        "temporary marker must still be cleared after keep succeeds"
    );
    assert_eq!(
        rt.state.draft.text, oversized,
        "in-flight oversized draft text must be preserved verbatim"
    );

    // 2. Local device attachment added while POST /keep is in flight
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-keep-att",
        "/tmp/cn-keep-att",
        true,
        vec![Session {
            id: "s-keep-att".into(),
            title: "Keep Att".into(),
        }],
    );
    let att_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| {
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-keep-att".into();
                b.session = "s-keep-att".into();
                b
            })
            .unwrap();
        let _ = workspace::bound(s, &bound_backend);
        s.draft.text = "short draft".into();
        workspace::capture(s);
        strings::with_locale("en", || {
            open_dialog(s, &att_key, Some(format!("t-{att_key}")), tx);
            choose_keep(s, tx);
        });
        assert!(s.temporary.keeping.is_some());
        assert!(
            s.composer
                .draft
                .attach(crate::composer::draft::Attachment::Device {
                    name: "local.bin".into(),
                    mime: "application/octet-stream".into(),
                    bytes: std::sync::Arc::from(&b"keep-device-bytes"[..]),
                    token: None,
                })
        );
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        att_key,
        "tab must stay open when a local device attachment arrives during keep"
    );
    assert!(
        !workspace::active_workspace(&rt.state).unwrap().1.temporary,
        "temporary marker must still be cleared after keep succeeds"
    );
    assert!(
        rt.state
            .composer
            .draft
            .attachments
            .iter()
            .any(|att| matches!(
                att,
                crate::composer::draft::Attachment::Device { name, bytes, .. }
                    if name == "local.bin" && bytes.as_ref() == b"keep-device-bytes"
            )),
        "in-flight local device attachment bytes must be preserved verbatim"
    );

    // 3. 404 temporary_not_found during Keep while device picker is busy must not detach or cancel it
    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-dead-busy",
        "/tmp/cn-dead-busy",
        true,
        vec![Session {
            id: "s-dead".into(),
            title: "Dead".into(),
        }],
    );
    let dead_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| {
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-dead-busy".into();
                b.session = "s-dead".into();
                b
            })
            .unwrap();
        let _ = workspace::bound(s, &bound_backend);
        s.screen.show_chat();
        s.phase = crate::Phase::Ready;
        s.composer.picker.set_attachments_supported(true);
        strings::with_locale("en", || {
            open_dialog(s, &dead_key, Some(format!("t-{dead_key}")), tx);
            choose_keep(s, tx);
        });
        assert!(s.temporary.keeping.is_some());
        assert!(crate::composer::device::available(s));
        s.composer.device.choosing = true;
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        dead_key,
        "404 temporary_not_found must not detach while device attachment picker is busy"
    );
    assert!(
        rt.state.composer.device.choosing,
        "active device picker must remain untouched"
    );

    // 4. Retained workspace.stopped after agent.workspace_stopped sets scope_missing must still
    //    preserve unsent agent form / rejection drafts instead of detaching the tab.
    rt.update(|s, tx| {
        s.composer.device.choosing = false;
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-dead-busy".into();
                b.session = "s-dead".into();
                b
            })
            .unwrap();
        let mut agent = crate::agent::Ui::new(crate::agent::start(bound_backend, s.wake.clone()));
        agent
            .reasons
            .insert("perm-1".into(), rune::edit::TextEdit::new("unsent reason"));
        assert!(agent.workspace_stopped("ws-temp-dead-busy"));
        assert!(agent.is_scope_missing());
        assert!(!agent.navigation_blocked());
        s.agent = Some(agent);
        assert!(
            !workspace::detach_stopped_temporary(s, "ws-temp-dead-busy", true, true, tx),
            "retained workspace.stopped must not detach a tab with unsent form/rejection drafts"
        );
    });
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), dead_key);
    assert_eq!(
        rt.state
            .agent
            .as_ref()
            .and_then(|a| a.reasons.get("perm-1"))
            .map(|e| e.text.as_str()),
        Some("unsent reason")
    );
}

#[test]
fn abandon_drain_retries_after_401_until_reauthenticated() {
    let server = MockServer::start(vec![
        // 1. First drain after auth renewal hits 401 -> re-queues & enters auth-required
        MockReply {
            status: "401 Unauthorized",
            body: r#"{"error":"unauthorized"}"#.into(),
        },
        // 2. Second drain after re-authentication succeeds
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
        // 3. Stale backend abandon hits 401 after launcher switched to a fresh connection on same server
        MockReply {
            status: "401 Unauthorized",
            body: r#"{"error":"unauthorized"}"#.into(),
        },
        // 4. Retry on the fresh connection succeeds without disrupting auth state
        MockReply {
            status: "204 No Content",
            body: String::new(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());

    // Queue an abandon while authentication is required.
    rt.update(|s, _| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = true;
        }
        queue_abandon(
            s,
            server.backend.clone(),
            "/tmp/cn-401-retry".into(),
            Some("req-401".into()),
        );
    });
    assert_eq!(rt.state.temporary.pending_abandons.len(), 1);

    // Renew auth: drain fires the abandon, which returns 401 and must re-queue instead of dropping.
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        assert!(poll(s, tx));
    });
    wait_until(&mut rt, |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.authentication_required)
            && !s.temporary.pending_abandons.is_empty()
            && s.temporary.in_flight_abandons.is_empty()
    });
    let abandon_count = |srv: &MockServer| {
        srv.requests()
            .iter()
            .filter(|(req, _)| req == "POST /api/workspaces/temporary/abandon HTTP/1.1")
            .count()
    };
    assert_eq!(abandon_count(&server), 1);

    // Additional polls while still unauthenticated must not spin in a 401 loop.
    rt.update(|s, tx| {
        let _ = poll(s, tx);
    });
    assert_eq!(abandon_count(&server), 1);
    assert_eq!(rt.state.temporary.pending_abandons.len(), 1);

    // Re-authenticate again: the re-queued abandon retries and settles with 204.
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.authentication_required = false;
        }
        assert!(poll(s, tx));
    });
    wait_until(&mut rt, |s| {
        s.temporary.pending_abandons.is_empty() && s.temporary.in_flight_abandons.is_empty()
    });
    assert_eq!(abandon_count(&server), 2);
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| !l.authentication_required)
    );

    // Direct abandon on an older Http client getting 401 after launcher already moved to a fresh
    // connection on the same server retries immediately on the fresh connection without forcing auth.
    let fresh_backend = Backend::unauthenticated(&format!("http://{}/", server.addr)).unwrap();
    rt.update(|s, _| {
        queue_abandon(
            s,
            server.backend.clone(),
            "/tmp/cn-401-fresh".into(),
            Some("req-fresh".into()),
        );
        if let Some(l) = s.screen.launcher_mut() {
            l.connection = Some(fresh_backend.clone());
        }
    });
    wait_until(&mut rt, |s| {
        abandon_count(&server) == 4
            && s.temporary.pending_abandons.is_empty()
            && s.temporary.in_flight_abandons.is_empty()
    });
    assert!(
        rt.state
            .screen
            .launcher()
            .is_some_and(|l| !l.authentication_required),
        "401 from superseded client must not force re-auth on the fresh connection"
    );
}

#[test]
fn discard_404_protecting_in_memory_draft_clears_dead_binding() {
    let server = MockServer::start(vec![MockReply {
        status: "404 Not Found",
        body: r#"{"error":"temporary_not_found"}"#.into(),
    }]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);

    rt.update(workspace::new_tab);
    open_fixture_tab(
        &mut rt,
        "ws-temp-dead",
        "/tmp/cn-dead",
        true,
        vec![Session {
            id: "s-dead".into(),
            title: "Dead".into(),
        }],
    );
    let dead_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, tx| {
        let bound_backend = s
            .screen
            .launcher()
            .and_then(|l| l.connection.clone())
            .map(|mut b| {
                b.workspace = "ws-temp-dead".into();
                b.session = "s-dead".into();
                b
            })
            .unwrap();
        let _ = workspace::bound(s, &bound_backend);
        assert!(
            s.composer
                .draft
                .attach(crate::composer::draft::Attachment::Device {
                    name: "keep.bin".into(),
                    mime: "application/octet-stream".into(),
                    bytes: std::sync::Arc::from(&b"preserve-bytes"[..]),
                    token: None,
                })
        );
        workspace::capture(s);
        strings::with_locale("en", || {
            let _ = open_dialog(s, &dead_key, Some(format!("t-{dead_key}")), tx);
            choose_discard(s, tx);
        });
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());

    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        dead_key,
        "tab with in-memory device attachment must be restored after 404 temporary_not_found"
    );
    assert_eq!(
        rt.state.composer.draft.inline_usage().0,
        1,
        "device attachment bytes must survive 404 restoration"
    );
    assert!(
        rt.state
            .screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .is_none(),
        "launcher must not retain dead project.id after 404 restoration"
    );
    assert!(
        workspace::active_workspace(&rt.state)
            .and_then(|(_, w)| w.workspace_id.as_deref())
            .is_none(),
        "saved workspace must clear dead workspace_id after 404 restoration"
    );
    assert!(
        workspace::temporary_tab_info(&rt.state, &dead_key).is_none(),
        "detached dead binding must no longer expose live temporary workspace actions"
    );
    assert!(rt.state.commands.is_none());
    assert!(rt.state.incoming.is_none());
    assert!(rt.state.stream_offline);
    assert!(rt.state.phase == crate::Phase::Failed);

    // Once the user clears the local attachment, closing detaches locally with no further server calls.
    let before_requests = server.requests().len();
    rt.update(|s, tx| {
        s.composer.draft.attachments.clear();
        strings::with_locale("en", || workspace::close(s, &dead_key, tx));
    });
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        "tab-0",
        "closing a dead-binding tab after clearing local drafts must detach locally"
    );
    assert_eq!(
        server.requests().len(),
        before_requests,
        "closing a dead-binding tab must not issue another /discard or DELETE request"
    );
}

#[test]
fn quiet_discard_busy_neighbour_and_inactive_explicit_refusal_focus() {
    let server = MockServer::start(vec![
        // 1. Quiet discard refusal while active neighbour is busy
        MockReply {
            status: "409 Conflict",
            body: r#"{"error":"temporary_not_empty"}"#.into(),
        },
        // 2. Explicit discard refusal on an inactive tab while active neighbour is idle
        MockReply {
            status: "500 Internal Server Error",
            body: r#"{"message":"disk busy"}"#.into(),
        },
        // 3. Explicit discard refusal on an inactive tab while active neighbour is busy
        MockReply {
            status: "500 Internal Server Error",
            body: r#"{"message":"disk busy"}"#.into(),
        },
    ]);
    let mut rt = connected_runtime(server.backend.clone());
    open_fixture_tab(&mut rt, "ws-base", "/repo/base", false, vec![]);
    let base_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();

    rt.update(workspace::new_tab);
    open_fixture_tab(&mut rt, "ws-temp-q", "/tmp/cn-quiet-busy", true, vec![]);
    let temp_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    let focused_key = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|el| el.focused)
            .and_then(|el| el.key)
    };

    // 1. Quiet discard fails while active neighbour (ws-base) becomes busy:
    //    must restore tab to the strip, emit error notification, and NOT open the modal.
    assert!(rt.find("notification-bubbles").is_none());
    rt.update(|s, tx| {
        strings::with_locale("en", || workspace::close(s, &temp_key, tx));
        assert!(s.temporary.discarding.is_some());
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = true;
            l.pending_restore_intent = None;
        }
        tx.focus(format!("t-{base_key}"), true);
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().active_key(),
        base_key,
        "busy neighbour must remain active on quiet discard refusal"
    );
    assert!(
        !is_open(&rt.state),
        "quiet discard refusal must not open the close modal over a busy neighbour"
    );
    assert_ne!(
        focused_key(&rt).as_deref(),
        Some(theme::CANCEL),
        "quiet discard refusal must not steal focus to modal Cancel over a busy neighbour"
    );
    let expected_title =
        strings::with_locale("en", || strings::t("temporaryInstance.discard.failedTitle"));
    assert!(
        rt.find("notification-bubbles").is_some()
            && rt.elements().into_iter().any(|el| {
                el.text.as_deref() == Some(expected_title)
                    || el
                        .label
                        .as_deref()
                        .is_some_and(|l| l.contains(expected_title))
            }),
        "quiet discard refusal over a busy neighbour must present a failure notification"
    );
    assert!(
        workspace::temporary_tab_info(&rt.state, &temp_key).is_some(),
        "stashed temporary tab must be restored into the tab strip"
    );

    // 2. Explicit discard refusal on an INACTIVE temporary tab while active neighbour is idle:
    //    active tab stays ws-base, and focus returns to the originating tab control.
    rt.update(|s, tx| {
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = false;
        }
        tx.focus(format!("t-{base_key}"), true);
        strings::with_locale("en", || {
            let _ = open_dialog(s, &temp_key, Some(format!("t-{temp_key}")), tx);
            choose_discard(s, tx);
        });
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), base_key);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some(format!("t-{temp_key}").as_str()),
        "explicit refusal on an inactive tab must return focus when active neighbour is idle"
    );

    // 3. Explicit discard refusal on an INACTIVE temporary tab while active neighbour is busy:
    //    focus must stay on the busy neighbour instead of being stolen back to the inactive tab.
    rt.update(|s, tx| {
        tx.focus(format!("t-{base_key}"), true);
        strings::with_locale("en", || {
            let _ = open_dialog(s, &temp_key, Some(format!("t-{temp_key}")), tx);
            choose_discard(s, tx);
        });
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = true;
            l.pending_restore_intent = None;
        }
        tx.focus(format!("t-{base_key}"), true);
    });
    wait_until(&mut rt, |s| !s.temporary.in_flight());
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), base_key);
    assert_eq!(
        focused_key(&rt).as_deref(),
        Some(format!("t-{base_key}").as_str()),
        "explicit refusal on an inactive tab must not steal focus from a busy neighbour"
    );
}
