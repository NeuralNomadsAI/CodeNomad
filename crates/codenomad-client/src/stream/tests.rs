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
            assert!(matches!(inbox.try_recv().unwrap(), Input::Native(1, _, _)));
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
    let mut watchdog = staleness::Watchdog::with_clock(
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

#[test]
fn native_stream_wake_probe_closes_stale_stream_after_sleep_and_keeps_fresh_stream_open() {
    use futures_lite::StreamExt;
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
            let watchdog = staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                staleness::CHECK_INTERVAL,
            );
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-1",
                chunks.map(Ok),
                watchdog,
                staleness::ProbeSubscription::register(),
            ));
            let event = |kind| {
                format!(
                    "data: {}\n\n",
                    json!({"type": "memory.changed", "tag": kind})
                )
                .into_bytes()
            };

            send.send(event("first")).await.unwrap();
            enum Step<A, B> {
                First(A),
                Second(B),
            }
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
            probe_stale();
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
            probe_stale();
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
            let (_probe_tx, probe) = staleness::ProbeSubscription::local();
            let watchdog = staleness::Watchdog::with_clock(
                staleness::SystemClock,
                Duration::from_millis(120),
                Duration::from_millis(30),
            );
            let mut wire = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-1",
                chunks.map(Ok),
                watchdog,
                probe,
            ));

            // Regular SSE heartbeat comments beyond the 120 ms threshold must keep the stream open.
            let heartbeats = async {
                assert!(matches!(recovery.recv().await.unwrap(), Input::Opened(1)));
                for _ in 0..4 {
                    runtime::sleep(Duration::from_millis(35)).await;
                    send.send(b": heartbeat\n\n".to_vec()).await.unwrap();
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
                Step::Second(result) => panic!("active heartbeat stream expired early: {result:?}"),
            }

            // Once heartbeats stop, silence closes the stream automatically without any wake probe.
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("silent stream must expire at threshold");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");
        });
}

#[test]
fn native_handshake_hanging_server_expires_on_staleness_instead_of_24h() {
    use std::io::Read;
    use std::net::TcpListener;
    enum Step<A, B> {
        First(A),
        Second(B),
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let (accepted_tx, accepted_rx) = crate::bounded(1);
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = accepted_tx.try_send(());
                let _ = release_rx.recv();
            });

            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let (out, _recovery) = crate::bounded(4);
            let state = State::default();
            let clock = FakeClock::new(20_000_000);
            let (probe_tx, probe) = staleness::ProbeSubscription::local();
            let watchdog = staleness::Watchdog::with_clock(
                clock.clone(),
                staleness::STALE_THRESHOLD,
                staleness::CHECK_INTERVAL,
            );
            let mut wire = std::pin::pin!(native::read_native_with(
                &backend, 1, &out, &state, watchdog, probe,
            ));

            match tokio::time::timeout(
                Duration::from_secs(2),
                futures_lite::future::race(
                    async { Step::First(accepted_rx.recv().await) },
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
            probe_tx.try_send(()).unwrap();
            runtime::sleep(Duration::from_millis(10)).await;
            assert!(futures_lite::future::poll_once(&mut wire).await.is_none());

            // At 45 s of silence during handshake, wake probe aborts immediately.
            clock.advance_wall_ms(25_000);
            probe_tx.try_send(()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(2), wire)
                .await
                .expect("hanging handshake must abort on staleness");
            assert_eq!(result.unwrap_err().to_string(), "event stream stale");

            let _ = release_tx.send(());
            server.join().unwrap();
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
            let probe_eof = staleness::ProbeSubscription::register();
            let eof_id = probe_eof.id().unwrap();
            assert!(staleness::has_probe_id(eof_id));
            let (send_eof, chunks_eof) = crate::bounded::<Vec<u8>>(2);
            let mut wire_eof = std::pin::pin!(native::read_frames_with(
                &backend,
                1,
                &out,
                &state,
                "stream-eof",
                chunks_eof.map(Ok),
                staleness::Watchdog::new(staleness::STALE_THRESHOLD),
                probe_eof,
            ));
            assert!(poll_once(&mut wire_eof).await.is_none());
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

            // 2. Cancelled/dropped stream unregisters while another open stream still wakes.
            let probe_drop = staleness::ProbeSubscription::register();
            let drop_id = probe_drop.id().unwrap();
            let probe_live = staleness::ProbeSubscription::register();
            let live_id = probe_live.id().unwrap();
            assert!(staleness::has_probe_id(drop_id));
            assert!(staleness::has_probe_id(live_id));

            let clock = FakeClock::new(30_000_000);
            let (_send_drop, chunks_drop) = crate::bounded::<Vec<u8>>(2);
            let (_send_live, chunks_live) = crate::bounded::<Vec<u8>>(2);
            {
                let mut wire_drop = std::pin::pin!(native::read_frames_with(
                    &backend,
                    2,
                    &out,
                    &state,
                    "stream-drop",
                    chunks_drop.map(Ok),
                    staleness::Watchdog::with_clock(
                        clock.clone(),
                        staleness::STALE_THRESHOLD,
                        staleness::CHECK_INTERVAL,
                    ),
                    probe_drop,
                ));
                assert!(poll_once(&mut wire_drop).await.is_none());
                assert!(staleness::has_probe_id(drop_id));
            }
            assert!(
                !staleness::has_probe_id(drop_id),
                "dropped/cancelled stream must unregister from probe_stale()"
            );
            assert!(staleness::has_probe_id(live_id));

            let mut wire_live = std::pin::pin!(native::read_frames_with(
                &backend,
                3,
                &out,
                &state,
                "stream-live",
                chunks_live.map(Ok),
                staleness::Watchdog::with_clock(
                    clock.clone(),
                    staleness::STALE_THRESHOLD,
                    staleness::CHECK_INTERVAL,
                ),
                probe_live,
            ));
            assert!(poll_once(&mut wire_live).await.is_none());
            let _ = recovery.try_recv();
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
