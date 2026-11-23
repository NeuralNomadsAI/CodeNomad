use super::*;
use codenomad_client::search::{Hit, Kind};
use rune::{Cx, El, Env, Mods, Runtime};
use rune_theme_codenomad::layout::Layout;

fn hit(session: &str, message: &str, kind: Kind, part: u64) -> Hit {
    Hit {
        session: session.into(),
        message: message.into(),
        role: "assistant".into(),
        kind,
        part,
        excerpt: "Technical needle".into(),
    }
}

#[test]
fn typing_revokes_an_anchor_before_the_reader_drains_and_retry_uses_current_selection() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    s.transcript_display.timeline.online = true;
    let (out, commands) = bounded(1);
    let (send, incoming) = bounded(1);
    s.commands = Some(out);
    s.incoming = Some(incoming);
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        let m = state(s);
        m.open = true;
        m.query = TextEdit::new("Old phrase");
        m.query.focused = true;
        m.text = "Old phrase".into();
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: false,
            examined_before: 0,
            exclusions: vec![],
            page: Page {
                hits: vec![hit("here", "old", Kind::Tool, 1)],
                ..Page::default()
            },
        });
        select(s, 0, tx);
        tx.focus_when_shown(FOCUS, true);
    });
    rt.frame(0.016);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.path.contains(FIELD) && el.focused)
    );
    let crate::transport::Command::Anchor(jump) = commands.try_recv().unwrap() else {
        panic!("expected jump")
    };
    send.try_send(crate::transport::Event::AnchorFailed(jump.ticket))
        .unwrap();
    rt.key(KeyEvent {
        key: Key::Text(" changed".into()),
        mods: Mods::default(),
    });
    rt.frame(0.016);
    assert!(
        jump.cancelled.is_closed(),
        "the committed edit revokes the ticket before its queued completion"
    );
    rt.update(|s, tx| {
        assert!(crate::poll(s, 1.0, tx));
        super::super::navigation::retry(s, tx);
        assert!(commands.try_recv().is_err());
        assert!(state(s).selected.is_none());
    });
}

#[test]
fn ranked_groups_keep_consecutive_runs_without_reordering() {
    let hits = [
        hit("a", "one", Kind::Text, 0),
        hit("a", "two", Kind::Text, 0),
        hit("b", "three", Kind::Text, 0),
        hit("a", "four", Kind::Text, 0),
    ];
    assert_eq!(super::view::group_starts(&hits), [0, 0, 2, 3]);
}

#[test]
fn an_other_session_preflight_applies_filters_at_completion() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "source".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend.clone()));
    s.chat_title = "Source".into();
    state(&mut s).open = true;
    let (guard, _) = bounded(1);
    let (reply, received) = bounded(1);
    state(&mut s).destination = Some((guard, received));
    backend.session = "other".into();
    let row = crate::history::decode_message(&serde_json::json!({
        "id":"step","type":"assistant","content":[
            {"type":"tool","id":"call","name":"grep","state":{"status":"completed","output":"Needle"}}
        ]
    })).unwrap().into();
    let result = crate::chat::search_hit::SearchHit::new(
        &hit("other", "step", Kind::Tool, 0),
        "Needle",
        false,
    );
    reply
        .try_send(Ok((backend, "Other".into(), "root".into(), result, row)))
        .unwrap();
    let mut rt = Runtime::new(s, view, (900., 600.), Env::new(false, 1.0));
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(
            s,
            serde_json::json!({"toolCallExpansionDefaults":{"tools":{"grep":"hidden"}}}),
        );
        assert!(settle_destination(s, tx));
        assert!(s.transcript_display.timeline.jump.filtered);
        assert!(state(s).open && state(s).destination.is_none());
        assert_eq!(s.chat_title, "Source");
        assert_eq!(
            s.transcript_display
                .timeline
                .backend
                .as_ref()
                .unwrap()
                .session,
            "source"
        );
    });
}

#[test]
fn preview_selection_revokes_a_previous_distant_jump_and_keeps_the_broker_excerpt() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    s.transcript_display.timeline.online = true;
    let (out, commands) = bounded(1);
    s.commands = Some(out);
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        let m = state(s);
        m.open = true;
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: false,
            examined_before: 0,
            exclusions: vec![],
            page: Page {
                hits: vec![
                    hit("here", "old", Kind::Tool, 1),
                    hit("elsewhere", "other", Kind::Reasoning, 4),
                ],
                ..Page::default()
            },
        });
        select(s, 0, tx);
        let crate::transport::Command::Anchor(jump) = commands.try_recv().unwrap() else {
            panic!("expected jump")
        };
        select(s, 1, tx);
        assert!(jump.cancelled.is_closed() && !super::super::navigation::pending_search(s));
        assert!(s.transcript_display.search_highlight.is_none());
        assert_eq!(
            preview::blocks(
                &hit("elsewhere", "other", Kind::Tool, 1),
                &["Earlier preview prefix".into()]
            )
            .collect::<Vec<_>>(),
            ["Technical needle", "Earlier preview prefix"]
        );
    });
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| {
        let mut overlays = Vec::new();
        super::overlay(s, cx, &mut overlays);
        rune_theme_codenomad::layout::with_overlays(
            rune::col().full_width().full_height().children(trigger(s)),
            overlays,
        )
        .key(super::HOST)
    })
}

#[test]
fn the_toolbar_drags_the_search_window_and_resize_keeps_its_close_button_visible() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    let mut rt = Runtime::new(s, view, (900., 600.), Env::new(false, 1.));
    let settle = |rt: &mut Runtime<State>| {
        for _ in 0..12 {
            rt.frame(0.016);
        }
    };
    settle(&mut rt);
    rt.update(|s, tx| {
        state(s).open = true;
        state(s).query.focused = true;
        tx.focus_when_shown(FOCUS, true);
    });
    settle(&mut rt);
    let focused = |rt: &Runtime<State>| {
        rt.elements()
            .iter()
            .any(|el| el.path.contains(FIELD) && el.focused)
    };
    assert!(focused(&rt), "the query has focus before dragging");
    let before = rt.presented("history-search").unwrap().0;
    let [left, top, _, height] = rt.presented("history-search-drag").unwrap().0;
    let (x, y) = (left + 8., top + height / 2.);
    rt.pointer_down(x, y);
    rt.pointer_move(x + 40., y + 80.);
    rt.frame(0.016);
    assert!(
        state(&mut rt.state).drag.is_some(),
        "the title receives the drag"
    );
    assert!(focused(&rt), "dragging must not blur the query field");
    rt.pointer_up(x + 40., y + 80.);
    settle(&mut rt);
    rt.key(KeyEvent {
        key: Key::Text("still focused".into()),
        mods: Mods::default(),
    });
    rt.frame(0.016);
    let dragged = rt.presented("history-search").unwrap().0;
    let model = state(&mut rt.state);
    assert_eq!(model.query.text, "still focused");
    assert!(
        dragged[0] > before[0] + 30. && dragged[1] > before[1] + 70.,
        "before={before:?} after={dragged:?} frame={:?} position={:?}",
        model.frame.0.get(),
        model.position,
    );
    rt.set_viewport((390., 300.), 1.);
    settle(&mut rt);
    let [x, y, w, h] = rt.presented("history-search-close").unwrap().0;
    assert!(
        x >= 0. && y >= 0. && x + w <= 390. && y + h <= 300.,
        "close bounds={:?}",
        [x, y, w, h]
    );
}

#[test]
fn the_short_search_body_scrolls_to_its_cursor_without_moving_the_toolbar() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "here".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    let mut rt = Runtime::new(s, view, (844., 245.), Env::new(false, 1.));
    rt.update(|s, _| {
        let m = state(s);
        m.open = true;
        m.results = Some(Ranked::Ranked {
            version: 1,
            capped: false,
            examined_before: 0,
            exclusions: vec![],
            page: Page {
                hits: (0..20)
                    .map(|i| hit("here", &format!("hit-{i}"), Kind::Text, 0))
                    .collect(),
                cursor: Some("older".into()),
                ..Page::default()
            },
        });
    });
    for _ in 0..12 {
        rt.frame(0.016);
    }
    let toolbar = rt.presented("history-search-close").unwrap().0;
    let [x, y, w, h] = rt.presented("history-search-body").unwrap().0;
    let more = |rt: &Runtime<State>| rt.presented("history-search-more").unwrap().0;
    assert!(more(&rt)[1] >= y + h);
    rt.wheel(x + w / 2., y + h / 2., -3500.);
    for _ in 0..12 {
        rt.frame(0.016);
    }
    let [left, top, width, height] = more(&rt);
    assert!(top >= y && top + height <= y + h + 1.);
    assert_eq!(rt.presented("history-search-close").unwrap().0, toolbar);
    rt.pointer_down(left + width / 2., top + height / 2.);
    rt.pointer_up(left + width / 2., top + height / 2.);
    rt.frame(0.016);
    assert_eq!(state(&mut rt.state).cursor.as_deref(), Some("older"));
}

#[test]
fn keyboard_opens_the_search_and_query_edits_revoke_obsolete_results() {
    let mut s = crate::init();
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend.session = "test-session".into();
    backend.workspace = "test-workspace".into();
    super::super::observe(&mut s, &crate::transport::Event::Connected(backend));
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        assert!(keys(
            s,
            &KeyEvent {
                key: Key::Command('f'),
                mods: Mods {
                    ctrl: true,
                    ..Default::default()
                }
            },
            tx
        ));
    });
    rt.frame(0.016);
    assert!(
        rt.elements()
            .into_iter()
            .any(|el| el.path.contains(FIELD) && el.role == "textbox" && el.focused)
    );
    rt.update(|s, tx| {
        let model = state(s);
        model.query = TextEdit::new("ab");
        query_changed(s, tx);
        poll(s, tx.clock(), tx);
        assert!(state(s).due.is_none());
        let model = state(s);
        model.text = "obsolete".into();
        model.query = TextEdit::new("Été");
        let (signal, cancelled) = bounded(1);
        let (out, events) = bounded(1);
        model.flight = Some((signal, events));
        out.try_send(Message::Complete(Ok(Ranked::Unsupported)))
            .ok()
            .unwrap();
        query_changed(s, tx);
        poll(s, tx.clock(), tx);
        assert!(cancelled.is_closed() && state(s).results.is_none());
        assert_eq!(state(s).due, Some(tx.clock() + DEBOUNCE));
        assert!(keys(
            s,
            &KeyEvent {
                key: Key::Escape,
                mods: Mods::default()
            },
            tx
        ));
        assert!(!is_open(s));
    });
}
