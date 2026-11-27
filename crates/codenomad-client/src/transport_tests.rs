//! Isolated loopback fixtures exercise the async transport through real HTTP bytes.
use crate::{
    backend::{Backend, read_json},
    bounded,
    recovery::Input,
    stream,
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, atomic::Ordering::SeqCst, mpsc},
    thread,
    time::Duration,
};

struct Server {
    address: String,
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn start(body: Vec<u8>, streaming: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                if stopped.try_recv().is_ok() || std::time::Instant::now() >= deadline {
                    return;
                }
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            // Accepted sockets inherit nonblocking mode on Windows. The fixture
            // reads complete HTTP headers on this owned worker before replying.
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                if socket.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                request.push(byte[0]);
            }
            let length = String::from_utf8_lossy(&request)
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or_default();
            assert!(length <= 16384, "fixture request body exceeds its bound");
            if socket.read_exact(&mut vec![0; length]).is_err() {
                return;
            }
            let header = if streaming {
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                    .to_owned()
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            if socket.write_all(header.as_bytes()).is_err() {
                return;
            }
            // Byte-sized writes force UTF-8 and SSE framing across transport boundaries.
            if streaming {
                for part in body.chunks(3) {
                    if socket.write_all(part).is_err() {
                        return;
                    }
                }
                let _ = socket.flush();
                let _ = stopped.recv_timeout(Duration::from_secs(5));
            } else {
                let _ = socket.write_all(&body);
            }
        });
        Self {
            address,
            stop: Some(stop),
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.worker.take().unwrap().join().unwrap();
    }
}
fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}
async fn next(receiver: &crate::Receiver<Input>) -> Input {
    tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("transport deadline")
        .unwrap()
}
fn event(workspace: &str, session: &str) -> String {
    format!(
        "data: {}\r\n\r\n",
        json!({"instanceId":workspace,"type":"instance.event","event":{
        "type":"session.text.delta","data":{"sessionID":session,"assistantMessageID":"reply", "delta":"été 🦀"}}})
    )
}
#[test]
fn async_http_decodes_json_and_rejects_an_oversized_streamed_body() {
    run(async {
        let server = Server::start(br#"{"ok":true}"#.to_vec(), false);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let response = backend
            .client
            .get(format!("{}/fixture", server.address))
            .send()
            .await
            .unwrap();
        assert_eq!(read_json(response).await.unwrap(), json!({"ok":true}));
        let oversized = Server::start(vec![b' '; 2 * 1024 * 1024 + 1], false);
        let response = backend
            .client
            .get(format!("{}/fixture", oversized.address))
            .send()
            .await
            .unwrap();
        assert!(
            read_json(response)
                .await
                .unwrap_err()
                .to_string()
                .contains("oversized")
        );
    });
}

#[test]
fn history_window_reads_large_valid_pages_without_relaxing_its_ceiling() {
    run(async {
        const ROWS: usize = 50;
        const WINDOW: usize = 24 * 1024 * 1024;
        let payload = |size: usize, last_extra: usize| {
            let messages: Vec<_> = (0..ROWS)
                .map(|i| {
                    json!({
                        "id": format!("msg_{i}"),
                        "type": "assistant",
                        "agent": "build",
                        "model": {"providerID": "fixture", "id": "fixture"},
                        "time": {"created": 1, "completed": 2},
                        "content": [{"type": "tool", "name": "read", "id": "tool", "state": {
                            "status": "completed",
                            "input": {"filePath": "fixture.txt"},
                            "metadata": {},
                            "content": [{"type": "text", "text": "x".repeat(size +
                                if i == ROWS - 1 { last_extra } else { 0 })}]
                        }}]
                    })
                })
                .collect();
            serde_json::to_vec(&json!({
                "status": "window", "messages": messages, "older": null, "newer": null,
                "resume": {"kind": "latest"}, "latest": true,
            }))
            .unwrap()
        };
        async fn read(payload: Vec<u8>) -> crate::history::Result<crate::history::Page> {
            let server = Server::start(payload, false);
            let mut backend = Backend::connect(&server.address, "").await.unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            backend.page(json!({"kind": "latest"})).await
        }
        async fn assert_page(payload: Vec<u8>, tail_bytes: usize) {
            let page = read(payload).await.unwrap();
            assert_eq!(page.rows.len(), ROWS);
            let [crate::content::Part::Tool(tool)] = page.rows.last().unwrap().parts.as_slice()
            else {
                panic!("expected the read tool from the page")
            };
            assert_eq!(tool.output.len(), tail_bytes);
            assert!(tool.output.bytes().all(|byte| byte == b'x'));
        }
        let usual = 45 * 1024;
        let regression = payload(usual, 0);
        assert!(regression.len() > 2 * 1024 * 1024);
        let remaining = WINDOW - regression.len();
        assert_page(regression, usual).await;

        let size = usual + remaining / ROWS;
        let tail = remaining % ROWS;
        let at_limit = payload(size, tail);
        assert_eq!(at_limit.len(), WINDOW);
        assert_page(at_limit, size + tail).await;

        let over_limit = payload(size, tail + 1);
        assert_eq!(over_limit.len(), WINDOW + 1);
        assert_eq!(
            read(over_limit).await.unwrap_err().to_string(),
            "oversized response"
        );
    });
}

#[test]
fn async_sse_scopes_epochs_and_cancellation_invalidates_the_snapshot_fence() {
    run(async {
        let server = Server::start(
            (event("foreign", "session")
                + &event("workspace", "foreign")
                + &event("workspace", "session"))
                .into_bytes(),
            true,
        );
        let mut backend = Backend::connect(&server.address, "").await.unwrap();
        backend.workspace = "workspace".into();
        backend.session = "session".into();
        let (out, input) = bounded(8);
        let state = Arc::new(stream::State::default());
        stream::start(backend, 7, out, state.clone());
        assert!(matches!(next(&input).await, Input::Opened(7)));
        let version = match next(&input).await {
            Input::Native(7, version, _, native) => {
                assert_eq!(native["data"]["delta"], "été 🦀");
                version
            }
            _ => panic!("expected only the scoped native event"),
        };
        assert!(state.valid(version));
        assert!(
            input.try_recv().is_err(),
            "foreign events must not publish or advance the fence"
        );
        state.cancel();
        assert!(matches!(next(&input).await, Input::Closed(7)));
        assert!(!state.valid(version));
        assert!(!state.alive.load(SeqCst));
    });
}
#[test]
fn dropping_the_sse_receiver_releases_an_idle_connection() {
    run(async {
        let server = Server::start(Vec::new(), true);
        let backend = Backend::connect(&server.address, "").await.unwrap();
        let (out, input) = bounded(1);
        let state = Arc::new(stream::State::default());
        stream::start(backend, 11, out, state.clone());
        assert!(matches!(next(&input).await, Input::Opened(11)));
        drop(input);
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.alive.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("idle transport must stop when its consumer disappears");
        assert!(!state.valid(0));
    });
}

#[test]
fn a_queued_prompt_has_one_http_attempt_with_the_reader_and_upstream_events_down() {
    prompt_during_stream_gap(true);
}

#[test]
fn a_prompt_has_one_http_attempt_after_an_established_stream_closes() {
    prompt_during_stream_gap(false);
}

fn prompt_during_stream_gap(with_reading: bool) {
    use crate::{
        recovery::{ReadingLane, demand},
        transport::{Command, Event},
    };
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    run(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(8);
            let (commands, input) = bounded(1);
            let (demand, observer) = demand::open();
            let (content, _snapshots) = bounded(1);
            demand.publish(None);
            let task = if with_reading {
                tokio::spawn(crate::transport::run_backend_reading(
                    backend, out, input, Arc::new(|| {}), ReadingLane {
                    demand: observer, events: content, connection: Default::default(), revoked: Default::default()
                }))
            } else {
                tokio::spawn(crate::transport::run_backend(backend, out, input, Arc::new(|| {})))
            };
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" { break; }
                headers.push(line);
            }
            assert!(headers[0].starts_with("GET /api/events?"));
            stream.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await.unwrap();
            if with_reading {
                stream.get_mut().write_all(b"data: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n")
                    .await.unwrap();
                while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}
            } else {
                while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
                drop(stream);
                while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}
            }

            let id = "msg_00000000000000000000000000000001";
            commands.send(Command::Prompt(crate::prompt::Prompt {
                id: Some(id.into()),
                text: "queued prompt".into(),
                delivery: with_reading.then_some(crate::prompt::Delivery::Queue),
                ..Default::default()
            })).await.unwrap();
            let mut reconnected_sse = None;
            let mut prompt = loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let mut header = String::new();
                assert!(reader.read_line(&mut header).await.unwrap() > 0);
                if !with_reading && header.starts_with("GET /api/events?") && reconnected_sse.is_none() {
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).await.unwrap() > 0);
                        if line == "\r\n" { break; }
                    }
                    reconnected_sse = Some(reader);
                    continue;
                }
                assert!(header.starts_with("POST /workspaces/workspace/instance/api/session/session/prompt "));
                break reader;
            };
            loop {
                let mut header = String::new();
                assert!(prompt.read_line(&mut header).await.unwrap() > 0);
                if header == "\r\n" { break; }
            }
            let expected = if with_reading {
                format!(r#"{{"id":"{id}","text":"queued prompt","delivery":"queue"}}"#)
            } else {
                format!(r#"{{"id":"{id}","text":"queued prompt"}}"#)
            };
            let mut body = vec![0; expected.len()];
            prompt.read_exact(&mut body).await.unwrap();
            assert_eq!(body, expected.as_bytes());
            let ack = format!(r#"{{"id":"{id}"}}"#);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                ack.len()
            );
            prompt.get_mut().write_all(response.as_bytes()).await.unwrap();
            assert!(matches!(events.recv().await.unwrap(), Event::PromptAcknowledged {
                attempted, outcome: crate::transport::PromptOutcome::Confirmed(confirmed)
            } if attempted == id && confirmed == id));
            if !with_reading {
                // Re-establish SSE after the prompt (or complete the one already accepted) and verify no Reconnecting regression or replay.
                let mut reconnected = match reconnected_sse {
                    Some(stream) => stream,
                    None => {
                        let (socket, _) = listener.accept().await.unwrap();
                        let mut reader = BufReader::new(socket);
                        let mut first = String::new();
                        assert!(reader.read_line(&mut first).await.unwrap() > 0);
                        assert!(first.starts_with("GET /api/events?"));
                        loop {
                            let mut line = String::new();
                            assert!(reader.read_line(&mut line).await.unwrap() > 0);
                            if line == "\r\n" { break; }
                        }
                        reader
                    }
                };
                reconnected.get_mut().write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"connected\"}\n\n"
                ).await.unwrap();
                let replayed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let replayed_flag = replayed.clone();
                let (stop_tx, stop_rx) = bounded::<()>(1);
                let sync_server = tokio::spawn(async move {
                    loop {
                        let accept = futures_lite::future::race(
                            async { Some(listener.accept().await) },
                            async {
                                let _ = stop_rx.recv().await;
                                None
                            },
                        )
                        .await;
                        let Some(Ok((socket, _))) = accept else {
                            break;
                        };
                        let mut req = BufReader::new(socket);
                        let mut req_line = String::new();
                        if req.read_line(&mut req_line).await.unwrap_or(0) == 0 {
                            continue;
                        }
                        let mut content_length = 0usize;
                        loop {
                            let mut line = String::new();
                            if req.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                                break;
                            }
                            if let Some(rest) = line.strip_prefix("content-length:").or_else(|| line.strip_prefix("Content-Length:")) {
                                content_length = rest.trim().parse().unwrap_or(0);
                            }
                        }
                        if content_length > 0 {
                            let mut discard = vec![0; content_length];
                            let _ = req.read_exact(&mut discard).await;
                        }
                        if req_line.contains("/prompt") || req_line.contains("/command") {
                            replayed_flag.store(true, SeqCst);
                            break;
                        }
                        let body = if req_line.contains("/session-history/window") {
                            r#"{"status":"window","messages":[],"older":null,"newer":null,"latest":true}"#
                        } else if req_line.contains("/api/session/session") {
                            r#"{"data":{"id":"session","time":{}}}"#
                        } else {
                            r#"{"data":{}}"#
                        };
                        let ok = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = req.get_mut().write_all(ok.as_bytes()).await;
                    }
                });
                loop {
                    match events.recv().await.unwrap() {
                        Event::Reconnecting | Event::Failed => {
                            panic!("reopening SSE after a stream gap must not emit Reconnecting or Failed");
                        }
                        Event::Sync(_) => break,
                        _ => {}
                    }
                }
                drop(reconnected);
                commands.send(Command::Close).await.unwrap();
                task.await.unwrap().unwrap();
                stop_tx.close();
                sync_server.await.unwrap();
                assert!(!replayed.load(SeqCst), "reconnecting SSE must not replay the prompt");
                return;
            }
            commands.send(Command::Close).await.unwrap();
            task.await.unwrap().unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err());
        })
        .await
        .expect("single owned POST must not depend on transcript or SSE availability");
    });
}

#[test]
fn publishing_to_a_dropped_display_channel_returns_without_waking_it() {
    run(async {
        let (out, input) = bounded(1);
        drop(input);
        let woke = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = woke.clone();
        let wake: crate::Wake = Arc::new(move || {
            flag.store(true, SeqCst);
        });
        assert!(!crate::transport::publish(&out, &wake, crate::transport::Event::Done).await);
        assert!(!woke.load(SeqCst));
    });
}

#[test]
fn prompt_connection_refused_and_oversized_body_are_rejected_not_unconfirmed() {
    run(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let mut backend = Backend::connect(&format!("http://{addr}"), "")
            .await
            .unwrap();
        backend.workspace = "workspace".into();
        backend.session = "session".into();
        let err = backend
            .prompt(&crate::prompt::Prompt {
                id: Some("msg_00000000000000000000000000000002".into()),
                text: "never connected".into(),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(
            err.downcast_ref::<crate::prompt::PromptError>(),
            Some(&crate::prompt::PromptError::Rejected)
        );
        let oversized = backend
            .prompt(&crate::prompt::Prompt {
                id: Some("msg_00000000000000000000000000000003".into()),
                text: "x".repeat(crate::prompt::MAX_BODY_BYTES + 1),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(oversized.is::<crate::prompt::EncodeError>());
        assert!(oversized.to_string().contains("request body"));
        let (out, _events) = bounded(4);
        let wire = Arc::new(crate::stream::State::default());
        let wake: crate::Wake = Arc::new(|| {});
        let outcome = crate::recovery::receipts::prompt(
            &backend,
            &out,
            &wake,
            &wire,
            true,
            "msg_00000000000000000000000000000003",
            &crate::prompt::Prompt {
                id: Some("msg_00000000000000000000000000000003".into()),
                text: "x".repeat(crate::prompt::MAX_BODY_BYTES + 1),
                ..Default::default()
            },
        )
        .await;
        assert!(matches!(
            outcome,
            crate::recovery::receipts::PromptReceipt::Outcome(
                crate::transport::PromptOutcome::Rejected
            )
        ));
    });
}

#[test]
fn queued_prompt_facing_sse_401_is_rejected_without_http_post() {
    use crate::transport::{Command, Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(1);
            let (commands, input) = bounded(4);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            // Establish the SSE stream first so ever_opened == true (not rejected by pre-open guard).
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
            // Park transport on a full display channel, then trigger SSE /pong 401 while Prompt is queued.
            stream
                .get_mut()
                .write_all(
                    b"data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"workspace\"}\n\n\
                      data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"workspace\"}\n\n\
                      event: codenomad.client.ping\ndata: {}\n\n",
                )
                .await
                .unwrap();
            let (pong_socket, _) = listener.accept().await.unwrap();
            let mut pong = BufReader::new(pong_socket);
            let mut first_line = String::new();
            assert!(pong.read_line(&mut first_line).await.unwrap() > 0);
            assert!(first_line.starts_with("POST /api/client-connections/pong "));
            loop {
                let mut line = String::new();
                assert!(pong.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            let id = "msg_00000000000000000000000000000004";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "blocked by 401".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            pong.get_mut()
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            drop(pong);
            // Wait deterministically for the SSE task to observe the 401, set auth_expired,
            // enqueue Input::AuthenticationRequired and close its SSE socket before unblocking transport.
            let mut eof = [0u8; 1];
            assert_eq!(
                tokio::io::AsyncReadExt::read(&mut stream, &mut eof)
                    .await
                    .unwrap(),
                0
            );
            let mut saw_rejected = false;
            let mut saw_auth = false;
            while let Ok(event) = events.recv().await {
                match event {
                    Event::PromptAcknowledged {
                        attempted,
                        outcome: PromptOutcome::Rejected,
                    } if attempted == id => saw_rejected = true,
                    Event::PromptAcknowledged { .. } => {
                        panic!("prompt facing 401 SSE must not become Confirmed or Unconfirmed")
                    }
                    Event::AuthenticationRequired(_) => {
                        saw_auth = true;
                        break;
                    }
                    _ => {}
                }
            }
            assert!(
                saw_rejected,
                "queued prompt must receive a Rejected receipt"
            );
            assert!(saw_auth, "SSE 401 must publish AuthenticationRequired");
            drop(stream);
            task.await.unwrap().unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "no HTTP POST may be sent when SSE returns 401"
            );
        })
        .await
        .expect("401 SSE must settle queued prompt without hanging");
    });
}

#[test]
fn direct_stream_gap_escalates_to_reconnecting_when_reconnect_fails() {
    use crate::transport::{Command, Event};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(8);
            let (commands, input) = bounded(1);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
            drop(stream);
            drop(listener);
            loop {
                match events.recv().await.unwrap() {
                    Event::ConnectionLost => break,
                    Event::Reconnecting | Event::Failed => {
                        panic!("first disconnect from an established stream must not emit Reconnecting before reconnect fails")
                    }
                    _ => {}
                }
            }
            while !matches!(events.recv().await.unwrap(), Event::Reconnecting) {}
            commands.send(Command::Close).await.unwrap();
            task.await.unwrap().unwrap();
        })
        .await
        .expect("failed reconnect after stream gap must escalate to Reconnecting");
    });
}

#[test]
fn prompt_pre_send_502_session_environment_failed_is_rejected_not_unconfirmed() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let server = tokio::spawn(async move {
                for (before_dispatch, body) in [
                    (true, r#"{"error":"session_environment_failed"}"#),
                    (false, r#"{"error":"opencode_unavailable_before_send"}"#),
                    (false, r#"{"error":"upstream_gateway_timeout"}"#),
                ] {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut req = BufReader::new(socket);
                    let mut content_length = 0usize;
                    loop {
                        let mut line = String::new();
                        assert!(req.read_line(&mut line).await.unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(rest) = line
                            .strip_prefix("content-length:")
                            .or_else(|| line.strip_prefix("Content-Length:"))
                        {
                            content_length = rest.trim().parse().unwrap_or(0);
                        }
                    }
                    if content_length > 0 {
                        let mut discard = vec![0; content_length];
                        req.read_exact(&mut discard).await.unwrap();
                    }
                    let marker = if before_dispatch {
                        "x-codenomad-before-dispatch: 1\r\n"
                    } else {
                        ""
                    };
                    let reply = format!(
                        "HTTP/1.1 502 Bad Gateway\r\n{marker}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    req.get_mut().write_all(reply.as_bytes()).await.unwrap();
                }
            });
            let first = backend
                .prompt(&crate::prompt::Prompt {
                    id: Some("msg_00000000000000000000000000000005".into()),
                    text: "env failed".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                first.downcast_ref::<crate::prompt::PromptError>(),
                Some(&crate::prompt::PromptError::Rejected)
            );
            let unmarked_spoof = backend
                .prompt(&crate::prompt::Prompt {
                    id: Some("msg_00000000000000000000000000000006".into()),
                    text: "unmarked 502 with pre-dispatch body".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                unmarked_spoof.downcast_ref::<crate::prompt::PromptError>(),
                Some(&crate::prompt::PromptError::Unconfirmed)
            );
            let third = backend
                .prompt(&crate::prompt::Prompt {
                    id: Some("msg_00000000000000000000000000000007".into()),
                    text: "ambiguous 502".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                third.downcast_ref::<crate::prompt::PromptError>(),
                Some(&crate::prompt::PromptError::Unconfirmed)
            );
            server.await.unwrap();
        })
        .await
        .expect("502 error classification must complete");
    });
}

#[test]
fn session_moved_rejects_queued_prompt_without_http_post() {
    use crate::transport::{Command, Event, PromptOutcome, WorkspaceEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            // Bound out to 1 so a buffered event pauses the transport while session.moved and a prompt queue behind it.
            let (out, events) = bounded(1);
            let (commands, input) = bounded(4);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            // Drain startup events (Connected, AgentHint(true), 2x Preferences) so the SSE loop is idle.
            let (mut saw_connected, mut saw_agent_hint, mut prefs) = (false, false, 0usize);
            while !(saw_connected && saw_agent_hint && prefs >= 2) {
                match events.recv().await.unwrap() {
                    Event::Connected(_) => saw_connected = true,
                    Event::AgentHint(true) => saw_agent_hint = true,
                    Event::Preferences(_) => prefs += 1,
                    Event::PromptAcknowledged { .. } => {
                        panic!("unexpected PromptAcknowledged before prompt was queued")
                    }
                    _ => {}
                }
            }
            // Two memory.changed frames fill bounded(1) `out` and block run_backend before it reads session.moved,
            // guaranteeing commands stays open until we enqueue Prompt after /pong confirms placement_closed.
            stream
                .get_mut()
                .write_all(
                    b"data: {\"type\":\"memory.changed\"}\n\ndata: {\"type\":\"memory.changed\"}\n\ndata: {\"instanceId\":\"workspace\",\"type\":\"instance.event\",\"event\":{\"type\":\"session.moved\",\"data\":{\"sessionID\":\"session\"}}}\n\nevent: codenomad.client.ping\ndata: {}\n\n",
                )
                .await
                .unwrap();
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(socket);
                let mut first_line = String::new();
                assert!(req.read_line(&mut first_line).await.unwrap() > 0);
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    assert!(req.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(rest) = line
                        .strip_prefix("content-length:")
                        .or_else(|| line.strip_prefix("Content-Length:"))
                    {
                        content_len = rest.trim().parse().unwrap_or(0);
                    }
                }
                if content_len > 0 {
                    let mut discard = vec![0; content_len];
                    tokio::io::AsyncReadExt::read_exact(&mut req, &mut discard)
                        .await
                        .unwrap();
                }
                assert!(
                    !first_line.contains("/prompt"),
                    "unexpected prompt before /pong barrier: {first_line}"
                );
                if first_line.starts_with("POST /api/client-connections/pong ") {
                    req.get_mut()
                        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                    break;
                }
                req.get_mut()
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
            let id = "msg_00000000000000000000000000000007";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "after move".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let mut saw_moved = false;
            let mut saw_rejected = false;
            while let Ok(event) = events.recv().await {
                match event {
                    Event::PromptAcknowledged {
                        attempted,
                        outcome: PromptOutcome::Rejected,
                    } if attempted == id => saw_rejected = true,
                    Event::PromptAcknowledged { .. } => {
                        panic!("prompt racing with session.moved must be Rejected, never Confirmed or Unconfirmed")
                    }
                    Event::Workspace(WorkspaceEvent::SessionMoved { session_id, .. })
                        if session_id == "session" =>
                    {
                        saw_moved = true;
                    }
                    _ => {}
                }
                if saw_rejected && saw_moved {
                    break;
                }
            }
            assert!(saw_rejected, "queued prompt must receive an explicit Rejected receipt");
            assert!(saw_moved, "session.moved event must be published");
            assert!(task.await.unwrap().is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "no HTTP POST may be sent after session.moved"
            );
        })
        .await
        .expect("session.moved must reject queued prompts without hanging");
    });
}

#[test]
fn upstream_event_outage_in_direct_mode_emits_connection_lost_and_allows_prompt() {
    use crate::transport::{Command, Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(8);
            let (commands, input) = bounded(2);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n",
                )
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}
            let id = "msg_00000000000000000000000000000008";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "upstream sse down".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let (socket, _) = listener.accept().await.unwrap();
            let mut prompt = BufReader::new(socket);
            let mut first = String::new();
            prompt.read_line(&mut first).await.unwrap();
            assert!(first.starts_with("POST /workspaces/workspace/instance/api/session/session/prompt "));
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                assert!(prompt.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(rest) = line
                    .strip_prefix("content-length:")
                    .or_else(|| line.strip_prefix("Content-Length:"))
                {
                    len = rest.trim().parse().unwrap_or(0);
                }
            }
            let mut discard = vec![0; len];
            prompt.read_exact(&mut discard).await.unwrap();
            let ack = format!(r#"{{"id":"{id}"}}"#);
            prompt
                .get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ack}",
                        ack.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            assert!(matches!(
                events.recv().await.unwrap(),
                Event::PromptAcknowledged {
                    attempted,
                    outcome: PromptOutcome::Confirmed(confirmed),
                } if attempted == id && confirmed == id
            ));
            drop(commands);
            drop(stream);
            task.await.unwrap().unwrap();
        })
        .await
        .expect("upstream SSE drop must stay in ConnectionLost and permit direct HTTP send");
    });
}

#[test]
fn session_deleted_rejects_queued_prompt_without_http_post() {
    use crate::transport::{Command, Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(1);
            let (commands, input) = bounded(4);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            let (mut saw_connected, mut saw_agent_hint, mut prefs) = (false, false, 0usize);
            while !(saw_connected && saw_agent_hint && prefs >= 2) {
                match events.recv().await.unwrap() {
                    Event::Connected(_) => saw_connected = true,
                    Event::AgentHint(true) => saw_agent_hint = true,
                    Event::Preferences(_) => prefs += 1,
                    Event::PromptAcknowledged { .. } => {
                        panic!("unexpected PromptAcknowledged before prompt was queued")
                    }
                    _ => {}
                }
            }
            stream
                .get_mut()
                .write_all(
                    b"data: {\"type\":\"memory.changed\"}\n\ndata: {\"type\":\"memory.changed\"}\n\ndata: {\"instanceId\":\"workspace\",\"type\":\"instance.event\",\"event\":{\"type\":\"session.deleted\",\"data\":{\"sessionID\":\"session\"}}}\n\nevent: codenomad.client.ping\ndata: {}\n\n",
                )
                .await
                .unwrap();
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(socket);
                let mut first_line = String::new();
                assert!(req.read_line(&mut first_line).await.unwrap() > 0);
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    assert!(req.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(rest) = line
                        .strip_prefix("content-length:")
                        .or_else(|| line.strip_prefix("Content-Length:"))
                    {
                        content_len = rest.trim().parse().unwrap_or(0);
                    }
                }
                if content_len > 0 {
                    let mut discard = vec![0; content_len];
                    tokio::io::AsyncReadExt::read_exact(&mut req, &mut discard)
                        .await
                        .unwrap();
                }
                assert!(
                    !first_line.contains("/prompt"),
                    "unexpected prompt before /pong barrier: {first_line}"
                );
                if first_line.starts_with("POST /api/client-connections/pong ") {
                    req.get_mut()
                        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                    break;
                }
                req.get_mut()
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
            let id = "msg_00000000000000000000000000000009";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "after delete".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let mut saw_invalidated = false;
            let mut saw_rejected = false;
            while let Ok(event) = events.recv().await {
                match event {
                    Event::PromptAcknowledged {
                        attempted,
                        outcome: PromptOutcome::Rejected,
                    } if attempted == id => saw_rejected = true,
                    Event::PromptAcknowledged { .. } => {
                        panic!("prompt racing with session.deleted must be Rejected")
                    }
                    Event::HistoryInvalidated => saw_invalidated = true,
                    _ => {}
                }
                if saw_rejected && saw_invalidated {
                    break;
                }
            }
            assert!(saw_rejected, "queued prompt must receive an explicit Rejected receipt");
            assert!(saw_invalidated, "session.deleted must publish HistoryInvalidated");
            assert!(task.await.unwrap().is_err());
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "no HTTP POST may be sent after session.deleted"
            );
        })
        .await
        .expect("session.deleted must reject queued prompts without HTTP POST");
    });
}

#[test]
fn prompt_501_prototype_is_rejected_and_native_401_is_unconfirmed() {
    use crate::transport::{Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let server = tokio::spawn(async move {
                let responses = [
                    (
                        "501 Not Implemented",
                        true,
                        r#"{"error":"Route not implemented in this prototype"}"#,
                    ),
                    ("401 Unauthorized", false, r#"{"error":"unauthorized"}"#),
                    ("200 OK", false, r#"{"authenticated":false}"#),
                ];
                for (status, before_dispatch, body) in responses {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut req = BufReader::new(socket);
                    let mut len = 0usize;
                    loop {
                        let mut line = String::new();
                        assert!(req.read_line(&mut line).await.unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(rest) = line
                            .strip_prefix("content-length:")
                            .or_else(|| line.strip_prefix("Content-Length:"))
                        {
                            len = rest.trim().parse().unwrap_or(0);
                        }
                    }
                    if len > 0 {
                        let mut discard = vec![0; len];
                        req.read_exact(&mut discard).await.unwrap();
                    }
                    let marker = if before_dispatch {
                        "x-codenomad-before-dispatch: 1\r\n"
                    } else {
                        ""
                    };
                    req.get_mut()
                        .write_all(
                            format!(
                                "HTTP/1.1 {status}\r\n{marker}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            });
            let first = backend
                .prompt(&crate::prompt::Prompt {
                    id: Some("msg_00000000000000000000000000000010".into()),
                    text: "prototype 501".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                first.downcast_ref::<crate::prompt::PromptError>(),
                Some(&crate::prompt::PromptError::Rejected)
            );
            let (out, events) = bounded(4);
            let wake: crate::Wake = Arc::new(|| {});
            let wire = crate::stream::State::default();
            let id = "msg_00000000000000000000000000000011";
            let settled = crate::recovery::receipts::prompt(
                &backend,
                &out,
                &wake,
                &wire,
                true,
                id,
                &crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "detached 401".into(),
                    ..Default::default()
                },
            )
            .await;
            assert!(matches!(
                settled,
                crate::recovery::receipts::PromptReceipt::AuthenticationRequired {
                    confirmed: true
                }
            ));
            assert!(matches!(
                events.recv().await.unwrap(),
                Event::PromptAcknowledged {
                    attempted,
                    outcome: PromptOutcome::Unconfirmed,
                } if attempted == id
            ));
            server.await.unwrap();
        })
        .await
        .expect("501 prototype rejection and 401 unconfirmed settlement must complete");
    });
}

#[test]
fn unsynced_reconnect_headers_do_not_reset_attempts_and_escalate_to_reconnecting() {
    use crate::transport::Event;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(16);
            let (commands, input) = bounded(2);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            // Initial stream opens and closes immediately -> stream_gap (ConnectionLost only).
            let (socket, _) = listener.accept().await.unwrap();
            let mut s1 = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(s1.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            s1.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
            drop(s1);
            while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}

            // Reconnect accepts SSE 200 headers but drops before any sync -> must escalate to Reconnecting.
            let (socket, _) = listener.accept().await.unwrap();
            let mut s2 = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(s2.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            s2.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
            drop(s2);
            while !matches!(events.recv().await.unwrap(), Event::Reconnecting) {}
            drop(commands);
            task.await.unwrap().unwrap();
        })
        .await
        .expect("unsynced reconnect drop must escalate to Reconnecting");
    });
}

#[test]
fn repeated_upstream_disconnect_keeps_http_send_authority_without_reconnecting() {
    use crate::transport::{Command, Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(16);
            let (commands, input) = bounded(2);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n",
                )
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}
            stream
                .get_mut()
                .write_all(
                    b"data: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n",
                )
                .await
                .unwrap();
            loop {
                match events.recv().await.unwrap() {
                    Event::ConnectionLost => break,
                    Event::Reconnecting | Event::Failed => {
                        panic!("repeated upstream SSE disconnect must not revoke HTTP send authority");
                    }
                    _ => {}
                }
            }
            let id = "msg_00000000000000000000000000000011";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "still sendable".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let (post_socket, _) = listener.accept().await.unwrap();
            let mut post = BufReader::new(post_socket);
            let mut line = String::new();
            assert!(post.read_line(&mut line).await.unwrap() > 0);
            assert!(line.starts_with("POST /workspaces/workspace/instance/api/session/session/prompt "));
            let body = format!(r#"{{"data":{{"id":"{id}","sessionID":"session"}}}}"#);
            post.get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            loop {
                match events.recv().await.unwrap() {
                    Event::PromptAcknowledged {
                        attempted,
                        outcome: PromptOutcome::Confirmed(confirmed),
                    } if attempted == id && confirmed == id => break,
                    Event::Reconnecting | Event::Failed => {
                        panic!("repeated upstream SSE disconnect must not emit Reconnecting or Failed");
                    }
                    _ => {}
                }
            }
            drop(stream);
            drop(commands);
            task.await.unwrap().unwrap();
        })
        .await
        .expect("repeated upstream disconnects must preserve HTTP send authority");
    });
}

#[test]
fn revoked_reading_lane_rejects_queued_prompt_without_http_post() {
    use crate::recovery::{ReadingLane, demand};
    use crate::transport::{Command, Event, PromptOutcome};
    use std::sync::atomic::Ordering::SeqCst;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(8);
            let (commands, input) = bounded(1);
            let (demand, observer) = demand::open();
            let (content, _snapshots) = bounded(1);
            demand.publish(None);
            let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend,
                out,
                input,
                Arc::new(|| {}),
                ReadingLane {
                    demand: observer,
                    events: content,
                    connection: Default::default(),
                    revoked: revoked.clone(),
                },
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}
            revoked.store(true, SeqCst);
            let id = "msg_00000000000000000000000000000010";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "after pairing loss".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            commands.close();
            let mut saw_rejected = false;
            while let Ok(event) = events.recv().await {
                if let Event::PromptAcknowledged { attempted, outcome } = event
                    && attempted == id
                {
                    assert!(
                        matches!(outcome, PromptOutcome::Rejected),
                        "revoked reading lane must reject queued prompt without POST"
                    );
                    saw_rejected = true;
                    break;
                }
            }
            assert!(saw_rejected);
            drop(stream);
            task.await.unwrap().unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "no HTTP POST may be sent once ReadingLane is revoked"
            );
        })
        .await
        .expect("revoked reading lane must deliver Rejected without HTTP POST");
    });
}

#[test]
fn workspace_stopped_rejects_queued_prompt_without_http_post() {
    use crate::transport::{Command, Event, PromptOutcome, WorkspaceEvent};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(1);
            let (commands, input) = bounded(2);
            let task = tokio::spawn(crate::transport::run_backend(
                backend,
                out,
                input,
                Arc::new(|| {}),
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}

            // Park transport on a full display channel, enqueue workspace.stopped ahead of
            // Command::Prompt, and confirm SSE ingested workspace.stopped via a /pong barrier.
            stream
                .get_mut()
                .write_all(
                    b"data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"workspace\"}\n\n\
                      data: {\"type\":\"workspace.worktreesChanged\",\"workspaceId\":\"workspace\"}\n\n\
                      data: {\"type\":\"workspace.stopped\",\"workspaceId\":\"workspace\"}\n\n\
                      event: codenomad.client.ping\ndata: {}\n\n",
                )
                .await
                .unwrap();
            loop {
                let (req_socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(req_socket);
                let mut first_line = String::new();
                assert!(req.read_line(&mut first_line).await.unwrap() > 0);
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    assert!(req.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(rest) = line
                        .strip_prefix("content-length:")
                        .or_else(|| line.strip_prefix("Content-Length:"))
                    {
                        content_len = rest.trim().parse().unwrap_or(0);
                    }
                }
                if content_len > 0 {
                    let mut discard = vec![0; content_len];
                    tokio::io::AsyncReadExt::read_exact(&mut req, &mut discard)
                        .await
                        .unwrap();
                }
                assert!(
                    !first_line.contains("/prompt"),
                    "unexpected prompt before /pong barrier: {first_line}"
                );
                if first_line.starts_with("POST /api/client-connections/pong ") {
                    req.get_mut()
                        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                    break;
                }
                req.get_mut()
                    .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
            let id = "msg_00000000000000000000000000000012";
            commands
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(id.into()),
                    text: "after workspace stop".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let mut saw_stopped = false;
            let mut saw_rejected = false;
            while let Ok(event) = events.recv().await {
                match event {
                    Event::Workspace(WorkspaceEvent::Stopped { workspace_id, .. })
                        if workspace_id == "workspace" =>
                    {
                        saw_stopped = true;
                    }
                    Event::PromptAcknowledged { attempted, outcome } if attempted == id => {
                        assert!(
                            matches!(outcome, PromptOutcome::Rejected),
                            "workspace.stopped must reject queued prompt without POST"
                        );
                        saw_rejected = true;
                    }
                    _ => {}
                }
            }
            assert!(saw_stopped);
            assert!(
                saw_rejected,
                "a prompt queued behind workspace.stopped must receive an explicit Rejected receipt"
            );
            drop(stream);
            task.await.unwrap().unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err(),
                "no HTTP POST may be sent once workspace.stopped arrives"
            );
        })
        .await
        .expect("workspace.stopped must reject queued prompts without HTTP POST");
    });
}

#[test]
fn pre_dispatch_401_rejects_prompt_while_detached_401_stays_unconfirmed() {
    use crate::transport::{Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                for (index, headers) in [
                    "x-codenomad-before-dispatch: 1\r\n",
                    "",
                ]
                .into_iter()
                .enumerate()
                {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut req = BufReader::new(socket);
                    let mut line = String::new();
                    assert!(req.read_line(&mut line).await.unwrap() > 0);
                    assert!(line.starts_with("POST /workspaces/workspace/instance/api/session/session/prompt "));
                    let body = r#"{"error":"Unauthorized"}"#;
                    req.get_mut()
                        .write_all(
                            format!(
                                "HTTP/1.1 401 Unauthorized\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();

                    let (status_socket, _) = listener.accept().await.unwrap();
                    let mut status_req = BufReader::new(status_socket);
                    let mut status_line = String::new();
                    assert!(status_req.read_line(&mut status_line).await.unwrap() > 0);
                    assert!(
                        status_line.starts_with("GET /api/auth/status "),
                        "attempt {index}: {status_line}"
                    );
                    let status_body = r#"{"authenticated":false}"#;
                    status_req
                        .get_mut()
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{status_body}",
                                status_body.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            });

            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let wake: crate::Wake = Arc::new(|| {});

            for (id, expected) in [
                ("msg_00000000000000000000000000000021", PromptOutcome::Rejected),
                ("msg_00000000000000000000000000000022", PromptOutcome::Unconfirmed),
            ] {
                let (out, events) = bounded(4);
                let wire = crate::stream::State::default();
                let settled = crate::recovery::receipts::prompt(
                    &backend,
                    &out,
                    &wake,
                    &wire,
                    true,
                    id,
                    &crate::prompt::Prompt {
                        id: Some(id.into()),
                        text: "401 receipt test".into(),
                        ..Default::default()
                    },
                )
                .await;
                assert!(matches!(
                    settled,
                    crate::recovery::receipts::PromptReceipt::AuthenticationRequired {
                        confirmed: true
                    }
                ));
                assert!(matches!(
                    events.recv().await.unwrap(),
                    Event::PromptAcknowledged { attempted, outcome }
                        if attempted == id && std::mem::discriminant(&outcome) == std::mem::discriminant(&expected)
                ));
            }
            server.await.unwrap();
        })
        .await
        .expect("pre-dispatch vs detached 401 settlement must complete");
    });
}

#[test]
fn unmarked_401_with_live_auth_stays_unconfirmed_and_marked_401_with_failed_status_rejects() {
    use crate::transport::{Event, PromptOutcome};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                // Case 1: unmarked 401 + /api/auth/status => authenticated: true -> Outcome(Unconfirmed)
                let (socket, _) = listener.accept().await.unwrap();
                let mut req = BufReader::new(socket);
                let mut line = String::new();
                assert!(req.read_line(&mut line).await.unwrap() > 0);
                let body = r#"{"error":"Unauthorized"}"#;
                req.get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let (status_socket, _) = listener.accept().await.unwrap();
                let mut status_req = BufReader::new(status_socket);
                let mut status_line = String::new();
                assert!(status_req.read_line(&mut status_line).await.unwrap() > 0);
                let status_body = r#"{"authenticated":true}"#;
                status_req
                    .get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{status_body}",
                            status_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();

                // Case 2: marked before-dispatch 401 + /api/auth/status fails (500) -> AuthenticationRequired{confirmed:false} + Rejected
                let (socket2, _) = listener.accept().await.unwrap();
                let mut req2 = BufReader::new(socket2);
                let mut line2 = String::new();
                assert!(req2.read_line(&mut line2).await.unwrap() > 0);
                req2.get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nx-codenomad-before-dispatch: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let (status_socket2, _) = listener.accept().await.unwrap();
                let mut status_req2 = BufReader::new(status_socket2);
                let mut status_line2 = String::new();
                assert!(status_req2.read_line(&mut status_line2).await.unwrap() > 0);
                let err_body = r#"{"error":"boom"}"#;
                status_req2
                    .get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{err_body}",
                            err_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });

            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let wake: crate::Wake = Arc::new(|| {});

            let (out1, _events1) = bounded(4);
            let wire1 = crate::stream::State::default();
            let id1 = "msg_00000000000000000000000000000023";
            let settled1 = crate::recovery::receipts::prompt(
                &backend,
                &out1,
                &wake,
                &wire1,
                true,
                id1,
                &crate::prompt::Prompt {
                    id: Some(id1.into()),
                    text: "unmarked 401 live auth".into(),
                    ..Default::default()
                },
            )
            .await;
            assert!(matches!(
                settled1,
                crate::recovery::receipts::PromptReceipt::Outcome(PromptOutcome::Unconfirmed)
            ));

            let (out2, events2) = bounded(4);
            let wire2 = crate::stream::State::default();
            let id2 = "msg_00000000000000000000000000000024";
            let settled2 = crate::recovery::receipts::prompt(
                &backend,
                &out2,
                &wake,
                &wire2,
                true,
                id2,
                &crate::prompt::Prompt {
                    id: Some(id2.into()),
                    text: "marked 401 failed status".into(),
                    ..Default::default()
                },
            )
            .await;
            assert!(matches!(
                settled2,
                crate::recovery::receipts::PromptReceipt::AuthenticationRequired { confirmed: false }
            ));
            assert!(matches!(
                events2.recv().await.unwrap(),
                Event::PromptAcknowledged {
                    attempted,
                    outcome: PromptOutcome::Rejected
                } if attempted == id2
            ));

            server.await.unwrap();
        })
        .await
        .expect("401 edge cases must complete");
    });
}

#[test]
fn unmarked_native_4xx_501_503_are_unconfirmed_while_marked_pre_dispatch_are_rejected() {
    use crate::prompt::PromptError;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                    .await
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let cases = [
                ("400 Bad Request", true, r#"{"error":"Invalid session ID"}"#, PromptError::Rejected),
                ("400 Bad Request", false, r#"{"error":"Invalid session ID"}"#, PromptError::Unconfirmed),
                ("404 Not Found", true, r#"{"error":"Session not found"}"#, PromptError::Rejected),
                ("404 Not Found", false, r#"{"error":"Session not found"}"#, PromptError::Unconfirmed),
                ("409 Conflict", true, r#"{"error":"Session move is in progress"}"#, PromptError::Rejected),
                ("409 Conflict", false, r#"{"error":"Session move is in progress"}"#, PromptError::Unconfirmed),
                (
                    "501 Not Implemented",
                    true,
                    r#"{"error":"Route not implemented in this prototype"}"#,
                    PromptError::Rejected,
                ),
                (
                    "501 Not Implemented",
                    false,
                    r#"{"error":"Route not implemented in this prototype"}"#,
                    PromptError::Unconfirmed,
                ),
                (
                    "503 Service Unavailable",
                    true,
                    r#"{"error":"Conversation permissions unavailable"}"#,
                    PromptError::Rejected,
                ),
                (
                    "503 Service Unavailable",
                    false,
                    r#"{"error":"Conversation permissions unavailable"}"#,
                    PromptError::Unconfirmed,
                ),
            ];
            let server_cases: Vec<_> = cases.iter().map(|(s, m, b, _)| (*s, *m, *b)).collect();
            let server = tokio::spawn(async move {
                for (status, before_dispatch, body) in server_cases {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut req = BufReader::new(socket);
                    let mut len = 0usize;
                    loop {
                        let mut line = String::new();
                        assert!(req.read_line(&mut line).await.unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(rest) = line
                            .strip_prefix("content-length:")
                            .or_else(|| line.strip_prefix("Content-Length:"))
                        {
                            len = rest.trim().parse().unwrap_or(0);
                        }
                    }
                    if len > 0 {
                        let mut discard = vec![0; len];
                        req.read_exact(&mut discard).await.unwrap();
                    }
                    let marker = if before_dispatch {
                        "x-codenomad-before-dispatch: 1\r\n"
                    } else {
                        ""
                    };
                    req.get_mut()
                        .write_all(
                            format!(
                                "HTTP/1.1 {status}\r\n{marker}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            });
            for (index, (status, before_dispatch, _, expected)) in cases.iter().enumerate() {
                let err = backend
                    .prompt(&crate::prompt::Prompt {
                        id: Some(format!("msg_0000000000000000000000000000003{index}")),
                        text: format!("{status} marked={before_dispatch}"),
                        ..Default::default()
                    })
                    .await
                    .unwrap_err();
                assert_eq!(
                    err.downcast_ref::<PromptError>(),
                    Some(expected),
                    "unexpected classification for {status} (before_dispatch={before_dispatch})"
                );
            }
            server.await.unwrap();
        })
        .await
        .expect("pre-dispatch vs unmarked native error classification must complete");
    });
}

#[test]
fn revoked_server_attestation_rejects_queued_prompt_without_http_post() {
    use crate::prompt::PromptError;
    use crate::transport::{Command, Event, PromptOutcome};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let mut backend = Backend::connect(&base, "").await.unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let posts = Arc::new(AtomicUsize::new(0));
            let server_posts = posts.clone();
            let serve_replacement = Arc::new(AtomicBool::new(false));
            let server_replacement = serve_replacement.clone();
            let (drop_stream_tx, drop_stream_rx) = bounded::<()>(2);
            let (stop_tx, stop_rx) = bounded::<()>(1);
            let server = tokio::spawn(async move {
                let mut streams = Vec::new();
                loop {
                    enum Action {
                        Stop,
                        DropStreams,
                        Accept(Option<tokio::net::TcpStream>),
                    }
                    let action = futures_lite::future::race(
                        async {
                            let _ = stop_rx.recv().await;
                            Action::Stop
                        },
                        futures_lite::future::race(
                            async {
                                let _ = drop_stream_rx.recv().await;
                                Action::DropStreams
                            },
                            async { Action::Accept(listener.accept().await.ok().map(|(s, _)| s)) },
                        ),
                    )
                    .await;
                    let socket = match action {
                        Action::Stop => break,
                        Action::DropStreams => {
                            streams.clear();
                            continue;
                        }
                        Action::Accept(Some(socket)) => socket,
                        Action::Accept(None) => break,
                    };
                    let mut req = BufReader::new(socket);
                    let mut head = String::new();
                    if req.read_line(&mut head).await.unwrap_or(0) == 0 {
                        continue;
                    }
                    if head.starts_with("POST ") {
                        server_posts.fetch_add(1, Ordering::SeqCst);
                    }
                    loop {
                        let mut line = String::new();
                        if req.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    if head.contains("/api/meta") {
                        let server_id = if server_replacement.load(Ordering::SeqCst) {
                            "server-replacement"
                        } else {
                            "server-original"
                        };
                        let meta = format!(
                            r#"{{"apiContract":1,"serverId":"{server_id}","capabilities":[]}}"#
                        );
                        let _ = req
                            .get_mut()
                            .write_all(
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{meta}",
                                    meta.len()
                                )
                                .as_bytes(),
                            )
                            .await;
                    } else if head.contains("/api/events") {
                        let _ = req
                            .get_mut()
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: ok\n\n",
                            )
                            .await;
                        // Keep the SSE socket open until explicitly dropped or test ends.
                        streams.push(req);
                    } else if head.contains("/api/history/window") {
                        let body = r#"{"status":"window","messages":[],"older":null,"newer":null,"latest":true}"#;
                        let _ = req
                            .get_mut()
                            .write_all(
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                    body.len()
                                )
                                .as_bytes(),
                            )
                            .await;
                    } else {
                        let body = r#"{"data":{}}"#;
                        let _ = req
                            .get_mut()
                            .write_all(
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                    body.len()
                                )
                                .as_bytes(),
                            )
                            .await;
                    }
                }
            });
            assert_eq!(backend.attest_server().await.unwrap(), "server-original");
            let (out, events) = bounded(16);
            let (cmd_tx, cmd_rx) = bounded(4);
            let wake: crate::Wake = Arc::new(|| {});
            let run_backend = backend.clone();
            let transport = tokio::spawn(async move {
                let _ = crate::recovery::run_with_reading(run_backend, out, cmd_rx, wake, None)
                    .await;
            });
            // Wait explicitly for AgentHint(true) proving the SSE stream is established.
            loop {
                match events.recv().await.unwrap() {
                    Event::AgentHint(true) => break,
                    _ => continue,
                }
            }
            // Dropping the SSE stream without changing server identity must NOT set server_identity_mismatch.
            drop_stream_tx.send(()).await.unwrap();
            loop {
                match events.recv().await.unwrap() {
                    Event::ConnectionLost => break,
                    _ => continue,
                }
            }
            assert!(!backend.client.server_identity_mismatch());
            // Wait for the stream to re-establish against the same server identity before simulating replacement.
            loop {
                match events.recv().await.unwrap() {
                    Event::AgentHint(true) => break,
                    _ => continue,
                }
            }
            assert!(!backend.client.server_identity_mismatch());
            // Now switch /api/meta to a replacement server and drop the SSE stream so automatic
            // reconnect re-attests through stream.rs -> Backend::attest_server().
            serve_replacement.store(true, Ordering::SeqCst);
            drop_stream_tx.send(()).await.unwrap();
            loop {
                if backend.client.server_identity_mismatch() {
                    break;
                }
                match events.recv().await {
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            assert!(backend.client.server_identity_mismatch());
            let attempt = "msg_00000000000000000000000000000099".to_owned();
            cmd_tx
                .send(Command::Prompt(crate::prompt::Prompt {
                    id: Some(attempt.clone()),
                    text: "must never post to replacement server".into(),
                    ..Default::default()
                }))
                .await
                .unwrap();
            let mut saw_rejected = false;
            while let Ok(event) = events.recv().await {
                if let Event::PromptAcknowledged { attempted, outcome } = event {
                    assert_eq!(attempted, attempt);
                    assert!(
                        matches!(outcome, PromptOutcome::Rejected),
                        "revoked server attestation must reject without HTTP POST"
                    );
                    saw_rejected = true;
                    break;
                }
            }
            assert!(saw_rejected);
            // Direct Backend::prompt and Backend::prompt_command calls must also fail closed without HTTP POST.
            let direct_prompt = backend
                .prompt(&crate::prompt::Prompt {
                    id: Some("msg_00000000000000000000000000000098".into()),
                    text: "direct prompt must fail closed".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                direct_prompt.downcast_ref::<PromptError>(),
                Some(&PromptError::Rejected)
            );
            let direct_cmd = backend.prompt_command("compact", "now").await.unwrap_err();
            assert_eq!(direct_cmd, PromptError::Rejected);
            assert_eq!(
                posts.load(Ordering::SeqCst),
                0,
                "active listener must observe zero POSTs after identity mismatch"
            );
            let _ = stop_tx.try_send(());
            drop(cmd_tx);
            let _ = transport.await;
            let _ = server.await;
        })
        .await
        .expect("revoked attestation send refusal must complete");
    });
}

#[test]
fn host_open_emits_agent_hint_without_upstream_ready_until_upstream_recovers() {
    use crate::{
        backend::Backend,
        bounded,
        recovery::{ReadingLane, demand},
        transport::Event,
    };
    use std::{sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut backend =
                Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();
            let (out, events) = bounded(16);
            let (commands, input) = bounded(1);
            let (demand, observer) = demand::open();
            let (content, _snapshots) = bounded(4);
            demand.publish(None);
            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend,
                out,
                input,
                Arc::new(|| {}),
                ReadingLane {
                    demand: observer,
                    events: content,
                    connection: Default::default(),
                    revoked: Default::default(),
                },
            ));
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            loop {
                let mut line = String::new();
                assert!(stream.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            // Opening the host SSE must emit AgentHint(true) without UpstreamReady.
            loop {
                match events.recv().await.unwrap() {
                    Event::UpstreamReady => {
                        panic!("host SSE open must not emit UpstreamReady before upstream status")
                    }
                    Event::AgentHint(true) => break,
                    _ => continue,
                }
            }
            // Upstream disconnect emits ConnectionLost; upstream reconnect emits UpstreamReady then AgentHint(true).
            stream
                .get_mut()
                .write_all(
                    b"data: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n",
                )
                .await
                .unwrap();
            loop {
                match events.recv().await.unwrap() {
                    Event::UpstreamReady => {
                        panic!("upstream disconnect must not emit UpstreamReady")
                    }
                    Event::ConnectionLost => break,
                    _ => continue,
                }
            }
            stream
                .get_mut()
                .write_all(
                    b"data: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"connected\"}\n\n",
                )
                .await
                .unwrap();
            let mut saw_upstream_ready = false;
            loop {
                match events.recv().await.unwrap() {
                    Event::UpstreamReady => saw_upstream_ready = true,
                    Event::AgentHint(true) if saw_upstream_ready => break,
                    _ => continue,
                }
            }
            assert!(saw_upstream_ready);
            drop(commands);
            drop(stream);
            let _ = task.await;
        })
        .await
        .expect("host open vs upstream ready test must complete");
    });
}
