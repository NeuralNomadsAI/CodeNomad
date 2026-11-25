use super::*;
use crate::{
    backend::Backend,
    settings::PreferencesWatch,
    stream::{CatalogueWatch, start},
    transport::WorkspaceEvent,
};
use serde_json::json;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn tabs_catalogue_and_preferences_share_one_sse_connection_and_close_on_zero() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = format!("http://{}/", listener.local_addr().unwrap());
            let sse_opens = Arc::new(AtomicUsize::new(0));
            let pong_count = Arc::new(AtomicUsize::new(0));
            let (frame_tx, frame_rx) = bounded::<String>(16);
            let (closed_tx, closed_rx) = bounded::<()>(4);
            let opens = sse_opens.clone();
            let pongs = pong_count.clone();
            let server = tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        break;
                    };
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.starts_with("POST /api/client-connections/pong ") {
                        pongs.fetch_add(1, SeqCst);
                        let _ = sock
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                            .await;
                        continue;
                    }
                    if req.starts_with("GET /api/events?") {
                        opens.fetch_add(1, SeqCst);
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
                            )
                            .await;
                        let frame_rx = frame_rx.clone();
                        let closed_tx = closed_tx.clone();
                        tokio::spawn(async move {
                            let mut probe = [0u8; 16];
                            enum ServerStep {
                                Frame(std::result::Result<String, async_channel::RecvError>),
                                Read(std::io::Result<usize>),
                            }
                            loop {
                                let step = futures_lite::future::race(
                                    async { ServerStep::Frame(frame_rx.recv().await) },
                                    async { ServerStep::Read(sock.read(&mut probe).await) },
                                )
                                .await;
                                match step {
                                    ServerStep::Frame(Ok(msg)) => {
                                        if sock.write_all(msg.as_bytes()).await.is_err() {
                                            break;
                                        }
                                    }
                                    ServerStep::Frame(Err(_))
                                    | ServerStep::Read(Ok(0))
                                    | ServerStep::Read(Err(_)) => break,
                                    ServerStep::Read(Ok(_)) => {}
                                }
                            }
                            let _ = closed_tx.try_send(());
                        });
                    }
                }
            });

            let base = Backend::unauthenticated(&addr).unwrap();
            let mut tab_a = base.clone();
            tab_a.workspace = "ws-a".into();
            let mut tab_b = base.clone();
            tab_b.client_id.push_str("-tab-b");
            tab_b.workspace = "ws-b".into();

            let (out_a, in_a) = bounded(16);
            let state_a = Arc::new(State::default());
            start(tab_a, 1, out_a, state_a.clone());
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), in_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Input::Opened(1)
            ));

            let (out_b, in_b) = bounded(16);
            let state_b = Arc::new(State::default());
            start(tab_b, 1, out_b, state_b.clone());
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Input::Opened(1)
            ));

            let (catalogue, cat_task) = CatalogueWatch::new(base.clone(), Arc::new(|| {}));
            let cat_handle = tokio::spawn(cat_task);
            let (prefs, prefs_task) = PreferencesWatch::task(base.clone(), None, Arc::new(|| {}));
            let prefs_handle = tokio::spawn(prefs_task);

            // Wait for PreferencesWatch and CatalogueWatch to complete initial Open, then clear
            // their initial-open flags so we prove live frames reach both afterwards.
            tokio::time::timeout(Duration::from_secs(2), async {
                while !prefs.take().0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("PreferencesWatch must open on shared SSE");
            tokio::time::timeout(Duration::from_secs(2), async {
                while catalogue.take_workspace_events().0 == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("CatalogueWatch must open on shared SSE");
            assert_eq!(
                sse_opens.load(SeqCst),
                1,
                "4 subscribers on one backend must open exactly 1 /api/events SSE stream"
            );

            // Ping triggers exactly one pong.
            frame_tx
                .send("event: codenomad.client.ping\ndata: {\"ts\":1}\n\n".into())
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while pong_count.load(SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(pong_count.load(SeqCst), 1);

            // Broadcast events reach tab B, CatalogueWatch, and PreferencesWatch cleanly.
            frame_tx
                .send(format!(
                    "data: {}\n\ndata: {}\n\n",
                    json!({"type":"workspace.stopped","workspaceId":"ws-b"}),
                    json!({"type":"storage.configChanged","owner":"ui","value":{}})
                ))
                .await
                .unwrap();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Input::Workspace(1, WorkspaceEvent::Stopped { workspace_id }) if workspace_id == "ws-b"
            ));
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let (_, _, events) = catalogue.take_workspace_events();
                    if events.iter().any(|ev| {
                        matches!(ev, WorkspaceEvent::Stopped { workspace_id } if workspace_id == "ws-b")
                    }) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("CatalogueWatch must receive workspace.stopped");
            tokio::time::timeout(Duration::from_secs(2), async {
                while !prefs.take().0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("PreferencesWatch must receive storage.configChanged after open");

            // Closing 3 of 4 subscribers keeps the shared SSE open; closing the last closes it.
            state_a.cancel();
            drop(catalogue);
            state_b.cancel();
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert!(
                closed_rx.try_recv().is_err(),
                "physical SSE must stay open while PreferencesWatch is still subscribed"
            );
            // Stopping PreferencesWatch as the last subscriber must close the physical TCP socket
            // BEFORE its closed receiver resolves.
            let _ = prefs.stop().recv().await;
            tokio::time::timeout(Duration::from_secs(2), closed_rx.recv())
                .await
                .expect("physical SSE must close before PreferencesWatch::stop resolves")
                .unwrap();
            let _ = (cat_handle, prefs_handle);
            assert_eq!(sse_opens.load(SeqCst), 1);
            server.abort();
        });
}

#[test]
fn physical_401_fans_out_authentication_required_to_all_subscribers() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = format!("http://{}/", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}")
                        .await;
                }
            });
            let base = Backend::unauthenticated(&addr).unwrap();
            let (out_a, in_a) = bounded(4);
            let (out_b, in_b) = bounded(4);
            start(base.clone(), 1, out_a, Arc::new(State::default()));
            start(base, 2, out_b, Arc::new(State::default()));
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), in_a.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Input::AuthenticationRequired(1)
            ));
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), in_b.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Input::AuthenticationRequired(2)
            ));
            server.abort();
        });
}

#[test]
fn slow_subscriber_overflow_resyncs_upstream_and_preferences_without_blocking_sibling() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let hub = Arc::new(Hub::default());
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let slow = Subscriber::new(1, None, None);
            let fast = Subscriber::new(2, None, None);
            let shared = Arc::new(SharedStream {
                base: "http://127.0.0.1:1/".into(),
                inner: Mutex::new(StreamInner {
                    phase: Phase::Connecting,
                    subscribers: vec![slow.clone(), fast.clone()],
                    replays: HashMap::new(),
                    replays_overflowed: false,
                    chunk_active: false,
                    stop: Some(stop_tx),
                }),
                done: done_rx,
            });
            assert!(shared.mark_open());
            assert!(matches!(fast.pop(), Some(HubItem::Opened)));
            shared.broadcast_frame(
                "message".into(),
                json!({
                    "type": "instance.eventStatus",
                    "instanceId": "ws-slow",
                    "status": "disconnected",
                    "generation": 4
                })
                .to_string(),
            );
            assert!(matches!(fast.pop(), Some(HubItem::Frame(_))));
            for i in 0..MAX_SUBSCRIBER_FRAMES {
                shared.broadcast_frame(
                    "message".into(),
                    format!("{{\"type\":\"memory.changed\",\"seq\":{i}}}"),
                );
                assert!(
                    matches!(fast.pop(), Some(HubItem::Frame(_))),
                    "fast sibling must receive every frame immediately"
                );
            }
            assert!(
                matches!(slow.pop(), Some(HubItem::Opened)),
                "slow subscriber preserves initial Opened"
            );
            assert!(
                matches!(slow.pop(), Some(HubItem::Skipped { overflow: true })),
                "slow subscriber collapses backlog to overflow Skipped"
            );
            // Resync restores upstream=false from replay cache and invalidates preferences/memory.
            let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            backend.workspace = "ws-slow".into();
            let state = State::default();
            state.upstream.store(true, SeqCst);
            let notices = backend.client.preferences_notices();
            let _ = state.preferences_notices.set(notices.clone());
            let (out, rx) = bounded(16);
            resync_after_skip(&shared, &backend, 1, &out, &state, "stream-1", true)
                .await
                .unwrap();
            assert!(
                !state.upstream.load(SeqCst),
                "overflow resync must restore disconnected instance.eventStatus"
            );
            assert_eq!(
                notices[crate::settings::Owner::Config.index()].load(SeqCst),
                1
            );
            assert_eq!(
                notices[crate::settings::Owner::State.index()].load(SeqCst),
                1
            );
            assert_eq!(
                notices[crate::settings::Owner::Server.index()].load(SeqCst),
                1
            );
            let mut saw_hint = false;
            let mut saw_memory = false;
            let mut saw_missions = false;
            while let Ok(item) = rx.try_recv() {
                match item {
                    Input::Hint(1, _) => saw_hint = true,
                    Input::Workspace(1, WorkspaceEvent::MemoryChanged) => saw_memory = true,
                    Input::Workspace(1, WorkspaceEvent::MissionsReconnected { .. }) => {
                        saw_missions = true
                    }
                    _ => {}
                }
            }
            assert!(saw_hint && saw_memory && saw_missions);
            shared.finish(&hub, false);
        });
}

#[test]
fn late_subscriber_receives_256_replays_evicts_workspace_error_and_sees_mid_chunk_disconnect() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let hub = Arc::new(Hub::default());
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let first = Subscriber::new(1, None, None);
            let shared = Arc::new(SharedStream {
                base: "http://127.0.0.1:1/".into(),
                inner: Mutex::new(StreamInner {
                    phase: Phase::Connecting,
                    subscribers: vec![first.clone()],
                    replays: HashMap::new(),
                    replays_overflowed: false,
                    chunk_active: false,
                    stop: Some(stop_tx),
                }),
                done: done_rx,
            });
            hub.streams.lock().unwrap().insert(
                "http://127.0.0.1:1/".into(),
                StreamEntry {
                    stream: shared.clone(),
                    active: true,
                },
            );
            assert!(shared.mark_open());
            // Fill cache to the full MAX_REPLAY_STATUSES (256) and verify workspace error evicts.
            shared.broadcast_frame(
                "message".into(),
                json!({
                    "type": "instance.eventStatus",
                    "instanceId": "ws-errored",
                    "status": "connected",
                    "generation": 1
                })
                .to_string(),
            );
            shared.broadcast_frame(
                "message".into(),
                json!({
                    "type": "instance.eventStatus",
                    "instanceId": "ws-errored",
                    "status": "disconnected",
                    "reason": "workspace error",
                    "generation": 2
                })
                .to_string(),
            );
            for i in 0..MAX_REPLAY_STATUSES {
                shared.broadcast_frame(
                    "message".into(),
                    json!({
                        "type": "instance.eventStatus",
                        "instanceId": format!("ws-{i}"),
                        "status": "connected",
                        "generation": 1
                    })
                    .to_string(),
                );
            }

            // Simulate joining mid-chunk: begin_chunk is active, then late subscriber joins,
            // then a disconnected status arrives in the SAME chunk.
            let chunk_guard = shared.begin_chunk();
            let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            backend.workspace = "ws-0".into();
            backend.session = "ses-1".into();
            let watch = crate::provider_usage::Watch::default();
            let wakes = Arc::new(AtomicUsize::new(0));
            let wakes_cb = wakes.clone();
            let ingress = crate::provider_usage::Ingress::new(
                watch.clone(),
                Arc::new(move || {
                    wakes_cb.fetch_add(1, SeqCst);
                }),
                backend.workspace.clone(),
                backend.session.clone(),
            );
            let late = hub.subscribe(&backend, Some(ingress), None).await;
            assert!(
                watch.backpressured(),
                "late subscriber joining mid-chunk must inherit active chunk backpressure"
            );
            // All 256 replays + Opened must fit without triggering Skipped, and ws-errored must be absent.
            assert!(matches!(late.sub.pop(), Some(HubItem::Opened)));
            let mut replayed_count = 0;
            while let Some(item) = late.sub.pop() {
                match item {
                    HubItem::Frame(frame) => {
                        assert!(
                            !frame.1.contains("\"ws-errored\""),
                            "workspace error disconnect must be evicted from replay cache"
                        );
                        replayed_count += 1;
                    }
                    other => panic!("unexpected item in 256-entry replay: {}", matches!(other, HubItem::Skipped { .. })),
                }
            }
            assert_eq!(replayed_count, MAX_REPLAY_STATUSES);

            // Mid-chunk disconnect must immediately update the late subscriber's Ingress!
            shared.broadcast_frame(
                "message".into(),
                json!({
                    "type": "instance.eventStatus",
                    "instanceId": "ws-0",
                    "status": "disconnected",
                    "generation": 2
                })
                .to_string(),
            );
            chunk_guard.finish();
            assert!(
                !watch.current().1,
                "mid-chunk disconnect must revoke quota authority for subscriber joined during chunk"
            );
            assert!(!watch.backpressured());
            drop(late);
            shared.finish(&hub, false);
        });
}

#[test]
fn physical_close_revokes_attestation_immediately_even_when_subscriber_output_is_blocked() {
    let hub = Arc::new(Hub::default());
    let (stop_tx, _stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    let client = backend.client.clone();
    let (gen0, seq0, _) = client.begin_meta_probe();
    assert!(client.observe_capabilities_at(gen0, seq0, true, true));
    assert!(!client.needs_capability_recheck());
    let (guard, open_flag) = client.track_stream(&backend.client_id);
    open_flag.store(true, SeqCst);
    client.open_streams_counter().fetch_add(1, SeqCst);
    let guard = Arc::new(guard);
    let sub = Subscriber::new(
        1,
        None,
        Some(CloseRevocation {
            http: client.clone(),
            guard: guard.clone(),
            client_id: backend.client_id.clone(),
        }),
    );
    let shared = Arc::new(SharedStream {
        base: backend.base.clone(),
        inner: Mutex::new(StreamInner {
            phase: Phase::Connecting,
            subscribers: vec![sub.clone()],
            replays: HashMap::new(),
            replays_overflowed: false,
            chunk_active: false,
            stop: Some(stop_tx),
        }),
        done: done_rx,
    });
    assert!(shared.mark_open());
    // Queue pending frames that have NOT been drained by the subscriber yet.
    shared.broadcast_frame("message".into(), r#"{"type":"memory.changed"}"#.into());
    // Physical close must immediately drop open_streams to 0, bump drop_generation
    // (needs_capability_recheck), and increment transport_drops BEFORE queued frames drain,
    // while still letting pre-EOF frames drain ahead of Closed.
    shared.finish(&hub, false);
    assert!(
        client.needs_capability_recheck(),
        "physical SSE close must revoke attestation immediately before subscriber queue drains"
    );
    assert_eq!(client.transport_drops(&backend.client_id), 1);
    assert!(matches!(sub.pop(), Some(HubItem::Opened)));
    assert!(matches!(sub.pop(), Some(HubItem::Frame(_))));
    assert!(matches!(
        sub.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));
    assert!(sub.pop().is_none());
    // Subsequent guard check on read_shared return must not double-count transport_drops.
    assert!(!guard.release_open());
    assert!(guard.mark_drop_recorded());
    assert_eq!(client.transport_drops(&backend.client_id), 1);
}

#[test]
fn shared_stream_staleness_and_hanging_pong_close_all_subscribers_and_unregister_probes() {
    use super::super::staleness::{Clock, ProbeSource, STALE_THRESHOLD, Stamp, Watchdog};
    use crate::runtime::Instant;
    #[derive(Clone)]
    struct FakeClock(Arc<Mutex<Stamp>>);
    impl FakeClock {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(Stamp {
                monotonic: Instant::now(),
                wall_ms: 1_000_000,
            })))
        }
        fn advance_wall(&self, ms: u64) {
            self.0.lock().unwrap().wall_ms += ms;
        }
    }
    impl Clock for FakeClock {
        fn now(&self) -> Stamp {
            *self.0.lock().unwrap()
        }
    }

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = format!("http://{}/", listener.local_addr().unwrap());
            let (frame_tx, frame_rx) = bounded::<String>(8);
            let (closed_tx, closed_rx) = bounded::<()>(1);
            let (pong_seen_tx, pong_seen_rx) = bounded::<()>(1);
            let server = tokio::spawn(async move {
                let mut held_pongs = Vec::new();
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        break;
                    };
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.starts_with("POST /api/client-connections/pong ") {
                        let _ = pong_seen_tx.try_send(());
                        // Deliberately hang the pong response to exercise forked pong staleness.
                        held_pongs.push(sock);
                        continue;
                    }
                    if req.starts_with("GET /api/events?") {
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
                            )
                            .await;
                        let frame_rx = frame_rx.clone();
                        let closed_tx = closed_tx.clone();
                        tokio::spawn(async move {
                            let mut probe = [0u8; 16];
                            enum Step {
                                Frame(std::result::Result<String, async_channel::RecvError>),
                                Read(std::io::Result<usize>),
                            }
                            loop {
                                let step = futures_lite::future::race(
                                    async { Step::Frame(frame_rx.recv().await) },
                                    async { Step::Read(sock.read(&mut probe).await) },
                                )
                                .await;
                                match step {
                                    Step::Frame(Ok(msg)) => {
                                        if sock.write_all(msg.as_bytes()).await.is_err() {
                                            break;
                                        }
                                    }
                                    Step::Frame(Err(_))
                                    | Step::Read(Ok(0))
                                    | Step::Read(Err(_)) => break,
                                    Step::Read(Ok(_)) => {}
                                }
                            }
                            let _ = closed_tx.try_send(());
                        });
                    }
                }
            });

            let hub = Arc::new(Hub::default());
            let (stop_tx, stop_rx) = bounded(1);
            let (done_tx, done_rx) = bounded(1);
            let sub_a = Subscriber::new(1, None, None);
            let sub_b = Subscriber::new(2, None, None);
            let shared = Arc::new(SharedStream {
                base: addr.clone(),
                inner: Mutex::new(StreamInner {
                    phase: Phase::Connecting,
                    subscribers: vec![sub_a.clone(), sub_b.clone()],
                    replays: HashMap::new(),
                    replays_overflowed: false,
                    chunk_active: false,
                    stop: Some(stop_tx),
                }),
                done: done_rx,
            });
            hub.streams.lock().unwrap().insert(
                addr.clone(),
                StreamEntry {
                    stream: shared.clone(),
                    active: true,
                },
            );
            let clock = FakeClock::new();
            let watchdog = Arc::new(Watchdog::with_clock(
                clock.clone(),
                STALE_THRESHOLD,
                Duration::from_secs(15),
            ));
            let (captured_ids, probes) = ProbeSource::global_capturing();
            let backend = Backend::unauthenticated(&addr).unwrap();
            let pump_hub = hub.clone();
            let pump_shared = shared.clone();
            tokio::spawn(async move {
                let _done = done_tx;
                super::super::native::pump_shared_with(
                    pump_hub,
                    pump_shared,
                    backend,
                    "hub-stale-test".into(),
                    stop_rx,
                    watchdog,
                    probes,
                )
                .await;
            });

            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_a.recv())
                    .await
                    .unwrap(),
                HubItem::Opened
            ));
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_b.recv())
                    .await
                    .unwrap(),
                HubItem::Opened
            ));

            // Trigger ping whose pong hangs, then send a trailing SSE frame to prove the
            // forked pong watchdog still closes the shared stream on wake probe.
            frame_tx
                .send("event: codenomad.client.ping\ndata: {\"ts\":1}\n\n".into())
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), pong_seen_rx.recv())
                .await
                .unwrap()
                .unwrap();
            frame_tx
                .send("data: {\"type\":\"memory.changed\"}\n\n".into())
                .await
                .unwrap();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_a.recv())
                    .await
                    .unwrap(),
                HubItem::Frame(_)
            ));
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_b.recv())
                    .await
                    .unwrap(),
                HubItem::Frame(_)
            ));

            clock.advance_wall(STALE_THRESHOLD.as_millis() as u64 + 1_000);
            super::super::probe_stale();

            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_a.recv())
                    .await
                    .unwrap(),
                HubItem::Closed {
                    auth_expired: false
                }
            ));
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), sub_b.recv())
                    .await
                    .unwrap(),
                HubItem::Closed {
                    auth_expired: false
                }
            ));
            tokio::time::timeout(Duration::from_secs(2), closed_rx.recv())
                .await
                .unwrap()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let ids = captured_ids.lock().unwrap().clone();
                    if !ids.is_empty()
                        && ids
                            .iter()
                            .all(|id| !super::super::staleness::has_probe_id(*id))
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("all shared-stream and pong probes must unregister after stale close");
            server.abort();
        });
}
