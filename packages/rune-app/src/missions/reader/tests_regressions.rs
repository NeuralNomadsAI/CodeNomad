use super::{
    tests::{header_with, header_with_reports, query_params, slice_reply, task_and_report},
    *,
};
use crate::{
    backend::Backend,
    files::test_http::{Http, wait},
    missions::directory::Panel,
    platform::reads::Reads,
};
use codenomad_client::{
    Receiver, bounded,
    missions::{ContentSelector, Status, Summary, content_digest},
};
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

struct MockHttp {
    backend: Backend,
    server: JoinHandle<()>,
}

impl Drop for MockHttp {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl MockHttp {
    async fn spawn(
        handler: impl Fn(String, Value) -> (u16, Value) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut backend =
            Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
                .await
                .unwrap();
        backend.workspace = "project".into();
        backend.session = "session".into();
        let handler = Arc::new(handler);
        let server = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let handler = handler.clone();
                tokio::spawn(async move {
                    serve_connection(socket, handler).await;
                });
            }
        });
        Self { backend, server }
    }

    async fn spawn_query(
        handler: impl Fn(HashMap<String, String>) -> (u16, Value) + Send + Sync + 'static,
    ) -> Self {
        Self::spawn(move |header, _| handler(query_params(&header))).await
    }
}

async fn serve_connection(
    mut socket: TcpStream,
    handler: Arc<dyn Fn(String, Value) -> (u16, Value) + Send + Sync>,
) {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() >= 32_768 {
            return;
        }
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let Ok(header) = String::from_utf8(buf[..header_end].to_vec()) else {
        return;
    };
    let content_length = header
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    if content_length > 65_536 {
        return;
    }
    let mut body_bytes = buf.split_off(header_end);
    if body_bytes.len() < content_length {
        let missing = content_length - body_bytes.len();
        let mut tail = vec![0u8; missing];
        if socket.read_exact(&mut tail).await.is_err() {
            return;
        }
        body_bytes.extend_from_slice(&tail);
    }
    let body_slice = &body_bytes[..content_length];
    let body = if body_slice.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body_slice).unwrap_or(Value::Null)
    };
    let (status, reply) = handler(header, body);
    let payload = if status == 204 {
        Vec::new()
    } else {
        serde_json::to_vec(&reply).unwrap()
    };
    let response_header = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    let _ = socket.write_all(response_header.as_bytes()).await;
    let _ = socket.write_all(&payload).await;
}

async fn wait_until<T>(wake_rx: &Receiver<()>, mut step: impl FnMut() -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(done) = step() {
                return done;
            }
            wake_rx.recv().await.expect("wake channel closed");
            while wake_rx.try_recv().is_ok() {}
        }
    })
    .await
    .expect("mission reader regression deadline")
}

fn noop_wake() -> Wake {
    Arc::new(|| {})
}

fn summary_row(id: &str, title: &str) -> Summary {
    Summary {
        id: id.into(),
        title: Some(title.into()),
        objective: "Fixture".into(),
        status: Status::Active,
        run_state: None,
        coordinator_session_id: "ses_fixture".into(),
        actor_count: 1,
        updated_at: 0.0,
        revision: 1,
        finish_sequence: None,
        task_count: None,
    }
}

#[test]
fn switching_overview_to_another_mission_keeps_reader_open_and_toggles_on_second_click() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.workspace = "project".into();
        let mut panel = Panel::new(
            backend,
            Some("project".into()),
            Reads::default(),
            noop_wake(),
        );
        panel.summaries = vec![summary_row("msn_a", "Alpha"), summary_row("msn_b", "Beta")];

        assert!(panel.toggle_overview("msn_a"));
        assert!(panel.reader.is_overview_open("msn_a"));
        assert_eq!(panel.selected.as_deref(), Some("msn_a"));

        // Clicking Mission B's eye while Mission A's overview is open must switch to B, not close.
        assert!(panel.toggle_overview("msn_b"));
        assert!(panel.reader.is_overview_open("msn_b"));
        assert_eq!(panel.selected.as_deref(), Some("msn_b"));

        // Clicking Mission B's eye again toggles the reader closed.
        assert!(!panel.toggle_overview("msn_b"));
        assert!(!panel.has_reader());
    });
}

#[test]
fn withdrawn_and_mismatched_task_reports_render_only_as_history_disclosures() {
    crate::platform::block_on(async {
        let digest = content_digest("Old attempt body");
        let report_requests = Arc::new(AtomicUsize::new(0));
        let req_c = report_requests.clone();
        let d_c = digest.clone();
        let mock = MockHttp::spawn_query(move |params| {
            let kind = params.get("kind").map(String::as_str).unwrap_or_default();
            let field = params.get("field").map(String::as_str).unwrap_or_default();
            if kind == "report" && field == "summary" {
                req_c.fetch_add(1, Ordering::SeqCst);
                slice_reply(
                    2,
                    "report",
                    "summary",
                    json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                    &d_c,
                    "Old attempt body",
                    0,
                    60_000,
                    false,
                )
            } else {
                (404, json!({}))
            }
        })
        .await;
        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);
        panel.detail.observe("msn_1", 2);
        // Task is withdrawn while its nested report was completed: not a current report.
        let (task, rep) = task_and_report(
            "tsk_old",
            "task-old",
            "Retried Task",
            "withdrawn",
            "completed",
            &[],
            0,
        );
        let snap = header_with_reports("msn_1", 2, json!({}), vec![task], vec![rep], None);
        assert!(current_task_report(&snap, snap.tasks.find_by_key("task-old").unwrap()).is_none());
        assert_eq!(
            task_history_reports(&snap, snap.tasks.find_by_key("task-old").unwrap()).len(),
            1
        );

        panel.detail.snapshot = Some(snap);
        panel.selected = Some("msn_1".into());
        panel
            .reader
            .open_task("msn_1".into(), "tsk_old".into(), "task-old".into());

        let mut rt = Runtime::new(
            panel,
            |p, _| {
                crate::strings::with_locale("en", || {
                    super::view::view(
                        p,
                        |p: &mut Panel| Some(p),
                        |p: &mut Panel, _| {
                            let _ = p.close_reader();
                        },
                    )
                })
            },
            (960.0, 720.0),
            Env::new(false, 1.0),
        );

        rt.update(|p, _| {
            p.poll();
        });
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(
            report_requests.load(Ordering::SeqCst),
            0,
            "history report must not fetch while disclosure is closed"
        );
        let (x, y) = rt
            .find("mission-reader-toggle-history-report-rep_tsk_old")
            .expect("history disclosure button");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }

        wait_until(&wake_rx, || {
            rt.update(|p, _| {
                p.poll();
            });
            for _ in 0..4 {
                rt.frame(1.0 / 60.0);
            }
            rt.accessibility_json()
                .to_string()
                .contains("Old attempt body")
                .then_some(())
        })
        .await;
        assert_eq!(report_requests.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn body_cache_promotes_newer_revision_stays_fresh_on_same_digest_and_rejects_bad_continuation() {
    crate::platform::block_on(async {
        let digest_a = content_digest("Stable digest");
        let digest_b = content_digest("Newer rev text");
        let mode = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mode_c = mode.clone();
        let calls_c = calls.clone();
        let da = digest_a.clone();
        let db = digest_b.clone();
        let mock = MockHttp::spawn_query(move |params| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            let offset = params
                .get("offset")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            match mode_c.load(Ordering::SeqCst) {
                0 => {
                    // Server already advanced to digest_b at rev 6 while header expected digest_a at rev 5.
                    slice_reply(
                        6,
                        "mission",
                        "objective",
                        json!({}),
                        &db,
                        "Newer rev text",
                        0,
                        6000,
                        false,
                    )
                }
                1 => {
                    // Same digest_a served at older rev 4 when header says rev 7 with digest_a.
                    slice_reply(
                        4,
                        "mission",
                        "notes",
                        json!({}),
                        &da,
                        "Stable digest",
                        0,
                        6000,
                        false,
                    )
                }
                _ => {
                    // Multi-slice where the second slice is individually valid at the HTTP client
                    // layer (offset=6000, text=6000 units, characters=12000, next=None) so it
                    // reaches BodyCache::accept_slice, which must reject the total mismatch vs
                    // slice 1's characters=10000.
                    if offset == 0 {
                        let chunk = "X".repeat(6000);
                        (
                            200,
                            json!({
                                "available": true,
                                "version": 1,
                                "projectID": "project",
                                "missionID": "msn_1",
                                "revision": 8,
                                "content": {
                                    "kind": "mission",
                                    "field": "summary",
                                    "digest": da,
                                    "offset": 0,
                                    "characters": 10000,
                                    "json": false,
                                    "text": chunk,
                                    "next": 6000
                                }
                            }),
                        )
                    } else {
                        let chunk = "Y".repeat(6000);
                        (
                            200,
                            json!({
                                "available": true,
                                "version": 1,
                                "projectID": "project",
                                "missionID": "msn_1",
                                "revision": 8,
                                "content": {
                                    "kind": "mission",
                                    "field": "summary",
                                    "digest": da,
                                    "offset": offset,
                                    "characters": 12000,
                                    "json": false,
                                    "text": chunk
                                }
                            }),
                        )
                    }
                }
            }
        })
        .await;

        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let reads = Reads::default();
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());

        // Case (a): newer revision with different digest is promoted and settles without loop.
        let snap_a = header_with(
            "msn_1",
            5,
            json!({ "objective": { "characters": 14, "digest": digest_a } }),
            vec![],
        );
        let obj_sel = ContentSelector::mission("objective");
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_a), &reads, &wake);
            let v = reader.body_view("project", "msn_1", &obj_sel);
            v.body
                .is_some_and(|b| b.text == "Newer rev text")
                .then_some(())
        })
        .await;
        let calls_after_a = calls.load(Ordering::SeqCst);
        reader.poll(&backend, Some("project"), Some(&snap_a), &reads, &wake);
        assert_eq!(calls.load(Ordering::SeqCst), calls_after_a);

        // Case (b): same digest at lower revision stays fresh without re-fetching.
        mode.store(1, Ordering::SeqCst);
        let snap_b = header_with(
            "msn_1",
            7,
            json!({ "notes": { "characters": 13, "digest": digest_a } }),
            vec![],
        );
        let notes_sel = ContentSelector::mission("notes");
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_b), &reads, &wake);
            reader
                .body_view("project", "msn_1", &notes_sel)
                .body
                .is_some_and(|b| b.text == "Stable digest")
                .then_some(())
        })
        .await;
        let calls_after_b = calls.load(Ordering::SeqCst);
        reader.poll(&backend, Some("project"), Some(&snap_b), &reads, &wake);
        assert_eq!(calls.load(Ordering::SeqCst), calls_after_b);

        // Case (c): continuation with inconsistent `characters` fails closed and parks.
        mode.store(2, Ordering::SeqCst);
        let snap_c = header_with(
            "msn_1",
            8,
            json!({ "summary": { "characters": 10000, "digest": digest_a } }),
            vec![],
        );
        let sum_sel = ContentSelector::mission("summary");
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_c), &reads, &wake);
            (reader.body_view("project", "msn_1", &sum_sel).status == BodyStatus::Error)
                .then_some(())
        })
        .await;
        let calls_after_c = calls.load(Ordering::SeqCst);
        reader.poll(&backend, Some("project"), Some(&snap_c), &reads, &wake);
        assert_eq!(calls.load(Ordering::SeqCst), calls_after_c);
    });
}

#[test]
fn async_copy_delivers_bound_digest_cancels_on_change_and_refuses_oversized() {
    crate::platform::block_on(async {
        let full = "Hello ".repeat(2200); // 13_200 units (> 9_000 page, 3 chunks of 5_000)
        let digest_a = content_digest(&full);
        let digest_b = content_digest("Changed digest body");
        let total = full.encode_utf16().count();
        let switch_digest = Arc::new(AtomicBool::new(false));
        let sw_c = switch_digest.clone();
        let da = digest_a.clone();
        let db = digest_b.clone();
        let full_c = full.clone();
        let mock = MockHttp::spawn_query(move |params| {
            let offset = params
                .get("offset")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            let field = params
                .get("field")
                .map(String::as_str)
                .unwrap_or("objective");
            if sw_c.load(Ordering::SeqCst) {
                slice_reply(
                    4,
                    "mission",
                    field,
                    json!({}),
                    &db,
                    "Changed digest body",
                    0,
                    5000,
                    false,
                )
            } else {
                slice_reply(
                    3,
                    "mission",
                    field,
                    json!({}),
                    &da,
                    &full_c,
                    offset,
                    5000,
                    false,
                )
            }
        })
        .await;
        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let reads = Reads::default();
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());
        let snap = header_with(
            "msn_1",
            3,
            json!({ "objective": { "characters": total, "digest": digest_a } }),
            vec![],
        );
        let sel = ContentSelector::mission("objective");
        let key = ("project".into(), "msn_1".into(), sel.clone());

        // Oversized bodies beyond MAX_WHOLE_BODY_UNITS must be refused without truncating.
        assert!(
            reader
                .request_copy(
                    key.clone(),
                    Some(digest_a.clone()),
                    MAX_WHOLE_BODY_UNITS + 1
                )
                .is_none()
        );
        assert!(reader.take_ready_copy().is_none());

        // Wait until first page (10_000 units loaded out of 13_200), then request whole copy.
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
            reader
                .body_view("project", "msn_1", &sel)
                .body
                .is_some_and(|b| b.utf16_len >= 9_000)
                .then_some(())
        })
        .await;
        assert!(
            reader
                .request_copy(key.clone(), Some(digest_a.clone()), total as u64)
                .is_none(),
            "whole body is not loaded yet"
        );
        let delivered = wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
            reader.take_ready_copy()
        })
        .await;
        assert_eq!(delivered, full);

        // Queue a copy on a second multi-slice body (`notes`) while only slice 1 is loaded,
        // then advance the snapshot digest before slice 2 finishes: copy must cancel, not deliver.
        let notes_sel = ContentSelector::mission("notes");
        let notes_key = ("project".into(), "msn_1".into(), notes_sel.clone());
        let snap_notes = header_with(
            "msn_1",
            3,
            json!({ "notes": { "characters": total, "digest": digest_a } }),
            vec![],
        );
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_notes), &reads, &wake);
            reader
                .body_view("project", "msn_1", &notes_sel)
                .body
                .is_some_and(|b| b.utf16_len >= 9_000)
                .then_some(())
        })
        .await;
        assert!(
            reader
                .request_copy(notes_key, Some(digest_a), total as u64)
                .is_none(),
            "notes body is only partially loaded"
        );
        switch_digest.store(true, Ordering::SeqCst);
        let snap_changed = header_with(
            "msn_1",
            4,
            json!({ "notes": { "characters": 19, "digest": digest_b } }),
            vec![],
        );
        reader.poll(
            &backend,
            Some("project"),
            Some(&snap_changed),
            &reads,
            &wake,
        );
        assert!(reader.take_ready_copy().is_none());
    });
}

#[test]
fn hidden_panel_preserves_refresh_and_suspend_revalidates_on_return() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.workspace = "project".into();
        let reads = Reads::default();
        let (wake_tx, _wake_rx) = bounded(16);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), reads, wake);
        panel.detail.observe("msn_1", 2);
        panel.detail.snapshot = Some(header_with("msn_1", 2, json!({}), vec![]));
        panel.selected = Some("msn_1".into());
        panel.reader.open_overview("msn_1".into());
        // Schedule a refresh while visible (draining the initial Summaries/Cleanups requests
        // so cancelled client sockets do not sit in the mock TcpListener backlog), then hide
        // the right panel while the reader stays open.
        panel.show(true);
        for _ in 0..2 {
            let req = wait(http.accept()).await;
            let _ = req.try_reply(503, json!({})).await;
        }
        panel.invalidate(Some(("msn_1", 3)), 10.0);
        panel.show(false);
        assert!(panel.has_reader());
        assert!(panel.detail.snapshot.is_some());

        // Suspending an inactive tab cancels flights and triggers detail revalidation on next poll.
        panel.suspend();
        assert!(panel.has_reader());
        panel.poll();
        let req = wait(http.accept()).await;
        assert!(
            req.header.contains("/missions/panel"),
            "returning from suspended tab must revalidate detail snapshot, got: {}",
            req.header
        );
    });
}

#[test]
fn overview_progress_fallback_and_offpage_task_lookup() {
    crate::platform::block_on(async {
        const OFFPAGE_TASKS: &str = r#"{"taskPage":{"order":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","offset":0,"end":0,"total":60,"reports":2,"counts":{"completed":60}},"tasks":[{"id":"tsk_far","key":"task-far","title":"Offpage Task","role":"specialist","status":"completed","blockedBy":[],"order":55,"createdAt":1,"updatedAt":1,"dependents":0,"reportCount":1,"outstandingExecution":false,"bodies":{"brief":{"characters":12,"digest":"mPPnWrHj4vEFmX9TRzV2jvYMian4OZjG3wx189MckAU"}},"report":{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2}}],"reports":[{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2,"bodies":{"summary":{"characters":24,"digest":"mwKfd7N-_i81PRfQA3tUMgTlcMxZN6otlkuGGAlVLFo"},"evidence":{"characters":20,"digest":"miBWWG3jJlR9rjbI4TGbcmpBlZ8cwEvRfQCGUzUiU-Y"},"next":{"characters":2,"digest":"XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc"}}}]}"#;
        const OFFPAGE_DIGEST: &str = "Ef_gOvbQNxC9Ft1k1PBB0ll16tmt2zrK-4Zg5L9e0QY";
        let lookup_hits = Arc::new(AtomicUsize::new(0));
        let lookup_c = lookup_hits.clone();
        let mock = MockHttp::spawn(move |header, body| {
            let params = query_params(&header);
            if header.contains("/missions/panel") && body["source"] == "tasks" {
                assert_eq!(body["task"]["keys"], json!(["task-far"]));
                lookup_c.fetch_add(1, Ordering::SeqCst);
                (
                    200,
                    json!({
                        "available": true,
                        "version": 1,
                        "source": "tasks",
                        "projectID": "project",
                        "missionID": "msn_1",
                        "revision": 5,
                        "discardedEvents": 0,
                        "controlUnavailable": false,
                        "notificationUnavailable": false,
                        "cleanupUnavailable": false,
                        "page": {
                            "digest": OFFPAGE_DIGEST,
                            "total": 1,
                            "pieces": [{
                                "index": 0,
                                "offset": 0,
                                "characters": OFFPAGE_TASKS.encode_utf16().count(),
                                "text": OFFPAGE_TASKS
                            }]
                        }
                    }),
                )
            } else if params.get("kind").map(String::as_str) == Some("report") {
                let field = params.get("field").map(String::as_str).unwrap_or_default();
                let (text, is_json) = match field {
                    "summary" => ("Offpage resolved summary", false),
                    "evidence" => ("[\"verified offpage\"]", true),
                    "next" => ("[]", true),
                    _ => ("{}", true),
                };
                let digest = content_digest(text);
                slice_reply(
                    5,
                    "report",
                    field,
                    json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                    &digest,
                    text,
                    0,
                    60_000,
                    is_json,
                )
            } else {
                (404, json!({}))
            }
        })
        .await;
        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(64);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);
        panel.detail.observe("msn_1", 5);
        let (done_task, done_rep) = task_and_report(
            "tsk_done",
            "task-done",
            "Completed Work",
            "completed",
            "completed",
            &["task-far"],
            0,
        );
        let (blocked_task, blocked_rep) = task_and_report(
            "tsk_blk",
            "task-blk",
            "Blocked Work",
            "needs-input",
            "blocked",
            &[],
            1,
        );
        // No summary and no briefing -> Overview falls back to recorded results & obstacles.
        // total_override = 60 (> loaded 2) so off-page task link `task-far` is active.
        panel.detail.snapshot = Some(header_with_reports(
            "msn_1",
            5,
            json!({}),
            vec![done_task, blocked_task],
            vec![done_rep, blocked_rep],
            Some(60),
        ));
        panel.selected = Some("msn_1".into());
        panel.reader.open_overview("msn_1".into());

        let mut rt = Runtime::new(
            panel,
            |p, _| {
                crate::strings::with_locale("en", || {
                    super::view::view(
                        p,
                        |p: &mut Panel| Some(p),
                        |p: &mut Panel, _| {
                            let _ = p.close_reader();
                        },
                    )
                })
            },
            (960.0, 720.0),
            Env::new(false, 1.0),
        );

        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let overview_tree = rt.accessibility_json().to_string();
        assert!(overview_tree.contains("Completed Work"));
        assert!(overview_tree.contains("Blocked Work"));

        // Open Completed Work, then follow its off-page dependency link `task-far`.
        let (x, y) = rt
            .find("mission-reader-progress-recorded-task-done")
            .expect("recorded progress task link");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let (x, y) = rt
            .find("mission-reader-dep-task-far")
            .expect("off-page dependency link");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }

        let offpage_summary = ContentSelector::report("rep_tsk_far", "summary");
        wait_until(&wake_rx, || {
            rt.update(|p, _| {
                p.poll();
            });
            for _ in 0..4 {
                rt.frame(1.0 / 60.0);
            }
            assert_eq!(
                rt.state.reader.lookup_failed(),
                None,
                "off-page lookup failed unexpectedly"
            );
            assert_eq!(
                rt.state.reader.lookup_missing(),
                None,
                "off-page lookup reported missing unexpectedly"
            );
            assert_ne!(
                rt.state
                    .reader
                    .body_view("project", "msn_1", &offpage_summary)
                    .status,
                BodyStatus::Error,
                "off-page summary fetch parked in Error"
            );
            let tree = rt.accessibility_json().to_string();
            (tree.contains("Offpage Task") && tree.contains("Offpage resolved summary"))
                .then_some(())
        })
        .await;
        assert_eq!(lookup_hits.load(Ordering::SeqCst), 1);
        assert!(rt.state.reader.is_task_open("msn_1", "tsk_far"));
    });
}

#[test]
fn return_focus_tracks_first_trigger_and_restores_on_close() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.workspace = "project".into();
        let mut panel = Panel::new(
            backend,
            Some("project".into()),
            Reads::default(),
            noop_wake(),
        );

        assert!(panel.toggle_overview("msn_1"));
        panel
            .reader
            .set_return_focus("mission-row-eye-msn_1".into());
        // Navigating inside the reader must not overwrite the opening trigger.
        panel
            .reader
            .open_task("msn_1".into(), "tsk_a".into(), "task-a".into());
        assert_eq!(
            panel.close_reader().as_deref(),
            Some("mission-row-eye-msn_1")
        );
        assert!(panel.close_reader().is_none());
    });
}

#[test]
fn tampered_body_digest_fails_closed_and_older_not_found_unparks_on_restore() {
    crate::platform::block_on(async {
        let genuine = "Restored notes body";
        let genuine_digest = content_digest(genuine);
        let phase = Arc::new(AtomicUsize::new(0));
        let phase_c = phase.clone();
        let d_c = genuine_digest.clone();
        let mock = MockHttp::spawn_query(move |_| match phase_c.load(Ordering::SeqCst) {
            0 => slice_reply(
                3,
                "mission",
                "notes",
                json!({}),
                &d_c,
                "TAMPERED notes body",
                0,
                6000,
                false,
            ),
            1 => (
                200,
                json!({
                    "available": true,
                    "version": 1,
                    "projectID": "project",
                    "missionID": "msn_1",
                    "revision": 4,
                    "refused": "content-not-found"
                }),
            ),
            _ => slice_reply(
                5,
                "mission",
                "notes",
                json!({}),
                &d_c,
                genuine,
                0,
                6000,
                false,
            ),
        })
        .await;
        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let reads = Reads::default();
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());
        let sel = ContentSelector::mission("notes");
        let key = ("project".into(), "msn_1".into(), sel.clone());
        let snap_v3 = header_with(
            "msn_1",
            3,
            json!({ "notes": { "characters": genuine.len(), "digest": genuine_digest } }),
            vec![],
        );

        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_v3), &reads, &wake);
            (reader.body_view("project", "msn_1", &sel).status == BodyStatus::Error).then_some(())
        })
        .await;
        assert!(reader.body_view("project", "msn_1", &sel).body.is_none());
        assert!(
            reader
                .request_copy(
                    key.clone(),
                    Some(genuine_digest.clone()),
                    genuine.len() as u64
                )
                .is_none()
        );

        phase.store(1, Ordering::SeqCst);
        let snap_v4 = header_with(
            "msn_1",
            4,
            json!({ "notes": { "characters": genuine.len(), "digest": genuine_digest } }),
            vec![],
        );
        reader.retry(&key);
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_v4), &reads, &wake);
            (reader.body_view("project", "msn_1", &sel).status == BodyStatus::Missing).then_some(())
        })
        .await;

        phase.store(2, Ordering::SeqCst);
        let snap_v5 = header_with(
            "msn_1",
            5,
            json!({ "notes": { "characters": genuine.len(), "digest": genuine_digest } }),
            vec![],
        );
        wait_until(&wake_rx, || {
            reader.poll(&backend, Some("project"), Some(&snap_v5), &reads, &wake);
            reader
                .body_view("project", "msn_1", &sel)
                .body
                .is_some_and(|b| b.text == genuine)
                .then_some(())
        })
        .await;
        assert_eq!(
            reader
                .request_copy(key, Some(genuine_digest), genuine.len() as u64)
                .as_deref(),
            Some(genuine)
        );
    });
}

#[test]
fn rebind_preserves_open_reader_and_missing_offpage_lookup_keeps_current_view() {
    crate::platform::block_on(async {
        const EMPTY_TASKS: &str = r#"{"taskPage":{"order":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","offset":0,"end":0,"total":60,"reports":2,"counts":{"completed":60}},"tasks":[],"reports":[]}"#;
        const EMPTY_DIGEST: &str = "mJ1imXdP_i7bo88sVwOZGOR9y0Xazue3EWYDorWcORs";
        let mock = MockHttp::spawn(move |header, body| {
            if header.contains("/missions/panel") && body["source"] == "tasks" {
                (
                    200,
                    json!({
                        "available": true,
                        "version": 1,
                        "source": "tasks",
                        "projectID": "project",
                        "missionID": "msn_1",
                        "revision": 5,
                        "discardedEvents": 0,
                        "controlUnavailable": false,
                        "notificationUnavailable": false,
                        "cleanupUnavailable": false,
                        "page": {
                            "digest": EMPTY_DIGEST,
                            "total": 1,
                            "pieces": [{
                                "index": 0,
                                "offset": 0,
                                "characters": EMPTY_TASKS.encode_utf16().count(),
                                "text": EMPTY_TASKS
                            }]
                        }
                    }),
                )
            } else {
                (503, json!({}))
            }
        })
        .await;
        let backend_a = mock.backend.clone();
        let backend_b = backend_a.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend_a, Some("project".into()), Reads::default(), wake);
        panel.summaries = vec![summary_row("msn_1", "Alpha")];
        panel.detail.observe("msn_1", 5);
        let (done_task, done_rep) = task_and_report(
            "tsk_done",
            "task-done",
            "Completed Work",
            "completed",
            "completed",
            &["task-ghost"],
            0,
        );
        let (other_task, other_rep) = task_and_report(
            "tsk_other",
            "task-other",
            "Other Work",
            "completed",
            "completed",
            &[],
            1,
        );
        panel.detail.snapshot = Some(header_with_reports(
            "msn_1",
            5,
            json!({}),
            vec![done_task, other_task],
            vec![done_rep, other_rep],
            Some(60),
        ));
        panel.selected = Some("msn_1".into());
        panel.reader.open_overview("msn_1".into());

        // Non-destructive off-page lookup for a missing task must keep the overview open and
        // never mark the shared Detail failed.
        panel
            .reader
            .request_task_lookup("msn_1".into(), "task-ghost".into());
        wait_until(&wake_rx, || {
            panel.poll();
            (panel.reader.lookup_missing() == Some("task-ghost")).then_some(())
        })
        .await;
        assert!(panel.reader.is_overview_open("msn_1"));
        assert!(!panel.detail.failed);

        // Rebinding after sign-in on the same workspace preserves the open reader target.
        assert!(panel.same_workspace(&backend_b));
        panel.rebind(backend_b);
        assert!(panel.reader.is_overview_open("msn_1"));
    });
}

#[test]
fn cross_page_report_id_collision_cannot_substitute_foreign_report() {
    let (task_a, _) = task_and_report(
        "tsk_a",
        "task-a",
        "Task A",
        "completed",
        "completed",
        &[],
        0,
    );
    // Foreign top-level report reusing rep_tsk_a under another taskKey must not substitute.
    let foreign_rep: codenomad_client::missions::Report = serde_json::from_value(json!({
        "id": "rep_tsk_a",
        "taskKey": "task-foreign",
        "sessionId": "ses_other",
        "outcome": "completed",
        "excerpt": "Foreign excerpt",
        "createdAt": 9,
        "bodies": { "summary": { "characters": 7, "digest": content_digest("Foreign") } }
    }))
    .unwrap();
    let snap = header_with_reports("msn_1", 2, json!({}), vec![task_a], vec![foreign_rep], None);
    let task = snap.tasks.find_by_key("task-a").unwrap();
    let resolved = current_task_report(&snap, task).expect("nested fallback");
    assert_eq!(resolved.task_key, "task-a");
    assert!(resolved.body("summary").is_none());
}

#[test]
fn failed_offpage_lookup_stays_retryable_instead_of_caching_missing() {
    crate::platform::block_on(async {
        const OFFPAGE_TASKS: &str = r#"{"taskPage":{"order":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","offset":0,"end":0,"total":60,"reports":2,"counts":{"completed":60}},"tasks":[{"id":"tsk_far","key":"task-far","title":"Offpage Task","role":"specialist","status":"completed","blockedBy":[],"order":55,"createdAt":1,"updatedAt":1,"dependents":0,"reportCount":1,"outstandingExecution":false,"bodies":{"brief":{"characters":12,"digest":"mPPnWrHj4vEFmX9TRzV2jvYMian4OZjG3wx189MckAU"}},"report":{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2}}],"reports":[{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2,"bodies":{"summary":{"characters":24,"digest":"mwKfd7N-_i81PRfQA3tUMgTlcMxZN6otlkuGGAlVLFo"},"evidence":{"characters":20,"digest":"miBWWG3jJlR9rjbI4TGbcmpBlZ8cwEvRfQCGUzUiU-Y"},"next":{"characters":2,"digest":"XukXOxtWTmGv0jWaiXwYC16oOHWpGihTffQgKq1LOqc"}}}]}"#;
        const OFFPAGE_DIGEST: &str = "Ef_gOvbQNxC9Ft1k1PBB0ll16tmt2zrK-4Zg5L9e0QY";
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let mock = MockHttp::spawn(move |header, body| {
            if header.contains("/missions/panel") && body["source"] == "tasks" {
                let n = calls_c.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    (503, json!({"error": "temporary"}))
                } else {
                    (
                        200,
                        json!({
                            "available": true,
                            "version": 1,
                            "source": "tasks",
                            "projectID": "project",
                            "missionID": "msn_1",
                            "revision": 5,
                            "discardedEvents": 0,
                            "controlUnavailable": false,
                            "notificationUnavailable": false,
                            "cleanupUnavailable": false,
                            "page": {
                                "digest": OFFPAGE_DIGEST,
                                "total": 1,
                                "pieces": [{
                                    "index": 0,
                                    "offset": 0,
                                    "characters": OFFPAGE_TASKS.encode_utf16().count(),
                                    "text": OFFPAGE_TASKS
                                }]
                            }
                        }),
                    )
                }
            } else {
                (503, json!({}))
            }
        })
        .await;
        let backend = mock.backend.clone();

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);
        panel.summaries = vec![summary_row("msn_1", "Alpha")];
        panel.detail.observe("msn_1", 5);
        let (done_task, done_rep) = task_and_report(
            "tsk_done",
            "task-done",
            "Completed Work",
            "completed",
            "completed",
            &["task-far"],
            0,
        );
        let (other_task, other_rep) = task_and_report(
            "tsk_other",
            "task-other",
            "Other Work",
            "completed",
            "completed",
            &[],
            1,
        );
        panel.detail.snapshot = Some(header_with_reports(
            "msn_1",
            5,
            json!({}),
            vec![done_task, other_task],
            vec![done_rep, other_rep],
            Some(60),
        ));
        panel.selected = Some("msn_1".into());
        panel.reader.open_overview("msn_1".into());

        // Transient 503 must report lookup_failed (never cached as lookup_missing).
        panel
            .reader
            .request_task_lookup("msn_1".into(), "task-far".into());
        wait_until(&wake_rx, || {
            panel.poll();
            (panel.reader.lookup_failed() == Some("task-far")).then_some(())
        })
        .await;
        assert!(panel.reader.lookup_missing().is_none());
        assert!(!panel.detail.lookup_settled("", "task-far"));
        assert!(panel.reader.is_overview_open("msn_1"));

        // Clicking again retries the lookup and opens the task once the server recovers.
        panel
            .reader
            .request_task_lookup("msn_1".into(), "task-far".into());
        wait_until(&wake_rx, || {
            panel.poll();
            panel.reader.is_task_open("msn_1", "tsk_far").then_some(())
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(panel.reader.lookup_failed().is_none());
    });
}
