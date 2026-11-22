use super::*;
use crate::{
    bounded,
    transport::{Command, Event},
};

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
            matches!(input.recv().await.unwrap(), Input::Workspace(7, WorkspaceEvent::Stopped { workspace_id }) if workspace_id == "owner")
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
                    workspace_id: "owner".into()
                },
            ]
        );
        commands.send(Command::Close).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    });
    let _ = stop.send(());
    assert_eq!(worker.join().unwrap(), 1);
}
