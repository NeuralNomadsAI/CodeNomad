use super::*;
use rune::{Cx, El, Env, Runtime};
use serde_json::json;

#[test]
fn technical_search_uses_native_part_indexes_and_reveals_the_match() {
    use codenomad_client::search::{Hit, Kind};
    for (part, kind) in [
        (1, Kind::Tool),
        (2, Kind::Reasoning),
        (3, Kind::Tool),
        (4, Kind::Tool),
    ] {
        let tail = format!("{}Technical néedle", "x".repeat(11_000));
        let ansi = "\u{1b}[31mTechnical néedle\u{1b}[0m";
        let row=crate::history::decode_message(&json!({
            "id":"tech","type":"assistant","time":{"completed":1},"content":[
                {"type":"unsupported"},
                {"type":"tool","id":"grep","name":"grep","state":{"status":"completed","content":[{"type":"text","text":tail}]}},
                {"type":"reasoning","text":tail},
                    {"type":"tool","id":"shell","name":"bash","state":{"status":"completed","content":[{"type":"text","text":ansi}]}},
                    {"type":"tool","id":"edit","name":"edit","state":{"status":"completed","input":{"filePath":"notes.txt"},
                        "metadata":{"diff":"--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+Technical néedle"}}}
            ]
        })).unwrap();
        let mut s = crate::init();
        s.messages = vec![row.into()];
        owner(&mut s).width = 800.0;
        let highlight = crate::chat::search_hit::SearchHit::new(
            &Hit {
                session: "s".into(),
                message: "tech".into(),
                role: "assistant".into(),
                part,
                kind,
                excerpt: "Technical néedle".into(),
            },
            "technical NÉEDLE",
            false,
        );
        assert_eq!(
            highlight.block(&s.messages[0], 0).unwrap().0,
            match part {
                1 => "tool-tech:4:grep",
                2 => "reasoning-tech:0",
                3 => "tool-tech:5:shell",
                _ => "tool-tech:4:edit",
            }
        );
        s.transcript_display.search_highlight = Some(highlight);
        let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
        rt.frame(0.016);
        rt.update(|s, tx| navigation::seek_message(s, "tech", tx));
        for _ in 0..5 {
            rt.frame(0.016);
        }
        assert!(
            rt.find("history-search-match").is_some(),
            "match in native part {part}"
        );
        rt.update(|s, _| s.transcript_display.search_highlight = None);
        rt.frame(0.016);
        assert!(rt.find("history-search-match").is_none());
    }
}

fn assistant(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"assistant","time":{"completed":1},
        "content":[{"type":"text","text":"Lead"},
            {"type":"tool","id":"inspect","name":"read","state":{"status":"completed","output":"OK"}},
            {"type":"text","text":"Exact destination"}]
    })).unwrap().into()
}

fn user(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"user","text":"Long transcript below this anchor.\n\n".repeat(10)
    }))
    .unwrap()
    .into()
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx))
}

#[test]
fn resident_click_aligns_the_block_and_never_dispatches_a_window() {
    let mut s = crate::init();
    s.messages = std::iter::once(assistant("anchored"))
        .chain((0..35).map(|i| user(&format!("new-{i}"))))
        .collect();
    let (send, commands) = bounded(1);
    s.commands = Some(send);
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    let mut runtime = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|s, tx| {
        assert!(poll(s, tx));
        rune_theme_codenomad::timeline::show_marker(0, tx);
    });
    for _ in 0..6 {
        runtime.frame(0.016);
    }
    let (x, y) = runtime.find("anchored:Assistant:1:false").unwrap();
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    for _ in 0..6 {
        runtime.frame(0.016);
    }
    let history = runtime.presented("history").unwrap().0;
    let block = runtime.presented("fragment-anchored:1").unwrap().0;
    let row = runtime.presented("anchored").unwrap().0;
    assert!(
        (block[1] - history[1]).abs() < 2.0,
        "block {block:?}, history {history:?}"
    );
    assert!(row[1] < block[1]);
    assert!(commands.try_recv().is_err());
}

#[test]
fn a_resident_click_revokes_the_distant_request_and_failed_reads_preserve_rows() {
    let mut s = crate::init();
    s.messages.push(assistant("anchored"));
    let (send, rx) = bounded(1);
    s.commands = Some(send);
    let t = owner(&mut s);
    t.width = 800.0;
    t.online = true;
    t.changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        poll(s, tx);
        let distant = Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        });
        owner(s).markers.insert(0, distant.clone());
        navigation::select(s, &distant.id, tx);
        let crate::transport::Command::Anchor(jump) = rx.try_recv().unwrap() else {
            panic!("expected a jump")
        };
        navigation::failed(s, jump.ticket);
        assert!(owner(s).jump.retry.is_some());
        assert_eq!(s.messages[0].id, "anchored");
        navigation::select(s, &distant.id, tx);
        let crate::transport::Command::Anchor(jump) = rx.try_recv().unwrap() else {
            panic!("expected a jump")
        };
        navigation::select(s, "anchored:Assistant:1:false", tx);
        assert!(jump.cancelled.is_closed());
        assert_eq!(s.messages[0].id, "anchored");
    });
}

#[test]
fn reasoning_uses_the_rendered_run_not_the_native_fragment_ordinal() {
    let row: crate::history::Row = crate::history::decode_message(&json!({
        "id":"think","type":"assistant","time":{"completed":1},
        "content":[{"type":"reasoning","text":""},
            {"type":"reasoning","text":"First reasoning"},
            {"type":"reasoning","text":"Still first"},
            {"type":"text","text":"First response"},
            {"type":"reasoning","text":"Second reasoning"}]
    }))
    .unwrap()
    .into();
    let blocks = crate::chat::anchors::blocks(&row, 0, false);
    let reasoning = blocks
        .iter()
        .filter(|b| b.marker.kind == MarkerKind::Reasoning)
        .map(|b| (b.marker.ordinal, b.key.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        reasoning,
        [(0, "reasoning-think:1"), (1, "reasoning-think:3")]
    );
    let mut state = crate::init();
    state.messages = std::iter::once(row.clone())
        .chain((0..35).map(|i| user(&format!("doc-{i}"))))
        .collect();
    let target = Marker::from(blocks.last().unwrap().marker);
    owner(&mut state).width = 800.0;
    owner(&mut state).changed = true;
    let mut runtime = Runtime::new(state, view, (800.0, 600.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.update(|s, tx| {
        poll(s, tx);
        navigation::select(s, &target.id, tx);
    });
    runtime.frame(0.016);
    let top = runtime.presented("history").unwrap().0[1];
    let group = runtime.presented("reasoning-think:3").unwrap().0[1];
    assert!(
        (top - group).abs() < 2.0,
        "history top {top}, group top {group}"
    );
}

#[test]
fn a_new_resident_jump_rejects_an_older_page_already_in_the_mailbox() {
    let mut s = crate::init();
    s.messages.push(assistant("anchored"));
    s.can_older = true;
    let (send, commands) = bounded(1);
    s.commands = Some(send);
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        poll(s, tx);
        crate::chat::reader::older(s);
        let crate::transport::Command::OlderCancellable(cancelled) = commands.try_recv().unwrap()
        else {
            panic!("older page must be cancellable");
        };
        navigation::select(s, "anchored:Assistant:1:false", tx);
        assert!(cancelled.is_closed());
        crate::chat::reader::older(s);
        assert!(!crate::chat::reader::admit_older(s, &cancelled, || panic!(
            "obsolete page admitted"
        )));
        assert_eq!(s.messages[0].id, "anchored");
        assert!(
            s.paging,
            "an obsolete response must not clear the new request"
        );
    });
}

#[test]
fn reading_line_tracks_the_first_displayed_block_below_its_cutoff() {
    let mut s = crate::init();
    s.messages = std::iter::once(assistant("anchored"))
        .chain((0..35).map(|i| user(&format!("after-{i}"))))
        .collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        poll(s, tx);
        tx.scroll_key_to("anchored/fragment-anchored:1", 0.0);
    });
    for _ in 0..8 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| {
        navigation::poll(s, tx);
    });
    assert_eq!(
        rt.state.transcript_display.timeline.jump.active.as_deref(),
        Some("anchored:Assistant:1:false")
    );
}

#[test]
fn native_system_and_compaction_content_have_exact_rendered_anchors() {
    for (role, field, kind) in [
        ("compaction", "summary", "Compaction"),
        ("system", "text", "System"),
    ] {
        let mut native = json!({"id":"context","type":role});
        native[field] = json!("Native context body");
        let row: crate::history::Row = crate::history::decode_message(&native).unwrap().into();
        assert_eq!(row.body, "Native context body");
        let mut s = crate::init();
        s.messages = std::iter::once(row)
            .chain((0..35).map(|i| user(&format!("after-{i}"))))
            .collect();
        owner(&mut s).width = 800.0;
        owner(&mut s).changed = true;
        let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
        rt.frame(0.016);
        rt.update(|s, tx| {
            poll(s, tx);
            navigation::select(s, &format!("context:{kind}:0:false"), tx);
        });
        for _ in 0..5 {
            rt.frame(0.016);
        }
        let top = rt.presented("history").unwrap().0[1];
        assert!((rt.presented("context-context").unwrap().0[1] - top).abs() < 2.0);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Native context body")
        );
    }
}

#[test]
fn marker_names_are_bounded_and_only_the_current_marker_reports_position() {
    let mut s = crate::init();
    let long = "é".repeat(210) + &"😀".repeat(20);
    let row =
        crate::history::decode_message(&json!({"id":"long","type":"user","text":long})).unwrap();
    s.messages = vec![assistant("anchored"), row.into()];
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        poll(s, tx);
        navigation::select(s, "long:User:0:false", tx);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    let label = view::excerpt(&long);
    assert!(label.ends_with('…') && label.encode_utf16().count() <= 220);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains(&label));
    assert_eq!(
        tree.matches(crate::strings::t("messageTimeline.current"))
            .count(),
        1
    );
}
