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
            Input::Native(7, version, native) => {
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
        state.cancelled.store(true, SeqCst);
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
    use crate::{
        recovery::{ReadingLane, demand},
        transport::{Command, Event},
    };
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
            let (commands, input) = bounded(1);
            let (demand, observer) = demand::open();
            let (content, _snapshots) = bounded(1);
            demand.publish(None);
            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend, out, input, Arc::new(|| {}), ReadingLane {
                    demand: observer, events: content, connection: Default::default(), on_session_deleted: None,
                },
            ));
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
            stream.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
                data: {\"instanceId\":\"workspace\",\"type\":\"instance.eventStatus\",\"status\":\"disconnected\"}\n\n")
                .await.unwrap();
            while !matches!(events.recv().await.unwrap(), Event::Reconnecting) {}

            let id = "msg_00000000000000000000000000000001";
            commands.send(Command::Prompt(crate::prompt::Prompt {
                id: Some(id.into()), text: "queued prompt".into(), ..Default::default()
            })).await.unwrap();
            let (socket, _) = listener.accept().await.unwrap();
            let mut prompt = BufReader::new(socket);
            let mut header = String::new();
            prompt.read_line(&mut header).await.unwrap();
            assert!(header.starts_with("POST /workspaces/workspace/instance/api/session/session/prompt "));
            loop {
                header.clear();
                assert!(prompt.read_line(&mut header).await.unwrap() > 0);
                if header == "\r\n" { break; }
            }
            let expected = format!(r#"{{"id":"{id}","text":"queued prompt"}}"#);
            let mut body = vec![0; expected.len()];
            prompt.read_exact(&mut body).await.unwrap();
            assert_eq!(body, expected.as_bytes());
            let ack = format!(r#"{{"id":"{id}"}}"#);
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{ack}", ack.len());
            prompt.get_mut().write_all(response.as_bytes()).await.unwrap();
            assert!(matches!(events.recv().await.unwrap(), Event::PromptAcknowledged {
                attempted, outcome: crate::transport::PromptOutcome::Confirmed(confirmed)
            } if attempted == id && confirmed == id));
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
fn sse_session_deleted_notifies_hook_at_ingress_even_after_conversation_receiver_drops() {
    use crate::recovery::{ReadingLane, demand};
    use crate::transport::Event;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    run(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut backend = Backend::unauthenticated(&format!("http://{address}/")).unwrap();
            backend.workspace = "project-1".into();
            backend.session = "ses-del-1".into();
            // Send a blocking `codenomad.client.ping` (pong never answered) followed immediately by
            // `session.deleted`, then drop BOTH `events` and `commands` (manual close cancelling the
            // routing queue). The frame-ingress observer must still fire before the cancellable queue.
            let (out, events) = bounded(16);
            let (commands, input) = bounded(1);
            let (demand, observer) = demand::open();
            let (content, _snapshots) = bounded(1);
            demand.publish(None);
            let (deleted_tx, deleted_rx) = bounded::<()>(1);
            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend,
                out,
                input,
                Arc::new(|| {}),
                ReadingLane {
                    demand: observer,
                    events: content,
                    connection: Default::default(),
                    on_session_deleted: Some(Arc::new(move || {
                        let _ = deleted_tx.try_send(());
                    })),
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
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
data: {\"type\":\"server.connected\"}\n\n",
                )
                .await
                .unwrap();
            while let Ok(event) = events.recv().await {
                if matches!(event, Event::AgentHint(true)) {
                    break;
                }
            }
            // Deliver ping + two filler frames + session.deleted in ONE chunk so ping stalls
            // routing, filler-1 fills the 1-slot channel, filler-2 parks on `frames.send().await`,
            // and session.deleted still fires before cancellation drops the routing queue.
            stream
                .get_mut()
                .write_all(
                    b"event: codenomad.client.ping\ndata: {}\n\n\
data: {\"type\":\"noop\",\"seq\":1}\n\n\
data: {\"type\":\"noop\",\"seq\":2}\n\n\
data: {\"type\":\"instance.event\",\"instanceId\":\"project-1\",\"event\":{\"type\":\"session.deleted\",\"data\":{\"sessionID\":\"ses-del-1\"}}}\n\n",
                )
                .await
                .unwrap();
            // Accept the pong TCP connection and leave it stalled while manually closing both
            // `commands` and `events`.
            let _stalled_pong = listener.accept().await.unwrap();
            drop(commands);
            drop(events);
            deleted_rx
                .recv()
                .await
                .expect("SSE frame-ingress hook must fire even when queued behind ping and cancelled by close");
            let _ = task.await;
        })
        .await
        .expect("SSE session.deleted ingress hook test timed out");
    });
}
