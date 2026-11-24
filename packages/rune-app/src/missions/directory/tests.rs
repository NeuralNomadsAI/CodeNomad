use super::*;
use codenomad_client::missions::Status;

fn panel() -> Panel {
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "fixture".into();
    Panel::new(
        backend,
        Some("project".into()),
        Reads::default(),
        std::sync::Arc::new(|| {}),
    )
}

fn summary(id: &str, title: &str) -> Summary {
    Summary {
        id: id.into(),
        title: Some(title.into()),
        objective: "Fixture".into(),
        status: Status::Active,
        run_state: None,
        coordinator_session_id: "ses_fixture".into(),
        actor_count: 1,
        updated_at: 0.0,
        revision: 0,
        finish_sequence: None,
        task_count: None,
    }
}

fn page(project: &str, order: &str, offset: u64, total: u64, rows: Vec<Summary>) -> DirectoryPage {
    DirectoryPage {
        project_id: project.into(),
        finish_high_water: None,
        window: Window {
            order: order.into(),
            offset,
            end: offset + rows.len() as u64,
            total,
        },
        rows: DirectoryRows::Summaries(rows),
    }
}

#[test]
fn keeps_selection_until_complete_coverage_and_pins_it_in_search() {
    let mut panel = panel();
    let kind = Kind::Summaries;
    assert!(panel.accept(
        kind,
        Read::Refresh,
        page("project", "first", 0, 2, vec![summary("a", "Alpha")])
    ));
    assert!(panel.accept(
        kind,
        Read::More,
        page("project", "first", 1, 2, vec![summary("b", "Beta")])
    ));
    panel.select("b");
    panel.filter = TextEdit::new("Alpha");
    assert_eq!(
        panel
            .shown_rows()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert!(panel.accept(
        kind,
        Read::Refresh,
        page("project", "first", 0, 2, vec![summary("a", "Alpha")])
    ));
    assert_eq!(
        panel.summaries.len(),
        2,
        "same snapshot keeps previously loaded rows"
    );
    assert!(panel.accept(
        kind,
        Read::Refresh,
        page("project", "changed", 0, 2, vec![summary("a", "Alpha")])
    ));
    assert_eq!(panel.selected.as_deref(), Some("b"));
    assert!(!panel.accept(
        kind,
        Read::More,
        page("other", "changed", 1, 2, vec![summary("c", "Other")])
    ));
    assert!(!panel.accept(
        kind,
        Read::More,
        page("project", "first", 1, 2, vec![summary("c", "Other")])
    ));
    assert_eq!(
        panel.summaries.len(),
        2,
        "partial refresh retains last-good rows"
    );
    assert!(!panel.covered(kind));
    assert!(panel.accept(
        kind,
        Read::More,
        page("project", "changed", 1, 2, vec![summary("c", "Gamma")])
    ));
    assert!(panel.selected.is_none());
    assert_eq!(
        panel
            .summaries
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "c"]
    );
}

#[test]
fn a_changed_order_parks_retry_at_the_first_window() {
    let mut panel = panel();
    let kind = Kind::Summaries;
    assert!(panel.accept(
        kind,
        Read::Refresh,
        page("project", "first", 0, 2, vec![summary("a", "Alpha")])
    ));
    let (cancel, _) = bounded(1);
    panel.lanes[kind as usize].active = Some((1, cancel));
    panel
        .out
        .try_send(Completion {
            kind,
            read: Read::More,
            serial: 1,
            page: Err(DirectoryChanged.into()),
        })
        .unwrap();
    assert!(panel.poll());
    assert_eq!(panel.lanes[kind as usize].failed, Some(Read::Refresh));
    assert_eq!(panel.summaries.len(), 1);
}

#[test]
fn hide_cancels_reads_and_rejects_stale_completions() {
    let mut panel = panel();
    panel.visible = true;
    let (cancel, cancelled) = bounded(1);
    panel.lanes[Kind::Summaries as usize].active = Some((3, cancel));
    panel.show(false);
    assert!(cancelled.is_closed());
    let (cancel, _) = bounded(1);
    panel.lanes[Kind::Summaries as usize].active = Some((4, cancel));
    panel
        .out
        .try_send(Completion {
            kind: Kind::Summaries,
            read: Read::Refresh,
            serial: 3,
            page: Ok(page(
                "project",
                "old",
                0,
                1,
                vec![summary("other", "Stale")],
            )),
        })
        .unwrap();
    assert!(!panel.poll());
    assert!(panel.summaries.is_empty());
    assert!(panel.busy(Kind::Summaries));
}

#[test]
fn the_read_only_panel_exposes_the_search_status_and_selection() {
    use crate::missions::panel as view;
    use rune::{Env, Runtime};

    let mut state = panel();
    assert!(state.accept(
        Kind::Summaries,
        Read::Refresh,
        page("project", "first", 0, 2, vec![summary("a", "Alpha")])
    ));
    let mut rt = Runtime::new(
        (state, TextEdit::new("")),
        |s, _| {
            crate::strings::with_locale("en", || {
                view(&s.0, |s: &mut (Panel, TextEdit)| (Some(&mut s.0), &mut s.1))
            })
        },
        (360.0, 600.0),
        Env::new(true, 1.0),
    );
    rt.frame(0.0);
    assert!(rt.find("missions-search").is_some());
    let (x, y) = rt.find("mission-row-a").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(rt.state.0.selected.as_deref(), Some("a"));
    fn row(tree: &serde_json::Value) -> Option<&serde_json::Value> {
        if tree["key"] == "mission-row-a" {
            Some(tree)
        } else {
            tree["children"].as_array()?.iter().find_map(row)
        }
    }
    let tree = rt.accessibility_json();
    let row = row(&tree).unwrap();
    assert_eq!(row["name"], "Alpha");
    assert_eq!(row["description"], "Active");
    let tree = tree.to_string();
    assert!(tree.contains("Search filters loaded missions only"));
    assert!(!tree.contains("No missions yet"));
    assert!(!tree.contains("No matching mission"));
}

#[test]
fn owed_refresh_restarts_even_when_the_inflight_read_fails() {
    crate::platform::block_on(async {
        let mut panel = panel();
        panel.visible = true;
        let kind = Kind::Summaries;
        let (cancel, _) = bounded(1);
        panel.lanes[kind as usize].active = Some((1, cancel));
        panel.lanes[kind as usize].owed = true;
        panel
            .out
            .try_send(Completion {
                kind,
                read: Read::Refresh,
                serial: 1,
                page: Err(DirectoryChanged.into()),
            })
            .unwrap();
        assert!(panel.poll());
        assert!(panel.busy(kind));
        assert!(!panel.lanes[kind as usize].owed);
        panel.show(false);
    });
}

#[test]
fn paginated_pending_cleanups_emit_incremental_observation_deltas() {
    let mut panel = panel();
    let total = 250u64;
    let make_page = |offset: u64, count: u64| DirectoryPage {
        project_id: "project".into(),
        finish_high_water: None,
        window: Window {
            order: "ord".into(),
            offset,
            end: offset + count,
            total,
        },
        rows: DirectoryRows::Cleanups(
            (offset..offset + count)
                .map(|i| Cleanup {
                    mission_id: format!("msn-{i}"),
                    deletion_id: format!("del-{i}"),
                    request_id: format!("req-{i}"),
                    expected_revision: 1,
                    delete_managed_sessions: true,
                    objective: String::new(),
                    created_at: i as f64 + 1.0,
                    removed: 0,
                    retained: 0,
                    pending: 1,
                    reasons: Vec::new(),
                    document_pending: None,
                })
                .collect(),
        ),
    };
    assert!(panel.accept(Kind::Cleanups, Read::Refresh, make_page(0, 50)));
    // Initial refresh requests a full scan.
    assert!(matches!(panel.prepare_observed_cleanups(1), Some(None)));
    assert!(panel.prepare_observed_cleanups(1).is_none());

    // Each subsequent page emits only its 50-row incremental delta, not all accumulated rows.
    for page_idx in 1..5u64 {
        assert!(panel.accept(Kind::Cleanups, Read::More, make_page(page_idx * 50, 50)));
        let delta = panel.prepare_observed_cleanups(1);
        match delta {
            Some(Some(rows)) => assert_eq!(rows.len(), 50),
            other => panic!("expected 50-row incremental delta on page {page_idx}, got {other:?}"),
        }
        assert!(panel.prepare_observed_cleanups(1).is_none());
    }
    assert_eq!(panel.cleanups.len(), 250);
}
