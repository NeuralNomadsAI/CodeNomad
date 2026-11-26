//! Deterministic loopback tests for session inbox contract and authoritative row ordering.
use crate::{
    Message,
    backend::Backend,
    bounded,
    history::{self, Row},
    inbox::{self, InboxUnavailable, QueuedPrompt},
    prompt::Delivery,
    recovery::{self, ReadingLane, demand},
    transport::{Command, Event, HistoryEdge},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    thread,
    time::Duration,
};

fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test)
}

fn row(id: &str) -> Row {
    Arc::new(Message {
        id: id.into(),
        role: "user".into(),
        completed: true,
        body: id.into(),
        usage: None,
        parts: vec![],
    })
}

#[test]
fn inbox_decoder_validates_items_and_order_consistency_detects_displaced_rows() {
    let payload = json!({
        "data": [
            {
                "id": "q1",
                "type": "user",
                "delivery": "queue",
                "time": { "created": 10 },
                "payload": {
                    "text": "raw prompt",
                    "metadata": { "displayText": "Display prompt" },
                    "skills": [{ "id": "sk_1", "name": "review" }],
                    "files": [{
                        "name": "note.txt",
                        "mime": "text/plain",
                        "source": { "type": "uri", "uri": "file:///tmp/note.txt" }
                    }]
                }
            },
            {
                "id": "syn1",
                "type": "synthetic",
                "delivery": "queue",
                "payload": { "text": "ignored synthetic" }
            },
            {
                "id": "q2",
                "type": "user",
                "delivery": "steer",
                "payload": { "text": "steer me" }
            }
        ]
    });
    let items = inbox::decode_list(&payload).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].id, "q1");
    assert_eq!(items[0].delivery, Delivery::Queue);
    assert_eq!(items[0].text, "Display prompt");
    assert_eq!(items[0].parts.len(), 2);
    assert_eq!(items[0].created, Some(10));
    assert_eq!(items[1].id, "q2");
    assert_eq!(items[1].delivery, Delivery::Steer);
    assert_eq!(items[1].text, "steer me");

    // Duplicate IDs and invalid delivery fail closed.
    assert!(
        inbox::decode_list(&json!({
            "data": [
                { "id": "dup", "type": "user", "delivery": "queue", "payload": { "text": "a" } },
                { "id": "dup", "type": "user", "delivery": "steer", "payload": { "text": "b" } }
            ]
        }))
        .is_err()
    );
    assert!(
        inbox::decode_list(&json!({
            "data": [
                { "id": "bad", "type": "user", "delivery": "urgent", "payload": { "text": "a" } }
            ]
        }))
        .is_err()
    );

    // Order consistency accepts insertions/subsets and rejects swapped shared rows.
    assert!(history::order_consistent(
        &[row("u1"), row("a1"), row("u2")],
        &[row("u0"), row("u1"), row("a1"), row("a2"), row("u2")],
    ));
    assert!(!history::order_consistent(
        &[row("u1"), row("u2"), row("a1")],
        &[row("u1"), row("a1"), row("u2")],
    ));
}

#[derive(Clone)]
struct FixtureState {
    rows: Vec<Value>,
    inbox: Vec<Value>,
    inbox_status: u16,
    patch_status: u16,
    delete_status: u16,
    running: bool,
    page_calls: usize,
    inbox_calls: usize,
    mutations: Vec<(String, String, Value)>,
    sse_queue: VecDeque<String>,
    drop_sse: bool,
    sse_connections: usize,
    older_cursor: Option<Value>,
    newer_cursor: Option<Value>,
    hold_inbox: Option<(Arc<AtomicBool>, Arc<AtomicBool>)>,
}

impl FixtureState {
    fn new(rows: Vec<Value>, inbox: Vec<Value>) -> Self {
        Self {
            rows,
            inbox,
            inbox_status: 200,
            patch_status: 200,
            delete_status: 204,
            running: true,
            page_calls: 0,
            inbox_calls: 0,
            mutations: Vec::new(),
            sse_queue: VecDeque::new(),
            drop_sse: false,
            sse_connections: 0,
            older_cursor: None,
            newer_cursor: None,
            hold_inbox: None,
        }
    }

    fn emit_native(&mut self, event: Value) {
        let envelope = json!({
            "type": "instance.event",
            "instanceId": "ws",
            "event": event,
        });
        self.sse_queue.push_back(format!("data: {envelope}\n\n"));
    }
}

struct LoopbackServer {
    address: String,
    state: Arc<Mutex<FixtureState>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl LoopbackServer {
    fn start(initial: FixtureState) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(initial));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_state = state.clone();
        let worker_stop = stop.clone();
        let handle = thread::spawn(move || {
            let mut workers = Vec::new();
            while !worker_stop.load(SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let st = worker_state.clone();
                        let sp = worker_stop.clone();
                        workers.push(thread::spawn(move || serve_socket(socket, st, sp)));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Self {
            address,
            state,
            stop,
            handle: Some(handle),
        }
    }

    fn backend(&self) -> Backend {
        let mut backend = Backend::unauthenticated(&self.address).unwrap();
        backend.workspace = "ws".into();
        backend.session = "ses".into();
        backend
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        self.stop.store(true, SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve_socket(
    mut socket: std::net::TcpStream,
    state: Arc<Mutex<FixtureState>>,
    stop: Arc<AtomicBool>,
) {
    let _ = socket.set_nonblocking(false);
    let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = socket.set_write_timeout(Some(Duration::from_secs(2)));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < 16384 {
        if socket.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let header_str = String::from_utf8_lossy(&head);
    let first_line = header_str.lines().next().unwrap_or_default();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let content_len = header_str
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body_bytes = vec![0u8; content_len];
    if content_len > 0 && socket.read_exact(&mut body_bytes).is_err() {
        return;
    }
    if path.starts_with("/api/events") {
        let header =
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
        if socket.write_all(header.as_bytes()).is_err() {
            return;
        }
        let connected = format!(
            "data: {}\n\n",
            json!({"type":"instance.eventStatus","instanceId":"ws","status":"connected"})
        );
        if socket.write_all(connected.as_bytes()).is_err() || socket.flush().is_err() {
            return;
        }
        {
            let mut st = state.lock().unwrap();
            st.sse_connections += 1;
        }
        while !stop.load(SeqCst) {
            let (frame, drop_now) = {
                let mut st = state.lock().unwrap();
                let frame = st.sse_queue.pop_front();
                let drop_now = if st.drop_sse {
                    st.drop_sse = false;
                    true
                } else {
                    false
                };
                (frame, drop_now)
            };
            if let Some(frame) = frame {
                if socket.write_all(frame.as_bytes()).is_err() || socket.flush().is_err() {
                    return;
                }
            }
            if drop_now {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        return;
    }

    let (status, payload) = {
        let mut st = state.lock().unwrap();
        if method == "POST" && path == "/api/workspaces/ws/session-history/window" {
            st.page_calls += 1;
            let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
            let target = &body["target"];
            let (older, newer) = if target["kind"] == "before" {
                (
                    None,
                    Some(
                        json!({"kind":"after","messageID":st.rows.last().and_then(|r| r["id"].as_str()).unwrap_or("m1")}),
                    ),
                )
            } else {
                (st.older_cursor.clone(), st.newer_cursor.clone())
            };
            (
                200,
                json!({
                    "status": "window",
                    "messages": st.rows,
                    "older": older,
                    "newer": newer,
                    "latest": newer.is_none(),
                }),
            )
        } else if method == "GET" && path == "/workspaces/ws/instance/api/session/ses" {
            let (busy, idle) = if st.running { (20, 10) } else { (10, 20) };
            (
                200,
                json!({"data":{"id":"ses","time":{"busy":busy,"idle":idle}}}),
            )
        } else if method == "GET" && path == "/workspaces/ws/instance/api/session/ses/inbox" {
            st.inbox_calls += 1;
            let hold = st.hold_inbox.take();
            let reply_status = st.inbox_status;
            let reply_inbox = st.inbox.clone();
            drop(st);
            if let Some((entered, release)) = hold {
                entered.store(true, SeqCst);
                let deadline = std::time::Instant::now() + Duration::from_secs(4);
                while !release.load(SeqCst)
                    && !stop.load(SeqCst)
                    && std::time::Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            if reply_status == 200 {
                (200, json!({"data": reply_inbox}))
            } else {
                (reply_status, json!({"error": "unavailable"}))
            }
        } else if method == "PATCH"
            && path.starts_with("/workspaces/ws/instance/api/session/ses/inbox/")
        {
            let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
            st.mutations.push((method.clone(), path.clone(), body));
            (st.patch_status, json!({"ok": st.patch_status < 300}))
        } else if method == "DELETE"
            && path.starts_with("/workspaces/ws/instance/api/session/ses/inbox/")
        {
            st.mutations
                .push((method.clone(), path.clone(), Value::Null));
            (st.delete_status, Value::Null)
        } else {
            (404, json!({"error": "not found"}))
        }
    };
    let text = if status == 204 {
        String::new()
    } else {
        payload.to_string()
    };
    let response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = socket.write_all(response.as_bytes());
}

fn user_json(id: &str, text: &str) -> Value {
    json!({"id": id, "type": "user", "text": text})
}

fn assistant_json(id: &str, text: &str, completed: bool) -> Value {
    if completed {
        json!({"id": id, "type": "assistant", "time": {"completed": 1}, "content": [{"type":"text","text":text}]})
    } else {
        json!({"id": id, "type": "assistant", "content": [{"type":"text","text":text}]})
    }
}

fn inbox_json(id: &str, delivery: &str, text: &str) -> Value {
    json!({"id": id, "type": "user", "delivery": delivery, "payload": {"text": text}})
}

#[test]
fn inbox_http_methods_handle_success_missing_and_unavailable() {
    run(async {
        let server = LoopbackServer::start(FixtureState::new(
            vec![user_json("u1", "hi")],
            vec![inbox_json("q1", "queue", "follow up")],
        ));
        let backend = server.backend();

        let listed = backend.session_inbox().await.unwrap().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "q1");
        assert_eq!(listed[0].delivery, Delivery::Queue);

        backend
            .update_queued_prompt_delivery("q1", Delivery::Steer)
            .await
            .unwrap();
        backend.cancel_queued_prompt("q1").await.unwrap();
        {
            let st = server.state.lock().unwrap();
            assert_eq!(st.mutations.len(), 2);
            assert_eq!(st.mutations[0].0, "PATCH");
            assert_eq!(
                st.mutations[0].1,
                "/workspaces/ws/instance/api/session/ses/inbox/q1"
            );
            assert_eq!(st.mutations[0].2, json!({"delivery": "steer"}));
            assert_eq!(st.mutations[1].0, "DELETE");
            assert_eq!(
                st.mutations[1].1,
                "/workspaces/ws/instance/api/session/ses/inbox/q1"
            );
        }

        {
            let mut st = server.state.lock().unwrap();
            st.inbox_status = 404;
            st.patch_status = 501;
            st.delete_status = 501;
        }
        assert!(backend.session_inbox().await.unwrap().is_none());
        let patch_err = backend
            .update_queued_prompt_delivery("q1", Delivery::Queue)
            .await
            .unwrap_err();
        assert!(patch_err.is::<InboxUnavailable>());
        let delete_err = backend.cancel_queued_prompt("q1").await.unwrap_err();
        assert!(delete_err.is::<InboxUnavailable>());
    });
}

async fn recv_reader(
    events: &crate::Receiver<(u64, u64, Event)>,
    mut accept: impl FnMut(u64, Event) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (generation, _conn, event) = events.recv().await.unwrap();
            if accept(generation, event) {
                break;
            }
        }
    })
    .await
    .expect("timed out waiting for reader event");
}

#[test]
fn delivery_promotion_and_reconnect_reconcile_authoritative_order_without_duplicates() {
    run(async {
        let server = LoopbackServer::start(FixtureState::new(
            vec![
                user_json("u1", "start"),
                assistant_json("a1", "working", false),
            ],
            vec![
                inbox_json("q1", "queue", "first queued"),
                inbox_json("q2", "queue", "second queued"),
            ],
        ));
        let backend = server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let generation = demand_tx.publish(Some(demand::Target::Latest));
        let (reader_tx, reader_rx) = bounded(64);
        let connection = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection,
            revoked: Default::default(),
        };
        let wakes = Arc::new(AtomicUsize::new(0));
        let wake_count = wakes.clone();
        let wake: crate::Wake = Arc::new(move || {
            wake_count.fetch_add(1, SeqCst);
        });
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake,
            Some(reading),
        ));

        // 1. Initial sync delivers committed rows and authoritative inbox.
        let mut initial_rows = Vec::new();
        let mut initial_inbox: Vec<QueuedPrompt> = Vec::new();
        recv_reader(&reader_rx, |seen_gen, event| {
            assert_eq!(seen_gen, generation);
            match event {
                Event::ReaderSync { page, .. } => {
                    initial_rows = page.rows.iter().map(|r| r.id.clone()).collect();
                }
                Event::Inbox {
                    items,
                    authoritative: true,
                    ..
                } => {
                    initial_inbox = items;
                }
                _ => {}
            }
            !initial_rows.is_empty() && initial_inbox.len() == 2
        })
        .await;
        assert_eq!(initial_rows, vec!["u1", "a1"]);
        assert_eq!(
            initial_inbox
                .iter()
                .map(|i| (i.id.as_str(), i.delivery))
                .collect::<Vec<_>>(),
            vec![("q1", Delivery::Queue), ("q2", Delivery::Queue)]
        );

        // 2. Promote q2 to steer -> SSE event + authoritative inbox reorders [q2(steer), q1(queue)].
        {
            let mut st = server.state.lock().unwrap();
            st.inbox = vec![
                inbox_json("q2", "steer", "second queued"),
                inbox_json("q1", "queue", "first queued"),
            ];
            st.emit_native(json!({
                "type": "session.inbox.delivery.changed",
                "data": { "sessionID": "ses", "inboxID": "q2", "delivery": "steer" }
            }));
        }
        let mut promoted_order = Vec::new();
        recv_reader(&reader_rx, |_, event| {
            if let Event::Inbox {
                items,
                authoritative: true,
                ..
            } = event
            {
                let ids: Vec<_> = items.iter().map(|i| (i.id.clone(), i.delivery)).collect();
                if ids
                    == vec![
                        ("q2".into(), Delivery::Steer),
                        ("q1".into(), Delivery::Queue),
                    ]
                {
                    promoted_order = ids;
                    return true;
                }
            }
            false
        })
        .await;
        assert_eq!(
            promoted_order,
            vec![
                ("q2".into(), Delivery::Steer),
                ("q1".into(), Delivery::Queue)
            ]
        );

        // 3. Deliver q2 while moving it ahead of a1 in authoritative history -> ReaderSync reconciles exact order.
        {
            let mut st = server.state.lock().unwrap();
            st.inbox = vec![inbox_json("q1", "queue", "first queued")];
            st.rows = vec![
                user_json("u1", "start"),
                user_json("q2", "second queued"),
                assistant_json("a1", "working", true),
            ];
            st.emit_native(json!({
                "type": "session.inbox.delivered",
                "data": { "sessionID": "ses", "inboxID": "q2" }
            }));
        }
        let mut delivered_rows = Vec::new();
        recv_reader(&reader_rx, |_, event| {
            if let Event::ReaderSync { page, .. } = event {
                let ids: Vec<_> = page.rows.iter().map(|r| r.id.clone()).collect();
                if ids == vec!["u1", "q2", "a1"] {
                    delivered_rows = ids;
                    return true;
                }
            }
            false
        })
        .await;
        assert_eq!(delivered_rows, vec!["u1", "q2", "a1"]);

        // 4. SSE disconnect during which q1 is silently delivered and reordered -> reconnect reconciles both.
        {
            let mut st = server.state.lock().unwrap();
            st.inbox.clear();
            st.rows = vec![
                user_json("u1", "start"),
                user_json("q2", "second queued"),
                assistant_json("a1", "working", true),
                user_json("q1", "first queued"),
                assistant_json("a2", "done", true),
            ];
            st.running = false;
            st.drop_sse = true;
        }
        let mut reconnected_rows = Vec::new();
        let mut reconnected_inbox = vec![inbox_json("placeholder", "queue", "x")];
        recv_reader(&reader_rx, |_, event| {
            match event {
                Event::ReaderSync { page, .. } => {
                    reconnected_rows = page.rows.iter().map(|r| r.id.clone()).collect();
                }
                Event::Inbox {
                    items,
                    authoritative: true,
                    ..
                } if items.is_empty() => {
                    reconnected_inbox.clear();
                }
                _ => {}
            }
            reconnected_rows == vec!["u1", "q2", "a1", "q1", "a2"] && reconnected_inbox.is_empty()
        })
        .await;
        assert!(server.state.lock().unwrap().sse_connections >= 2);

        // 5. Generation change fences old generation events cleanly.
        let next_gen = demand_tx.publish(Some(demand::Target::Latest));
        assert!(next_gen > generation);
        let mut saw_next_gen = false;
        recv_reader(&reader_rx, |seen_gen, event| {
            if seen_gen == next_gen && matches!(event, Event::ReaderSync { .. }) {
                saw_next_gen = true;
                return true;
            }
            false
        })
        .await;
        assert!(saw_next_gen);

        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    });
}

#[test]
fn pagination_detects_reordered_overlap_and_schedules_authoritative_resync() {
    run(async {
        let mut initial =
            FixtureState::new(vec![user_json("m1", "one"), user_json("m2", "two")], vec![]);
        initial.newer_cursor = Some(json!({"kind":"after","messageID":"m2"}));
        let server = LoopbackServer::start(initial);
        let backend = server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let _ = demand_tx.publish(Some(demand::Target::Around("m1".into())));
        let (reader_tx, reader_rx) = bounded(64);
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let wake: crate::Wake = Arc::new(|| {});
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake,
            Some(reading),
        ));

        // Wait for initial historical window [m1, m2].
        recv_reader(&reader_rx, |_, event| {
            matches!(event, Event::ReaderSync { page, .. } if page.rows.len() == 2 && page.newer.is_some())
        })
        .await;

        // Server reorders overlap [m2, m1, m3] at tail while paging After.
        {
            let mut st = server.state.lock().unwrap();
            st.rows = vec![
                user_json("m2", "two"),
                user_json("m1", "one"),
                user_json("m3", "three"),
            ];
            st.newer_cursor = None;
        }
        let (_cancel_tx, cancel_rx) = bounded(1);
        cmd_tx
            .send(Command::Page(HistoryEdge::After, cancel_rx))
            .await
            .unwrap();

        let mut offered = Vec::new();
        let mut resynced = Vec::new();
        recv_reader(&reader_rx, |_, event| {
            match event {
                Event::PageOffered { page, admit, .. } => {
                    assert!(admit.accept());
                    offered = page.rows.iter().map(|r| r.id.clone()).collect();
                }
                Event::ReaderSync { page, .. } => {
                    resynced = page.rows.iter().map(|r| r.id.clone()).collect();
                }
                _ => {}
            }
            offered == vec!["m2", "m1", "m3"] && resynced == vec!["m2", "m1", "m3"]
        })
        .await;
        assert_eq!(offered, vec!["m2", "m1", "m3"]);
        assert_eq!(resynced, vec!["m2", "m1", "m3"]);

        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    });
}

#[test]
fn decode_marks_only_lossless_plain_text_prompts_editable_and_accepts_attachment_only() {
    let list = json!({
        "data": [
            {"id": "plain", "type": "user", "delivery": "queue", "payload": {"text": "Plain follow-up", "resume": false}},
            {"id": "with_display", "type": "user", "delivery": "queue", "payload": {"text": "expanded", "metadata": {"displayText": "[Pasted #1]"}}},
            {"id": "with_agent", "type": "user", "delivery": "queue", "payload": {"text": "@coder check", "agents": [{"name": "coder"}]}},
            {"id": "att_only", "type": "user", "delivery": "steer", "payload": {"files": [{"name": "a.txt", "mime": "text/plain", "source": {"type": "uri", "uri": "file:///a.txt"}}]}},
            {"id": "with_resume", "type": "user", "delivery": "queue", "payload": {"text": "Resume turn", "resume": true}},
            {"id": "with_extra", "type": "user", "delivery": "queue", "payload": {"text": "Extra metadata", "model": {"id": "m1"}}}
        ]
    });
    let items = inbox::decode_list(&list).unwrap();
    assert_eq!(items.len(), 6);
    assert!(items[0].editable);
    assert!(!items[1].editable);
    assert!(!items[2].editable);
    assert!(!items[3].editable);
    assert_eq!(items[3].text, "");
    assert_eq!(items[3].parts.len(), 1);
    assert!(!items[4].editable);
    assert!(!items[5].editable);
}

#[test]
fn background_inbox_read_does_not_block_streaming_or_stall_and_generation_switch_clears_stale() {
    run(async {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let mut initial = FixtureState::new(
            vec![user_json("u1", "start"), assistant_json("a1", "hi", false)],
            vec![inbox_json("q1", "steer", "promoted")],
        );
        initial.hold_inbox = Some((entered.clone(), release.clone()));
        let server = LoopbackServer::start(initial);
        let backend = server.backend();
        let (out_tx, out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let gen1 = demand_tx.publish(Some(demand::Target::Latest));
        let (reader_tx, reader_rx) = bounded(64);
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let wake: crate::Wake = Arc::new(|| {});
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake,
            Some(reading),
        ));

        // Initial history sync completes while GET /inbox is held open in the background.
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1 && matches!(event, Event::ReaderSync { .. })
        })
        .await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while !entered.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("background GET /inbox must start");

        // While GET /inbox is held, send a live streaming delta and verify it arrives immediately.
        server.state.lock().unwrap().emit_native(json!({
            "type": "session.text.delta",
            "data": {
                "sessionID": "ses",
                "assistantMessageID": "a1",
                "ordinal": 0,
                "delta": " live-chunk"
            }
        }));
        let saw_delta = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok((_, _, Event::Text(id, _))) = reader_rx.recv().await
                    && id == "a1"
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            saw_delta,
            "held background inbox GET must not block live streaming text deltas"
        );

        // Release GET /inbox: unrelated text delta must NOT reject or stall the inbox result.
        release.store(true, SeqCst);
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q1"
                )
        })
        .await;

        // Lone session.inbox.enqueued with zero subsequent SSE frames wakes via inbox_deadline.
        {
            let mut st = server.state.lock().unwrap();
            st.inbox = vec![
                inbox_json("q1", "steer", "promoted"),
                inbox_json("q2", "queue", "lone enqueue"),
            ];
            st.emit_native(json!({
                "type": "session.inbox.enqueued",
                "created": 100,
                "data": {
                    "sessionID": "ses",
                    "inboxID": "q2",
                    "item": {
                        "id": "q2",
                        "type": "user",
                        "delivery": "queue",
                        "payload": {"text": "lone enqueue"}
                    }
                }
            }));
        }
        let calls_before = server.state.lock().unwrap().inbox_calls;
        tokio::time::timeout(Duration::from_secs(3), async {
            while server.state.lock().unwrap().inbox_calls <= calls_before {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("lone enqueue must wake the loop and fetch authoritative inbox order");

        // Hold an old-generation GET /inbox across generation switch; new generation returns empty [].
        let old_entered = Arc::new(AtomicBool::new(false));
        let old_release = Arc::new(AtomicBool::new(false));
        {
            let mut st = server.state.lock().unwrap();
            st.inbox = vec![inbox_json("q-stale", "queue", "from old gen")];
            st.hold_inbox = Some((old_entered.clone(), old_release.clone()));
        }
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !old_entered.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("old-gen GET /inbox must start");

        // Switch generation and clear server inbox to empty [].
        server.state.lock().unwrap().inbox.clear();
        let gen2 = demand_tx.publish(Some(demand::Target::Latest));
        assert!(gen2 > gen1);
        // Release the late old-generation reply; it must be discarded and gen2 must emit empty [].
        old_release.store(true, SeqCst);
        let mut saw_gen2_empty = false;
        recv_reader(&reader_rx, |seen_gen, event| {
            if seen_gen == gen2
                && let Event::Inbox {
                    items,
                    authoritative: true,
                    ..
                } = event
            {
                assert!(
                    items.is_empty(),
                    "late old-generation inbox items must never leak into new generation"
                );
                saw_gen2_empty = true;
                return true;
            }
            false
        })
        .await;
        assert!(saw_gen2_empty);

        // Persistent inbox failure emits Event::InboxFailed after bounded retries,
        // and a subsequent successful GET with identical rows still republishes authoritative: true.
        server.state.lock().unwrap().inbox_status = 500;
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen2 && matches!(event, Event::InboxFailed)
        })
        .await;
        server.state.lock().unwrap().inbox_status = 200;
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen2
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.is_empty()
                )
        })
        .await;
        drop(out_rx);
        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    });
}

#[test]
fn persistent_inbox_history_overlap_prefers_committed_and_bounds_repairs() {
    run(async {
        // Server persistently reports already-committed u1 inside /inbox alongside q2.
        let initial = FixtureState::new(
            vec![user_json("u1", "committed")],
            vec![
                inbox_json("u1", "queue", "stale duplicate"),
                inbox_json("q2", "queue", "real queued"),
            ],
        );
        let server = LoopbackServer::start(initial);
        let backend = server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let gen1 = demand_tx.publish(Some(demand::Target::Latest));
        let (reader_tx, reader_rx) = bounded(64);
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let wake: crate::Wake = Arc::new(|| {});
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake,
            Some(reading),
        ));

        // Published Event::Inbox must suppress committed u1 and retain only q2.
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q2"
                )
        })
        .await;

        // Initial overlap schedules repair #1; wait for it to settle before measuring further SyncInbox triggers.
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1 && matches!(event, Event::ReaderSync { .. })
        })
        .await;

        // Next SyncInbox hits repair #2 (the cap); wait for its history repair to settle.
        let page_calls_before = server.state.lock().unwrap().page_calls;
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1 && matches!(event, Event::ReaderSync { .. })
        })
        .await;
        let page_calls_after_cap = server.state.lock().unwrap().page_calls;
        assert_eq!(
            page_calls_after_cap - page_calls_before,
            1,
            "second overlap should trigger exactly one bounded repair"
        );

        // Further SyncInbox triggers with persistent overlap must NOT schedule any more history repairs.
        for _ in 0..3 {
            cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
            recv_reader(&reader_rx, |seen_gen, event| {
                seen_gen == gen1
                    && matches!(
                        event,
                        Event::Inbox {
                            items,
                            authoritative: true,
                            ..
                        } if items.len() == 1 && items[0].id == "q2"
                    )
            })
            .await;
        }
        assert_eq!(
            server.state.lock().unwrap().page_calls,
            page_calls_after_cap,
            "once capped, further SyncInbox triggers must not schedule more overlap repairs"
        );

        // Even with overlap repairs saturated on u1, an unrelated disappearance of q2 still resyncs history.
        {
            let mut st = server.state.lock().unwrap();
            st.inbox = vec![inbox_json("u1", "queue", "stale duplicate")];
            st.rows = vec![user_json("u1", "committed"), user_json("q2", "real queued")];
        }
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        let mut saw_committed_q2 = false;
        recv_reader(&reader_rx, |seen_gen, event| {
            if seen_gen == gen1
                && let Event::ReaderSync { page, .. } = event
                && page.rows.iter().any(|r| r.id == "q2")
            {
                saw_committed_q2 = true;
                return true;
            }
            false
        })
        .await;
        assert!(saw_committed_q2);

        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    });
}

#[test]
fn available_retry_and_queued_sse_cancel_fence_and_resync_inbox() {
    run(async {
        let initial = FixtureState::new(
            vec![user_json("u1", "start")],
            vec![inbox_json("q1", "queue", "first")],
        );
        let server = LoopbackServer::start(initial);
        let backend = server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let gen1 = demand_tx.publish(Some(demand::Target::Latest));
        let (reader_tx, reader_rx) = bounded(64);
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let wake: crate::Wake = Arc::new(|| {});
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake,
            Some(reading),
        ));

        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q1"
                )
        })
        .await;

        // 1. Unavailable -> Available without server.connected must still resync inbox authoritatively.
        {
            let mut st = server.state.lock().unwrap();
            st.sse_queue.push_back(format!(
                "data: {}\n\n",
                json!({"type":"instance.eventStatus","instanceId":"ws","status":"disconnected"})
            ));
            st.sse_queue.push_back(format!(
                "data: {}\n\n",
                json!({"type":"instance.eventStatus","instanceId":"ws","status":"connected"})
            ));
        }
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q1"
                )
        })
        .await;

        // 2. Command::Retry must also trigger an authoritative inbox refresh even with unchanged rows.
        cmd_tx.send(Command::Retry).await.unwrap();
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q1"
                )
        })
        .await;

        // 3. In-flight GET /inbox racing a queued session.inbox.cancelled SSE frame must be fenced out.
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        {
            let mut st = server.state.lock().unwrap();
            st.hold_inbox = Some((entered.clone(), release.clone()));
        }
        cmd_tx.send(Command::SyncInbox(0)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !entered.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("raced GET /inbox must start");

        {
            let mut st = server.state.lock().unwrap();
            st.inbox.clear();
            st.emit_native(json!({
                "type": "session.inbox.cancelled",
                "data": { "sessionID": "ses", "inboxID": "q1" }
            }));
        }
        // Wait for the targeted SSE cancellation delta to be observed, then release stale GET.
        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::InboxDelta(crate::inbox::InboxDelta::Removed(ref id)) if id == "q1"
                )
        })
        .await;
        release.store(true, SeqCst);

        // Authoritative replacement GET must settle with empty []; stale [q1] must NEVER reappear.
        recv_reader(&reader_rx, |seen_gen, event| {
            if seen_gen == gen1
                && let Event::Inbox {
                    items,
                    authoritative,
                    ..
                } = event
            {
                assert!(
                    items.is_empty(),
                    "stale in-flight GET must not resurrect cancelled item q1"
                );
                return authoritative;
            }
            false
        })
        .await;

        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    });
}

#[test]
fn unrelated_sse_text_burst_does_not_starve_completed_inbox_read() {
    run(async {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let mut initial = FixtureState::new(
            vec![user_json("u1", "start"), assistant_json("a1", "hi", false)],
            vec![inbox_json("q-burst", "queue", "ready under burst")],
        );
        initial.hold_inbox = Some((entered.clone(), release.clone()));
        let server = LoopbackServer::start(initial);
        let backend = server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let gen1 = demand_tx.publish(Some(demand::Target::Latest));
        let (reader_tx, reader_rx) = bounded(128);
        let reading = ReadingLane {
            demand: demand_rx,
            events: reader_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let wake: crate::Wake = Arc::new(|| {});
        let task = tokio::spawn(recovery::run_with_reading(
            backend,
            out_tx,
            cmd_rx,
            wake.clone(),
            Some(reading),
        ));

        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1 && matches!(event, Event::ReaderSync { .. })
        })
        .await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while !entered.load(SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("held GET /inbox must start");

        // Enqueue a burst of 24 unrelated text deltas while releasing the completed inbox read.
        {
            let mut st = server.state.lock().unwrap();
            for i in 0..24 {
                st.emit_native(json!({
                    "type": "session.text.delta",
                    "data": {
                        "sessionID": "ses",
                        "assistantMessageID": "a1",
                        "ordinal": 0,
                        "delta": format!(" c{i}")
                    }
                }));
            }
        }
        release.store(true, SeqCst);

        recv_reader(&reader_rx, |seen_gen, event| {
            seen_gen == gen1
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        fence: Some(ref fence),
                    } if items.len() == 1 && items[0].id == "q-burst" && fence.is_valid()
                )
        })
        .await;

        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;

        // A historical reader receiving server.connected still schedules and publishes a fresh valid inbox GET.
        let mut hist = FixtureState::new(
            vec![user_json("m1", "older")],
            vec![inbox_json("q-hist", "queue", "pending while historical")],
        );
        hist.newer_cursor = Some(json!({"kind": "after", "messageID": "m1"}));
        let hist_server = LoopbackServer::start(hist);
        let hist_backend = hist_server.backend();
        let (out_tx, _out_rx) = bounded(64);
        let (cmd_tx, cmd_rx) = bounded(16);
        let (demand_tx, demand_rx) = demand::open();
        let hgen = demand_tx.publish(Some(demand::Target::Around("m1".into())));
        let (h_tx, h_rx) = bounded(64);
        let h_reading = ReadingLane {
            demand: demand_rx,
            events: h_tx,
            connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            revoked: Default::default(),
        };
        let h_task = tokio::spawn(recovery::run_with_reading(
            hist_backend,
            out_tx,
            cmd_rx,
            wake,
            Some(h_reading),
        ));
        recv_reader(&h_rx, |seen_gen, event| {
            seen_gen == hgen
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        ..
                    } if items.len() == 1 && items[0].id == "q-hist"
                )
        })
        .await;
        let calls_before = hist_server.state.lock().unwrap().inbox_calls;
        hist_server
            .state
            .lock()
            .unwrap()
            .emit_native(json!({"type": "server.connected", "data": {}}));
        recv_reader(&h_rx, |seen_gen, event| {
            seen_gen == hgen
                && matches!(
                    event,
                    Event::Inbox {
                        items,
                        authoritative: true,
                        fence: Some(ref f),
                    } if items.len() == 1 && items[0].id == "q-hist" && f.is_valid()
                )
        })
        .await;
        assert!(hist_server.state.lock().unwrap().inbox_calls > calls_before);
        let _ = cmd_tx.send(Command::Close).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), h_task).await;
    });
}
