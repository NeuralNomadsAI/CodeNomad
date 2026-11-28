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
    let (cancel, _) = CancelToken::new();
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
    let (cancel, cancelled) = CancelToken::new();
    panel.lanes[Kind::Summaries as usize].active = Some((3, cancel));
    panel.show(false);
    assert!(cancelled.is_cancelled());
    let (cancel, _) = CancelToken::new();
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

    // Visual parity: header refresh is a compact right-aligned icon button, and selected row
    // renders a visible status badge inside a highlighted full-row container.
    let elements = rt.elements();
    let refresh = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("missions-refresh"))
        .expect("missions-refresh icon button");
    assert!(
        refresh.rect[2] <= 36.0 && refresh.rect[3] <= 36.0,
        "missions-refresh must be a compact icon button: {:?}",
        refresh.rect
    );
    let heading = elements
        .iter()
        .find(|el| el.role == "heading" && el.rect[1] < 60.0)
        .expect("missions header heading");
    assert!(
        (refresh.rect[1] + refresh.rect[3] / 2.0 - (heading.rect[1] + heading.rect[3] / 2.0)).abs()
            <= 8.0
            && refresh.rect[0] > heading.rect[0] + heading.rect[2],
        "missions-refresh must align on the header row to the right of the heading: refresh={:?} heading={:?}",
        refresh.rect,
        heading.rect
    );
    let container = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("mission-row-container-a"))
        .expect("mission-row-container-a");
    assert!(
        container.fill.a > 0.0,
        "selected mission row container must highlight the entire row: {:?}",
        container.fill
    );
    assert!(
        elements.iter().any(|el| el.role == "status"
            && el.rect[1] >= container.rect[1] - 1.0
            && el.rect[1] <= container.rect[1] + container.rect[3]),
        "mission row must display a visible status badge"
    );

    // Refresh stays enabled even while a summaries read is in flight so coalesced refresh
    // can queue a trailing read and refresh detail/activity/calendars immediately.
    let (cancel, _cancelled) = CancelToken::new();
    rt.state.0.lanes[Kind::Summaries as usize].active = Some((1, cancel));
    rt.frame(0.04);
    assert!(rt.state.0.busy(Kind::Summaries));
    fn find_key<'a>(tree: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if tree["key"] == key {
            Some(tree)
        } else {
            tree["children"]
                .as_array()?
                .iter()
                .find_map(|child| find_key(child, key))
        }
    }
    let busy_tree = rt.accessibility_json();
    let refresh_node = find_key(&busy_tree, "missions-refresh").expect("missions-refresh node");
    assert_ne!(
        refresh_node["disabled"],
        serde_json::Value::Bool(true),
        "missions-refresh must remain enabled while Kind::Summaries is busy: {refresh_node}"
    );
}
