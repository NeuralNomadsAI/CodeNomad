use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;

fn spawn_sse_server(bodies: Vec<&str>) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
    let address = listener
        .local_addr()
        .expect("test server should have an address");
    let (request_tx, request_rx) = mpsc::channel();
    let bodies: Vec<String> = bodies.into_iter().map(str::to_string).collect();
    let handle = thread::spawn(move || {
        for body in bodies {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).expect("request should read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            request_tx
                .send(String::from_utf8_lossy(&request).into_owned())
                .expect("request should be observed");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response should write");
        }
    });
    (format!("http://{address}/api/events"), request_rx, handle)
}

fn read_test_stream(response: Response) -> Vec<ReaderMessage> {
    let (tx, rx) = mpsc::sync_channel(64);
    read_sse(
        response,
        tx,
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicU64::new(1)),
        1,
    );
    rx.into_iter().collect()
}

fn cursor(messages: &[ReaderMessage]) -> Option<String> {
    messages.iter().find_map(|message| match message {
        ReaderMessage::Cursor(id) => Some(id.clone()),
        ReaderMessage::Event { id, .. } | ReaderMessage::ReplayReset { id, .. } => id.clone(),
        _ => None,
    })
}

fn fresh_stats() -> DesktopEventTransportStats {
    DesktopEventTransportStats::default()
}

#[test]
fn reconnect_requests_and_parses_a_missed_event() {
    let (url, requests, server) = spawn_sse_server(vec![
        "id: epoch-a:1\ndata: {\"type\":\"workspace.log\",\"entry\":{\"sequence\":1}}\n\n",
        "id: epoch-a:2\ndata: {\"type\":\"workspace.log\",\"entry\":{\"sequence\":2}}\n\n",
    ]);
    let client = Client::new();

    let first = attach_last_event_id(client.get(&url), None)
        .send()
        .expect("first stream should open");
    let first_messages = read_test_stream(first);
    let last_event_id = cursor(&first_messages).expect("first stream should provide a cursor");
    let second = attach_last_event_id(client.get(&url), Some(&last_event_id))
        .send()
        .expect("reconnect should open");
    let second_messages = read_test_stream(second);

    let first_request = requests.recv().expect("first request should be captured");
    let second_request = requests.recv().expect("second request should be captured");
    assert!(!first_request
        .to_ascii_lowercase()
        .contains("last-event-id:"));
    assert!(second_request
        .to_ascii_lowercase()
        .contains("last-event-id: epoch-a:1"));
    assert!(second_messages.iter().any(|message| matches!(
        message,
        ReaderMessage::Event { event, .. }
            if event["entry"]["sequence"].as_u64() == Some(2)
    )));
    server.join().expect("test server should stop");
}

#[test]
fn reconnect_parses_overflow_reset_and_advances_cursor() {
    let (url, requests, server) = spawn_sse_server(vec![
        "event: codenomad.replay.cursor\nid: epoch-a:1\ndata: {}\n\n",
        "event: codenomad.replay.reset\nid: epoch-a:5\ndata: {}\n\n",
    ]);
    let client = Client::new();

    let first = attach_last_event_id(client.get(&url), None)
        .send()
        .expect("first stream should open");
    let last_event_id = cursor(&read_test_stream(first)).expect("cursor should be parsed");
    let second = attach_last_event_id(client.get(&url), Some(&last_event_id))
        .send()
        .expect("reconnect should open");
    let second_messages = read_test_stream(second);

    let _ = requests.recv().expect("first request should be captured");
    let second_request = requests.recv().expect("second request should be captured");
    assert!(second_request
        .to_ascii_lowercase()
        .contains("last-event-id: epoch-a:1"));
    assert_eq!(cursor(&second_messages).as_deref(), Some("epoch-a:5"));
    assert!(second_messages
        .iter()
        .any(|message| matches!(message, ReaderMessage::ReplayReset { .. })));
    server.join().expect("test server should stop");
}

#[test]
fn truncated_and_invalid_frames_do_not_advance_the_cursor() {
    let (url, _requests, server) = spawn_sse_server(vec![
        "id: epoch-a:1\ndata: {\"type\":\"workspace.log\"}",
        "id: epoch-a:2\ndata: not-json\n\n",
    ]);
    let client = Client::new();

    for _ in 0..2 {
        let response = client.get(&url).send().expect("stream should open");
        assert_eq!(cursor(&read_test_stream(response)), None);
    }

    server.join().expect("test server should stop");
}

#[test]
fn stale_transport_lease_cannot_stop_its_replacement() {
    let manager = DesktopEventTransportManager::new();
    let stop = Arc::new(AtomicBool::new(false));
    manager.lease.store(2, Ordering::SeqCst);
    manager.state.lock().stop = Some(stop.clone());

    manager.stop_lease(1);
    assert!(!stop.load(Ordering::SeqCst));
    assert!(manager.state.lock().stop.is_some());

    manager.stop_lease(2);
    assert!(stop.load(Ordering::SeqCst));
    assert!(manager.state.lock().stop.is_none());
}

#[test]
fn reused_port_fences_stale_sse_and_does_not_reuse_its_cookie() {
    let manager = Arc::new(DesktopEventTransportManager::new());
    let endpoint_authority = Arc::new(AtomicU64::new(1));
    let stale_stream = DesktopEventStreamConfig {
        base_url: "http://127.0.0.1:43123".to_string(),
        events_url: "http://127.0.0.1:43123/api/events".to_string(),
        client_id: "tauri-test".to_string(),
        connection_id: "stale".to_string(),
        cookie_name: "cookie-old".to_string(),
        session_cookie: Some("session-old".to_string()),
        authority_generation: 1,
        authority: endpoint_authority.clone(),
    };
    let stale_stop = Arc::new(AtomicBool::new(false));
    manager.generation.store(1, Ordering::SeqCst);
    {
        let mut state = manager.state.lock();
        state.stop = Some(stale_stop.clone());
        state.config = Some(DesktopEventTransportConfig::new(
            stale_stream.clone(),
            &DesktopEventsStartRequest::default(),
        ));
    }
    *manager.last_event_id.lock() = Some("old-process:7".to_string());

    let operation = manager.operation_fence.lock();
    endpoint_authority.store(2, Ordering::SeqCst);
    let revoking = manager.clone();
    let revoked = thread::spawn(move || revoking.revoke_endpoint());
    while !stale_stop.load(Ordering::SeqCst) {
        thread::yield_now();
    }
    assert!(!generation_matches(&manager.generation, 1));
    assert!(!revoked.is_finished());
    drop(operation);
    revoked.join().expect("revocation should finish");

    assert!(manager.state.lock().config.is_none());
    assert!(manager.last_event_id.lock().is_none());
    assert!(!stale_stream.is_authorized());
    let stale_operation_ran = AtomicBool::new(false);
    assert!(
        with_current_transport(&manager.operation_fence, &manager.generation, 1, || {
            stale_operation_ran.store(true, Ordering::SeqCst)
        },)
        .is_none()
    );
    assert!(!stale_operation_ran.load(Ordering::SeqCst));

    let fresh_stream = DesktopEventStreamConfig {
        connection_id: "fresh".to_string(),
        cookie_name: "cookie-new".to_string(),
        session_cookie: Some("session-new".to_string()),
        authority_generation: 2,
        ..stale_stream
    };
    assert!(fresh_stream.is_authorized());
    assert_eq!(fresh_stream.events_url, "http://127.0.0.1:43123/api/events");
    assert_eq!(fresh_stream.session_cookie.as_deref(), Some("session-new"));
}

fn delta_event(delta: &str) -> Value {
    json!({
        "type": "instance.event",
        "instanceId": "inst-1",
        "event": {
            "type": "message.part.delta",
            "properties": {
                "sessionID": "sess-1",
                "messageID": "msg-1",
                "partID": "part-1",
                "field": "text",
                "delta": delta,
            }
        }
    })
}

fn delta_event_for(part_id: &str, delta: &str) -> Value {
    json!({
        "type": "instance.event",
        "instanceId": "inst-1",
        "event": {
            "type": "message.part.delta",
            "properties": {
                "sessionID": "sess-1",
                "messageID": "msg-1",
                "partID": part_id,
                "field": "text",
                "delta": delta,
            }
        }
    })
}

fn direct_delta_event(delta: &str) -> Value {
    json!({
        "type": "message.part.delta",
        "properties": {
            "sessionID": "sess-1",
            "messageID": "msg-1",
            "partID": "part-1",
            "field": "text",
            "delta": delta,
        }
    })
}

fn direct_message_part_updated_event(text: &str) -> Value {
    json!({
        "type": "message.part.updated",
        "properties": {
            "part": {
                "id": "part-1",
                "type": "text",
                "text": text,
                "sessionID": "sess-1",
                "messageID": "msg-1"
            }
        }
    })
}

fn message_part_updated_event(text: &str) -> Value {
    json!({
        "type": "instance.event",
        "instanceId": "inst-1",
        "event": {
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "id": "part-1",
                    "type": "text",
                    "text": text,
                    "sessionID": "sess-1",
                    "messageID": "msg-1"
                }
            }
        }
    })
}

#[test]
fn coalesces_message_part_delta_events() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(delta_event("Hello"), &mut stats);
    pending.push(delta_event(" world"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["event"]["properties"]["delta"].as_str(),
        Some("Hello world")
    );
}

#[test]
fn last_write_wins_for_status_events() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(
        json!({
            "type": "instance.eventStatus",
            "instanceId": "inst-1",
            "status": "connecting"
        }),
        &mut stats,
    );
    pending.push(
        json!({
            "type": "instance.eventStatus",
            "instanceId": "inst-1",
            "status": "connected"
        }),
        &mut stats,
    );

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["status"].as_str(), Some("connected"));
}

#[test]
fn last_write_wins_for_consecutive_snapshot_events() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(message_part_updated_event("Hello"), &mut stats);
    pending.push(message_part_updated_event("Hello world"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["event"]["properties"]["part"]["text"].as_str(),
        Some("Hello world")
    );
}

#[test]
fn interleaved_snapshot_keys_keep_order() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(message_part_updated_event("A1"), &mut stats);
    pending.push(
        json!({
            "type": "instance.event",
            "instanceId": "inst-1",
            "event": {
                "type": "message.part.updated",
                "properties": {
                    "part": {
                        "id": "part-2",
                        "type": "text",
                        "text": "B1",
                        "sessionID": "sess-1",
                        "messageID": "msg-1"
                    }
                }
            }
        }),
        &mut stats,
    );
    pending.push(message_part_updated_event("A2"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0]["event"]["properties"]["part"]["id"].as_str(),
        Some("part-1")
    );
    assert_eq!(
        events[1]["event"]["properties"]["part"]["id"].as_str(),
        Some("part-2")
    );
    assert_eq!(
        events[2]["event"]["properties"]["part"]["text"].as_str(),
        Some("A2")
    );
}

#[test]
fn snapshot_replaces_trailing_deltas_for_same_part() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(delta_event("Hello"), &mut stats);
    pending.push(message_part_updated_event("Hello world"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["event"]["type"].as_str(),
        Some("message.part.updated")
    );
    assert_eq!(
        events[0]["event"]["properties"]["part"]["text"].as_str(),
        Some("Hello world")
    );
}

#[test]
fn structural_events_force_coalesced_flush_before_append() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(delta_event("Hello"), &mut stats);
    pending.push(
        json!({
            "type": "instance.event",
            "instanceId": "inst-1",
            "event": {
                "type": "message.updated",
                "properties": {
                    "id": "msg-1"
                }
            }
        }),
        &mut stats,
    );

    let events = pending.take_events();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["event"]["type"].as_str(),
        Some("message.part.delta")
    );
    assert_eq!(events[1]["event"]["type"].as_str(), Some("message.updated"));
}

#[test]
fn interleaved_delta_keys_keep_order() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(delta_event_for("part-1", "A1"), &mut stats);
    pending.push(delta_event_for("part-2", "B1"), &mut stats);
    pending.push(delta_event_for("part-1", "A2"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0]["event"]["properties"]["partID"].as_str(),
        Some("part-1")
    );
    assert_eq!(
        events[0]["event"]["properties"]["delta"].as_str(),
        Some("A1")
    );
    assert_eq!(
        events[1]["event"]["properties"]["partID"].as_str(),
        Some("part-2")
    );
    assert_eq!(
        events[1]["event"]["properties"]["delta"].as_str(),
        Some("B1")
    );
    assert_eq!(
        events[2]["event"]["properties"]["partID"].as_str(),
        Some("part-1")
    );
    assert_eq!(
        events[2]["event"]["properties"]["delta"].as_str(),
        Some("A2")
    );
}

#[test]
fn reconnect_delay_grows_and_caps() {
    let policy = ResolvedDesktopEventReconnectPolicy {
        initial_delay_ms: 100,
        max_delay_ms: 500,
        multiplier: 2.0,
        max_attempts: None,
    };

    assert_eq!(compute_reconnect_delay_ms(1, &policy), 100);
    assert_eq!(compute_reconnect_delay_ms(2, &policy), 200);
    assert_eq!(compute_reconnect_delay_ms(3, &policy), 400);
    assert_eq!(compute_reconnect_delay_ms(4, &policy), 500);
}

#[test]
fn holds_single_delta_within_stream_window() {
    let pending = PendingBatch {
        events: vec![PendingEntry::Delta {
            key: "delta-key".to_string(),
            scope: "delta-scope".to_string(),
            event: delta_event("Hello"),
            started_at: Instant::now(),
        }],
        last_event_id: None,
    };

    assert!(pending.should_hold_single_delta(Instant::now()));
}

#[test]
fn flushes_single_delta_after_stream_window() {
    let started_at = Instant::now() - Duration::from_millis(DELTA_STREAM_WINDOW_MS + 1);
    let pending = PendingBatch {
        events: vec![PendingEntry::Delta {
            key: "delta-key".to_string(),
            scope: "delta-scope".to_string(),
            event: delta_event("Hello"),
            started_at,
        }],
        last_event_id: None,
    };

    assert!(!pending.should_hold_single_delta(Instant::now()));
    assert!(pending.single_delta_window_elapsed(Instant::now()));
}

#[test]
fn coalesces_direct_message_part_delta_events() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(direct_delta_event("Hello"), &mut stats);
    pending.push(direct_delta_event(" world"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["properties"]["delta"].as_str(),
        Some("Hello world")
    );
}

#[test]
fn direct_snapshot_replaces_trailing_direct_deltas_for_same_part() {
    let mut pending = PendingBatch::default();
    let mut stats = fresh_stats();
    pending.push(direct_delta_event("Hello"), &mut stats);
    pending.push(direct_message_part_updated_event("Hello world"), &mut stats);

    let events = pending.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"].as_str(), Some("message.part.updated"));
    assert_eq!(
        events[0]["properties"]["part"]["text"].as_str(),
        Some("Hello world")
    );
}
