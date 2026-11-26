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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
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
                        body: r#"{"serverId":"srv-temp","apiContract":1,"capabilities":["temporary-workspaces"]}"#.into(),
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
        if rt.find("new-temporary-tab").is_some() {
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

    // 3. workspace.stopped detaches temporary tab locally WITHOUT calling DELETE
    rt.update(|s, tx| {
        assert!(workspace::detach_stopped_temporary(s, "ws-temp-stop", tx));
    });
    assert_eq!(rt.state.workspace.as_ref().unwrap().tab_count(), 2);
    assert!(
        server.requests().is_empty(),
        "workspace.stopped on temporary tab must not send DELETE: {:?}",
        server.requests()
    );
}
