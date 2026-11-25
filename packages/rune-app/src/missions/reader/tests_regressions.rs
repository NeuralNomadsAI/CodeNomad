use super::{
    tests::{
        header_with, header_with_reports, query_params, slice_reply, spawn_http, task_and_report,
    },
    *,
};
use crate::{
    files::test_http::{Http, wait},
    missions::directory::Panel,
    platform::reads::Reads,
};
use codenomad_client::{
    bounded,
    missions::{ContentSelector, Status, Summary},
};
use rune::{Env, Runtime};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

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
        let digest = "e".repeat(43);
        let report_requests = Arc::new(AtomicUsize::new(0));
        let req_c = report_requests.clone();
        let d_c = digest.clone();
        let backend = spawn_http(move |params| {
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

        wait(async {
            loop {
                rt.update(|p, _| {
                    p.poll();
                });
                for _ in 0..4 {
                    rt.frame(1.0 / 60.0);
                }
                if rt
                    .accessibility_json()
                    .to_string()
                    .contains("Old attempt body")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        assert_eq!(report_requests.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn body_cache_promotes_newer_revision_stays_fresh_on_same_digest_and_rejects_bad_continuation() {
    crate::platform::block_on(async {
        let digest_a = "a".repeat(43);
        let digest_b = "b".repeat(43);
        let mode = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mode_c = mode.clone();
        let calls_c = calls.clone();
        let da = digest_a.clone();
        let db = digest_b.clone();
        let backend = spawn_http(move |params| {
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
                    // Multi-slice where second slice lies about total `characters`.
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
                                    "characters": 9999,
                                    "json": false,
                                    "text": "mismatch"
                                }
                            }),
                        )
                    }
                }
            }
        })
        .await;

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
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap_a), &reads, &wake);
                let v = reader.body_view("project", "msn_1", &obj_sel);
                if v.body.is_some_and(|b| b.text == "Newer rev text") {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
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
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap_b), &reads, &wake);
                if reader
                    .body_view("project", "msn_1", &notes_sel)
                    .body
                    .is_some_and(|b| b.text == "Stable digest")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
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
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap_c), &reads, &wake);
                if reader.body_view("project", "msn_1", &sum_sel).status == BodyStatus::Error {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
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
        let digest_a = "f".repeat(43);
        let digest_b = "g".repeat(43);
        let full = "Hello ".repeat(2200); // 13_200 units (> 9_000 page, 3 chunks of 5_000)
        let total = full.encode_utf16().count();
        let switch_digest = Arc::new(AtomicBool::new(false));
        let sw_c = switch_digest.clone();
        let da = digest_a.clone();
        let db = digest_b.clone();
        let full_c = full.clone();
        let backend = spawn_http(move |params| {
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
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                if reader
                    .body_view("project", "msn_1", &sel)
                    .body
                    .is_some_and(|b| b.utf16_len >= 9_000)
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        assert!(
            reader
                .request_copy(key.clone(), Some(digest_a.clone()), total as u64)
                .is_none(),
            "whole body is not loaded yet"
        );
        let delivered = wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                if let Some(text) = reader.take_ready_copy() {
                    break text;
                }
                wake_rx.recv().await.unwrap();
            }
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
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap_notes), &reads, &wake);
                if reader
                    .body_view("project", "msn_1", &notes_sel)
                    .body
                    .is_some_and(|b| b.utf16_len >= 9_000)
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
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
        const OFFPAGE_TASKS: &str = r#"{"taskPage":{"order":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","offset":0,"end":0,"total":60,"reports":2,"counts":{"completed":60}},"tasks":[{"id":"tsk_far","key":"task-far","title":"Offpage Task","role":"specialist","status":"completed","blockedBy":[],"order":55,"createdAt":1,"updatedAt":1,"dependents":0,"reportCount":1,"outstandingExecution":false,"bodies":{"brief":{"characters":12,"digest":"hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"}},"report":{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2}}],"reports":[{"id":"rep_tsk_far","taskKey":"task-far","sessionId":"ses_task","outcome":"completed","excerpt":"Excerpt for task-far","createdAt":2,"bodies":{"summary":{"characters":24,"digest":"hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"},"evidence":{"characters":20,"digest":"hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"},"next":{"characters":2,"digest":"hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"}}}]}"#;
        const OFFPAGE_DIGEST: &str = "2LMOQBIXuElvuUus8x_L-5nOkvPXE2TRv-SO1HGn-RE";
        let digest = "h".repeat(43);
        let d_c = digest.clone();
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.workspace = "project".into();
        let lookup_hits = Arc::new(AtomicUsize::new(0));
        let lookup_c = lookup_hits.clone();
        crate::platform::spawn(async move {
            loop {
                let req = http.accept().await;
                let params = query_params(&req.header);
                if req.header.contains("/missions/panel") && req.body["source"] == "tasks" {
                    assert_eq!(req.body["task"]["keys"], json!(["task-far"]));
                    lookup_c.fetch_add(1, Ordering::SeqCst);
                    let _ = req
                        .try_reply(
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
                        .await;
                } else if params.get("kind").map(String::as_str) == Some("report") {
                    let field = params.get("field").map(String::as_str).unwrap_or_default();
                    let (text, is_json) = match field {
                        "summary" => ("Offpage resolved summary", false),
                        "evidence" => ("[\"verified offpage\"]", true),
                        "next" => ("[]", true),
                        _ => ("{}", true),
                    };
                    let (st, body) = slice_reply(
                        5,
                        "report",
                        field,
                        json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                        &d_c,
                        text,
                        0,
                        60_000,
                        is_json,
                    );
                    let _ = req.try_reply(st, body).await;
                } else {
                    let _ = req.try_reply(404, json!({})).await;
                }
            }
        });

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

        wait(async {
            loop {
                rt.update(|p, _| {
                    p.poll();
                });
                for _ in 0..4 {
                    rt.frame(1.0 / 60.0);
                }
                let tree = rt.accessibility_json().to_string();
                if tree.contains("Offpage Task") && tree.contains("Offpage resolved summary") {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
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
            .capture_return_focus("mission-eye-msn_1".into());
        // Navigating inside the reader must not overwrite the original opening trigger.
        panel
            .reader
            .capture_return_focus("mission-reader-dep-task-a".into());
        assert_eq!(panel.close_reader().as_deref(), Some("mission-eye-msn_1"));
        assert!(panel.close_reader().is_none());
    });
}
