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

const TEST_TIMEOUT: Duration = Duration::from_secs(30);

fn block_bounded<F: std::future::Future<Output = ()>>(name: &str, future: F) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            tokio::time::timeout(TEST_TIMEOUT, future)
                .await
                .unwrap_or_else(|_| panic!("{name} timed out after {TEST_TIMEOUT:?}"));
        });
}

#[test]
fn tabs_catalogue_and_preferences_share_one_sse_connection_and_close_on_zero() {
    block_bounded(
        "tabs_catalogue_and_preferences_share_one_sse_connection_and_close_on_zero",
        async {
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
            // before its closed receiver resolves (and within a bounded deadline).
            let stopped = prefs.stop();
            let stop_res = tokio::time::timeout(Duration::from_secs(2), stopped.recv())
                .await
                .expect("PreferencesWatch::stop must settle promptly");
            assert!(stop_res.is_err());
            tokio::time::timeout(Duration::from_millis(250), closed_rx.recv())
                .await
                .expect(
                    "physical SSE socket must have already received FIN on PreferencesWatch::stop",
                )
                .unwrap();
            let _ = (cat_handle, prefs_handle);
            assert_eq!(sse_opens.load(SeqCst), 1);
            server.abort();
        },
    );
}

#[test]
fn physical_401_fans_out_authentication_required_to_all_subscribers() {
    block_bounded(
        "physical_401_fans_out_authentication_required_to_all_subscribers",
        async {
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
        },
    );
}

#[test]
fn slow_subscriber_overflow_closes_only_the_slow_subscriber_without_disrupting_sibling() {
    let hub = Arc::new(Hub::default());
    let (stop_tx, stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    let client = backend.client.clone();
    let (gen0, seq0, _) = client.begin_meta_probe();
    assert!(client.observe_capabilities_at(gen0, seq0, true, true));
    let slow_guard = client.track_stream("slow-tab");
    let fast_guard = client.track_stream("fast-tab");
    let slow_watch = crate::provider_usage::Watch::default();
    let slow_ingress = crate::provider_usage::Ingress::new(
        slow_watch.clone(),
        Arc::new(|| {}),
        "ws-slow".into(),
        "ses-1".into(),
    );
    let slow = Subscriber::new(
        1,
        Some(slow_ingress),
        Some(GuardHook {
            http: client.clone(),
            guard: Arc::new(slow_guard),
            count_open_stream: true,
        }),
    );
    let fast = Subscriber::new(
        2,
        None,
        Some(GuardHook {
            http: client.clone(),
            guard: Arc::new(fast_guard),
            count_open_stream: true,
        }),
    );
    let shared = Arc::new(SharedStream {
        base: backend.base.clone(),
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
    hub.streams.lock().unwrap().insert(
        backend.base.clone(),
        StreamEntry {
            stream: shared.clone(),
            active: true,
        },
    );
    assert!(shared.mark_open());
    assert!(slow_watch.current().1);
    assert!(matches!(fast.pop(), Some(HubItem::Opened)));
    for i in 0..=MAX_SUBSCRIBER_FRAMES {
        shared.broadcast_frame(
            &hub,
            "message".into(),
            format!("{{\"type\":\"memory.changed\",\"seq\":{i}}}"),
        );
        assert!(
            matches!(fast.pop(), Some(HubItem::Frame(_))),
            "fast sibling must keep receiving every frame on the shared stream"
        );
    }
    // Slow subscriber is detached and closed so its standard reconnect loop runs cleanly
    // (recovering workspace.stopped, session.moved, PreferencesWatch, etc.), while the physical
    // stream stays open for the fast sibling.
    assert!(
        matches!(
            slow.pop(),
            Some(HubItem::Closed {
                auth_expired: false
            })
        ),
        "overflowing subscriber must close cleanly"
    );
    assert!(slow.pop().is_none());
    assert!(
        !slow_watch.current().1,
        "overflowing subscriber must revoke quota authority immediately"
    );
    assert_eq!(client.transport_drops("slow-tab"), 1);
    assert_eq!(client.transport_drops("fast-tab"), 0);
    assert!(
        !client.needs_capability_recheck(),
        "fast sibling still holds an open stream so global attestation stays valid"
    );
    assert!(
        !stop_rx.is_closed(),
        "physical SSE pump must stay alive while fast sibling is still subscribed"
    );
    shared.finish(&hub, false);
}

#[test]
fn late_subscriber_receives_256_replays_evicts_workspace_error_and_sees_mid_chunk_disconnect() {
    block_bounded(
        "late_subscriber_receives_256_replays_evicts_workspace_error_and_sees_mid_chunk_disconnect",
        async {
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
            let _ = first.pop();
            // Fill cache to the full MAX_REPLAY_STATUSES (256) and verify workspace error evicts.
            shared.broadcast_frame(
                &hub,
                "message".into(),
                json!({
                    "type": "instance.eventStatus",
                    "instanceId": "ws-errored",
                    "status": "connected",
                    "generation": 1
                })
                .to_string(),
            );
            let _ = first.pop();
            shared.broadcast_frame(
                &hub,
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
            let _ = first.pop();
            for i in 0..MAX_REPLAY_STATUSES {
                shared.broadcast_frame(
                    &hub,
                    "message".into(),
                    json!({
                        "type": "instance.eventStatus",
                        "instanceId": format!("ws-{i}"),
                        "status": "connected",
                        "generation": 1
                    })
                    .to_string(),
                );
                let _ = first.pop();
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
            let late = tokio::time::timeout(
                Duration::from_secs(5),
                hub.subscribe(&backend, Some(ingress), None, SubscriberSignals::default()),
            )
            .await
            .unwrap_or_else(|_| {
                let inner = shared.inner.lock().unwrap();
                panic!(
                    "late hub.subscribe timed out (subscribers={}, replays={}, first_queue_closed={})",
                    inner.subscribers.len(),
                    inner.replays.len(),
                    first.queue.lock().unwrap().closed,
                )
            });
            assert!(
                watch.backpressured(),
                "late subscriber joining mid-chunk must inherit active chunk backpressure atomically"
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
                    other => panic!(
                        "unexpected item in 256-entry replay: {}",
                        matches!(other, HubItem::Skipped)
                    ),
                }
            }
            assert_eq!(replayed_count, MAX_REPLAY_STATUSES);

            // Mid-chunk disconnect must immediately update the late subscriber's Ingress!
            shared.broadcast_frame(
                &hub,
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
        },
    );
}

#[test]
fn physical_close_revokes_attestation_immediately_and_queued_opened_cannot_reinstate_it() {
    block_bounded(
        "physical_close_revokes_attestation_immediately_and_queued_opened_cannot_reinstate_it",
        async {
            let hub = Arc::new(Hub::default());
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            let client = backend.client.clone();
            let (gen0, seq0, _) = client.begin_meta_probe();
            assert!(client.observe_capabilities_at(gen0, seq0, true, true));
            assert!(!client.needs_capability_recheck());

            // Do NOT pre-initialize open_streams: mark_open() itself must transition the guard
            // to open, finish() must immediately revoke it BEFORE Opened is popped, and draining
            // Opened afterwards via stream::opened() must NOT reinstate open_streams or clear outage.
            let guard = Arc::new(client.track_stream(&backend.client_id));
            let state = State::default();
            let sub = Subscriber::new(
                1,
                None,
                Some(GuardHook {
                    http: client.clone(),
                    guard: guard.clone(),
                    count_open_stream: true,
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
            assert_eq!(client.open_streams_counter().load(SeqCst), 1);
            // Queue a pre-EOF frame while Opened is STILL undrained in sub.queue.
            shared.broadcast_frame(
                &hub,
                "message".into(),
                r#"{"type":"memory.changed"}"#.into(),
            );
            // Physical close must immediately drop open_streams to 0, bump drop_generation
            // (needs_capability_recheck), and record the outage BEFORE Opened or Frame drains.
            shared.finish(&hub, false);
            assert_eq!(client.open_streams_counter().load(SeqCst), 0);
            assert!(
                client.needs_capability_recheck(),
                "physical SSE close must revoke attestation immediately even if Opened is still queued"
            );
            assert_eq!(client.transport_drops(&backend.client_id), 1);
            assert!(client.is_in_outage(&backend.client_id));

            // Draining the already-queued Opened through the real stream::opened() helper or
            // retrying try_mark_open() must NOT increment open_streams or clear outage.
            let (out, rx) = bounded(8);
            assert!(matches!(sub.pop(), Some(HubItem::Opened)));
            opened(1, &out, &state).await.unwrap();
            assert!(!guard.try_mark_open(&client, true));
            assert!(matches!(rx.try_recv(), Ok(Input::Opened(1))));
            assert_eq!(
                client.open_streams_counter().load(SeqCst),
                0,
                "draining queued Opened after finish() must never increment open_streams"
            );
            assert!(
                client.is_in_outage(&backend.client_id),
                "draining queued Opened after finish() must never clear outage state"
            );
            assert!(matches!(sub.pop(), Some(HubItem::Frame(_))));
            assert!(matches!(
                sub.pop(),
                Some(HubItem::Closed {
                    auth_expired: false
                })
            ));
            assert!(sub.pop().is_none());
            // Final guard cleanup on read_shared return must not double-count transport_drops.
            guard.close_and_revoke(&client, true, true);
            assert_eq!(client.transport_drops(&backend.client_id), 1);
        },
    );
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

    block_bounded(
        "shared_stream_staleness_and_hanging_pong_close_all_subscribers_and_unregister_probes",
        async {
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
            // Because pump_shared awaits pong_done BEFORE finish(), every probe ID is ALREADY
            // unregistered the moment Closed arrives.
            let ids = captured_ids.lock().unwrap().clone();
            assert!(!ids.is_empty());
            assert!(
                ids.iter()
                    .all(|id| !super::super::staleness::has_probe_id(*id)),
                "all shared-stream and pong probes must already be unregistered when Closed arrives"
            );
            tokio::time::timeout(Duration::from_secs(2), closed_rx.recv())
                .await
                .unwrap()
                .unwrap();
            server.abort();
        },
    );
}

#[test]
fn begin_close_revokes_guards_and_blocks_new_subscribers_before_finish() {
    block_bounded(
        "begin_close_revokes_guards_and_blocks_new_subscribers_before_finish",
        async {
            let hub = Arc::new(Hub::default());
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            let client = backend.client.clone();
            let (gen0, seq0, _) = client.begin_meta_probe();
            assert!(client.observe_capabilities_at(gen0, seq0, true, true));
            assert!(!client.needs_capability_recheck());

            let guard = Arc::new(client.track_stream(&backend.client_id));
            let watch = crate::provider_usage::Watch::default();
            let ingress = crate::provider_usage::Ingress::new(
                watch.clone(),
                Arc::new(|| {}),
                "ws-1".into(),
                "ses-1".into(),
            );
            let sub = Subscriber::new(
                1,
                Some(ingress),
                Some(GuardHook {
                    http: client.clone(),
                    guard: guard.clone(),
                    count_open_stream: true,
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
            hub.streams.lock().unwrap().insert(
                backend.base.clone(),
                StreamEntry {
                    stream: shared.clone(),
                    active: true,
                },
            );
            assert!(shared.mark_open());
            assert_eq!(client.open_streams_counter().load(SeqCst), 1);
            assert!(matches!(sub.pop(), Some(HubItem::Opened)));
            shared.broadcast_frame(
                &hub,
                "message".into(),
                r#"{"type":"memory.changed"}"#.into(),
            );

            // Simulates EOF detected while pong teardown has not resolved yet:
            // begin_close() must immediately deactivate the hub entry and revoke guards/quotas.
            shared.begin_close(&hub);
            assert_eq!(client.open_streams_counter().load(SeqCst), 0);
            assert!(
                client.needs_capability_recheck(),
                "begin_close() must revoke attestation before awaiting pong teardown"
            );
            assert!(!client.supports_atomic_settings_patches());
            assert_eq!(client.transport_drops(&backend.client_id), 1);
            assert!(!watch.current().1);
            assert!(
                !hub.streams.lock().unwrap()[&backend.base].active,
                "closing hub entry must not accept new subscribers while pong teardown runs"
            );
            // Pre-EOF frame is still buffered ahead of Closed until finish() runs.
            assert!(matches!(sub.pop(), Some(HubItem::Frame(_))));
            assert!(sub.pop().is_none());

            shared.finish(&hub, false);
            assert!(matches!(
                sub.pop(),
                Some(HubItem::Closed {
                    auth_expired: false
                })
            ));
            assert!(hub.streams.lock().unwrap().is_empty());
            // finish() must not double-count transport drops already recorded by begin_close().
            assert_eq!(client.transport_drops(&backend.client_id), 1);
        },
    );
}

#[test]
fn hub_upstream_health_evicts_stopped_workspaces_and_recovers_after_overflow() {
    let hub = Arc::new(Hub::default());
    // Creating and stopping more than MAX_TRACKED_LOCATIONS workspaces must never
    // leak upstream_unhealthy or trigger a permanent global lockout.
    for i in 0..(MAX_TRACKED_LOCATIONS + 25) {
        let id = format!("stopped-{i}");
        assert!(matches!(
            classify_frame(
                "message",
                &json!({
                    "type": "workspace.stopped",
                    "workspaceId": id,
                })
                .to_string(),
            ),
            FrameClass::ReplayStopped { error: false, .. }
        ));
        assert!(matches!(
            classify_frame(
                "message",
                &json!({
                    "type": "instance.eventStatus",
                    "instanceId": id,
                    "status": "disconnected",
                    "reason": "workspace stopped",
                })
                .to_string(),
            ),
            FrameClass::ReplayStopped { error: false, .. }
        ));
        hub.note_workspace_upstream_status(&id, false);
        assert!(!hub.workspace_upstream_healthy(&id));
        hub.note_workspace_stopped(&id);
    }
    assert!(
        hub.workspace_upstream_healthy("healthy-ws"),
        "stopped workspaces must be evicted from upstream_unhealthy instead of tripping overflow"
    );

    // Even if more than MAX_TRACKED_LOCATIONS live workspaces simultaneously error and trip
    // overflow_unhealthy, a workspace that receives `connected` must recover immediately while
    // unknown workspaces remain fail-closed.
    for i in 0..(MAX_TRACKED_LOCATIONS + 10) {
        hub.note_workspace_upstream_status(&format!("errored-{i}"), false);
    }
    assert!(!hub.workspace_upstream_healthy("unverified-ws"));
    hub.note_workspace_upstream_status("recovered-ws", true);
    assert!(
        hub.workspace_upstream_healthy("recovered-ws"),
        "connected workspace must remain usable even after upstream_unhealthy overflow"
    );
    hub.note_workspace_upstream_status("recovered-ws", false);
    assert!(!hub.workspace_upstream_healthy("recovered-ws"));
}

#[test]
fn voluntary_detach_revokes_guard_immediately_without_outage_before_pump_exits() {
    block_bounded(
        "voluntary_detach_revokes_guard_immediately_without_outage_before_pump_exits",
        async {
            let hub = Arc::new(Hub::default());
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            let client = backend.client.clone();
            let (gen0, seq0, _) = client.begin_meta_probe();
            assert!(client.observe_capabilities_at(gen0, seq0, true, true));
            assert!(!client.needs_capability_recheck());

            let guard = Arc::new(client.track_stream(&backend.client_id));
            let watch = crate::provider_usage::Watch::default();
            let ingress = crate::provider_usage::Ingress::new(
                watch.clone(),
                Arc::new(|| {}),
                "ws-1".into(),
                "ses-1".into(),
            );
            let sub = Subscriber::new(
                1,
                Some(ingress),
                Some(GuardHook {
                    http: client.clone(),
                    guard: guard.clone(),
                    count_open_stream: true,
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
            hub.streams.lock().unwrap().insert(
                backend.base.clone(),
                StreamEntry {
                    stream: shared.clone(),
                    active: true,
                },
            );
            assert!(shared.mark_open());
            assert_eq!(client.open_streams_counter().load(SeqCst), 1);
            assert!(watch.current().1);

            let mut subscription = Subscription {
                hub: hub.clone(),
                shared: shared.clone(),
                sub,
                closed: false,
            };
            // Voluntary detach while pump has NOT exited yet (done_tx still held):
            // open_streams must immediately drop to 0 and bump drop_generation without outage.
            let done = subscription.detach();
            assert!(done.is_some());
            assert_eq!(client.open_streams_counter().load(SeqCst), 0);
            assert!(
                client.needs_capability_recheck(),
                "last subscriber voluntary detach must immediately bump drop_generation before pump exits"
            );
            assert_eq!(
                client.transport_drops(&backend.client_id),
                0,
                "voluntary detach must not record a transport outage"
            );
            assert!(!watch.current().1);

            // A new stream opening before the old pump exits transitions 0 -> 1 cleanly.
            let next_guard = client.track_stream(&backend.client_id);
            assert!(next_guard.try_mark_open(&client, true));
            assert_eq!(client.open_streams_counter().load(SeqCst), 1);
            // Final cleanup of the detached guard must be a no-op and keep next_guard's count at 1.
            guard.close_and_revoke(&client, true, false);
            assert_eq!(client.open_streams_counter().load(SeqCst), 1);
            drop(next_guard);
            assert_eq!(client.open_streams_counter().load(SeqCst), 0);
        },
    );
}

#[test]
fn overflow_preserves_pending_session_moved_and_signals_placement_and_close() {
    let hub = Arc::new(Hub::default());
    let (stop_tx, _stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let (ev_tx, _ev_rx) = bounded(1);
    let state_queued = State::observing_preferences(ev_tx.clone(), Arc::new(|| {}));
    let state_overflow = State::observing_preferences(ev_tx.clone(), Arc::new(|| {}));
    let state_popped = State::observing_preferences(ev_tx, Arc::new(|| {}));

    let make_sub = |id, session: &str, state: &State| {
        Subscriber::with_signals(
            id,
            None,
            None,
            SubscriberSignals {
                conversation: Some(("ws-1".into(), session.into())),
                closed: Some(state.closed_signal()),
                placement: state.placement_signal(),
                inbox: Some(state.inbox.clone()),
            },
        )
    };
    let queued = make_sub(1, "ses-1", &state_queued);
    let on_overflow = make_sub(2, "ses-2", &state_overflow);
    let already_popped = make_sub(3, "ses-3", &state_popped);
    let shared = Arc::new(SharedStream {
        base: "http://127.0.0.1:1/".into(),
        inner: Mutex::new(StreamInner {
            phase: Phase::Connecting,
            subscribers: vec![queued.clone(), on_overflow.clone(), already_popped.clone()],
            replays: HashMap::new(),
            replays_overflowed: false,
            chunk_active: false,
            stop: Some(stop_tx),
        }),
        done: done_rx,
    });
    hub.streams.lock().unwrap().insert(
        shared.base.clone(),
        StreamEntry {
            stream: shared.clone(),
            active: true,
        },
    );
    assert!(shared.mark_open());
    // Drain Opened on already_popped and deliver its session.moved before later overflow.
    assert!(matches!(already_popped.pop(), Some(HubItem::Opened)));
    let moved_1 = r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.moved","data":{"sessionID":"ses-1"}}}"#;
    let moved_2 = r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.moved","data":{"sessionID":"ses-2"}}}"#;
    let moved_3 = r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.moved","data":{"sessionID":"ses-3"}}}"#;
    shared.broadcast_frame(&hub, "message".into(), moved_3.into());
    assert!(state_popped.is_placement_changed());
    assert!(matches!(already_popped.pop(), Some(HubItem::Frame(f)) if f.1 == moved_3));

    // Queue session.moved for ses-1 while it has not popped yet.
    shared.broadcast_frame(&hub, "message".into(), moved_1.into());
    assert!(state_queued.is_placement_changed());
    assert!(!state_overflow.is_placement_changed());

    // Fill queues to capacity (256 frames): already_popped has 1 frame left to capacity,
    // queued and on_overflow have Opened + 2 frames already -> fill up to MAX_SUBSCRIBER_FRAMES - 1.
    for i in 0..(MAX_SUBSCRIBER_FRAMES - 2) {
        shared.broadcast_frame(
            &hub,
            "message".into(),
            format!("{{\"type\":\"memory.changed\",\"seq\":{i}}}"),
        );
    }
    // Now queued & on_overflow are at MAX_SUBSCRIBER_FRAMES; broadcast moved_2 as the overflowing frame.
    shared.broadcast_frame(&hub, "message".into(), moved_2.into());
    assert!(state_queued.is_stream_closed());
    assert!(state_overflow.is_placement_changed());
    assert!(state_overflow.is_stream_closed());

    // Both queued (earlier session.moved) and on_overflow (overflowing session.moved) retain it before Closed.
    assert!(matches!(queued.pop(), Some(HubItem::Frame(f)) if f.1 == moved_1));
    assert!(matches!(
        queued.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));
    assert!(queued.pop().is_none());

    assert!(matches!(on_overflow.pop(), Some(HubItem::Frame(f)) if f.1 == moved_2));
    assert!(matches!(
        on_overflow.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));
    assert!(on_overflow.pop().is_none());

    // Overflow already_popped as well: already-delivered session.moved is NOT re-emitted.
    for i in 0..4 {
        shared.broadcast_frame(
            &hub,
            "message".into(),
            format!("{{\"type\":\"memory.changed\",\"tail\":{i}}}"),
        );
    }
    assert!(state_popped.is_stream_closed());
    assert!(matches!(
        already_popped.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));
    assert!(already_popped.pop().is_none());
    shared.finish(&hub, false);
}

#[test]
fn begin_close_signals_stream_closed_immediately_behind_queued_frames() {
    let hub = Arc::new(Hub::default());
    let (stop_tx, _stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let state = State::default();
    let sub = Subscriber::with_signals(
        1,
        None,
        None,
        SubscriberSignals {
            conversation: None,
            closed: Some(state.closed_signal()),
            placement: None,
            inbox: Some(state.inbox.clone()),
        },
    );
    let shared = Arc::new(SharedStream {
        base: "http://127.0.0.1:1/".into(),
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
    hub.streams.lock().unwrap().insert(
        shared.base.clone(),
        StreamEntry {
            stream: shared.clone(),
            active: true,
        },
    );
    assert!(shared.mark_open());
    shared.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"memory.changed","seq":1}"#.into(),
    );
    assert!(!state.is_stream_closed());

    // Physical EOF signals stream_closed immediately even while pre-EOF items remain queued.
    shared.begin_close(&hub);
    assert!(state.is_stream_closed());
    shared.finish(&hub, false);

    assert!(matches!(sub.pop(), Some(HubItem::Opened)));
    assert!(matches!(sub.pop(), Some(HubItem::Frame(_))));
    assert!(matches!(
        sub.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));

    // finish() without a prior begin_close() must also signal stream_closed immediately.
    let state2 = State::default();
    let sub2 = Subscriber::with_signals(
        2,
        None,
        None,
        SubscriberSignals {
            conversation: None,
            closed: Some(state2.closed_signal()),
            placement: None,
            inbox: Some(state2.inbox.clone()),
        },
    );
    let (stop_tx2, _stop_rx2) = bounded(1);
    let (_done_tx2, done_rx2) = bounded(1);
    let shared2 = Arc::new(SharedStream {
        base: "http://127.0.0.1:2/".into(),
        inner: Mutex::new(StreamInner {
            phase: Phase::Connecting,
            subscribers: vec![sub2.clone()],
            replays: HashMap::new(),
            replays_overflowed: false,
            chunk_active: false,
            stop: Some(stop_tx2),
        }),
        done: done_rx2,
    });
    hub.streams.lock().unwrap().insert(
        shared2.base.clone(),
        StreamEntry {
            stream: shared2.clone(),
            active: true,
        },
    );
    assert!(shared2.mark_open());
    shared2.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"memory.changed","seq":2}"#.into(),
    );
    assert!(!state2.is_stream_closed());
    shared2.finish(&hub, false);
    assert!(state2.is_stream_closed());
    assert!(matches!(sub2.pop(), Some(HubItem::Opened)));
    assert!(matches!(sub2.pop(), Some(HubItem::Frame(_))));
    assert!(matches!(
        sub2.pop(),
        Some(HubItem::Closed {
            auth_expired: false
        })
    ));
}

#[test]
fn chunk_guard_defers_inbox_fence_until_chunk_classification_finishes() {
    use crate::inbox::FenceState;

    let hub = Arc::new(Hub::default());
    let (stop_tx, _stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let (ev_tx, _ev_rx) = bounded(4);
    let wakes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let wake_count = wakes.clone();
    let state = State::observing_preferences(
        ev_tx,
        Arc::new(move || {
            wake_count.fetch_add(1, SeqCst);
        }),
    );
    let sub = Subscriber::with_signals(
        1,
        None,
        None,
        SubscriberSignals {
            conversation: Some(("ws-1".into(), "ses-1".into())),
            closed: Some(state.closed_signal()),
            placement: state.placement_signal(),
            inbox: Some(state.inbox.clone()),
        },
    );
    let shared = Arc::new(SharedStream {
        base: "http://127.0.0.1:3/".into(),
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

    // Chunk 1: unrelated text frame followed by inbox cancellation in the same HTTP chunk.
    let fence1 = state.inbox.fence(state.inbox.capture(), 0);
    let chunk1 = shared.begin_chunk();
    shared.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.text.delta","data":{"sessionID":"ses-1","delta":"hi"}}}"#.into(),
    );
    assert_eq!(
        fence1.check(),
        FenceState::Deferred,
        "snapshot must be held while the received chunk is still being parsed"
    );
    shared.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.inbox.cancelled","data":{"sessionID":"ses-1","inboxID":"q1"}}}"#.into(),
    );
    assert_eq!(
        fence1.check(),
        FenceState::Invalid,
        "cancellation in second frame of chunk must invalidate the fence immediately"
    );
    chunk1.finish();
    assert_eq!(
        wakes.load(SeqCst),
        1,
        "finishing a chunk with a waiting inbox publication must wake the UI"
    );

    // Chunk 2: unrelated frame only -> Deferred during chunk, then Valid after chunk finishes.
    let mark = state.inbox.ingress();
    state.inbox.advance_applied(mark);
    let fence2 = state.inbox.fence(state.inbox.capture(), 0);
    let chunk2 = shared.begin_chunk();
    assert_eq!(fence2.check(), FenceState::Deferred);
    shared.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.text.delta","data":{"sessionID":"ses-1","delta":"ok"}}}"#.into(),
    );
    assert_eq!(fence2.check(), FenceState::Deferred);
    chunk2.finish();
    assert_eq!(wakes.load(SeqCst), 2);
    assert_eq!(fence2.check(), FenceState::Valid);
}

#[test]
fn seed_opened_numbers_replayed_status_monotonically_before_live_inbox_frames() {
    let hub = Arc::new(Hub::default());
    let (stop_tx, _stop_rx) = bounded(1);
    let (_done_tx, done_rx) = bounded(1);
    let replay_status = Arc::new((
        "message".to_owned(),
        r#"{"type":"instance.eventStatus","instanceId":"ws-1","status":"connected"}"#.to_owned(),
    ));
    let state = State::default();
    let sub = Subscriber::with_signals(
        1,
        None,
        None,
        SubscriberSignals {
            conversation: Some(("ws-1".into(), "ses-1".into())),
            inbox: Some(state.inbox.clone()),
            ..SubscriberSignals::default()
        },
    );
    let shared = Arc::new(SharedStream {
        base: "http://127.0.0.1:4/".into(),
        inner: Mutex::new(StreamInner {
            phase: Phase::Open,
            subscribers: vec![sub.clone()],
            replays: HashMap::from([("ws-1".to_owned(), replay_status.clone())]),
            replays_overflowed: false,
            chunk_active: false,
            stop: Some(stop_tx),
        }),
        done: done_rx,
    });
    assert!(!sub.seed_opened(&[replay_status], false));
    shared.broadcast_frame(
        &hub,
        "message".into(),
        r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.inbox.enqueued","data":{"sessionID":"ses-1","item":{"id":"q1","delivery":"queue","text":"hi"}}}}"#.into(),
    );
    let (first, mark_opened) = sub.pop_marked().unwrap();
    assert!(matches!(first, HubItem::Opened));
    assert_eq!(mark_opened, 0);
    let (_, mark_replay) = sub.pop_marked().unwrap();
    let (_, mark_live) = sub.pop_marked().unwrap();
    assert!(
        mark_replay > 0 && mark_live > mark_replay,
        "replayed status ({mark_replay}) must be numbered strictly before subsequent live inbox frame ({mark_live})"
    );
    state.inbox.advance_applied(mark_replay);
    assert!(
        !state.inbox.applied_caught_up(),
        "applying replayed status must not skip past later buffered live inbox frame"
    );
    state.inbox.advance_applied(mark_live);
    assert!(state.inbox.applied_caught_up());
}

#[test]
fn read_shared_delivers_session_moved_before_closed_after_overflow() {
    block_bounded(
        "read_shared_delivers_session_moved_before_closed_after_overflow",
        async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses-1".into();
            let hub = backend.client.sse_hub();
            let (stop_tx, _stop_rx) = bounded(1);
            let (_done_tx, done_rx) = bounded(1);
            let anchor = Subscriber::new(u64::MAX, None, None);
            let shared = Arc::new(SharedStream {
                base: backend.base.clone(),
                inner: Mutex::new(StreamInner {
                    phase: Phase::Connecting,
                    subscribers: vec![anchor.clone()],
                    replays: HashMap::new(),
                    replays_overflowed: false,
                    chunk_active: false,
                    stop: Some(stop_tx),
                }),
                done: done_rx,
            });
            hub.streams.lock().unwrap().insert(
                backend.base.clone(),
                StreamEntry {
                    stream: shared.clone(),
                    active: true,
                },
            );
            assert!(shared.mark_open());
            assert!(matches!(anchor.pop(), Some(HubItem::Opened)));

            let (ev_tx, _ev_rx) = bounded(8);
            let state = Arc::new(State::observing_preferences(ev_tx, Arc::new(|| {})));
            // Capacity 1 lets the first Opened sit in `out` while we overflow the hub queue.
            let (out, inbox) = bounded(1);
            crate::stream::start(backend.clone(), 1, out, state.clone());

            // Wait until the subscriber attaches and fills `out` (capacity 1) with Input::Opened(1).
            while inbox.is_empty() {
                tokio::task::yield_now().await;
            }
            // Push a filler frame, then session.moved, then overflow synchronously so session.moved
            // is guaranteed to sit unpopped in the hub queue when close_overflow() runs.
            shared.broadcast_frame(
                hub,
                "message".into(),
                r#"{"type":"memory.changed","seq":0}"#.into(),
            );
            assert!(matches!(anchor.pop(), Some(HubItem::Frame(_))));
            let moved = r#"{"type":"instance.event","instanceId":"ws-1","event":{"type":"session.moved","data":{"sessionID":"ses-1"}}}"#;
            shared.broadcast_frame(hub, "message".into(), moved.into());
            assert!(matches!(anchor.pop(), Some(HubItem::Frame(_))));
            for i in 1..=MAX_SUBSCRIBER_FRAMES {
                shared.broadcast_frame(
                    hub,
                    "message".into(),
                    format!("{{\"type\":\"memory.changed\",\"seq\":{i}}}"),
                );
                assert!(matches!(anchor.pop(), Some(HubItem::Frame(_))));
            }
            assert!(state.is_placement_changed());
            assert!(state.is_stream_closed());

            // Drain inbox: must observe Input::Native(1, _, session.moved) before Input::Closed(1).
            let mut saw_moved = false;
            let mut saw_closed = false;
            while let Ok(item) = inbox.recv().await {
                match item {
                    Input::Native(1, _, _, native) if native["type"] == "session.moved" => {
                        assert!(
                            !saw_closed,
                            "session.moved must arrive before Input::Closed"
                        );
                        saw_moved = true;
                    }
                    Input::Closed(1) => {
                        saw_closed = true;
                        break;
                    }
                    _ => {}
                }
            }
            assert!(saw_moved, "preserved session.moved must be delivered");
            assert!(
                saw_closed,
                "Input::Closed must follow preserved session.moved"
            );
            state.wait_stopped().await;
            shared.finish(hub, false);
        },
    );
}

#[test]
fn hub_location_state_reads_revision_and_health_atomically() {
    let hub = Hub::default();
    let (rev0, healthy0) = hub.location_state("ws-a", Some("ses-1"));
    assert_eq!(rev0, 0);
    assert!(healthy0);

    hub.note_session_location_change("ws-a", "ses-1");
    let (rev1, healthy1) = hub.location_state("ws-a", Some("ses-1"));
    assert_eq!(rev1, 1);
    assert!(healthy1);
    assert_eq!(hub.location_revision("ws-a", Some("ses-1")), rev1);
    assert_eq!(hub.workspace_upstream_healthy("ws-a"), healthy1);

    hub.note_workspace_upstream_status("ws-a", false);
    let (rev2, healthy2) = hub.location_state("ws-a", Some("ses-1"));
    assert_eq!(rev2, 2);
    assert!(!healthy2);

    hub.note_workspace_upstream_status("ws-a", true);
    let (rev3, healthy3) = hub.location_state("ws-a", Some("ses-1"));
    assert_eq!(rev3, 3);
    assert!(healthy3);
}
