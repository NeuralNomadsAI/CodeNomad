use super::*;
use serde_json::json;

#[test]
fn draining_one_frame_cannot_publish_before_a_later_revocation_in_the_same_chunk() {
    use futures_lite::{
        StreamExt,
        future::{poll_once, zip},
    };
    use std::sync::{Mutex, atomic::AtomicBool};
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            let (out, recovery) = crate::bounded(1);
            let (events, _display) = crate::bounded(4);
            let watch = crate::provider_usage::Watch::default();
            let ready = Arc::new(Mutex::new(None));
            let published = Arc::new(AtomicBool::new(false));
            let wake = {
                let (watch, ready, published) = (watch.clone(), ready.clone(), published.clone());
                Arc::new(move || {
                    if let Some(stamp) = *ready.lock().unwrap() {
                        // Reproduce a display wake at exactly the point the reader offers its next frame.
                        watch.publish_if_current(stamp, || published.store(true, SeqCst));
                    }
                })
            };
            let state =
                State::observing_preferences(events, wake).with_provider_usage(Some(watch.clone()));
            let frame = |kind| {
                format!(
                    "data: {}\n\n",
                    json!({
                        "type":"instance.event","instanceId":"project","event":{"type":kind}
                    })
                )
            };
            let (send, chunks) = crate::bounded(1);
            let mut wire = std::pin::pin!(native::read_frames(
                &backend,
                1,
                &out,
                &state,
                "stream",
                chunks.map(Ok),
            ));
            send.send(frame("provider.updated").into_bytes())
                .await
                .unwrap();
            assert!(poll_once(&mut wire).await.is_none());
            assert!(out.is_full());
            let expected = watch.current();
            send.send(
                [
                    frame("irrelevant"),
                    frame("irrelevant"),
                    frame("credential.switched"),
                ]
                .concat()
                .into_bytes(),
            )
            .await
            .unwrap();
            assert!(poll_once(&mut wire).await.is_none());
            assert_eq!(
                watch.current(),
                expected,
                "the revocation is later in the received chunk"
            );
            *ready.lock().unwrap() = Some(expected);
            assert_eq!(watch.publish_if_current(expected, || ()), None);
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            let drain = async {
                assert!(matches!(
                    recovery.recv().await.unwrap(),
                    Input::Workspace(_, WorkspaceEvent::ProviderUsageRefresh(_))
                ));
                for _ in 0..2 {
                    assert!(matches!(
                        recovery.recv().await.unwrap(),
                        Input::Workspace(_, WorkspaceEvent::ProvidersChanged { .. })
                    ));
                }
                assert_eq!(watch.current().0, expected.0 + 1);
                drop(send);
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(2), zip(wire, drain))
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "event stream ended");
            assert!(!published.load(SeqCst));
        });
}

#[test]
fn received_credentials_revoke_quota_authority_before_a_full_recovery_queue() {
    use futures_lite::{
        StreamExt,
        future::{poll_once, zip},
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            let (out, recovery) = crate::bounded(1);
            let (events, _display) = crate::bounded(4);
            let watch = crate::provider_usage::Watch::default();
            let state = State::observing_preferences(events, Arc::new(|| {}))
                .with_provider_usage(Some(watch.clone()));
            let payload = |kind| {
                json!({
                    "type":"instance.event", "instanceId":"project", "event":{"type":kind}
                })
            };
            let chunk = |kind| format!("data: {}\n\n", payload(kind));
            let (bytes, chunks) = crate::bounded(1);
            let mut routed = std::pin::pin!(native::read_frames(
                &backend,
                1,
                &out,
                &state,
                "stream",
                chunks.map(Ok),
            ));
            bytes
                .send(chunk("provider.updated").into_bytes())
                .await
                .unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert!(out.is_full());
            let before = watch.current();
            assert!(before.1);
            bytes
                .send(chunk("credential.switched").into_bytes())
                .await
                .unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert_eq!(watch.current(), (before.0 + 1, true, before.2));
            let switched = watch.current();
            bytes.send(chunk("irrelevant").into_bytes()).await.unwrap();
            assert!(poll_once(&mut routed).await.is_none());
            assert!(watch.backpressured());
            assert_eq!(watch.current(), switched);
            drop(bytes);
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            let drain = async {
                assert!(matches!(
                    recovery.recv().await.unwrap(),
                    Input::Workspace(_, WorkspaceEvent::ProviderUsageRefresh(_))
                ));
                for _ in 0..2 {
                    assert!(matches!(
                        recovery.recv().await.unwrap(),
                        Input::Workspace(_, WorkspaceEvent::ProvidersChanged { .. })
                    ));
                }
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(2), zip(routed, drain))
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "event stream ended");
            assert!(!watch.backpressured() && !watch.current().1);
        });
}

#[test]
fn owner_changes_invalidate_the_intended_consumers_without_recovering_history() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            let (out, recovery) = crate::bounded(4);
            let (send, events) = crate::bounded(4);
            let state = State::observing_preferences(send, Arc::new(|| {}));
            opened(1, &out, &state).await.unwrap();
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let stamp = state.version.load(SeqCst);
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                r#"{"owner":"ui","type":"storage.stateChanged","value":{}}"#,
            )
            .await
            .unwrap();
            assert!(recovery.is_empty() && state.valid(stamp));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let data = json!({"owner":"ui","type":"storage.configChanged",
                              "value":{"padding":"x".repeat(300 * 1024)}});
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                &data.to_string(),
            )
            .await
            .unwrap();
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Workspace(WorkspaceEvent::UiPreferencesChanged)
            ));
            assert!(events.is_empty() && recovery.is_empty() && state.valid(stamp));
        });
}

#[test]
fn a_matching_move_cancels_the_body_before_waiting_for_queue_space() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(1);
            let (events, _receiver) = crate::bounded(1);
            let state = State::observing_preferences(events, Arc::new(|| {}));
            out.try_send(Input::Opened(1)).ok().unwrap();
            let move_event = json!({"type":"instance.event","instanceId":"project","event":{
                "type":"session.moved","data":{"sessionID":"session"}
            }});
            let payload = move_event.to_string();
            let mut dispatch_move = std::pin::pin!(dispatch(
                &backend, 1, &out, &state, "stream", "message", &payload
            ));
            assert!(
                futures_lite::future::poll_once(&mut dispatch_move)
                    .await
                    .is_none()
            );
            assert!(
                futures_lite::future::poll_once(state.placement_changed())
                    .await
                    .is_some()
            );
            assert!(matches!(inbox.try_recv().unwrap(), Input::Opened(1)));
            dispatch_move.await.unwrap();
            assert!(matches!(
                inbox.try_recv().unwrap(),
                Input::Native(1, _, _, _)
            ));
        });
}

#[derive(Clone)]
struct FakeClock {
    now: Arc<std::sync::Mutex<staleness::Stamp>>,
}

impl FakeClock {
    fn new(wall_ms: u64) -> Self {
        Self {
            now: Arc::new(std::sync::Mutex::new(staleness::Stamp {
                monotonic: runtime::Instant::now(),
                wall_ms,
            })),
        }
    }

    fn advance_monotonic(&self, delta: Duration) {
        self.now.lock().unwrap().monotonic += delta;
    }

    fn advance_wall_ms(&self, delta_ms: u64) {
        let mut guard = self.now.lock().unwrap();
        guard.wall_ms = guard.wall_ms.saturating_add(delta_ms);
    }

    fn rewind_wall_ms(&self, delta_ms: u64) {
        let mut guard = self.now.lock().unwrap();
        guard.wall_ms = guard.wall_ms.saturating_sub(delta_ms);
    }
}

impl staleness::Clock for FakeClock {
    fn now(&self) -> staleness::Stamp {
        *self.now.lock().unwrap()
    }
}

#[test]
fn staleness_watchdog_tracks_monotonic_wall_wake_and_clock_rollback() {
    let clock = FakeClock::new(1_000_000);
    let watchdog = staleness::Watchdog::with_clock(
        clock.clone(),
        staleness::STALE_THRESHOLD,
        staleness::CHECK_INTERVAL,
    );
    assert!(!watchdog.is_stale());
    assert_eq!(watchdog.next_check_delay(), Duration::from_secs(15));

    clock.advance_monotonic(Duration::from_millis(44_999));
    assert!(!watchdog.is_stale());
    assert_eq!(watchdog.next_check_delay(), Duration::from_millis(1));

    clock.advance_monotonic(Duration::from_millis(1));
    assert!(watchdog.is_stale());
    assert_eq!(watchdog.next_check_delay(), Duration::ZERO);

    watchdog.activity();
    assert!(!watchdog.is_stale());

    // Simulate OS sleep where monotonic time stays frozen while wall clock advances 45 s.
    clock.advance_wall_ms(45_000);
    assert!(watchdog.is_stale());
    assert_eq!(watchdog.next_check_delay(), Duration::ZERO);

    // Wall-clock rollback (NTP adjustment) must not trigger false staleness.
    watchdog.activity();
    clock.rewind_wall_ms(60_000);
    assert!(!watchdog.is_stale());
    assert_eq!(watchdog.elapsed(), Duration::ZERO);

    // Pausing during local queue backpressure suspends staleness and restarts the clock on drop.
    {
        let _pause = watchdog.pause();
        clock.advance_monotonic(Duration::from_secs(60));
        clock.advance_wall_ms(60_000);
        assert!(!watchdog.is_stale());
        assert_eq!(watchdog.next_check_delay(), Duration::from_secs(15));
    }
    assert!(!watchdog.is_stale());
    clock.advance_monotonic(Duration::from_secs(44));
    assert!(!watchdog.is_stale());
    clock.advance_monotonic(Duration::from_secs(1));
    assert!(watchdog.is_stale());

    // A replacement connection starts with its own full 45 s silence deadline.
    clock.advance_wall_ms(30_000);
    let replacement = staleness::Watchdog::with_clock(
        clock.clone(),
        staleness::STALE_THRESHOLD,
        staleness::CHECK_INTERVAL,
    );
    clock.advance_wall_ms(20_000);
    assert!(!replacement.is_stale());
    clock.advance_wall_ms(25_000);
    assert!(replacement.is_stale());
}

struct HangingServer {
    addr: std::net::SocketAddr,
    accepted: crate::Receiver<()>,
    release: Option<std::sync::mpsc::Sender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl HangingServer {
    fn spawn() -> Self {
        use std::io::Read;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (accepted_tx, accepted) = crate::bounded(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                let mut buf = [0u8; 256];
                loop {
                    if release_rx.try_recv().is_ok() {
                        return;
                    }
                    match stream.read(&mut buf) {
                        Ok(_) => break,
                        Err(err)
                            if matches!(
                                err.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
                let _ = accepted_tx.try_send(());
                let _ = release_rx.recv();
            }
        });
        Self {
            addr,
            accepted,
            release: Some(release_tx),
            handle: Some(handle),
        }
    }
}

impl Drop for HangingServer {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        // Unblock accept() if the test exited before connecting.
        let _ = std::net::TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[test]
fn native_stream_wake_probe_closes_stale_stream_after_sleep_and_keeps_fresh_stream_open() {
    use futures_lite::StreamExt;
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            let (out, recovery) = crate::bounded(8);
            let (events, _display) = crate::bounded(8);
            let watch = crate::provider_usage::Watch::default();
            let state = State::observing_preferences(events, Arc::new(|| {}))
                .with_provider_usage(Some(watch.clone()));
            let (send, chunks) = crate::bounded(4);
            let clock = FakeClock::new(10_000_000);
            let (probe, probes) = staleness::ProbeSource::local();
            let watchdog = Arc::new(staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                staleness::CHECK_INTERVAL,
            ));
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-1",
                chunks.map(Ok),
                watchdog,
                probes,
            ));
            let event = |kind| {
                format!(
                    "data: {}\n\n",
                    json!({"type": "memory.changed", "tag": kind})
                )
                .into_bytes()
            };

            send.send(event("first")).await.unwrap();
            let drain = async {
                assert!(matches!(recovery.recv().await.unwrap(), Input::Opened(1)));
                assert!(matches!(
                    recovery.recv().await.unwrap(),
                    Input::Workspace(1, WorkspaceEvent::MemoryChanged)
                ));
            };
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async {
                        drain.await;
                        Step::First(())
                    },
                    async { Step::Second((&mut wire).await) },
                ),
            )
            .await
            .unwrap()
            {
                Step::First(()) => {}
                Step::Second(result) => panic!("stream ended early: {result:?}"),
            }
            assert!(watch.current().1, "transport should be marked online");

            // Under 45 s of sleep, wake probe must keep the stream open and deliver later frames.
            clock.advance_wall_ms(20_000);
            probe.trigger();
            send.send(event("second")).await.unwrap();
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(async { Step::First(recovery.recv().await) }, async {
                    Step::Second((&mut wire).await)
                }),
            )
            .await
            .unwrap()
            {
                Step::First(item) => {
                    assert!(matches!(
                        item.unwrap(),
                        Input::Workspace(1, WorkspaceEvent::MemoryChanged)
                    ));
                }
                Step::Second(result) => panic!("fresh stream closed on wake probe: {result:?}"),
            }

            // After 45 s of wall-clock sleep with frozen monotonic time, wake probe closes immediately.
            clock.advance_wall_ms(45_000);
            probe.trigger();
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("wake probe must close stale stream without waiting for check interval");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
            assert!(
                !watch.current().1,
                "transport must be marked offline on stale close"
            );
        });
}

#[test]
fn native_stream_silence_expires_without_probe_while_heartbeats_keep_it_alive() {
    use futures_lite::StreamExt;
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let (out, recovery) = crate::bounded(8);
            let state = State::default();
            let (send, chunks) = crate::bounded(4);
            let (_probe, probes) = staleness::ProbeSource::local();
            let clock = FakeClock::new(15_000_000);
            let watchdog = Arc::new(staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                Duration::from_millis(10),
            ));
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-1",
                chunks.map(Ok),
                watchdog,
                probes,
            ));

            // Four 15 s SSE heartbeat comments (60 s total > 45 s threshold) keep the stream alive.
            let heartbeats = async {
                assert!(matches!(recovery.recv().await.unwrap(), Input::Opened(1)));
                for _ in 0..4 {
                    clock.advance_monotonic(Duration::from_secs(15));
                    clock.advance_wall_ms(15_000);
                    send.send(b": heartbeat\n\n".to_vec()).await.unwrap();
                    runtime::sleep(Duration::from_millis(15)).await;
                }
            };
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async {
                        heartbeats.await;
                        Step::First(())
                    },
                    async { Step::Second((&mut wire).await) },
                ),
            )
            .await
            .unwrap()
            {
                Step::First(()) => {}
                Step::Second(result) => {
                    panic!("active heartbeat stream expired early: {result:?}")
                }
            }

            // Once heartbeats stop for 45 s, periodic check expires the stream without any wake probe.
            clock.advance_monotonic(Duration::from_secs(45));
            clock.advance_wall_ms(45_000);
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("silent stream must expire at threshold without wake probe");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
        });
}

#[test]
fn native_handshake_hanging_server_expires_on_staleness_instead_of_24h() {
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let server = HangingServer::spawn();
            let backend = Backend::unauthenticated(&format!("http://{}/", server.addr)).unwrap();
            let (out, _recovery) = crate::bounded(4);
            let state = State::default();
            let clock = FakeClock::new(20_000_000);
            let (probe, probes) = staleness::ProbeSource::local();
            let watchdog = Arc::new(staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                staleness::CHECK_INTERVAL,
            ));
            let mut wire = std::pin::pin!(native::read_native_with(
                &backend, 1, &out, &state, watchdog, probes,
            ));

            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async { Step::First(server.accepted.recv().await) },
                    async { Step::Second((&mut wire).await) },
                ),
            )
            .await
            .unwrap()
            {
                Step::First(Ok(())) => {}
                Step::First(Err(err)) => panic!("accept channel closed: {err}"),
                Step::Second(result) => {
                    panic!("handshake ended before server accepted: {result:?}")
                }
            }

            // Under 45 s, a wake probe must not abort a connecting stream.
            clock.advance_wall_ms(20_000);
            probe.trigger();
            runtime::sleep(Duration::from_millis(10)).await;
            assert!(futures_lite::future::poll_once(&mut wire).await.is_none());

            // At 45 s of silence during handshake, wake probe aborts immediately.
            clock.advance_wall_ms(25_000);
            probe.trigger();
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("hanging handshake must abort on staleness");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
        });
}

#[test]
fn full_downstream_queue_past_45s_does_not_close_healthy_stream() {
    use futures_lite::{StreamExt, future::poll_once};
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let (out, recovery) = crate::bounded(1);
            let state = State::default();
            let (send, chunks) = crate::bounded(4);
            let clock = FakeClock::new(25_000_000);
            let (probe, probes) = staleness::ProbeSource::local();
            let watchdog = Arc::new(staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                Duration::from_millis(10),
            ));
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-backpressure",
                chunks.map(Ok),
                watchdog,
                probes,
            ));
            let event = format!("data: {}\n\n", json!({"type": "memory.changed"})).into_bytes();

            // Fill downstream queue `out` with Opened(1) and block route on sending `event`.
            send.send(event.clone()).await.unwrap();
            assert!(poll_once(&mut wire).await.is_none());
            assert!(out.is_full());

            // More than 45 s of local backpressure (with periodic ticks and wake probe) must not drop the stream.
            clock.advance_monotonic(Duration::from_secs(60));
            clock.advance_wall_ms(60_000);
            probe.trigger();
            runtime::sleep(Duration::from_millis(25)).await;
            assert!(
                poll_once(&mut wire).await.is_none(),
                "full downstream queue must pause staleness instead of closing a healthy stream"
            );

            // Draining `out` releases backpressure and restarts the silence deadline from zero.
            let drain = async {
                assert!(matches!(recovery.recv().await.unwrap(), Input::Opened(1)));
                assert!(matches!(
                    recovery.recv().await.unwrap(),
                    Input::Workspace(1, WorkspaceEvent::MemoryChanged)
                ));
            };
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async {
                        drain.await;
                        Step::First(())
                    },
                    async { Step::Second((&mut wire).await) },
                ),
            )
            .await
            .unwrap()
            {
                Step::First(()) => {}
                Step::Second(result) => panic!("stream closed while draining queue: {result:?}"),
            }

            // Server stays responsive within the fresh 45 s window after backpressure clears.
            clock.advance_monotonic(Duration::from_secs(20));
            clock.advance_wall_ms(20_000);
            probe.trigger();
            send.send(event).await.unwrap();
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(async { Step::First(recovery.recv().await) }, async {
                    Step::Second((&mut wire).await)
                }),
            )
            .await
            .unwrap()
            {
                Step::First(item) => {
                    assert!(matches!(
                        item.unwrap(),
                        Input::Workspace(1, WorkspaceEvent::MemoryChanged)
                    ));
                }
                Step::Second(result) => {
                    panic!("stream closed after backpressure cleared: {result:?}")
                }
            }

            // Now genuine server silence of 45 s without local backpressure closes the stream.
            clock.advance_monotonic(Duration::from_secs(45));
            clock.advance_wall_ms(45_000);
            probe.trigger();
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("stream must expire once genuinely silent after backpressure clears");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
        });
}

#[test]
fn hanging_pong_past_45s_closes_stream_as_stale() {
    use futures_lite::{StreamExt, future::poll_once};
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let server = HangingServer::spawn();
            let mut backend =
                Backend::unauthenticated(&format!("http://{}/", server.addr)).unwrap();
            backend.workspace = "project".into();
            let (out, recovery) = crate::bounded(8);
            let (events, _display) = crate::bounded(8);
            let watch = crate::provider_usage::Watch::default();
            let state = State::observing_preferences(events, Arc::new(|| {}))
                .with_provider_usage(Some(watch.clone()));
            let (send, chunks) = crate::bounded(4);
            let clock = FakeClock::new(28_000_000);
            let (probe, probes) = staleness::ProbeSource::local();
            let watchdog = Arc::new(staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                staleness::CHECK_INTERVAL,
            ));
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-pong",
                chunks.map(Ok),
                watchdog,
                probes,
            ));

            send.send(b"event: codenomad.client.ping\ndata: {\"ts\":1}\n\n".to_vec())
                .await
                .unwrap();
            // Queue two frames behind the ping so `read` blocks on the bounded internal channel
            // and holds `read_watchdog.pause()`; only the pong's own forked watchdog can expire.
            let trailing = format!("data: {}\n\n", json!({"type": "memory.changed"})).into_bytes();
            send.send(trailing.clone()).await.unwrap();
            send.send(trailing).await.unwrap();
            let wait_pong = async {
                assert!(matches!(recovery.recv().await.unwrap(), Input::Opened(1)));
                server.accepted.recv().await.unwrap();
            };
            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async {
                        wait_pong.await;
                        Step::First(())
                    },
                    async { Step::Second((&mut wire).await) },
                ),
            )
            .await
            .unwrap()
            {
                Step::First(()) => {}
                Step::Second(result) => {
                    panic!("stream ended before pong reached server: {result:?}")
                }
            }
            assert!(
                watch.current().1,
                "transport should be online while pong is in flight"
            );

            // Under 45 s, a wake probe must not cut an in-flight pong.
            clock.advance_wall_ms(20_000);
            probe.trigger();
            runtime::sleep(Duration::from_millis(10)).await;
            assert!(poll_once(&mut wire).await.is_none());

            // Past 45 s, a hanging pong POST is a network wait and must close the stream as stale.
            clock.advance_wall_ms(25_000);
            probe.trigger();
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("hanging pong past 45 s must abort stream immediately");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
            assert!(
                !watch.current().1,
                "transport must be marked offline after stale pong close"
            );
        });
}

#[test]
fn probe_registry_unregisters_closed_and_cancelled_streams() {
    use futures_lite::{StreamExt, future::poll_once};
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let (out, recovery) = crate::bounded(8);
            let state = State::default();

            // 1. Stream closed by EOF unregisters from the process-local probe registry.
            let (eof_ids, eof_source) = staleness::ProbeSource::global_capturing();
            let (send_eof, chunks_eof) = crate::bounded::<Vec<u8>>(2);
            let mut wire_eof = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-eof",
                chunks_eof.map(Ok),
                Arc::new(staleness::Watchdog::new(staleness::STALE_THRESHOLD)),
                eof_source,
            ));
            assert!(poll_once(&mut wire_eof).await.is_none());
            let eof_id = eof_ids.lock().unwrap()[0];
            assert!(staleness::has_probe_id(eof_id));
            drop(send_eof);
            let _ = recovery.recv().await;
            let result = tokio::time::timeout(Duration::from_secs(2), wire_eof)
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "event stream ended");
            assert!(
                !staleness::has_probe_id(eof_id),
                "closed stream must unregister from probe_stale()"
            );

            // 2. Cancelling/dropping one open stream removes only its own entry while an already
            //    registered sibling stream remains active and wakes on probe_stale().
            let clock = FakeClock::new(30_000_000);
            let (drop_ids, drop_source) = staleness::ProbeSource::global_capturing();
            let (live_ids, live_source) = staleness::ProbeSource::global_capturing();
            let (_send_drop, chunks_drop) = crate::bounded::<Vec<u8>>(2);
            let (_send_live, chunks_live) = crate::bounded::<Vec<u8>>(2);
            let mut wire_live = std::pin::pin!(native::read_frames_with(
                &backend,
                3,
                &out,
                &state,
                "stream-live",
                chunks_live.map(Ok),
                Arc::new(staleness::Watchdog::with_clock(
                    clock.clone(),
                    staleness::STALE_THRESHOLD,
                    staleness::CHECK_INTERVAL,
                )),
                live_source,
            ));
            assert!(poll_once(&mut wire_live).await.is_none());
            let live_id = live_ids.lock().unwrap()[0];
            assert!(staleness::has_probe_id(live_id));

            let drop_id;
            {
                let mut wire_drop = std::pin::pin!(native::read_frames_with(
                    &backend,
                    2,
                    &out,
                    &state,
                    "stream-drop",
                    chunks_drop.map(Ok),
                    Arc::new(staleness::Watchdog::with_clock(
                        clock.clone(),
                        staleness::STALE_THRESHOLD,
                        staleness::CHECK_INTERVAL,
                    )),
                    drop_source,
                ));
                assert!(poll_once(&mut wire_drop).await.is_none());
                drop_id = drop_ids.lock().unwrap()[0];
                assert!(staleness::has_probe_id(drop_id));
                assert!(staleness::has_probe_id(live_id));
            }
            assert!(
                !staleness::has_probe_id(drop_id),
                "dropped/cancelled stream must unregister from probe_stale()"
            );
            assert!(
                staleness::has_probe_id(live_id),
                "sibling open stream must remain registered after another stream drops"
            );

            while recovery.try_recv().is_ok() {}
            clock.advance_wall_ms(45_000);
            probe_stale();
            let result = tokio::time::timeout(Duration::from_secs(2), wire_live)
                .await
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
            assert!(
                !staleness::has_probe_id(live_id),
                "stale-closed stream must unregister from probe_stale()"
            );
        });
}
