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
