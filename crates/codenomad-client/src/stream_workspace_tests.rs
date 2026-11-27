use super::*;
use crate::{
    bounded,
    transport::{Command, DirectoryChange, Event},
};
use serde_json::{Value, json};

fn run(task: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(task);
}
async fn backend() -> Backend {
    let mut b = Backend::connect("http://127.0.0.1:1/", "").await.unwrap();
    b.workspace = "owner".into();
    b.session = "session".into();
    b
}
async fn deliver(b: &Backend, out: &Sender<Input>, state: &State, value: Value) {
    dispatch(
        b,
        7,
        out,
        state,
        "connection",
        "message",
        &value.to_string(),
    )
    .await
    .unwrap();
}

#[test]
fn permissions_of_an_owned_streams_parent_reach_its_status_section() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(4);
        let state = State::default();
        for workspace in ["foreign", "owner"] {
            deliver(
                &b,
                &out,
                &state,
                json!({
                    "type":"instance.event","instanceId":workspace,
                    "event":{"type":"session.permissions","data":{"sessionID":"ses_parent"}}
                }),
            )
            .await;
        }
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Workspace(7, WorkspaceEvent::PermissionModeChanged { root: Some(root) }) if root == "ses_parent"
        ));
        assert!(input.is_empty());
    });
}

#[test]
fn an_upstream_reconnect_invalidates_picker_catalogues_without_a_new_sse_connection() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(6);
        let state = State::default();
        state.upstream.store(true, SeqCst);
        for status in ["disconnected", "connected", "connected"] {
            deliver(
                &b,
                &out,
                &state,
                json!({
                    "type":"instance.eventStatus","instanceId":"owner","status":status
                }),
            )
            .await;
        }
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Unavailable(7, _)
        ));
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Workspace(7, WorkspaceEvent::ComposerCataloguesChanged)
        ));
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Workspace(7, WorkspaceEvent::ProvidersChanged { workspace_id }) if workspace_id == "owner"
        ));
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Available(7, _, _)
        ));
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Available(7, _, _)
        ));
        assert!(input.is_empty());
    });
}

#[test]
fn global_command_update_reaches_only_the_owning_catalogue() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(4);
        let state = State::default();
        for workspace in ["foreign", "owner"] {
            deliver(
                &b,
                &out,
                &state,
                json!({"type":"instance.event","instanceId":workspace,
                "event":{"type":"command.updated","data":{}}}),
            )
            .await;
        }
        assert!(matches!(
            input.try_recv().unwrap(),
            Input::Workspace(7, WorkspaceEvent::CommandsChanged)
        ));
        assert!(input.is_empty());
        assert_eq!(state.version.load(SeqCst), 0);
    });
}

#[test]
fn workspace_batches_keep_scope_and_do_not_fence_transcript_reads() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(4);
        let state = State::default();
        state.version.store(19, SeqCst);
        let changes = json!([
            {"directory":"D:/project","path":"src"},
            {"directory":"/project","path":"a:/folder"},
            {"directory":"/project/alias","path":"."}
        ]);
        deliver(
            &b,
            &out,
            &state,
            json!({"type":"workspace.filesChanged","workspaceId":"owner","changes":changes}),
        )
        .await;
        let Input::Workspace(
            7,
            WorkspaceEvent::FilesChanged {
                workspace_id,
                changes,
            },
        ) = input.recv().await.unwrap()
        else {
            panic!("missing workspace batch")
        };
        assert_eq!(workspace_id, "owner");
        assert_eq!(
            changes,
            [
                DirectoryChange {
                    directory: "D:/project".into(),
                    path: "src".into()
                },
                DirectoryChange {
                    directory: "/project".into(),
                    path: "a:/folder".into()
                },
                DirectoryChange {
                    directory: "/project/alias".into(),
                    path: ".".into()
                },
            ]
        );
        deliver(&b, &out, &state, json!({"type":"workspace.stopped","workspaceId":"owner","reason":"deleted","temporaryRetained":true})).await;
        assert!(
            matches!(input.recv().await.unwrap(), Input::Workspace(7, WorkspaceEvent::Stopped { workspace_id, .. }) if workspace_id == "owner")
        );
        assert_eq!(state.version.load(SeqCst), 19);
    });
}

#[test]
fn foreign_and_malformed_workspace_events_publish_no_partial_batch() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(4);
        let state = State::default();
        for value in [
            json!({"type":"workspace.stopped","workspaceId":"foreign","instanceId":"owner"}),
            json!({"type":"workspace.filesChanged","workspaceId":"foreign","changes":[]}),
            json!({"type":"workspace.filesChanged","workspaceId":"owner"}),
            json!({"type":"workspace.filesChanged","workspaceId":"owner","changes":null}),
        ] {
            deliver(&b, &out, &state, value).await;
        }
        for (directory, path) in [
            ("relative", "."),
            ("D:/project", "../foreign"),
            ("D:/project", "C:/foreign"),
            ("/project", "/foreign"),
            ("/project", "src\\nested"),
            ("/project", ""),
        ] {
            deliver(
                &b,
                &out,
                &state,
                json!({"type":"workspace.filesChanged","workspaceId":"owner","changes":[
                    {"directory":"/project","path":"src"}, {"directory":directory,"path":path}
                ]}),
            )
            .await;
        }
        assert!(input.is_empty());
        assert_eq!(state.version.load(SeqCst), 0);
    });
}

#[test]
fn a_renamed_active_session_does_not_invalidate_an_inflight_history_read() {
    run(async {
        let b = backend().await;
        let (out, input) = bounded(2);
        let state = State::default();
        deliver(
            &b,
            &out,
            &state,
            json!({"type":"instance.event","instanceId":"owner",
            "event":{"type":"session.renamed","data":{"sessionID":"session","title":"New"}}}),
        )
        .await;
        assert!(input.is_empty());
        assert_eq!(state.version.load(SeqCst), 0);
    });
}

#[test]
fn git_hints_follow_the_owned_stream_without_a_native_session_id() {
    run(async {
        let backend = backend().await;
        let (out, inbox) = bounded(5);
        let state = State::default();
        deliver(&backend, &out, &state, json!({"type":"instance.event","instanceId":"foreign","event":{"type":"filesystem.changed","data":{}}})).await;
        assert!(inbox.is_empty());
        deliver(&backend, &out, &state, json!({"type":"instance.event","instanceId":"owner","event":{"type":"filesystem.changed","data":{}}})).await;
        deliver(&backend, &out, &state, json!({"type":"instance.event","instanceId":"owner","event":{"type":"vcs.branch.updated","data":{}}})).await;
        deliver(
            &backend,
            &out,
            &state,
            json!({"type":"workspace.worktreesChanged","workspaceId":"owner"}),
        )
        .await;
        deliver(
            &backend,
            &out,
            &state,
            json!({"type":"storage.configChanged","owner":"ui","value":{}}),
        )
        .await;
        assert!(
            matches!(inbox.recv().await.unwrap(), Input::Workspace(7, WorkspaceEvent::NativeFilesystemChanged{workspace_id}) if workspace_id=="owner")
        );
        assert!(
            matches!(inbox.recv().await.unwrap(), Input::Workspace(7, WorkspaceEvent::WorktreesChanged{workspace_id}) if workspace_id=="owner")
        );
        assert!(
            matches!(inbox.recv().await.unwrap(), Input::Workspace(7, WorkspaceEvent::WorktreesChanged{workspace_id}) if workspace_id=="owner")
        );
        assert!(matches!(
            inbox.recv().await.unwrap(),
            Input::Preferences(crate::settings::Owner::Config)
        ));
        assert!(matches!(
            inbox.recv().await.unwrap(),
            Input::Workspace(7, WorkspaceEvent::UiPreferencesChanged)
        ));
        assert!(inbox.is_empty());
        assert_eq!(state.version.load(SeqCst), 0);
    });
}

#[test]
fn workspace_events_cross_existing_http_stream_and_recovery_lane() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let (stop, stopped) = mpsc::channel();
    let worker = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut streams = vec![];
        while stopped.try_recv().is_err() && std::time::Instant::now() < deadline {
            let Ok((mut socket, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(2));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = vec![];
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                if socket.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                request.push(byte[0]);
            }
            if request.starts_with(b"GET /api/events?") {
                let events = [
                    json!({"type":"workspace.filesChanged","workspaceId":"foreign","changes":[]}),
                    json!({"type":"workspace.filesChanged","workspaceId":"owner","changes":[{"directory":"/project","path":"src"}]}),
                    json!({"type":"workspace.stopped","workspaceId":"owner"}),
                ].iter().map(|v| format!("data: {v}\n\n")).collect::<String>();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{events}").unwrap();
                socket.flush().unwrap();
                streams.push(socket);
            } else {
                let body = r#"{"data":[]}"#;
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        }
        streams.len()
    });
    run(async {
        let mut b = Backend::connect(&address, "").await.unwrap();
        b.workspace = "owner".into();
        b.session = "session".into();
        b.fresh_mode = true;
        let (out, input) = bounded(16);
        let (commands, incoming) = bounded(1);
        let task = tokio::spawn(crate::transport::run_backend(
            b,
            out,
            incoming,
            Arc::new(|| {}),
        ));
        let mut events = vec![];
        while events.len() < 2 {
            let event = tokio::time::timeout(Duration::from_secs(2), input.recv())
                .await
                .unwrap()
                .unwrap();
            if let Event::Workspace(event) = event {
                events.push(event);
            }
        }
        assert_eq!(
            events,
            [
                WorkspaceEvent::FilesChanged {
                    workspace_id: "owner".into(),
                    changes: vec![DirectoryChange {
                        directory: "/project".into(),
                        path: "src".into()
                    }]
                },
                WorkspaceEvent::Stopped {
                    workspace_id: "owner".into(),
                    deleted: false,
                    temporary_retained: false,
                },
            ]
        );
        assert!(commands.send(Command::Close).await.is_err());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    });
    let _ = stop.send(());
    assert_eq!(worker.join().unwrap(), 1);
}

#[test]
fn catalogue_watch_receives_owned_hints_without_binding_a_conversation() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let (signal, send_hint) = mpsc::channel();
    let worker = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            if let Ok((socket, _)) = listener.accept() {
                break socket;
            }
            assert!(
                std::time::Instant::now() < until,
                "catalogue SSE not attached"
            );
            thread::sleep(Duration::from_millis(2));
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = vec![];
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 8192);
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        assert!(bytes.starts_with(b"GET /api/events?"));
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        socket.flush().unwrap();
        send_hint.recv_timeout(Duration::from_secs(2)).unwrap();
        let frame = json!({"type":"workspace.worktreesChanged","workspaceId":"owner"});
        writeln!(socket, "data: {frame}\n").unwrap();
        socket.flush().unwrap();
    });
    run(async {
        let backend = Backend::connect(&address, "").await.unwrap();
        assert!(backend.session.is_empty());
        let (wake, changed) = bounded(4);
        let (watch, task) = CatalogueWatch::new(
            backend,
            Arc::new(move || {
                let _ = wake.try_send(());
            }),
        );
        let task = tokio::spawn(task);
        let ready = runtime::recv_timeout(&changed, Duration::from_secs(2)).await;
        assert!(ready.is_some());
        assert!(matches!(watch.take(), CatalogueChanges::All));
        signal.send(()).unwrap();
        assert!(
            runtime::recv_timeout(&changed, Duration::from_secs(2))
                .await
                .is_some()
        );
        assert!(matches!(watch.take(), CatalogueChanges::Workspaces(ids) if ids.contains("owner")));
        drop(watch);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    });
    worker.join().unwrap();
}
