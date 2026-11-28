use super::*;
use codenomad_client::search::{Hit, Kind};
use rune::{Cx, El, Env, Runtime};
use rune_theme_codenomad::layout::Layout;

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| {
        let mut overlays = Vec::new();
        super::overlay(s, cx, &mut overlays);
        rune_theme_codenomad::layout::with_overlays(
            rune::col()
                .full_width()
                .full_height()
                .children(super::trigger(s)),
            overlays,
        )
        .key(super::HOST)
    })
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..12 {
        rt.frame(0.016);
    }
}

fn hit(session: &str, message: &str, kind: Kind, excerpt: &str) -> Hit {
    Hit {
        session: session.into(),
        message: message.into(),
        role: "assistant".into(),
        part: 0,
        kind,
        excerpt: excerpt.into(),
    }
}

fn connected_state() -> (State, crate::backend::Backend) {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend.clone()));
    s.transcript_display.timeline.online = true;
    (s, backend)
}

#[test]
fn search_window_surfaces_match_counter_and_tooltips_hold_in_light_and_dark() {
    let inspect = |dark: bool| {
        let (mut s, _) = connected_state();
        let m = state(&mut s);
        m.open = true;
        m.text = "needle".into();
        m.query = TextEdit::new("needle");
        m.selected = Some(1);
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: false,
            examined_before: 0,
            exclusions: Vec::new(),
            page: Page {
                hits: vec![
                    hit("here", "m-0", Kind::Text, "First needle match"),
                    hit("here", "m-1", Kind::Text, "Second needle match"),
                    hit("here", "m-2", Kind::Tool, "Third needle match"),
                ],
                cursor: None,
                scanned: 12,
                skipped: 0,
            },
        });
        let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let panel = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search"))
            .expect("history-search floating panel mounted");
        assert_eq!(panel.role, "region");
        assert_eq!(panel.radius, 0.0, "history-search window must stay square");
        assert!(panel.fill.a > 0.0, "history-search must paint overlay fill");
        let overlay_fill = panel.fill;

        let query_field_fill = elements
            .iter()
            .find(|el| el.path.contains(FIELD) && el.fill.a > 0.0)
            .map(|el| el.fill)
            .expect("query field surface fill");
        assert_ne!(
            query_field_fill, overlay_fill,
            "search input field surface must be distinct from overlay surface (dark={dark})"
        );

        let count = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-count"))
            .expect("match counter badge mounted");
        assert_eq!(count.role, "status");
        assert!(
            count.radius > 0.0,
            "numeric match count badge uses chip radius"
        );
        let count_prefix = format!("{}/", count.path);
        assert!(
            elements
                .iter()
                .any(|el| el.path.starts_with(&count_prefix) && el.text.as_deref() == Some("2 / 3")),
            "match counter must display active/total index"
        );

        for key in [
            "history-search-close",
            "history-search-prev",
            "history-search-next",
        ] {
            let control = elements
                .iter()
                .find(|el| el.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("{key} mounted"));
            assert!(
                control.help.as_deref().is_some_and(|tip| !tip.is_empty()),
                "{key} must expose a hover tooltip"
            );
        }

        assert!(
            elements.iter().any(|el| {
                el.key.as_deref() == Some("history-search-progress") && el.role == "status"
            }),
            "search progress caption must carry status role"
        );

        (overlay_fill, query_field_fill)
    };

    let (light_overlay, light_field) = inspect(false);
    let (dark_overlay, dark_field) = inspect(true);
    assert_ne!(
        light_overlay, dark_overlay,
        "overlay surface must adapt across themes"
    );
    assert_ne!(
        light_field, dark_field,
        "field surface must adapt across themes"
    );
}

#[test]
fn search_status_notes_and_error_alerts_use_semantic_roles_and_ink() {
    for dark in [false, true] {
        let (mut s, _) = connected_state();
        let m = state(&mut s);
        m.open = true;
        m.text = "a".into();
        m.query = TextEdit::new("a");
        m.error = true;
        let (cancel, _cancelled) = bounded(1);
        let (_out, events) = bounded(1);
        m.flight = Some((cancel, events));
        m.results = Some(Ranked::Unsupported);
        s.transcript_display.timeline.jump.filtered = true;

        let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();

        let min_chars = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-min-chars"))
            .expect("min-chars hint mounted");
        assert_eq!(min_chars.radius, 0.0);

        let search_error = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-error"))
            .expect("history-search-error mounted");
        let filtered_alert = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-filtered"))
            .expect("history-search-filtered mounted");
        assert_eq!(search_error.role, "alert");
        assert_eq!(filtered_alert.role, "alert");
        let error_ink = search_error.text_color.expect("search error ink");
        assert_eq!(
            filtered_alert.text_color,
            Some(error_ink),
            "search alerts must share semantic error ink (dark={dark})"
        );

        for note_key in ["history-search-searching", "history-search-unsupported"] {
            let note = elements
                .iter()
                .find(|el| el.key.as_deref() == Some(note_key))
                .unwrap_or_else(|| panic!("{note_key} mounted"));
            assert_eq!(note.role, "status", "{note_key} must use status role");
            assert_eq!(note.radius, 0.0, "{note_key} must not use pill radius");
            assert_ne!(
                note.text_color,
                Some(error_ink),
                "{note_key} must use muted ink, not error ink"
            );
        }

        // RestartRequired inset row + Fresh search action
        rt.update(|s, _| {
            let m = state(s);
            m.flight = None;
            m.error = false;
            m.results = Some(Ranked::RestartRequired);
            s.transcript_display.timeline.jump.filtered = false;
        });
        settle(&mut rt);
        let restart_els = rt.elements();
        let restart_row = restart_els
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-restart-row"))
            .expect("restart row mounted");
        assert_eq!(restart_row.radius, 0.0);
        assert!(
            restart_row.fill.a > 0.0,
            "restart row uses inset surface fill"
        );
        assert!(
            restart_els
                .iter()
                .any(|el| el.key.as_deref() == Some("history-search-fresh") && el.role == "button"),
            "fresh search action button mounted"
        );

        // Empty search results note
        rt.update(|s, _| {
            state(s).results = Some(Ranked::Ranked {
                version: 1,
                capped: false,
                examined_before: 0,
                exclusions: Vec::new(),
                page: Page::default(),
            });
        });
        settle(&mut rt);
        let empty_els = rt.elements();
        let empty = empty_els
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-empty"))
            .expect("empty search note mounted");
        assert_eq!(empty.role, "status");
        assert_eq!(empty.radius, 0.0);
    }
}

#[test]
fn ranked_group_headers_show_worktree_chip_and_inter_session_preview_uses_inset_surface() {
    let inspect = |dark: bool| {
        let (mut s, backend) = connected_state();
        crate::git::connected(&mut s, &backend);
        crate::git::fixture_worktrees(&mut s);

        let m = state(&mut s);
        m.open = true;
        m.ranked = true;
        m.text = "needle".into();
        m.query = TextEdit::new("needle");
        m.selected = Some(0);
        m.labels.fixture_set("other", "Release triage", "review");
        m.preview.body = Some(preview::Body {
            title: "Release triage".into(),
            slug: "review".into(),
            created: Some(1),
            blocks: vec!["Context around the needle match.".into()],
        });
        m.preview.failed = true;
        m.open_error = true;
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: true,
            examined_before: 10,
            exclusions: Vec::new(),
            page: Page {
                hits: vec![hit("other", "msg-1", Kind::Text, "Needle in other session")],
                cursor: None,
                scanned: 25,
                skipped: 1,
            },
        });

        let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let query_field_fill = elements
            .iter()
            .find(|el| el.path.contains(FIELD) && el.fill.a > 0.0)
            .map(|el| el.fill)
            .expect("query field surface fill");

        let group = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-result-group-0"))
            .expect("ranked session group header mounted");
        assert_eq!(group.role, "heading");
        let group_label = group.label.as_deref().expect("group accessible label");
        assert!(
            group_label.contains("Release triage") && group_label.contains("feature"),
            "group label must include session title and worktree label: {group_label}"
        );

        let worktree = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-result-worktree-0"))
            .expect("worktree badge chip mounted");
        assert_eq!(worktree.role, "note");
        assert!(worktree.radius > 0.0, "worktree tag uses chip radius");
        assert!(
            worktree
                .help
                .as_deref()
                .is_some_and(|tip| tip.contains("feature")),
            "worktree badge must carry tooltip naming worktree: {:?}",
            worktree.help
        );

        let preview = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-inter-session-preview"))
            .expect("inter-session preview card mounted");
        assert_eq!(preview.role, "group");
        assert_eq!(
            preview.radius, 0.0,
            "inter-session preview card stays square"
        );
        assert!(
            preview.fill.a > 0.0,
            "inter-session preview must paint inset fill"
        );
        let preview_fill = preview.fill;
        assert_ne!(
            preview_fill, query_field_fill,
            "inter-session preview inset surface must differ from input field surface (dark={dark})"
        );

        let progress_ink = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-search-progress"))
            .and_then(|el| el.text_color)
            .expect("progress caption ink");
        let preview_error = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-preview-error"))
            .expect("history-preview-error mounted");
        let open_error = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("history-preview-open-error"))
            .expect("history-preview-open-error mounted");
        assert_eq!(preview_error.role, "alert");
        assert_eq!(open_error.role, "alert");
        let error_ink = preview_error.text_color.expect("preview error ink");
        assert_eq!(open_error.text_color, Some(error_ink));
        assert_ne!(
            error_ink, progress_ink,
            "preview alerts must use error ink distinct from caption ink (dark={dark})"
        );

        preview_fill
    };

    let light_preview = inspect(false);
    let dark_preview = inspect(true);
    assert_ne!(
        light_preview, dark_preview,
        "inter-session preview inset surface must adapt across themes"
    );
}
