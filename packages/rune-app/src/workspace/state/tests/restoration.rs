use super::*;

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
            let _ = socket.write_all(format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes());
        }
    });
    let mut state = draft_state();
    state
        .screen
        .launcher_mut()
        .unwrap()
        .connection
        .as_mut()
        .unwrap()
        .base = address;
    let mut rt = runtime(state);
    for _ in 1..crate::workspace::MAX_TABS {
        rt.update(new_tab);
    }
    let original = Project {
        id: "original-record".into(),
        path: "/original".into(),
        temporary: false,
    };
    rt.state.screen.launcher_mut().unwrap().project = Some(original.clone());
    opened(&mut rt.state, &original);
    rt.state.draft = TextEdit::new("KEEP THIS UNSENT DRAFT");
    capture(&mut rt.state);
    let before = rt.state.workspace.as_ref().unwrap().snapshot();
    rt.state.screen.launcher_mut().unwrap().folder = TextEdit::new("/replacement");
    rt.update(crate::launcher::open);
    assert!(!rt.state.screen.launcher().unwrap().pending);
    assert!(
        rt.state
            .screen
            .launcher()
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
    rt.state.screen.launcher_mut().unwrap().folder = TextEdit::new("/replacement");
    rt.update(crate::launcher::open);
    let wait = |rt: &mut rune::Runtime<State>| {
        let deadline = Instant::now() + Duration::from_secs(4);
        while rt.state.screen.launcher().unwrap().pending {
            assert!(Instant::now() < deadline);
            rt.update(|s, tx| {
                crate::launcher::poll(s, tx);
            });
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(rt.state.screen.launcher().unwrap().error.is_none());
    };
    wait(&mut rt);
    let after = rt.state.workspace.as_ref().unwrap().snapshot();
    let last = crate::workspace::MAX_TABS - 1;
    assert_eq!(after.tabs.len(), crate::workspace::MAX_TABS);
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
    rt.state.screen.launcher_mut().unwrap().folder = TextEdit::new("/blank-origin");
    rt.update(crate::launcher::open);
    wait(&mut rt);
    let saved = rt.state.workspace.as_ref().unwrap().snapshot();
    assert_eq!(saved.tabs.len(), crate::workspace::MAX_TABS);
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
        assert!(crate::workspace::encode(&s.workspace.as_ref().unwrap().snapshot()).is_ok());
        s.draft = TextEdit::new("sent prompt");
        capture(&mut s);
        s.draft = TextEdit::new("");
        capture(&mut s);
        let snapshot = s.workspace.as_ref().unwrap().snapshot();
        assert!(crate::workspace::encode(&snapshot).is_ok());
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
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(old)],
        active: Some(0),
    };
    let encoded = crate::workspace::encode(&snapshot).unwrap();
    let decoded = crate::workspace::decode(&encoded).unwrap();
    let mut s = draft_state();
    let ui = s.workspace.as_mut().unwrap();
    ui.touched = false;
    ui.hydrate(decoded);
    assert_eq!(ui.entries[0].cleared.len(), 24);
    s.draft = TextEdit::new(bound(&mut s, &backend("session-new")));
    s.draft = TextEdit::new("nouveau brouillon 🦀");
    capture(&mut s);
    let snapshot = s.workspace.as_ref().unwrap().snapshot();
    assert!(crate::workspace::encode(&snapshot).is_ok());
    assert!(
        matches!(&snapshot.tabs[0], Tab::Workspace(w) if w.drafts.len() == 1 && w.drafts["session-new"] == "nouveau brouillon 🦀")
    );
}
