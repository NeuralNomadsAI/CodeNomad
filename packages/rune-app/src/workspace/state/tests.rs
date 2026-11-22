use super::*;
use crate::{Phase, init};
use codenomad_client::{bounded, http::Http};
use std::collections::BTreeMap;

fn workspace(id: &str, draft: &str) -> Workspace {
    Workspace {
        backend_id: None,
        server_id: None,
        folder: "/fixture".into(),
        occurrence: 0,
        workspace_id: None,
        active_session_id: Some(id.into()),
        drafts: BTreeMap::from([(id.into(), draft.into())]),
    }
}
fn backend(session: &str) -> Backend {
    Backend {
        client: Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "fixture".into(),
        session: session.into(),
        client_id: "fixture".into(),
        fresh_mode: false,
    }
}
fn runtime(s: State) -> rune::Runtime<State> {
    rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0))
}

#[test]
fn waiting_saved_session_keeps_its_draft_until_native_binding() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("native-session", "été\n日本語🦀"));
    s.workspace = Some(ui);
    capture(&mut s);
    let Tab::Workspace(saved) = &s.workspace.as_ref().unwrap().snapshot().tabs[0] else {
        panic!()
    };
    assert_eq!(saved.drafts["native-session"], "été\n日本語🦀");
    assert!(s.commands.is_none());
}

#[test]
fn two_occurrences_keep_their_drafts_when_the_user_selects_another_tab() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Alpha local");
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("alpha", "Alpha saved"));
    ui.entries[0].binding = Some(backend("alpha"));
    let mut other = init();
    other.phase = Phase::Ready;
    other.draft = TextEdit::new("Beta\n🦀");
    let mut second = entry(
        "tab-1".into(),
        Tab::Workspace(workspace("beta", "Beta\n🦀")),
    );
    second.binding = Some(backend("beta"));
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt.update(|s, tx| select(s, "tab-1", tx));
    assert_eq!(rt.state.draft.text, "Beta\n🦀");
    rt.update(|s, tx| select(s, "tab-0", tx));
    assert_eq!(rt.state.draft.text, "Alpha local");
    let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(alpha) = &snapshot.tabs[0] else {
        panic!()
    };
    let Tab::Workspace(beta) = &snapshot.tabs[1] else {
        panic!()
    };
    assert_eq!(alpha.drafts["alpha"], "Alpha local");
    assert_eq!(beta.drafts["beta"], "Beta\n🦀");
}

#[test]
fn hidden_tab_drains_events_without_changing_active_conversation() {
    let mut s = init();
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("Active draft");
    let mut ui = Ui::new();
    ui.ready = true;
    let mut other = init();
    other.phase = Phase::Streaming;
    let (out, incoming) = bounded(64);
    other.incoming = Some(incoming);
    out.try_send(crate::transport::Event::Done).unwrap();
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    assert!(rt.state.phase == Phase::Ready);
    assert_eq!(rt.state.draft.text, "Active draft");
    let hidden = rt.state.workspace.as_mut().unwrap().entries[1]
        .cache
        .take()
        .unwrap();
    let mut scratch = init();
    hidden.apply(&mut scratch);
    assert!(scratch.phase == Phase::Ready);
    assert!(scratch.incoming.as_ref().unwrap().try_recv().is_err());
}

fn draft_state() -> State {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(backend(""));
    l.server_id = Some("trial-server".into());
    s.launcher = Some(l);
    s.workspace = Some(ui);
    opened(
        &mut s,
        &Project {
            id: "project".into(),
            path: "/fixture".into(),
        },
    );
    s
}

#[test]
fn full_tab_admission_preserves_the_project_then_reuses_only_an_admitted_slot() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex, mpsc},
        time::{Duration, Instant},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let (stop, stopped) = mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        let mut creations = 0;
        while matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            let Ok((mut socket, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                assert!(bytes.len() < 16384);
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let header = String::from_utf8(bytes).unwrap();
            let line = header.lines().next().unwrap().to_string();
            let length = header
                .lines()
                .find_map(|l| {
                    l.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            assert!(length < 16384);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            received.lock().unwrap().push(line.clone());
            let (status, body) = if line == "POST /api/workspaces HTTP/1.1" {
                creations += 1;
                let input: serde_json::Value = serde_json::from_slice(&body).unwrap();
                (201,serde_json::json!({"id":format!("replacement-{creations}"),"requestId":input["requestId"],"location":{"directory":input["path"]}}).to_string())
            } else if line.starts_with("GET /workspaces/") {
                (200, "{\"data\":[]}".into())
            } else {
                (204, String::new())
            };
            let _ = write!(
                socket,
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    let mut state = draft_state();
    state
        .launcher
        .as_mut()
        .unwrap()
        .connection
        .as_mut()
        .unwrap()
        .base = address;
    let mut rt = runtime(state);
    for _ in 1..super::super::MAX_TABS {
        rt.update(new_tab);
    }
    let original = Project {
        id: "original-record".into(),
        path: "/original".into(),
    };
    rt.state.launcher.as_mut().unwrap().project = Some(original.clone());
    opened(&mut rt.state, &original);
    rt.state.draft = TextEdit::new("KEEP THIS UNSENT DRAFT");
    capture(&mut rt.state);
    let before = rt.state.workspace.as_ref().unwrap().snapshot();
    rt.state.launcher.as_mut().unwrap().folder = TextEdit::new("/replacement");
    rt.update(crate::launcher::open);
    assert!(!rt.state.launcher.as_ref().unwrap().pending);
    assert!(
        rt.state
            .launcher
            .as_ref()
            .unwrap()
            .openings
            .pending()
            .is_empty()
    );
    assert_eq!(rt.state.workspace.as_ref().unwrap().snapshot(), before);
    assert_eq!(rt.state.draft.text, "KEEP THIS UNSENT DRAFT");
    assert!(
        requests.lock().unwrap().is_empty(),
        "full admission must not dispatch any request"
    );
    rt.update(|s, tx| close(s, "tab-1", tx));
    rt.state.launcher.as_mut().unwrap().folder = TextEdit::new("/replacement");
    rt.update(crate::launcher::open);
    let wait = |rt: &mut rune::Runtime<State>| {
        let deadline = Instant::now() + Duration::from_secs(4);
        while rt.state.launcher.as_ref().unwrap().pending {
            assert!(Instant::now() < deadline);
            rt.update(|s, tx| {
                crate::launcher::poll(s, tx);
            });
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(rt.state.launcher.as_ref().unwrap().error.is_none());
    };
    wait(&mut rt);
    let after = rt.state.workspace.as_ref().unwrap().snapshot();
    let last = super::super::MAX_TABS - 1;
    assert_eq!(after.tabs.len(), super::super::MAX_TABS);
    assert_eq!(after.active, Some(last));
    assert_eq!(after.tabs[last - 1], before.tabs[last]);
    assert!(
        matches!(&after.tabs[last],Tab::Workspace(w) if w.folder=="/replacement"&&w.workspace_id.as_deref()==Some("replacement-1")&&w.drafts.is_empty())
    );
    assert!(rt.state.draft.text.is_empty());
    rt.update(|s, tx| select(s, &format!("tab-{last}"), tx));
    assert_eq!(rt.state.draft.text, "KEEP THIS UNSENT DRAFT");
    rt.update(|s, tx| select(s, "tab-2", tx));
    let blank_index = rt.state.workspace.as_ref().unwrap().snapshot().active;
    rt.state.launcher.as_mut().unwrap().folder = TextEdit::new("/blank-origin");
    rt.update(crate::launcher::open);
    wait(&mut rt);
    let saved = rt.state.workspace.as_ref().unwrap().snapshot();
    assert_eq!(saved.tabs.len(), super::super::MAX_TABS);
    assert_eq!(saved.active, blank_index);
    assert_eq!(saved.tabs[last - 1], before.tabs[last]);
    assert!(
        matches!(&saved.tabs[blank_index.unwrap()],Tab::Workspace(w) if w.folder=="/blank-origin")
    );
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.as_str() == "POST /api/workspaces HTTP/1.1")
            .count(),
        2
    );
    assert!(
        !requests.iter().any(|r| r.starts_with("DELETE")),
        "no existing record may be deleted"
    );
    drop(requests);
    drop(stop);
    server.join().unwrap();
}

#[test]
fn empty_navigation_and_sent_drafts_keep_the_snapshot_writable() {
    let mut s = draft_state();
    for id in (0..25).chain((0..25).rev()) {
        s.draft = TextEdit::new(bound(&mut s, &backend(&format!("session-{id}"))));
        capture(&mut s);
        assert!(super::super::encode(&s.workspace.as_ref().unwrap().snapshot()).is_ok());
        s.draft = TextEdit::new("sent prompt");
        capture(&mut s);
        s.draft = TextEdit::new("");
        capture(&mut s);
        let snapshot = s.workspace.as_ref().unwrap().snapshot();
        assert!(super::super::encode(&snapshot).is_ok());
        assert!(matches!(&snapshot.tabs[0], Tab::Workspace(w) if w.drafts.is_empty()));
    }
}

#[test]
fn valid_v1_with_twenty_four_empty_drafts_can_accept_new_text() {
    let mut old = workspace("session-0", "");
    old.drafts = (0..24)
        .map(|id| (format!("session-{id}"), String::new()))
        .collect();
    let snapshot = Snapshot {
        revision: 1,
        saved_at: 1,
        tabs: vec![Tab::Workspace(old)],
        active: Some(0),
    };
    let encoded = super::super::encode(&snapshot).unwrap();
    let decoded = super::super::decode(&encoded).unwrap();
    let mut s = draft_state();
    let ui = s.workspace.as_mut().unwrap();
    ui.touched = false;
    ui.hydrate(decoded);
    assert_eq!(ui.entries[0].cleared.len(), 24);
    s.draft = TextEdit::new(bound(&mut s, &backend("session-new")));
    s.draft = TextEdit::new("nouveau brouillon 🦀");
    capture(&mut s);
    let snapshot = s.workspace.as_ref().unwrap().snapshot();
    assert!(super::super::encode(&snapshot).is_ok());
    assert!(
        matches!(&snapshot.tabs[0], Tab::Workspace(w) if w.drafts.len() == 1 && w.drafts["session-new"] == "nouveau brouillon 🦀")
    );
}

fn closed(session: &str, text: &str) -> Workspace {
    let mut w = workspace(session, text);
    w.backend_id = Some("external".into());
    w.server_id = Some("trial-server".into());
    w
}

fn reopen(s: &mut State) {
    s.workspace.as_mut().unwrap().entries[0] = entry("tab-0".into(), Tab::Blank);
    opened(
        s,
        &Project {
            id: "reopened".into(),
            path: "/fixture".into(),
        },
    );
}

#[test]
fn closed_occurrences_merge_each_session_with_latest_clear_authority() {
    let mut s = draft_state();
    s.workspace.as_mut().unwrap().closed = vec![
        closed("alpha", "Alpha"),
        closed("beta", "Beta"),
        closed("alpha", ""),
    ];
    reopen(&mut s);
    assert_eq!(bound(&mut s, &backend("alpha")), "");
    s.draft = TextEdit::new(bound(&mut s, &backend("beta")));
    assert_eq!(s.draft.text, "Beta");
    assert!(
        s.workspace.as_ref().unwrap().entries[0]
            .cleared
            .contains("alpha")
    );
    let mut rt = runtime(s);
    rt.update(|s, tx| close(s, "tab-0", tx));
    opened(
        &mut rt.state,
        &Project {
            id: "successor".into(),
            path: "/fixture".into(),
        },
    );
    assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
    assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
}

#[test]
fn clearing_or_sending_an_inherited_draft_retires_older_closed_text() {
    for clear in [true, false] {
        let mut s = draft_state();
        s.workspace.as_mut().unwrap().closed =
            vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
        reopen(&mut s);
        s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
        assert_eq!(s.draft.text, "Old Alpha");
        if clear {
            s.draft = TextEdit::new("");
            capture(&mut s);
        } else {
            let (commands, input) = bounded(1);
            s.commands = Some(commands);
            s.phase = Phase::Ready;
            let mut rt = runtime(s);
            rt.update(crate::send);
            assert!(
                matches!(input.try_recv(), Ok(crate::transport::Command::Send(text)) if text == "Old Alpha")
            );
            s = rt.state;
        }
        s.phase = Phase::Ready;
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "successor".into(),
                path: "/fixture".into(),
            },
        );
        assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
        assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
    }
}

#[test]
fn closed_drafts_cannot_cross_backend_installation_or_folder() {
    let mut s = draft_state();
    let mut wrong_server = closed("server", "foreign");
    wrong_server.server_id = Some("another-server".into());
    let mut wrong_backend = closed("backend", "foreign");
    wrong_backend.backend_id = None;
    wrong_backend.server_id = None;
    let mut wrong_folder = closed("folder", "foreign");
    wrong_folder.folder = "/other".into();
    s.workspace.as_mut().unwrap().closed = vec![
        wrong_server,
        wrong_backend,
        wrong_folder,
        closed("owned", "Own"),
    ];
    reopen(&mut s);
    for id in ["server", "backend", "folder"] {
        assert_eq!(bound(&mut s, &backend(id)), "");
    }
    assert_eq!(bound(&mut s, &backend("owned")), "Own");
}

#[test]
fn snapshot_preserves_needed_clear_authority_and_untouched_sibling_absence() {
    for mode in ["untouched", "cleared", "sent"] {
        let cleared = mode != "untouched";
        let mut s = draft_state();
        let ui = s.workspace.as_mut().unwrap();
        ui.entries = vec![
            entry("tab-0".into(), Tab::Workspace(closed("alpha", "Old Alpha"))),
            entry(
                "tab-1".into(),
                Tab::Workspace(closed("alpha", if cleared { "Old Alpha" } else { "" })),
            ),
        ];
        // A never-edited empty occurrence has no clear authority.
        if !cleared {
            ui.entries[1].cleared.clear();
        }
        ui.active = 1;
        ui.entries[1].binding = Some(backend("alpha"));
        if mode == "sent" {
            s.draft = TextEdit::new("Old Alpha");
            let (commands, input) = bounded(1);
            s.commands = Some(commands);
            s.phase = Phase::Ready;
            let mut rt = runtime(s);
            rt.update(crate::send);
            assert!(
                matches!(input.try_recv(), Ok(crate::transport::Command::Send(text)) if text == "Old Alpha")
            );
            s = rt.state;
        } else {
            s.draft = TextEdit::new("");
            capture(&mut s);
        }
        let before = s.workspace.as_ref().unwrap().snapshot();
        let Tab::Workspace(b) = &before.tabs[1] else {
            panic!()
        };
        assert_eq!(b.drafts.get("alpha"), cleared.then_some(&String::new()));
        let bytes = super::super::encode(&before).unwrap();
        let mut restored = Ui::new();
        restored.hydrate(super::super::decode(&bytes).unwrap());
        restored.ready = true;
        s.workspace = Some(restored);
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        rt.update(|s, tx| close(s, "tab-1", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "successor".into(),
                path: "/fixture".into(),
            },
        );
        assert_eq!(
            bound(&mut rt.state, &backend("alpha")),
            if cleared { "" } else { "Old Alpha" }
        );
    }
}
