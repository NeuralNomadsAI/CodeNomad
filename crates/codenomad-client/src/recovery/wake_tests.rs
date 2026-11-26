use super::{
    Input, ReadingLane, authentication::close_for_authentication, demand, reader::Reader,
    transport::next_input,
};
use crate::{
    backend::Backend,
    bounded,
    runtime::Instant,
    stream,
    transport::{Command, Event},
};
use std::{
    pin::pin,
    sync::{Arc, atomic::Ordering::SeqCst},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn run(task: impl std::future::Future<Output = ()>) {
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
fn stream_cancel_and_stop_waiters_settle_on_first_poll_without_timers() {
    run(async {
        let state = stream::State::default();
        let (tx, rx) = bounded(1);
        let mut cancelled = pin!(state.wait_cancelled(&tx));
        assert!(
            futures_lite::future::poll_once(&mut cancelled)
                .await
                .is_none()
        );
        state.cancel();
        assert!(
            futures_lite::future::poll_once(&mut cancelled)
                .await
                .is_some()
        );
        drop(rx);

        let state = stream::State::default();
        let (tx, rx) = bounded(1);
        let mut closed = pin!(state.wait_cancelled(&tx));
        assert!(futures_lite::future::poll_once(&mut closed).await.is_none());
        drop(rx);
        assert!(futures_lite::future::poll_once(&mut closed).await.is_some());

        let idle = stream::State::default();
        assert!(
            futures_lite::future::poll_once(idle.wait_stopped())
                .await
                .is_some()
        );

        let running = stream::State::default();
        running.running.store(true, SeqCst);
        let (events_tx, events_rx) = bounded(1);
        let mut auth_close = pin!(close_for_authentication(&running, &events_tx));
        assert!(
            futures_lite::future::poll_once(&mut auth_close)
                .await
                .is_none()
        );
        assert!(running.cancelled.load(SeqCst));
        drop(events_rx);
        assert!(
            futures_lite::future::poll_once(&mut auth_close)
                .await
                .is_some()
        );
    });
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
            assert!(matches!(in_rx.recv().await.unwrap(), Input::Closed(3)));
        })
        .await
        .expect("authentication close timed out");
    });
}

#[test]
fn next_input_wakes_immediately_on_demand_and_guards_spin_windows() {
    run(async {
        let (tx, rx) = bounded(4);
        let (demand_tx, observer) = demand::open();
        let (events, _snapshots) = bounded(1);
        let reading = ReadingLane {
            demand: observer,
            events,
            connection: Default::default(),
        };

        // Idle wait wakes on the very next poll when demand changes.
        let mut fut = pin!(next_input(&rx, Some(&reading), 0, None));
        assert!(futures_lite::future::poll_once(&mut fut).await.is_none());
        let gen1 = demand_tx.publish(None);
        assert!(matches!(
            futures_lite::future::poll_once(&mut fut).await,
            Some(None)
        ));

        // Dropping Demand must stay Pending (no busy spin) until an Input arrives.
        drop(demand_tx);
        let mut fut = pin!(next_input(&rx, Some(&reading), gen1, None));
        assert!(futures_lite::future::poll_once(&mut fut).await.is_none());
        tx.send(Input::Opened(1)).await.unwrap();
        assert!(matches!(
            futures_lite::future::poll_once(&mut fut).await,
            Some(Some(Input::Opened(1)))
        ));

        // next_sync_at returns None once stream or placement is closed (no spin before Closed/Moved).
        let (ev_tx, _ev_rx) = bounded(1);
        let wire = stream::State::observing_preferences(ev_tx, Arc::new(|| {}));
        wire.upstream.store(true, SeqCst);
        let reader = Reader::new();
        assert!(reader.next_sync_at(true, &wire).is_some());
        wire.close_stream();
        assert!(reader.next_sync_at(true, &wire).is_none());

        let (ev_tx, _ev_rx) = bounded(1);
        let wire = stream::State::observing_preferences(ev_tx, Arc::new(|| {}));
        wire.upstream.store(true, SeqCst);
        assert!(reader.next_sync_at(true, &wire).is_some());
        wire.close_placement();
        assert!(reader.next_sync_at(true, &wire).is_none());
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
                },
            ));

            // 1. Open SSE epoch 1 while reader demand is suspended.
            let (socket, _) = listener.accept().await.unwrap();
            let mut sse1 = BufReader::new(socket);
            let req = read_request_line(&mut sse1).await;
            assert!(req.contains("connectionId=stream-1"), "got {req}");
            sse1.get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            while !matches!(events.recv().await.unwrap(), Event::AgentHint(true)) {}

            // 2. Resume reader demand -> immediate history fetch without 25 ms polling.
            demand_tx.publish(Some(demand::Target::Latest));
            let (socket, _) = listener.accept().await.unwrap();
            let mut history = BufReader::new(socket);
            let req = read_request_line(&mut history).await;
            assert!(
                req.starts_with("POST /api/workspaces/workspace/session-history/window"),
                "unexpected history request: {req}"
            );
            let body = r#"{"status":"window","latest":true,"older":null,"newer":null,"messages":[]}"#;
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
            // Backend::reading_window also reads session status for running state.
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

            // 3. Drop SSE -> enters 500 ms backoff; Command::Retry wakes reconnect immediately.
            drop(sse1);
            while !matches!(events.recv().await.unwrap(), Event::Reconnecting) {}
            let started = Instant::now();
            commands.send(Command::Retry).await.unwrap();
            let (socket, _) = listener.accept().await.unwrap();
            let elapsed = started.elapsed();
            let mut sse2 = BufReader::new(socket);
            let req = read_request_line(&mut sse2).await;
            assert!(req.contains("connectionId=stream-2"), "got {req}");
            assert!(
                elapsed < Duration::from_millis(300),
                "Command::Retry should bypass the 500 ms backoff, took {elapsed:?}"
            );

            // 4. Close exits cleanly.
            commands.send(Command::Close).await.unwrap();
            task.await.unwrap().unwrap();
            drop(sse2);
        })
        .await
        .expect("recovery transport wake test timed out");
    });
}
