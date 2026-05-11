use super::*;
use serde_json::json;

fn fresh_stats() -> DesktopEventTransportStats {
    DesktopEventTransportStats::default()
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

fn active_target() -> ActiveSessionTarget {
    ActiveSessionTarget {
        instance_id: "inst-1".to_string(),
        session_id: "sess-1".to_string(),
    }
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
            instance_id: "inst-1".to_string(),
            session_id: Some("sess-1".to_string()),
            event: delta_event("Hello"),
            started_at: Instant::now(),
        }],
    };

    assert!(pending.should_hold_single_delta(Instant::now(), None));
}

#[test]
fn flushes_single_delta_after_stream_window() {
    let started_at = Instant::now() - Duration::from_millis(DELTA_STREAM_WINDOW_MS + 1);
    let pending = PendingBatch {
        events: vec![PendingEntry::Delta {
            key: "delta-key".to_string(),
            scope: "delta-scope".to_string(),
            instance_id: "inst-1".to_string(),
            session_id: Some("sess-1".to_string()),
            event: delta_event("Hello"),
            started_at,
        }],
    };

    assert!(!pending.should_hold_single_delta(Instant::now(), None));
}

#[test]
fn active_session_uses_shorter_hold_window() {
    // Delta aged past the active-stream window but within the base window.
    // Active session should flush faster, so this should NOT be held.
    let started_at = Instant::now() - Duration::from_millis(ACTIVE_STREAM_HOLD_WINDOW_MS + 10);
    let pending = PendingBatch {
        events: vec![PendingEntry::Delta {
            key: "delta-key".to_string(),
            scope: "delta-scope".to_string(),
            instance_id: "inst-1".to_string(),
            session_id: Some("sess-1".to_string()),
            event: delta_event("Hello"),
            started_at,
        }],
    };

    let active_target = active_target();
    let other_target = ActiveSessionTarget {
        instance_id: "inst-1".to_string(),
        session_id: "sess-2".to_string(),
    };

    // Active session: uses ACTIVE_STREAM_HOLD_WINDOW_MS, so this stale delta is not held.
    assert!(!pending.should_hold_single_delta(Instant::now(), Some(&active_target)));
    // Non-matching session: still uses the wider base window.
    assert!(pending.should_hold_single_delta(Instant::now(), Some(&other_target)));
}

#[test]
fn active_session_holds_fresh_delta() {
    // A very fresh delta should be held even for the active session's shorter window.
    let started_at = Instant::now() - Duration::from_millis(5);
    let pending = PendingBatch {
        events: vec![PendingEntry::Delta {
            key: "delta-key".to_string(),
            scope: "delta-scope".to_string(),
            instance_id: "inst-1".to_string(),
            session_id: Some("sess-1".to_string()),
            event: delta_event("Hello"),
            started_at,
        }],
    };

    let active_target = active_target();

    assert!(pending.should_hold_single_delta(Instant::now(), Some(&active_target)));
}

#[test]
fn assembler_emits_first_preview_chunk_immediately() {
    let mut assembler = ActiveTextAssembler::default();
    let now = Instant::now();

    let emitted = assembler.absorb(
        ActiveTextDelta {
            instance_id: "inst-1".to_string(),
            session_id: "sess-1".to_string(),
            message_id: "msg-1".to_string(),
            part_id: "part-1".to_string(),
            delta: "Hello".to_string(),
        },
        now,
    );

    assert_eq!(emitted.len(), 1);
    assert_eq!(
        coalesced_payload_event(&emitted[0])
            .get("type")
            .and_then(Value::as_str),
        Some("assistant.stream.chunk")
    );
    assert_eq!(
        coalesced_payload_event(&emitted[0])
            .get("properties")
            .and_then(|props| props.get("delta"))
            .and_then(Value::as_str),
        Some("Hello")
    );
}

#[test]
fn snapshot_buffer_coalesces_updates_within_window() {
    let mut buffer = ActiveTextSnapshotBuffer::default();
    let now = Instant::now();

    buffer.buffer(
        parse_active_text_snapshot(&message_part_updated_event("A"), Some(&active_target()))
            .unwrap(),
        now,
    );
    buffer.buffer(
        parse_active_text_snapshot(&message_part_updated_event("AB"), Some(&active_target()))
            .unwrap(),
        now + Duration::from_millis(40),
    );
    buffer.buffer(
        parse_active_text_snapshot(&message_part_updated_event("ABC"), Some(&active_target()))
            .unwrap(),
        now + Duration::from_millis(80),
    );

    let early = buffer.take_due(now + Duration::from_millis(ACTIVE_STREAM_SNAPSHOT_WINDOW_MS - 1));
    assert!(early.is_empty());

    let emitted =
        buffer.take_due(now + Duration::from_millis(ACTIVE_STREAM_SNAPSHOT_WINDOW_MS + 1));
    assert_eq!(emitted.len(), 1);
    assert_eq!(
        emitted[0]["event"]["properties"]["part"]["text"].as_str(),
        Some("ABC")
    );
}

#[test]
fn snapshot_buffer_flushes_latest_snapshot_before_message_update() {
    let mut buffer = ActiveTextSnapshotBuffer::default();
    let now = Instant::now();

    buffer.buffer(
        parse_active_text_snapshot(&message_part_updated_event("Hello"), Some(&active_target()))
            .unwrap(),
        now,
    );
    buffer.buffer(
        parse_active_text_snapshot(
            &message_part_updated_event("Hello world"),
            Some(&active_target()),
        )
        .unwrap(),
        now + Duration::from_millis(25),
    );

    let flushed = buffer.flush_for_event(&json!({
        "type": "instance.event",
        "instanceId": "inst-1",
        "event": {
            "type": "message.updated",
            "properties": {
                "info": {
                    "id": "msg-1",
                    "sessionID": "sess-1"
                }
            }
        }
    }));

    assert_eq!(flushed.len(), 1);
    assert_eq!(
        flushed[0]["event"]["properties"]["part"]["text"].as_str(),
        Some("Hello world")
    );
}

#[test]
fn assembler_keeps_first_delta_after_full_flush() {
    let mut assembler = ActiveTextAssembler::default();
    let now = Instant::now();
    let delta = ActiveTextDelta {
        instance_id: "inst-1".to_string(),
        session_id: "sess-1".to_string(),
        message_id: "msg-1".to_string(),
        part_id: "part-1".to_string(),
        delta: "Hello".to_string(),
    };

    let _ = assembler.absorb(delta.clone(), now);
    let _ = assembler.flush_message("inst-1", "sess-1", "msg-1", now);
    let _ = assembler.absorb(
        ActiveTextDelta {
            delta: " world".to_string(),
            ..delta
        },
        now,
    );
    let emitted = assembler.flush_store_only_all(now + Duration::from_millis(1));

    assert!(emitted.iter().any(|event| {
        coalesced_payload_event(event)
            .get("type")
            .and_then(Value::as_str)
            == Some("message.part.delta")
            && coalesced_payload_event(event)
                .get("properties")
                .and_then(|props| props.get("delta"))
                .and_then(Value::as_str)
                == Some(" world")
    }));
}

#[test]
fn flush_store_only_all_preserves_canonical_text_without_preview() {
    let mut assembler = ActiveTextAssembler::default();
    let now = Instant::now();
    let _ = assembler.absorb(
        ActiveTextDelta {
            instance_id: "inst-1".to_string(),
            session_id: "sess-1".to_string(),
            message_id: "msg-1".to_string(),
            part_id: "part-1".to_string(),
            delta: "Hello".to_string(),
        },
        now,
    );

    let emitted = assembler.flush_store_only_all(now + Duration::from_millis(1));
    assert_eq!(emitted.len(), 1);
    assert_eq!(
        coalesced_payload_event(&emitted[0])
            .get("type")
            .and_then(Value::as_str),
        Some("message.part.delta")
    );
    assert_eq!(
        coalesced_payload_event(&emitted[0])
            .get("properties")
            .and_then(|props| props.get("delta"))
            .and_then(Value::as_str),
        Some("Hello")
    );
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
