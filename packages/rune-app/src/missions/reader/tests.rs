use super::*;
use crate::{
    files::test_http::{Http, wait},
    missions::{detail::Snapshot, directory::Panel, task_rows::TaskRows},
    platform::reads::Reads,
};
use codenomad_client::{
    bounded,
    missions::{ContentSelector, MapHeader, Report, Task, content_digest},
};
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

pub(super) fn header_with_reports(
    mission_id: &str,
    revision: u64,
    bodies: Value,
    tasks: Vec<Task>,
    reports: Vec<Report>,
    total_override: Option<u64>,
) -> Snapshot {
    let descriptor = json!({"characters":0,"digest":"0".repeat(43),"total":0,"array":true});
    let loaded = tasks.len() as u64;
    let total = total_override.unwrap_or(loaded);
    let mut counts = serde_json::Map::new();
    if total > 0 {
        counts.insert("completed".into(), json!(total));
    }
    let header: MapHeader = serde_json::from_value(json!({
        "root": {
            "version": 1,
            "id": mission_id,
            "projectID": "project",
            "projectCanonical": "/fixture",
            "title": "Fixture Mission",
            "excerpt": "Fixture excerpt",
            "template": "custom",
            "status": "active",
            "coordinatorSessionId": "ses_fixture",
            "revision": revision,
            "createdAt": 1,
            "updatedAt": 1,
            "historyTruncated": false,
            "bodies": bodies,
        },
        "collections": {
            "actors": descriptor,
            "history": descriptor,
            "reports": descriptor,
        },
        "tasks": {
            "page": {
                "order": "a".repeat(43),
                "offset": 0,
                "end": loaded,
                "total": total,
                "counts": counts,
                "reports": reports.len(),
            },
            "pins": [],
            "reportPins": [],
            "version": "b".repeat(43),
        }
    }))
    .unwrap();
    let report_map = reports
        .into_iter()
        .map(|report| (report.id.clone(), report))
        .collect();
    Snapshot {
        header,
        tasks: Rc::new(TaskRows::new(tasks)),
        reports: report_map,
        end: loaded,
        attention_end: 0,
    }
}

pub(super) fn header_with(
    mission_id: &str,
    revision: u64,
    bodies: Value,
    tasks: Vec<Task>,
) -> Snapshot {
    header_with_reports(mission_id, revision, bodies, tasks, vec![], None)
}

/// Real compact-map wire shape: `task.report` omits `bodies`, which live on the top-level
/// `TaskWindow.reports` entry returned alongside the task.
pub(super) fn task_and_report(
    id: &str,
    key: &str,
    title: &str,
    status: &str,
    outcome: &str,
    blocked_by: &[&str],
    order: u64,
) -> (Task, Report) {
    let brief_digest = content_digest("Task brief!!");
    let summary_digest = content_digest("All passed!");
    let evidence_digest = content_digest("[\"cargo test ok\"]");
    let next_digest = content_digest("[\"ship it!\"]");
    let artifact_digest = content_digest("{\"artifactMarker\":true}");
    let report_id = format!("rep_{id}");
    let task: Task = serde_json::from_value(json!({
        "id": id,
        "key": key,
        "title": title,
        "role": "specialist",
        "status": status,
        "blockedBy": blocked_by,
        "order": order,
        "createdAt": 1,
        "updatedAt": 1,
        "dependents": 0,
        "reportCount": 1,
        "outstandingExecution": false,
        "bodies": {
            "brief": { "characters": 12, "digest": brief_digest }
        },
        "report": {
            "id": report_id,
            "taskKey": key,
            "sessionId": "ses_task",
            "outcome": outcome,
            "excerpt": format!("Excerpt for {key}"),
            "createdAt": 2
        }
    }))
    .unwrap();
    let report: Report = serde_json::from_value(json!({
        "id": format!("rep_{id}"),
        "taskKey": key,
        "sessionId": "ses_task",
        "outcome": outcome,
        "excerpt": format!("Excerpt for {key}"),
        "createdAt": 2,
        "bodies": {
            "summary": { "characters": 11, "digest": summary_digest },
            "evidence": { "characters": 17, "digest": evidence_digest },
            "next": { "characters": 12, "digest": next_digest },
            "artifact": { "characters": 23, "digest": artifact_digest }
        }
    }))
    .unwrap();
    (task, report)
}

pub(super) fn query_params(header: &str) -> HashMap<String, String> {
    let path = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();
    let Some((_, query)) = path.split_once('?') else {
        return HashMap::new();
    };
    reqwest::Url::parse(&format!("http://fixture.invalid/?{query}"))
        .map(|url| url.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

pub(super) async fn spawn_http(
    handler: impl Fn(HashMap<String, String>) -> (u16, Value) + Send + Sync + 'static,
) -> Backend {
    let http = Http::new().await;
    let mut backend = http.backend.clone();
    backend.workspace = "project".into();
    let handler = Arc::new(handler);
    crate::platform::spawn(async move {
        loop {
            let req = http.accept().await;
            let params = query_params(&req.header);
            let (status, body) = handler(params);
            let _ = req.try_reply(status, body).await;
        }
    });
    backend
}

#[allow(clippy::too_many_arguments)]
pub(super) fn slice_reply(
    revision: u64,
    kind: &str,
    field: &str,
    extra_sel: Value,
    digest: &str,
    full: &str,
    offset: usize,
    chunk: usize,
    json_body: bool,
) -> (u16, Value) {
    let units: Vec<u16> = full.encode_utf16().collect();
    let total = units.len();
    let end = (offset + chunk).min(total);
    let text = String::from_utf16(&units[offset..end]).unwrap();
    let next = (end < total).then_some(end);
    let mut content = serde_json::Map::new();
    content.insert("kind".into(), json!(kind));
    content.insert("field".into(), json!(field));
    if let Some(map) = extra_sel.as_object() {
        for (k, v) in map {
            content.insert(k.clone(), v.clone());
        }
    }
    content.insert("digest".into(), json!(digest));
    content.insert("offset".into(), json!(offset));
    content.insert("characters".into(), json!(total));
    content.insert("json".into(), json!(json_body));
    content.insert("text".into(), json!(text));
    if let Some(next) = next {
        content.insert("next".into(), json!(next));
    }
    (
        200,
        json!({
            "available": true,
            "version": 1,
            "projectID": "project",
            "missionID": "msn_1",
            "revision": revision,
            "content": content,
        }),
    )
}

#[test]
fn multi_slice_body_pages_and_copies_whole_digest() {
    crate::platform::block_on(async {
        let full = "Alpha ".repeat(1800); // 10_800 UTF-16 units (> READER_PAGE_SIZE = 9_000)
        let digest = content_digest(&full);
        let total_units = full.encode_utf16().count();
        let requests = Arc::new(AtomicUsize::new(0));
        let req_c = requests.clone();
        let d_c = digest.clone();
        let full_c = full.clone();
        let backend = spawn_http(move |params| {
            req_c.fetch_add(1, Ordering::SeqCst);
            let offset = params
                .get("offset")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            slice_reply(
                3,
                "mission",
                "objective",
                json!({}),
                &d_c,
                &full_c,
                offset,
                6000,
                false,
            )
        })
        .await;

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());
        let snap = header_with(
            "msn_1",
            3,
            json!({ "objective": { "characters": total_units, "digest": digest } }),
            vec![],
        );
        let reads = Reads::default();
        let sel = ContentSelector::mission("objective");

        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                let v = reader.body_view("project", "msn_1", &sel);
                if v.body.is_some_and(|b| b.utf16_len >= 9_000) {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;

        assert_eq!(requests.load(Ordering::SeqCst), 2);
        let key = ("project".into(), "msn_1".into(), sel);
        let copied = reader
            .request_copy(key, Some(digest), total_units as u64)
            .expect("full body loaded");
        assert_eq!(copied, full);
    });
}

#[test]
fn content_changed_refusal_stops_after_four_restarts_and_recovers_on_retry() {
    crate::platform::block_on(async {
        // Real server sequence: offset=0 succeeds with slice 1 (next=6000), then the digest-bound
        // continuation (offset=6000) is refused with `content-changed` across 1 initial + 4 bounded
        // restarts before parking in BodyStatus::Error until Retry recovers both slices.
        let full = "Recov ".repeat(1800); // 10_800 UTF-16 units (> 6000 chunk)
        let total_units = full.encode_utf16().count();
        let digest = content_digest(&full);
        let refusals = Arc::new(AtomicUsize::new(0));
        let ref_c = refusals.clone();
        let d_c = digest.clone();
        let full_c = full.clone();
        let backend = spawn_http(move |params| {
            let offset = params
                .get("offset")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            if offset > 0 {
                let n = ref_c.fetch_add(1, Ordering::SeqCst);
                if n < 5 {
                    return (
                        200,
                        json!({
                            "available": true,
                            "version": 1,
                            "projectID": "project",
                            "missionID": "msn_1",
                            "revision": 4,
                            "refused": "content-changed"
                        }),
                    );
                }
            }
            slice_reply(
                4,
                "mission",
                "objective",
                json!({}),
                &d_c,
                &full_c,
                offset,
                6000,
                false,
            )
        })
        .await;

        let (wake_tx, wake_rx) = bounded(32);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());
        let snap = header_with(
            "msn_1",
            4,
            json!({ "objective": { "characters": total_units, "digest": digest } }),
            vec![],
        );
        let reads = Reads::default();
        let sel = ContentSelector::mission("objective");

        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                if reader.body_view("project", "msn_1", &sel).status == BodyStatus::Error {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        assert_eq!(
            refusals.load(Ordering::SeqCst),
            5,
            "1 initial + 4 bounded continuation restarts"
        );

        reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
        assert_eq!(refusals.load(Ordering::SeqCst), 5);

        reader.retry(&("project".into(), "msn_1".into(), sel.clone()));
        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                let v = reader.body_view("project", "msn_1", &sel);
                if v.status == BodyStatus::Ready
                    && v.body.is_some_and(|b| b.utf16_len == total_units as u64)
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        assert_eq!(
            reader
                .body_view("project", "msn_1", &sel)
                .body
                .unwrap()
                .text,
            full
        );
    });
}

#[test]
fn unauthorized_content_surfaces_auth_expired_and_parks() {
    crate::platform::block_on(async {
        let digest = "3".repeat(43);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let backend = spawn_http(move |_| {
            calls_c.fetch_add(1, Ordering::SeqCst);
            (401, json!({}))
        })
        .await;

        let (wake_tx, wake_rx) = bounded(16);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut reader = Reader::default();
        reader.open_overview("msn_1".into());
        let snap = header_with(
            "msn_1",
            1,
            json!({ "objective": { "characters": 5, "digest": digest } }),
            vec![],
        );
        let reads = Reads::default();

        wait(async {
            loop {
                reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
                if reader.take_auth_expired().is_some() {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        reader.poll(&backend, Some("project"), Some(&snap), &reads, &wake);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn runtime_renders_stale_briefing_navigates_to_task_and_closes() {
    crate::platform::block_on(async {
        let briefing_json = json!({
            "basedOnRevision": 1,
            "summary": "Briefing summary text",
            "achieved": [{ "text": "Finished step one", "taskKeys": ["task-a"] }],
            "ongoing": [],
            "obstacles": [],
            "next": []
        })
        .to_string();
        let briefing_len = briefing_json.encode_utf16().count();
        let briefing_digest = content_digest(&briefing_json);
        let objective_digest = content_digest("Mission objective markdown");
        let brief_requests = Arc::new(AtomicUsize::new(0));
        let artifact_requests = Arc::new(AtomicUsize::new(0));
        let brief_c = brief_requests.clone();
        let artifact_c = artifact_requests.clone();
        let b_c = briefing_json.clone();
        let backend = spawn_http(move |params| {
            let kind = params.get("kind").map(String::as_str).unwrap_or_default();
            let field = params.get("field").map(String::as_str).unwrap_or_default();
            match (kind, field) {
                ("mission", "briefing") => slice_reply(
                    5,
                    "mission",
                    "briefing",
                    json!({}),
                    &content_digest(&b_c),
                    &b_c,
                    0,
                    60_000,
                    true,
                ),
                ("mission", "objective") => slice_reply(
                    5,
                    "mission",
                    "objective",
                    json!({}),
                    &content_digest("Mission objective markdown"),
                    "Mission objective markdown",
                    0,
                    60_000,
                    false,
                ),
                ("task", "brief") => {
                    brief_c.fetch_add(1, Ordering::SeqCst);
                    slice_reply(
                        5,
                        "task",
                        "brief",
                        json!({ "taskKey": params.get("taskKey").cloned().unwrap_or_default() }),
                        &content_digest("Task brief!!"),
                        "Task brief!!",
                        0,
                        60_000,
                        false,
                    )
                }
                ("report", "summary") => slice_reply(
                    5,
                    "report",
                    "summary",
                    json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                    &content_digest("All passed!"),
                    "All passed!",
                    0,
                    60_000,
                    false,
                ),
                ("report", "evidence") => slice_reply(
                    5,
                    "report",
                    "evidence",
                    json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                    &content_digest("[\"cargo test ok\"]"),
                    "[\"cargo test ok\"]",
                    0,
                    60_000,
                    true,
                ),
                ("report", "next") => slice_reply(
                    5,
                    "report",
                    "next",
                    json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                    &content_digest("[\"ship it!\"]"),
                    "[\"ship it!\"]",
                    0,
                    60_000,
                    true,
                ),
                ("report", "artifact") => {
                    artifact_c.fetch_add(1, Ordering::SeqCst);
                    slice_reply(
                        5,
                        "report",
                        "artifact",
                        json!({ "reportId": params.get("reportId").cloned().unwrap_or_default() }),
                        &content_digest("{\"artifactMarker\":true}"),
                        "{\"artifactMarker\":true}",
                        0,
                        60_000,
                        true,
                    )
                }
                _ => (404, json!({})),
            }
        })
        .await;

        let (wake_tx, wake_rx) = bounded(64);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);
        panel.detail.observe("msn_1", 5);
        let (task_a, rep_a) = task_and_report(
            "tsk_a",
            "task-a",
            "Build Reader",
            "completed",
            "completed",
            &["task-b"],
            0,
        );
        let (task_b, rep_b) = task_and_report(
            "tsk_b",
            "task-b",
            "Wire Client",
            "completed",
            "completed",
            &[],
            1,
        );
        panel.detail.snapshot = Some(header_with_reports(
            "msn_1",
            5,
            json!({
                "objective": { "characters": 26, "digest": objective_digest },
                "briefing": { "characters": briefing_len, "digest": briefing_digest },
            }),
            vec![task_a, task_b],
            vec![rep_a, rep_b],
            None,
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

        wait(async {
            loop {
                rt.update(|p, _| {
                    p.poll();
                });
                for _ in 0..4 {
                    rt.frame(1.0 / 60.0);
                }
                let tree = rt.accessibility_json().to_string();
                if tree.contains("Briefing summary text")
                    && tree.contains("Mission objective markdown")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;

        let overview_tree = rt.accessibility_json().to_string();
        assert!(overview_tree.contains("Finished step one"));
        assert!(
            overview_tree.contains(crate::strings::with_locale("en", || {
                crate::strings::t("missions.briefing.changed")
            }))
        );

        let (x, y) = rt
            .find("mission-reader-briefing-achieved-task-a")
            .expect("briefing task link");
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
                if tree.contains("All passed!")
                    && tree.contains("cargo test ok")
                    && tree.contains("ship it!")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;

        // Task brief and report artifact must stay closed and unrequested until opened.
        assert_eq!(brief_requests.load(Ordering::SeqCst), 0);
        assert_eq!(artifact_requests.load(Ordering::SeqCst), 0);

        let (x, y) = rt
            .find("mission-reader-toggle-task-brief")
            .expect("brief disclosure");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        let (x, y) = rt
            .find("mission-reader-toggle-report-artifact")
            .expect("artifact disclosure");
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
                if tree.contains("Task brief!!") && tree.contains("artifactMarker") {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;
        assert_eq!(brief_requests.load(Ordering::SeqCst), 1);
        assert_eq!(artifact_requests.load(Ordering::SeqCst), 1);

        let (x, y) = rt
            .find("mission-reader-dep-task-b")
            .expect("dependency link");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        assert!(rt.state.reader.is_task_open("msn_1", "tsk_b"));

        let (x, y) = rt.find("mission-reader-close").expect("close button");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        assert!(!rt.state.has_reader());
    });
}

#[test]
fn pagination_controls_and_hidden_panel_keep_reader_alive() {
    crate::platform::block_on(async {
        let page_one_marker = "START_MARKER_PAGE_ONE ";
        let page_two_marker = " END_MARKER_PAGE_TWO";
        let full = format!("{page_one_marker}{}{page_two_marker}", "word ".repeat(2200));
        let digest = content_digest(&full);
        let total_units = full.encode_utf16().count();
        let d_c = digest.clone();
        let full_c = full.clone();
        let backend = spawn_http(move |params| {
            let offset = params
                .get("offset")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            slice_reply(
                2,
                "mission",
                "objective",
                json!({}),
                &d_c,
                &full_c,
                offset,
                6000,
                false,
            )
        })
        .await;

        let (wake_tx, wake_rx) = bounded(64);
        let wake: Wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);
        panel.detail.observe("msn_1", 2);
        panel.detail.snapshot = Some(header_with(
            "msn_1",
            2,
            json!({ "objective": { "characters": total_units, "digest": digest } }),
            vec![],
        ));
        panel.selected = Some("msn_1".into());
        panel.reader.open_overview("msn_1".into());
        // Hiding the right panel must keep the open Mission reader and its detail snapshot alive.
        panel.show(false);
        assert!(panel.has_reader());
        assert!(panel.detail.snapshot.is_some());

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
                    .contains("START_MARKER_PAGE_ONE")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;

        let page1 = rt.accessibility_json().to_string();
        assert!(page1.contains("START_MARKER_PAGE_ONE"));
        assert!(!page1.contains("END_MARKER_PAGE_TWO"));

        let (x, y) = rt
            .find("mission-reader-next-objective")
            .expect("next page button");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
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
                    .contains("END_MARKER_PAGE_TWO")
                {
                    break;
                }
                wake_rx.recv().await.unwrap();
            }
        })
        .await;

        let (x, y) = rt
            .find("mission-reader-prev-objective")
            .expect("prev page button");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("START_MARKER_PAGE_ONE")
        );
    });
}

#[test]
fn mission_reader_markdown_links_share_transcript_external_filter() {
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let wake: Wake = Arc::new(|| {});
    let panel = Panel::new(backend, Some("project".into()), Reads::default(), wake);

    const CASES: &[(&str, Option<&str>)] = &[
        ("https://example.org/spec", Some("https://example.org/spec")),
        (
            "http://127.0.0.1:8123/view?a=1#top",
            Some("http://127.0.0.1:8123/view?a=1#top"),
        ),
        (
            "https://[::1]:8080/?filter[]=open",
            Some("https://[::1]:8080/?filter%5B%5D=open"),
        ),
        ("mailto:team@example.org", Some("mailto:team@example.org")),
        ("javascript:alert(1)", None),
        ("data:text/html,payload", None),
        ("file:///etc/passwd", None),
        ("file:///C:/secret.txt", None),
        ("http://alice:demo@example.org/", None),
        ("http://@example.org/", None),
        ("https://.example.org/", None),
        ("https://a..b.org/", None),
        ("https://example.org/%00", None),
        ("https://example.org/%ZZ", None),
        ("mailto:", None),
        ("mailto://evil.example/team", None),
        ("mailto:team@example.org%00", None),
    ];

    let markdown = CASES
        .iter()
        .enumerate()
        .map(|(i, (href, _))| format!("[link-{i}](<{href}>)"))
        .collect::<Vec<_>>()
        .join(" · ");

    struct Harness {
        panel: Panel,
        markdown: String,
    }

    let mut rt = Runtime::new(
        Harness { panel, markdown },
        |h, _| {
            crate::strings::with_locale("en", || {
                let scoped = super::view::Scoped::new(
                    |h: &mut Harness| Some(&mut h.panel),
                    h.panel.scope.clone(),
                );
                super::sections::local_section(
                    &h.panel,
                    &scoped,
                    "links",
                    "missions.control.summary",
                    &h.markdown,
                    false,
                    true,
                )
            })
        },
        (960.0, 720.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    assert!(rt.take_url_requests().is_empty());

    for (href, expected) in CASES {
        let node = rt
            .elements()
            .into_iter()
            .find(|node| node.role == "link" && node.key.as_deref() == Some(*href))
            .unwrap_or_else(|| panic!("missing rendered mission link {href:?}"));
        let [x, y, w, h] = node.rect;
        rt.pointer_down(x + w / 2.0, y + h / 2.0);
        rt.pointer_up(x + w / 2.0, y + h / 2.0);
        rt.frame(0.02);
        let expected_urls: Vec<String> = expected.map(str::to_owned).into_iter().collect();
        assert_eq!(rt.take_url_requests(), expected_urls, "href={href:?}");
    }
}
