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
        view: Default::default(),
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
fn panel_visibility_returns_only_with_its_own_project_tab() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        s.shell.wanted = [Some([false, true]), None];
        select(s, "tab-1", tx);
        assert_eq!(s.shell.wanted, [None; 2]);
        s.shell.wanted = [Some([true, false]), None];
        select(s, "tab-0", tx);
        assert_eq!(s.shell.wanted, [Some([false, true]), None]);
        select(s, "tab-1", tx);
        assert_eq!(s.shell.wanted, [Some([true, false]), None]);
    });
}

#[test]
fn right_panel_selection_is_specific_to_each_project_occurrence() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("first", ""));
    ui.entries.push(entry(
        "tab-1".into(),
        Tab::Workspace(workspace("second", "")),
    ));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        set_files_tab(s, true);
        assert!(files_tab(s));
        select(s, "tab-1", tx);
        assert!(!files_tab(s));
        select(s, "tab-0", tx);
        assert!(files_tab(s));
        set_files_tab(s, false);
        let saved = s.workspace.as_ref().unwrap().snapshot();
        assert!(
            matches!(&saved.tabs[0], Tab::Workspace(w) if w.view.files_mode == Some("workspace"))
        );
        assert!(matches!(&saved.tabs[1], Tab::Workspace(w) if w.view.files_mode.is_none()));
    });
}

#[test]
fn sidebar_search_and_title_edits_are_kept_only_by_their_origin_tab() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].project = s.screen.launcher().unwrap().project.clone();
    ui.entries.push(entry("tab-1".into(), Tab::Blank));
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.update(|s, tx| {
        let launcher = s.screen.launcher_mut().unwrap();
        launcher.search = TextEdit::new("alpha");
        launcher.title = TextEdit::new("unsent title");
        launcher.show_title = true;
        launcher.show_search = true;
        launcher.creation_uncertain = true;
        select(s, "tab-1", tx);
        assert!(s.screen.launcher().unwrap().search.text.is_empty());
        assert!(!s.screen.launcher().unwrap().creation_uncertain);
        select(s, "tab-0", tx);
        let launcher = s.screen.launcher_mut().unwrap();
        assert_eq!(launcher.search.text, "alpha");
        assert_eq!(launcher.title.text, "unsent title");
        assert!(launcher.show_title && launcher.show_search);
        assert!(launcher.creation_uncertain);
        assert_eq!(launcher.error, Some("rune.create_error"));
        launcher.creation_uncertain = false;
        launcher.error = None;
        assert!(!s.workspace.as_ref().unwrap().entries[0].creation_uncertain);
        resume(s, tx);
        let launcher = s.screen.launcher().unwrap();
        assert!(!launcher.creation_uncertain);
        assert_eq!(launcher.error, None);
        assert_eq!(launcher.title.text, "unsent title");
    });
}

#[test]
fn a_press_held_on_send_is_cancelled_when_the_pending_selection_binds() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let mut ui = Ui::new();
    ui.ready = true;
    let mut saved = workspace("old-session", "Old draft");
    saved
        .drafts
        .insert("new-session".into(), "New draft".into());
    ui.entries[0].saved = Tab::Workspace(saved);
    ui.entries[0].binding = Some(backend("old-session"));
    let (old_commands, old) = bounded(1);
    s.commands = Some(old_commands);
    s.draft = TextEdit::new("Old draft");
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    let (x, y) = rt.find("send").unwrap();
    rt.pointer_down(x, y);
    rt.frame(0.02);
    let (new_commands, new) = bounded(1);
    rt.update(move |s, tx| {
        s.draft = TextEdit::new(bound(s, &backend("new-session")));
        s.commands = Some(new_commands);
        s.renew_scope();
        tx.instant();
    });
    rt.frame(0.02);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(old.try_recv().is_err() && new.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "New draft");
}

#[test]
fn retry_rebinds_when_the_event_lane_is_gone_even_if_the_command_relay_is_open() {
    let mut s = init();
    crate::gallery::shell::fixture(&mut s);
    let backend = backend("session");
    let launcher = s.screen.launcher_mut().unwrap();
    launcher.connection = Some(backend.clone());
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("session", "keep this draft"));
    ui.entries[0].binding = Some(backend);
    s.workspace = Some(ui);
    s.draft = TextEdit::new("keep this draft");
    s.phase = Phase::Failed;
    let (events, incoming) = bounded(1);
    drop(events);
    s.incoming = Some(incoming);
    let (out, relay) = bounded(1);
    s.commands = Some(out);
    let mut rt = runtime(s);
    rt.update(crate::retry_connection);
    assert!(
        rt.state.screen.launcher().unwrap().pending,
        "retry starts a targeted read"
    );
    assert!(relay.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "keep this draft");
}

#[test]
fn confirmed_missing_selection_does_not_block_future_project_restoration() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0].saved = Tab::Workspace(workspace("missing", "saved draft"));
    ui.entries[0].binding = Some(backend("missing"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("unsent latest");
    assert!(!unselect_missing(&mut s, "another"));
    assert!(unselect_missing(&mut s, "missing"));
    let snapshot = s.workspace.as_ref().unwrap().snapshot();
    let saved = super::super::decode(&super::super::encode(&snapshot).unwrap()).unwrap();
    let Tab::Workspace(project) = &saved.tabs[0] else {
        panic!("workspace must remain")
    };
    assert_eq!(project.active_session_id, None);
    assert_eq!(project.drafts["missing"], "unsent latest");
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
fn files_follow_their_occurrence_through_tab_switches_and_hidden_stream_events() {
    use codenomad_client::{
        files::{Entry as File, EntryKind},
        transport::WorkspaceEvent,
    };
    fn files(s: &State, name: &str) -> crate::files::Ui {
        let mut b = backend("same-session");
        b.workspace = name.into();
        let mut ui = crate::files::Ui::new(b, "/fixture".into(), s.reads.clone(), s.wake.clone());
        ui.tree.activate(true);
        let read = ui.tree.take_refresh().pop().unwrap();
        assert!(ui.tree.complete(
            read,
            Ok(vec![File {
                path: name.into(),
                name: name.into(),
                kind: EntryKind::File,
                absolute_path: None,
                directory_identity: None,
                size: None,
                modified_at: None,
            }]),
            Ok
        ));
        ui.tree.select(name.into());
        ui.activate(false);
        ui
    }
    let mut s = init();
    s.phase = Phase::Ready;
    s.files = Some(files(&s, "alpha"));
    let (out, incoming) = bounded(64);
    s.incoming = Some(incoming);
    let mut ui = Ui::new();
    ui.ready = true;
    let mut other = init();
    other.phase = Phase::Ready;
    other.files = Some(files(&other, "beta"));
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    ui.entries.push(second);
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    rt.update(|s, tx| select(s, "tab-1", tx));
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("beta")
    );
    out.try_send(crate::transport::Event::Workspace(
        WorkspaceEvent::Stopped {
            workspace_id: "alpha".into(),
        },
    ))
    .unwrap();
    rt.frame(0.1);
    let active = rt.state.files.as_ref().unwrap();
    assert!(!active.stopped);
    assert_eq!(active.tree.selected(), Some("beta"));
    rt.update(|s, tx| select(s, "tab-0", tx));
    let restored = rt.state.files.as_ref().unwrap();
    assert!(restored.stopped);
    assert_eq!(restored.tree.selected(), Some("alpha"));
    assert_eq!(restored.tree.rows()[0].entry.name, "alpha");
    rt.update(|s, tx| select(s, "tab-1", tx));
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(
        rt.state.files.as_ref().unwrap().tree.selected(),
        Some("beta")
    );
}

#[test]
#[cfg(feature = "test-support")]
fn closing_active_or_cached_tab_keeps_a_draft_after_its_reader_closed() {
    let mut s = init();
    s.phase = Phase::Ready;
    let mut workspace = Ui::new();
    workspace.ready = true;
    let mut other = init();
    other.phase = Phase::Ready;
    let mut second = entry("tab-1".into(), Tab::Blank);
    second.cache = Some(Cache::take(&mut other));
    workspace.entries.push(second);
    s.workspace = Some(workspace);
    let mut files = crate::files::Ui::new(
        backend("draft-session"),
        "/fixture".into(),
        s.reads.clone(),
        s.wake.clone(),
    );
    files.open("draft.txt".into());
    files.reader.scene(Ok(codenomad_client::files::Preview {
        workspace_id: "fixture".into(),
        path: "draft.txt".into(),
        bytes: b"original".to_vec(),
        version: Some("v1".into()),
    }));
    files.document.online(true);
    files.document.poll(&mut files.reader);
    let scope = files.document.scope();
    files.document.input(scope).replace_text("unsaved");
    files.document.changed(scope);
    files.close_reader();
    s.files = Some(files);
    let mut rt = runtime(s);
    rt.frame(0.0);
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    rt.update(|s, tx| select(s, "tab-1", tx));
    rt.update(|s, tx| close(s, "tab-0", tx));
    assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    rt.update(|s, tx| select(s, "tab-0", tx));
    rt.update(|s, _| s.files.as_mut().unwrap().open("draft.txt".into()));
    assert_eq!(
        rt.state.files.as_ref().unwrap().document.edit().text,
        "unsaved"
    );
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
#[test]
fn polling_preserves_the_active_editor_scope_and_tab_switch_expires_it() {
    let mut s = init();
    s.phase = Phase::Ready;
    let mut ui = Ui::new();
    ui.ready = true;
    s.workspace = Some(ui);
    let mut rt = runtime(s);
    rt.poll = Some(crate::poll);
    let scope = rt.state.input_scope.clone();
    for _ in 0..8 {
        rt.frame(0.02);
    }
    assert!(rt.state.current_scope(&scope));
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.paste("active input");
    rt.frame(0.02);
    assert_eq!(rt.state.draft.text, "active input");
    rt.update(|s, tx| new_tab(s, tx));
    assert!(!rt.state.current_scope(&scope));
    let active = rt.state.draft.text.clone();
    rt.state
        .editor(&scope, crate::screen::Editor::Composer)
        .text
        .push_str("late");
    assert_eq!(rt.state.draft.text, active);
}

fn draft_state() -> State {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(backend(""));
    l.server_id = Some("trial-server".into());
    s.screen = crate::Screen::Chat { launcher: Some(l) };
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
    for _ in 1..super::super::MAX_TABS {
        rt.update(new_tab);
    }
    let original = Project {
        id: "original-record".into(),
        path: "/original".into(),
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
    rt.state.screen.launcher_mut().unwrap().folder = TextEdit::new("/blank-origin");
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
        panel_widths: [None; 2],
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

#[test]
fn delivered_bundles_follow_live_edits_and_sends_without_retiring_other_sessions() {
    for mode in ["cleared", "sent", "edited"] {
        for restart in [false, true] {
            let mut s = draft_state();
            s.workspace.as_mut().unwrap().closed =
                vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
            reopen(&mut s);
            s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
            assert_eq!(s.draft.text, "Old Alpha");
            let mut rt = runtime(s);
            if mode == "sent" {
                let (commands, input) = bounded(1);
                rt.state.commands = Some(commands);
                rt.state.phase = Phase::Ready;
                rt.update(crate::send);
                assert!(
                    matches!(input.try_recv(), Ok(crate::transport::Command::Send(text)) if text == "Old Alpha")
                );
            } else {
                rt.state.draft = TextEdit::new(if mode == "edited" { "New Alpha" } else { "" });
                capture(&mut rt.state);
            }
            if restart {
                let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
                let bytes = super::super::encode(&snapshot).unwrap();
                let mut ui = Ui::new();
                ui.hydrate(super::super::decode(&bytes).unwrap());
                ui.ready = true;
                rt.state.workspace = Some(ui);
            }
            rt.update(new_tab);
            opened(
                &mut rt.state,
                &Project {
                    id: "third".into(),
                    path: "/fixture".into(),
                },
            );
            rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
            assert!(
                rt.state.draft.text.is_empty(),
                "a live owner reserves its delivered bundle"
            );
            rt.update(|s, tx| close(s, "tab-0", tx));
            rt.update(|s, tx| close(s, "tab-1", tx));
            opened(
                &mut rt.state,
                &Project {
                    id: "fourth".into(),
                    path: "/fixture".into(),
                },
            );
            rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
            assert_eq!(
                rt.state.draft.text,
                if mode == "edited" { "New Alpha" } else { "" }
            );
            assert_eq!(
                bound(&mut rt.state, &backend("beta")),
                "Beta",
                "undelivered sessions survive"
            );
        }
    }
}

#[test]
fn an_unbound_or_failed_open_keeps_its_source_and_binding_revalidates_pending_text() {
    for bind in [false, true] {
        let mut s = draft_state();
        s.workspace.as_mut().unwrap().closed =
            vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
        reopen(&mut s);
        s.workspace
            .as_mut()
            .unwrap()
            .closed
            .push(closed("alpha", "New Alpha"));
        if bind {
            s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
            assert_eq!(
                s.draft.text, "New Alpha",
                "successful binding admits the current source"
            );
        }
        // Failed native admission never calls bound; closing returns no obsolete pending copy.
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "retry".into(),
                path: "/fixture".into(),
            },
        );
        rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
        assert_eq!(rt.state.draft.text, "New Alpha");
        assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
    }
}

#[test]
fn delivery_retires_pending_copies_but_preserves_independent_occurrence_authority() {
    let mut s = draft_state();
    s.workspace.as_mut().unwrap().closed = vec![closed("alpha", "Source Alpha")];
    reopen(&mut s);
    let mut rt = runtime(s);
    rt.update(new_tab);
    opened(
        &mut rt.state,
        &Project {
            id: "pending".into(),
            path: "/fixture".into(),
        },
    );
    let ui = rt.state.workspace.as_mut().unwrap();
    ui.entries.push(entry(
        "independent".into(),
        Tab::Workspace(closed("alpha", "Own Alpha")),
    ));
    rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
    assert_eq!(rt.state.draft.text, "Source Alpha");
    let ui = rt.state.workspace.as_ref().unwrap();
    assert!(matches!(&ui.entries[0].saved, Tab::Workspace(w) if !w.drafts.contains_key("alpha")));
    assert!(matches!(&ui.entries[2].saved, Tab::Workspace(w) if w.drafts["alpha"] == "Own Alpha"));
    assert!(ui.closed.iter().all(|w| !w.drafts.contains_key("alpha")));
    rt.update(|s, tx| select(s, "tab-0", tx));
    assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
}

#[test]
fn delivery_hidden_interruptions_keep_the_active_close_guard_and_button() {
    for kind in ["form", "reason", "busy", "stopping"] {
        let mut s = draft_state();
        let mut a = crate::agent::Ui::new(crate::agent::start(backend("alpha"), s.wake.clone()));
        match kind {
            "form" => {
                a.forms.push(crate::agent_api::Form {
                    id: "request".into(),
                    title: "Question".into(),
                    fields: vec![serde_json::json!({"key":"answer","type":"string"})],
                });
                a.selected = "request".into();
                let mut d = crate::agent::forms::Draft::default();
                d.choose("UNSENT FORM RESPONSE");
                a.drafts.insert(("request".into(), "answer".into()), d);
            }
            "reason" => {
                a.permissions.push(crate::agent_api::Permission {
                    id: "request".into(),
                    action: "read".into(),
                    resources: vec!["/fixture".into()],
                    message: String::new(),
                    supported: true,
                });
                a.selected = "request".into();
                a.reasons
                    .insert("request".into(), TextEdit::new("UNSENT REASON"));
            }
            "busy" => a.busy = true,
            _ => a.stopping = true,
        }
        s.agent = Some(a);
        let mut rt = runtime(s);
        rt.frame(0.0);
        assert!(rt.find("c-tab-0").is_none());
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 1);
        rt.update(new_tab);
        rt.frame(0.0);
        assert!(
            rt.find("c-tab-0").is_none(),
            "hidden {kind} must retain the same rendered guard"
        );
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
        rt.update(|s, tx| select(s, "tab-0", tx));
        let a = rt.state.agent.as_mut().unwrap();
        a.busy = false;
        a.stopping = false;
        a.drafts.clear();
        a.reasons.clear();
        rt.update(new_tab);
        rt.frame(0.0);
        assert!(rt.find("c-tab-0").is_some());
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    }
}

#[test]
fn delivery_folder_spelling_preserves_only_the_same_server_project_scope() {
    for (saved, path, server, backend_id, preserve) in [
        (
            "D:/Fixture",
            r"d:\FIXTURE",
            "trial-server",
            "external",
            true,
        ),
        (
            r"\\Host\Share\Fixture",
            r"\\host/SHARE/fixture",
            "trial-server",
            "external",
            true,
        ),
        ("/Fixture", "/fixture", "trial-server", "external", false),
        (
            "D:/Fixture",
            "E:/Fixture",
            "trial-server",
            "external",
            false,
        ),
        (
            "D:/Fixture",
            "d:/fixture",
            "another-server",
            "external",
            false,
        ),
        (
            "D:/Fixture",
            "d:/fixture",
            "trial-server",
            "another-backend",
            false,
        ),
    ] {
        let mut s = draft_state();
        let mut saved_project = closed("alpha", "RESTORED UNSENT TEXT");
        saved_project.folder = saved.into();
        saved_project.server_id = Some(server.into());
        saved_project.backend_id = Some(backend_id.into());
        s.workspace.as_mut().unwrap().entries[0] =
            entry("tab-0".into(), Tab::Workspace(saved_project));
        opened(
            &mut s,
            &Project {
                id: "fresh-record".into(),
                path: path.into(),
            },
        );
        assert_eq!(
            bound(&mut s, &backend("alpha")),
            if preserve { "RESTORED UNSENT TEXT" } else { "" },
            "scope {saved} -> {path}, {server}, {backend_id}"
        );
    }
}

#[test]
fn delivery_inactive_close_preserves_the_active_reader_and_focus() {
    for before in [false, true] {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = crate::transport::synthetic();
        let mut ui = Ui::new();
        ui.ready = true;
        ui.entries.push(entry("tab-1".into(), Tab::Blank));
        ui.active = usize::from(before);
        s.workspace = Some(ui);
        let mut rt = runtime(s);
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        let (x, y) = rt.find("composer").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.paste("KEEP FOCUS 🦀");
        rt.wheel(400.0, 300.0, 1200.0);
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        let focus = rt
            .elements()
            .into_iter()
            .find(|e| e.focused)
            .map(|e| (e.key, e.edit_range));
        assert_eq!(
            focus.as_ref().and_then(|(key, _)| key.as_deref()),
            Some("composer")
        );
        let anchor = rt
            .elements()
            .into_iter()
            .find(|e| {
                e.visible[3] > 0.0 && e.key.as_deref().is_some_and(|key| key.starts_with("body-"))
            })
            .map(|e| (e.key, e.rect));
        assert!(anchor.is_some());
        let active = rt
            .state
            .workspace
            .as_ref()
            .unwrap()
            .active_key()
            .to_string();
        rt.update(|s, tx| close(s, if before { "tab-0" } else { "tab-1" }, tx));
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), active);
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        assert_eq!(rt.state.draft.text, "KEEP FOCUS 🦀");
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|e| e.focused)
                .map(|e| (e.key, e.edit_range)),
            focus
        );
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|e| e.visible[3] > 0.0
                    && e.key.as_deref().is_some_and(|key| key.starts_with("body-")))
                .map(|e| (e.key, e.rect)),
            anchor
        );
    }
}
