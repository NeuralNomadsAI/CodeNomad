use super::{
    Input, ReadingLane, authentication::close_for_authentication, demand, reader::Reader,
    transport::next_input,
};
use crate::{
    backend::Backend,
    bounded, stream,
    transport::{Command, Event},
};
use std::{
    future::Future,
    pin::pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::SeqCst},
    },
    task::{Context, Poll, Wake, Waker},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct CounterWake(AtomicUsize);

impl Wake for CounterWake {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, SeqCst);
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, SeqCst);
    }
}

fn counter_waker() -> (Arc<CounterWake>, Waker) {
    let counter = Arc::new(CounterWake(AtomicUsize::new(0)));
    let waker = Waker::from(counter.clone());
    (counter, waker)
}

fn run(task: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(task);
}

async fn read_request_line(stream: &mut BufReader<tokio::net::TcpStream>) -> String {
    let mut first = String::new();
    assert!(stream.read_line(&mut first).await.unwrap() > 0);
    let mut content_len = 0usize;
    loop {
        let mut line = String::new();
        assert!(stream.read_line(&mut line).await.unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            content_len = value.trim().parse().unwrap_or(0);
        }
    }
    if content_len > 0 {
        let mut body = vec![0u8; content_len];
        stream.read_exact(&mut body).await.unwrap();
    }
    first
}

#[test]
fn stream_cancel_and_stop_waiters_notify_waker_synchronously() {
    let state = stream::State::default();
    let (tx, rx) = bounded(1);
    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut cancelled = pin!(state.wait_cancelled(&tx));
    assert!(cancelled.as_mut().poll(&mut cx).is_pending());
    assert_eq!(wakes.0.load(SeqCst), 0);
    state.cancel();
    assert!(wakes.0.load(SeqCst) >= 1, "cancel() must notify the waker");
    assert!(cancelled.as_mut().poll(&mut cx).is_ready());
    drop(rx);

    let state = stream::State::default();
    let (tx, rx) = bounded(1);
    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut closed = pin!(state.wait_cancelled(&tx));
    assert!(closed.as_mut().poll(&mut cx).is_pending());
    assert_eq!(wakes.0.load(SeqCst), 0);
    drop(rx);
    assert!(
        wakes.0.load(SeqCst) >= 1,
        "dropping receiver must notify the waker"
    );
    assert!(closed.as_mut().poll(&mut cx).is_ready());

    let idle = stream::State::default();
    let (_, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    assert!(pin!(idle.wait_stopped()).poll(&mut cx).is_ready());

    let running = stream::State::default();
    running.running.store(true, SeqCst);
    let (events_tx, events_rx) = bounded(1);
    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut auth_close = pin!(close_for_authentication(&running, &events_tx));
    assert!(auth_close.as_mut().poll(&mut cx).is_pending());
    assert!(running.is_cancelled());
    assert_eq!(wakes.0.load(SeqCst), 0);
    drop(events_rx);
    assert!(
        wakes.0.load(SeqCst) >= 1,
        "closing Event receiver must wake close_for_authentication"
    );
    assert!(auth_close.as_mut().poll(&mut cx).is_ready());
}

#[test]
fn cancelling_during_stalled_attestation_stops_stream_immediately() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());

            // 1. Explicit state.cancel() while /api/meta stalls.
            let backend = Backend::unauthenticated(&base).unwrap();
            backend.client.require_attestation();
            let (out, inbox) = bounded(4);
            let state = Arc::new(stream::State::default());
            stream::start(backend, 1, out, state.clone());
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let req = read_request_line(&mut reader).await;
            assert!(
                req.starts_with("GET /api/meta "),
                "unexpected request: {req}"
            );

            state.cancel();
            state.wait_stopped().await;
            assert!(!state.running.load(SeqCst));
            assert!(!state.alive.load(SeqCst));
            assert!(state.version.load(SeqCst) > 0);
            assert!(matches!(inbox.recv().await.unwrap(), Input::Closed(1)));
            drop(reader);

            // 2. Dropping the Input receiver while /api/meta stalls.
            let backend = Backend::unauthenticated(&base).unwrap();
            backend.client.require_attestation();
            let (out, inbox) = bounded(4);
            let state = Arc::new(stream::State::default());
            stream::start(backend, 2, out, state.clone());
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let req = read_request_line(&mut reader).await;
            assert!(
                req.starts_with("GET /api/meta "),
                "unexpected request: {req}"
            );

            drop(inbox);
            state.wait_stopped().await;
            assert!(!state.running.load(SeqCst));
            assert!(!state.alive.load(SeqCst));
            assert!(state.version.load(SeqCst) > 0);
        })
        .await
        .expect("attestation cancellation timed out");
    });
}

#[test]
fn close_for_authentication_cancels_live_stream_without_polling() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend =
                Backend::unauthenticated(&format!("http://{}", listener.local_addr().unwrap()))
                    .unwrap();
            let (in_tx, in_rx) = bounded(4);
            let (ev_tx, _ev_rx) = bounded(4);
            let wire = Arc::new(stream::State::default());
            stream::start(backend, 3, in_tx, wire.clone());

            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let req = read_request_line(&mut reader).await;
            assert!(req.starts_with("GET /api/events?"));
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            assert!(matches!(in_rx.recv().await.unwrap(), Input::Opened(3)));
            assert!(wire.running.load(SeqCst));

            close_for_authentication(&wire, &ev_tx).await;
            assert!(!wire.running.load(SeqCst));
            assert!(!wire.alive.load(SeqCst));
            assert!(wire.version.load(SeqCst) > 0);
            assert!(matches!(in_rx.recv().await.unwrap(), Input::Closed(3)));
        })
        .await
        .expect("authentication close timed out");
    });
}

#[test]
fn next_input_wakes_on_demand_and_guards_all_spin_windows() {
    let (tx, rx) = bounded(4);
    let (demand_tx, observer) = demand::open();
    let (events, _snapshots) = bounded(1);
    let reading = ReadingLane {
        demand: observer,
        events,
        connection: Default::default(),
        on_session_deleted: None,
        revoked: Default::default(),
    };

    // Idle wait notifies the waker synchronously when demand changes.
    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut fut = pin!(next_input(&rx, Some(&reading), 0, true, None));
    assert!(fut.as_mut().poll(&mut cx).is_pending());
    assert_eq!(wakes.0.load(SeqCst), 0);
    let gen1 = demand_tx.publish(Some(demand::Target::Latest));
    assert!(wakes.0.load(SeqCst) >= 1, "demand change must notify waker");
    assert!(matches!(fut.as_mut().poll(&mut cx), Poll::Ready(None)));

    // Dropping Demand while the reader is active wakes next_input once so Reader::demand can
    // release the window and deactivate, after which next_input stays Pending (no spin).
    let (ev_tx, _ev_rx) = bounded(1);
    let wire = stream::State::observing_preferences(ev_tx, Arc::new(|| {}));
    wire.upstream.store(true, SeqCst);
    let mut reader = Reader::new();
    reader.demand(Some(&reading));
    assert!(reader.active_reader && reader.dirty);
    assert!(reader.next_sync_at(true, &wire, Some(&reading)).is_some());

    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut drop_wake = pin!(next_input(
        &rx,
        Some(&reading),
        gen1,
        reader.active_reader,
        None
    ));
    assert!(drop_wake.as_mut().poll(&mut cx).is_pending());
    assert_eq!(wakes.0.load(SeqCst), 0);
    drop(demand_tx);
    assert!(
        wakes.0.load(SeqCst) >= 1,
        "dropping Demand while active must wake next_input once"
    );
    assert!(matches!(
        drop_wake.as_mut().poll(&mut cx),
        Poll::Ready(None)
    ));
    assert!(reader.next_sync_at(true, &wire, Some(&reading)).is_none());
    reader.demand(Some(&reading));
    assert!(!reader.active_reader && !reader.dirty);

    let (wakes, waker) = counter_waker();
    let mut cx = Context::from_waker(&waker);
    let mut fut = pin!(next_input(
        &rx,
        Some(&reading),
        gen1,
        reader.active_reader,
        None
    ));
    assert!(fut.as_mut().poll(&mut cx).is_pending());
    assert_eq!(wakes.0.load(SeqCst), 0);
    tx.try_send(Input::Opened(1)).unwrap();
    assert!(wakes.0.load(SeqCst) >= 1, "rx send must notify waker");
    assert!(matches!(
        fut.as_mut().poll(&mut cx),
        Poll::Ready(Some(Input::Opened(1)))
    ));

    // next_sync_at returns None once stream or placement is closed (no spin before Closed/Moved).
    let (ev_tx, _ev_rx) = bounded(1);
    let wire = stream::State::observing_preferences(ev_tx, Arc::new(|| {}));
    wire.upstream.store(true, SeqCst);
    let reader = Reader::new();
    assert!(reader.next_sync_at(true, &wire, None).is_some());
    wire.close_stream();
    assert!(reader.next_sync_at(true, &wire, None).is_none());

    let (ev_tx, _ev_rx) = bounded(1);
    let wire = stream::State::observing_preferences(ev_tx, Arc::new(|| {}));
    wire.upstream.store(true, SeqCst);
    assert!(reader.next_sync_at(true, &wire, None).is_some());
    wire.close_placement();
    assert!(reader.next_sync_at(true, &wire, None).is_none());
}

#[test]
fn dropping_demand_during_active_sync_stops_sync_without_spinning() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::unauthenticated(&format!("http://{}", listener.local_addr().unwrap()))
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();

            let (out, events) = bounded(16);
            let (commands, input) = bounded(4);
            let (demand_tx, observer) = demand::open();
            let (content, _snapshots) = bounded(8);

            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend,
                out,
                input,
                Arc::new(|| {}),
                ReadingLane {
                    demand: observer,
                    events: content,
                    connection: Default::default(),
                    on_session_deleted: None,
                    revoked: Default::default(),
                },
            ));

            let (socket, _) = listener.accept().await.unwrap();
            let mut sse = BufReader::new(socket);
            let req = read_request_line(&mut sse).await;
            assert!(req.contains("connectionId=hub-1"), "got {req}");
            sse.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}

            // Reader is active by default; accept the initial history request and stall it.
            let (socket, _) = listener.accept().await.unwrap();
            let mut stalled_history = BufReader::new(socket);
            let req = read_request_line(&mut stalled_history).await;
            assert!(
                req.starts_with("POST /api/workspaces/workspace/session-history/window"),
                "unexpected request: {req}"
            );

            // Drop Demand while the history read is in flight: must abort the request (EOF on
            // server socket) and stay idle (no retry spin).
            drop(demand_tx);
            let mut probe = [0u8; 1];
            let read =
                tokio::time::timeout(Duration::from_secs(2), stalled_history.read(&mut probe))
                    .await
                    .expect("stalled history socket must close when Demand drops")
                    .unwrap();
            assert_eq!(read, 0, "aborted history request should reach EOF");
            assert!(
                tokio::time::timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err(),
                "dropped Demand must not trigger repeated sync attempts"
            );

            commands.send(Command::Close).await.unwrap();
            task.await.unwrap().unwrap();
            drop(stalled_history);
            drop(sse);
        })
        .await
        .expect("dropped demand test timed out");
    });
}

#[test]
fn recovery_transport_wakes_immediately_on_demand_and_retry_after_drop() {
    run(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut backend =
                Backend::unauthenticated(&format!("http://{}", listener.local_addr().unwrap()))
                    .unwrap();
            backend.workspace = "workspace".into();
            backend.session = "session".into();

            let (out, events) = bounded(16);
            let (commands, input) = bounded(4);
            let (demand_tx, observer) = demand::open();
            let (content, snapshots) = bounded(8);
            demand_tx.publish(None);

            let task = tokio::spawn(crate::transport::run_backend_reading(
                backend,
                out,
                input,
                Arc::new(|| {}),
                ReadingLane {
                    demand: observer,
                    events: content,
                    connection: Default::default(),
                    on_session_deleted: None,
                    revoked: Default::default(),
                },
            ));

            // 1. Open SSE epoch 1 while reader demand is suspended.
            let (socket, _) = listener.accept().await.unwrap();
            let mut sse1 = BufReader::new(socket);
            let req = read_request_line(&mut sse1).await;
            assert!(req.contains("connectionId=hub-1"), "got {req}");
            sse1.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}

            // 2. Resume reader demand -> history fetch starts without waiting for a poll tick.
            demand_tx.publish(Some(demand::Target::Latest));
            let (socket, _) = listener.accept().await.unwrap();
            let mut history = BufReader::new(socket);
            let req = read_request_line(&mut history).await;
            assert!(
                req.starts_with("POST /api/workspaces/workspace/session-history/window"),
                "unexpected history request: {req}"
            );
            let body =
                r#"{"status":"window","latest":true,"older":null,"newer":null,"messages":[]}"#;
            history
                .get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let (socket, _) = listener.accept().await.unwrap();
            let mut status = BufReader::new(socket);
            let req = read_request_line(&mut status).await;
            assert!(
                req.starts_with("GET /workspaces/workspace/instance/api/session/session"),
                "unexpected status request: {req}"
            );
            let status_body = r#"{"id":"session","time":{}}"#;
            status
                .get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{status_body}",
                        status_body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let (_, _, ev) = snapshots.recv().await.unwrap();
            assert!(matches!(ev, Event::ReaderSync { .. }));
            let (socket, _) = listener.accept().await.unwrap();
            let mut inbox = BufReader::new(socket);
            let req = read_request_line(&mut inbox).await;
            assert!(
                req.starts_with("GET /workspaces/workspace/instance/api/session/session/inbox"),
                "unexpected inbox request: {req}"
            );
            let inbox_body = r#"{"data":[]}"#;
            inbox
                .get_mut()
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{inbox_body}",
                        inbox_body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let (_, _, ev) = snapshots.recv().await.unwrap();
            assert!(matches!(
                ev,
                Event::Inbox {
                    authoritative: true,
                    ..
                }
            ));

            // 3. Drop SSE twice so automatic backoff is 1000 ms; Command::Retry must wake
            // reconnect well before that automatic backoff.
            drop(sse1);
            while !matches!(events.recv().await.unwrap(), Event::ConnectionLost) {}
            let (socket, _) = listener.accept().await.unwrap();
            drop(socket);
            while !matches!(events.recv().await.unwrap(), Event::Reconnecting) {}
            commands.send(Command::Retry).await.unwrap();
            let (socket, _) = tokio::time::timeout(Duration::from_millis(450), listener.accept())
                .await
                .expect("Command::Retry must bypass the 1000 ms automatic backoff")
                .unwrap();
            let mut sse3 = BufReader::new(socket);
            let req = read_request_line(&mut sse3).await;
            assert!(req.contains("connectionId=hub-3"), "got {req}");

            // 4. Close exits cleanly.
            commands.send(Command::Close).await.unwrap();
            task.await.unwrap().unwrap();
            drop(sse3);
        })
        .await
        .expect("recovery transport wake test timed out");
    });
}
