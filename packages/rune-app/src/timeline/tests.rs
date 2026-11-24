use super::*;
use rune::{Cx, El, Env, Runtime, TouchPhase};
use serde_json::json;

#[test]
fn technical_search_uses_native_part_indexes_and_reveals_the_match() {
    use codenomad_client::search::{Hit, Kind};
    for (part, kind) in [
        (1, Kind::Tool),
        (2, Kind::Reasoning),
        (3, Kind::Tool),
        (4, Kind::Tool),
        (5, Kind::Tool),
        (6, Kind::Tool),
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
                        "metadata":{"diff":"--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+Technical néedle"}}},
                {"type":"tool","id":"args","name":"read","state":{"status":"completed","input":{"payload":tail}}},
                {"type":"tool","id":"patch","name":"apply_patch","state":{"status":"completed","metadata":{"files":[
                    {"file":"first.txt","diff":"@@ -1 +1 @@\n-old\n+new"},{"relativePath":"second.txt","patch":"@@ -1 +1 @@\n-old\n+Technical néedle"}
                ]}}}
            ]
        })).unwrap();
        let mut s = crate::init();
        crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
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
                4 => "tool-tech:4:edit",
                5 => "tool-tech:4:args",
                _ => "tool-tech:5:patch",
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

#[test]
fn older_gesture_revokes_the_distant_jump_and_keeps_the_visible_window() {
    let mut s = crate::init();
    s.messages = vec![assistant("visible")];
    s.can_older = true;
    owner(&mut s).online = true;
    let (out, commands) = bounded(1);
    s.commands = Some(out);
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.update(|s, tx| {
        navigation::seek_message(s, "distant", tx);
        let crate::transport::Command::Anchor(jump) = commands.try_recv().unwrap() else {
            panic!("expected jump")
        };
        crate::chat::reader::older(s);
        assert!(jump.cancelled.is_closed());
        assert!(matches!(
            commands.try_recv().unwrap(),
            crate::transport::Command::Page(crate::transport::HistoryEdge::Before, _)
        ));
        assert_eq!(s.messages[0].id, "visible");
        assert!(s.paging);
    });
}

#[test]
fn oldest_supersedes_a_pending_page_and_absent_newer_cursor_is_local() {
    use crate::transport::{
        Command,
        HistoryEdge::{After, Before, Oldest},
    };
    let mut s = crate::init();
    s.can_older = true;
    s.messages.push(assistant("reading"));
    let (out, commands) = bounded(1);
    s.commands = Some(out);
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.update(|s, tx| {
        crate::chat::reader::request_page(s, After);
        assert!(commands.try_recv().is_err());
        crate::chat::reader::request_page(s, Before);
        let Command::Page(Before, cancelled) = commands.try_recv().unwrap() else {
            panic!("older page")
        };
        crate::chat::reader::oldest(s, tx);
        assert!(cancelled.is_closed());
        assert!(matches!(
            commands.try_recv().unwrap(),
            Command::Page(Oldest, _)
        ));
        assert_eq!(s.messages[0].id, "reading");
    });
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
fn touch_release_keeps_the_page_and_a_new_reverse_pan_rejects_its_queued_completion() {
    use crate::transport::{Command, Event, HistoryEdge::Before};
    let mut s = crate::init();
    s.can_older = true;
    s.messages = (0..20).map(|i| user(&format!("row-{i}"))).collect();
    let (out, commands) = bounded(1);
    let (events, incoming) = bounded(1);
    s.commands = Some(out);
    s.incoming = Some(incoming);
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.016);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    for _ in 0..6 {
        rt.frame(0.016);
    }
    assert!(
        commands.try_recv().is_err(),
        "programmatic positioning is local"
    );
    let [x, y, w, h] = rt.presented("history").unwrap().0;
    let x = x + w / 2.0;
    rt.touch(1, TouchPhase::Started, x, y + h * 0.18, 0.2);
    for i in 1..=8 {
        rt.touch(
            1,
            TouchPhase::Moved,
            x,
            y + h * (0.18 + 0.07 * i as f32),
            0.2 + f64::from(i) * 0.016,
        );
        rt.frame(0.016);
    }
    let Command::Page(Before, cancelled) = commands.try_recv().unwrap() else {
        panic!("touch must request older history")
    };
    rt.touch(1, TouchPhase::Ended, x, y + h * 0.74, 0.33);
    for _ in 0..90 {
        rt.frame(0.016);
    }
    assert!(
        !cancelled.is_closed(),
        "the elastic return is not a new reverse gesture"
    );
    assert!(
        commands.try_recv().is_err(),
        "one page per released gesture"
    );
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.path.contains("history-navigation-status") && el.role == "status")
    );
    rt.touch(2, TouchPhase::Started, x, y + h * 0.74, 2.0);
    rt.touch(2, TouchPhase::Moved, x, y + h * 0.20, 2.1);
    rt.frame(0.016);
    events
        .try_send(Event::PageFailed(cancelled.clone()))
        .unwrap();
    rt.frame(0.016);
    assert!(
        cancelled.is_closed(),
        "the reverse gesture must precede queued admission"
    );
    rt.update(|s, _| assert!(!s.history_error && !s.paging));
}

#[test]
fn an_earlier_reader_sync_does_not_allow_a_second_page_and_resident_first_is_local() {
    use crate::{
        history::Page,
        transport::{Command, Event, HistoryEdge::Before},
    };
    let mut s = crate::init();
    s.messages = vec![assistant("resident")];
    s.can_older = true;
    let (out, commands) = bounded(1);
    let (events, incoming) = bounded(1);
    s.commands = Some(out);
    s.incoming = Some(incoming);
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.update(|s, tx| {
        crate::chat::reader::request_page(s, Before);
        let Command::Page(Before, cancelled) = commands.try_recv().unwrap() else {
            panic!("older request")
        };
        events
            .try_send(Event::ReaderSync {
                page: Page {
                    rows: s.messages.clone(),
                    older: Some(json!({"kind":"before","messageID":"resident"})),
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                version: 0,
            })
            .unwrap();
        assert!(crate::poll(s, 1.0, tx));
        assert!(!crate::chat::reader::request_page(s, Before));
        assert!(commands.try_recv().is_err() && !cancelled.is_closed());
        crate::chat::reader::cancel_page(s);
        s.can_older = false;
        crate::chat::reader::oldest(s, tx);
        assert!(commands.try_recv().is_err());
    });
    rt.frame(0.016);
    assert!(rt.find("oldest").is_some());
}

#[test]
fn downwards_input_revokes_oldest_before_admitting_its_response() {
    use crate::transport::{Command, Event, HistoryEdge::Oldest};
    let mut s = crate::init();
    s.can_older = true;
    s.messages = (0..20).map(|i| user(&format!("row-{i}"))).collect();
    let (out, commands) = bounded(1);
    let (events, incoming) = bounded(1);
    s.commands = Some(out);
    s.incoming = Some(incoming);
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.016);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    for _ in 0..6 {
        rt.frame(0.016);
    }
    assert!(
        commands.try_recv().is_err(),
        "programmatic positioning is local"
    );
    rt.update(crate::chat::reader::oldest);
    let Command::Page(Oldest, cancelled) = commands.try_recv().unwrap() else {
        panic!("oldest request");
    };
    let [x, y, w, h] = rt.presented("history").unwrap().0;
    let x = x + w / 2.0;
    rt.frame(0.016);
    rt.touch(1, TouchPhase::Started, x, y + h * 0.76, 0.2);
    for i in 1..=8 {
        rt.touch(
            1,
            TouchPhase::Moved,
            x,
            y + h * (0.76 - 0.07 * i as f32),
            0.2 + f64::from(i) * 0.016,
        );
        rt.frame(0.016);
    }
    events
        .try_send(Event::PageFailed(cancelled.clone()))
        .unwrap();
    rt.frame(0.016);
    assert!(cancelled.is_closed());
    rt.update(|s, _| {
        assert!(!s.history_error);
        assert!(!s.paging);
        assert_eq!(s.messages.first().map(|row| row.id.as_str()), Some("row-0"));
    });
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
    crate::settings::fixture_transcript(&mut state, json!({"showThinkingBlocks":true}));
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
        let crate::transport::Command::Page(crate::transport::HistoryEdge::Before, cancelled) =
            commands.try_recv().unwrap()
        else {
            panic!("older page must be cancellable");
        };
        navigation::select(s, "anchored:Assistant:1:false", tx);
        assert!(cancelled.is_closed());
        crate::chat::reader::older(s);
        assert!(
            crate::chat::reader::admit_page(s, &cancelled, || panic!("obsolete page admitted"))
                .is_none()
        );
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
fn a_collapsed_tool_group_is_the_local_destination_for_its_second_marker() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"toolGroupVisibility":"collapsed"}));
    s.messages.push(
        crate::history::decode_message(&json!({
            "id":"step","type":"assistant","content":[
                {"type":"tool","id":"one","name":"read","state":{"status":"completed","input":{}}},
                {"type":"tool","id":"two","name":"grep","state":{"status":"completed","input":{}}}
            ]
        }))
        .unwrap()
        .into(),
    );
    s.messages
        .extend((0..30).map(|i| user(&format!("after-{i}"))));
    let (commands, sent) = bounded(1);
    s.commands = Some(commands);
    owner(&mut s).width = 800.;
    owner(&mut s).changed = true;
    let mut rt = Runtime::new(s, view, (800., 600.), Env::new(false, 1.0));
    rt.frame(0.016);
    rt.update(|s, tx| {
        poll(s, tx);
        navigation::select(s, "step:Tool:1:false", tx);
    });
    for _ in 0..8 {
        rt.frame(0.016);
    }
    let group = rt.presented("group-tool-step:3:one").unwrap().0[1];
    let top = rt.presented("history").unwrap().0[1];
    assert!((group - top).abs() < 2.);
    assert!(rt.find("tool-step:3:two").is_none());
    assert!(sent.try_recv().is_err());
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
        crate::settings::fixture_transcript(&mut s, json!({"systemMessagesVisibility":"expanded"}));
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
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn hidden_history_invalidation_revokes_the_shared_seed_and_another_occurrence() {
    use crate::files::test_http::{Http, wait};
    use serde_json::json;
    use std::sync::Arc;

    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/project".into());
        let client = backend.clone();
        let load = tokio::spawn(async move {
            client.attest_server().await.unwrap();
            client
                .read_outline_cached(&Default::default(), Some("/project"), None, |_| {
                    panic!("a cold read cannot publish a saved seed")
                })
                .await
                .unwrap()
        });
        http.accept()
            .await
            .reply(200, json!({"apiContract":1,"serverId":"installation"}))
            .await;
        let record = json!({"data":{"id":"session","projectID":"project","location":{"directory":"/project"}}});
        http.accept().await.reply(200, record.clone()).await;
        http.accept()
            .await
            .reply(
                200,
                json!({"status":"outline","total":1,"cursor":null,
                    "entries":[{"id":"old","seq":1,"type":"user","tools":0,"reasoning":0}],
                    "checkpoints":[{"after":-1,"through":1,"digest":"a".repeat(64),"changed":true}]
                }),
            )
            .await;
        http.accept().await.reply(200, record).await;
        let outline = Arc::new(wait(load).await.unwrap());
        let mut s = crate::init();
        super::observe(&mut s, &crate::transport::Event::Connected(backend.clone()));
        super::owner(&mut s).outline = Some(outline.clone());
        let active = std::mem::take(&mut s.transcript_display.timeline);
        crate::workspace::outlines::remember(&mut s, outline.clone());
        super::observe(&mut s, &crate::transport::Event::Connected(backend.clone()));
        assert!(s.workspace.is_none());
        assert!(crate::workspace::outlines::seed(&s, &backend, "/project").is_some());
        super::observe(&mut s, &crate::transport::Event::HistoryInvalidated);
        assert!(crate::workspace::outlines::seed(&s, &backend, "/project").is_none());
        s.transcript_display.timeline = active;
        assert!(super::sync_outline_mutation(&mut s));
        assert!(super::owner(&mut s).outline.is_none());
    });
}

#[test]
fn banners_keep_the_history_viewport_mounted_and_preserve_reading_position() {
    for reduced_motion in [false, true] {
        banners_keep_history_mounted(reduced_motion);
    }
}

fn banners_keep_history_mounted(reduced_motion: bool) {
    let mut s = crate::init();
    s.messages = (0..25).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).changed = true;
    owner(&mut s).backend = Some(codenomad_client::backend::Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "w".into(),
        session: "s".into(),
        client_id: "c".into(),
        session_directory: None,
        fresh_mode: false,
    });
    assert!(demanded(&s));
    let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.set_system_reduced_motion(reduced_motion);
    let settle = |rt: &mut Runtime<State>| {
        for _ in 0..45 {
            rt.frame(0.016);
        }
    };
    rt.frame(0.0);
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-4", -14.0);
    });
    settle(&mut rt);

    let history_path = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some("history"))
            .expect("history viewport mounted")
            .path
    };
    let anchor_offset = |rt: &Runtime<State>| {
        let history = rt.presented("history").unwrap().0;
        let row = rt.presented("row-4").unwrap().0;
        (history[3], row[1] - history[1])
    };
    let expected_path = history_path(&rt);
    let (base_height, expected_offset) = anchor_offset(&rt);
    assert_eq!(rt.scroll_at_bottom("history"), Some(false));
    assert!(
        (expected_offset - (-14.0)).abs() < 1.0,
        "unexpected initial anchor offset: {expected_offset}"
    );

    const BANNERS: [&str; 3] = [
        "timeline-destination-filtered",
        "timeline-jump-retry",
        "timeline-outline-retry",
    ];
    let filtered_text = crate::strings::t("history.destinationFiltered");
    let session_unavailable_text = crate::strings::t("history.sessionUnavailable");
    let outline_unavailable_text = crate::strings::t("history.navigation.outlineUnavailable");
    let retry_text = crate::strings::t("messageSection.search.retry");
    struct Snapshot {
        path: String,
        mounted_banners: Vec<&'static str>,
        visible_banners: Vec<&'static str>,
        mounted_filtered_alerts: Vec<String>,
        visible_filtered_alerts: Vec<String>,
        outline_retry_button: Option<[f32; 4]>,
        any_rail_keys: Vec<String>,
        rail_keys: Vec<String>,
        visible_keys: Vec<String>,
    }
    let snapshot = |rt: &Runtime<State>| {
        let elements = rt.elements();
        let path = elements
            .iter()
            .find(|node| node.key.as_deref() == Some("history"))
            .expect("history viewport mounted")
            .path
            .clone();
        let fully_unclipped = |rect: [f32; 4], visible: [f32; 4]| {
            rect[2] > 0.0
                && rect[3] > 0.0
                && (visible[2] - rect[2]).abs() <= 0.5
                && (visible[3] - rect[3]).abs() <= 0.5
        };
        let banner_ok = |key: Option<&str>,
                         role: &str,
                         text: Option<&str>,
                         path: &str,
                         rect: [f32; 4],
                         visible: [f32; 4]| {
            let prefix = format!("{path}/");
            let children: Vec<_> = elements
                .iter()
                .filter(|child| child.path.starts_with(&prefix))
                .collect();
            let expected_children = match key {
                Some("timeline-destination-filtered") => {
                    role == "alert" && text == Some(filtered_text) && children.is_empty()
                }
                Some("timeline-jump-retry") | Some("timeline-outline-retry") => {
                    let expected_message = if key == Some("timeline-jump-retry") {
                        session_unavailable_text
                    } else {
                        outline_unavailable_text
                    };
                    let message_count = children
                        .iter()
                        .filter(|child| {
                            child.role != "button"
                                && child.text.as_deref() == Some(expected_message)
                        })
                        .count();
                    let button_count = children
                        .iter()
                        .filter(|child| {
                            child.role == "button"
                                && (child.label.as_deref() == Some(retry_text)
                                    || child.text.as_deref() == Some(retry_text))
                        })
                        .count();
                    message_count == 1 && button_count == 1
                }
                _ => true,
            };
            fully_unclipped(rect, visible)
                && expected_children
                && children
                    .iter()
                    .all(|child| fully_unclipped(child.rect, child.visible))
        };
        let mounted_banners = elements
            .iter()
            .filter_map(|node| {
                let key = node.key.as_deref()?;
                BANNERS.iter().copied().find(|banner| *banner == key)
            })
            .collect();
        let visible_banners = elements
            .iter()
            .filter_map(|node| {
                let key = node.key.as_deref()?;
                let banner = BANNERS.iter().copied().find(|banner| *banner == key)?;
                banner_ok(
                    node.key.as_deref(),
                    &node.role,
                    node.text.as_deref(),
                    &node.path,
                    node.rect,
                    node.visible,
                )
                .then_some(banner)
            })
            .collect();
        let mounted_filtered_alerts = elements
            .iter()
            .filter(|node| node.role == "alert" && node.text.as_deref() == Some(filtered_text))
            .map(|node| node.path.clone())
            .collect();
        let visible_filtered_alerts = elements
            .iter()
            .filter(|node| {
                node.role == "alert"
                    && node.text.as_deref() == Some(filtered_text)
                    && banner_ok(
                        node.key.as_deref(),
                        &node.role,
                        node.text.as_deref(),
                        &node.path,
                        node.rect,
                        node.visible,
                    )
            })
            .map(|node| node.path.clone())
            .collect();
        let outline_retry_button = elements
            .iter()
            .find(|node| node.path.contains("/timeline-outline-retry/") && node.role == "button")
            .map(|node| node.rect);
        let any_rail_keys = elements
            .iter()
            .filter(|node| {
                node.path.contains("/timeline/") && node.visible[2] > 0.0 && node.visible[3] > 0.0
            })
            .filter_map(|node| node.key.clone())
            .collect();
        let rail_keys = elements
            .iter()
            .filter(|node| {
                node.path.contains("/timeline/") && fully_unclipped(node.rect, node.visible)
            })
            .filter_map(|node| node.key.clone())
            .collect();
        let visible_keys = elements
            .iter()
            .filter(|node| node.visible[3] > 0.0)
            .filter_map(|node| node.key.clone())
            .collect();
        Snapshot {
            path,
            mounted_banners,
            visible_banners,
            mounted_filtered_alerts,
            visible_filtered_alerts,
            outline_retry_button,
            any_rail_keys,
            rail_keys,
            visible_keys,
        }
    };
    let assert_preserved = |rt: &Runtime<State>, label: &str, banner_key: Option<&str>| {
        let snap = snapshot(rt);
        assert_eq!(snap.path, expected_path, "{label}: history remounted");
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(false),
            "{label}: jumped to bottom"
        );
        let (height, offset) = anchor_offset(rt);
        assert!(
            (offset - expected_offset).abs() < 0.5,
            "{label}: anchor drifted from {expected_offset} to {offset}"
        );
        let expected_banners: Vec<&str> = banner_key.into_iter().collect();
        assert_eq!(
            snap.mounted_banners, expected_banners,
            "{label}: unexpected mounted banners"
        );
        assert_eq!(
            snap.visible_banners, expected_banners,
            "{label}: unexpected visible banners"
        );
        let expect_filtered_alert = banner_key == Some("timeline-destination-filtered")
            || (search::is_open(&rt.state) && rt.state.transcript_display.timeline.jump.filtered);
        assert_eq!(
            snap.mounted_filtered_alerts.len(),
            usize::from(expect_filtered_alert),
            "{label}: unexpected destinationFiltered alerts: {:?}",
            snap.mounted_filtered_alerts
        );
        if banner_key.is_some() {
            assert!(
                height < base_height,
                "{label}: history height {height} did not shrink below {base_height}"
            );
        } else {
            assert!(
                (height - base_height).abs() < 0.5,
                "{label}: history height {height} did not restore to {base_height}"
            );
        }
        snap
    };

    rt.update(|s, _| {
        let t = owner(s);
        t.refresh = false;
        t.outline_error = true;
    });
    settle(&mut rt);
    let retry_snap = assert_preserved(&rt, "outline_error shown", Some("timeline-outline-retry"));
    let [x, y, w, h] = retry_snap
        .outline_retry_button
        .expect("outline retry button");
    rt.pointer_down(x + w / 2.0, y + h / 2.0);
    rt.pointer_up(x + w / 2.0, y + h / 2.0);
    settle(&mut rt);
    assert!(
        !owner(&mut rt.state).outline_error && owner(&mut rt.state).refresh,
        "clicking outline retry must clear error AND request a fresh outline read"
    );
    assert_preserved(&rt, "outline_error cleared", None);

    let retry_marker = Marker::from(timeline::Marker {
        message: "distant",
        kind: MarkerKind::User,
        ordinal: 0,
        continued: false,
        omitted_before: false,
        tool_name: None,
    });
    let (jump_tx, jump_rx) = codenomad_client::bounded(4);
    let mut prev_jump_env = None;
    rt.update(|s, _| {
        let prev_commands = s.commands.replace(jump_tx);
        let t = owner(s);
        prev_jump_env = Some((prev_commands, t.online, t.refresh));
        t.online = true;
        t.refresh = false;
        t.jump.retry = Some(retry_marker.clone());
    });
    settle(&mut rt);
    assert_preserved(&rt, "jump.retry shown", Some("timeline-jump-retry"));
    let [jx, jy, jw, jh] = rt
        .elements()
        .into_iter()
        .find(|n| n.path.contains("/timeline-jump-retry/") && n.role == "button")
        .map(|n| n.rect)
        .expect("timeline-jump-retry button");
    rt.pointer_down(jx + jw / 2.0, jy + jh / 2.0);
    rt.pointer_up(jx + jw / 2.0, jy + jh / 2.0);
    settle(&mut rt);
    match jump_rx
        .try_recv()
        .expect("jump retry button must dispatch Command::Anchor")
    {
        crate::transport::Command::Anchor(jump) => assert_eq!(jump.message, "distant"),
        other => panic!("unexpected command from jump retry button: {other:?}"),
    }
    assert!(owner(&mut rt.state).jump.retry.is_none());
    assert_preserved(&rt, "jump.retry cleared", None);
    rt.update(|s, _| {
        navigation::cancel_jump(s);
        let (prev_commands, prev_online, prev_refresh) = prev_jump_env.take().unwrap();
        s.commands = prev_commands;
        let t = owner(s);
        t.online = prev_online;
        t.refresh = prev_refresh;
    });
    settle(&mut rt);

    rt.update(|s, _| owner(s).jump.filtered = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "destinationFiltered shown",
        Some("timeline-destination-filtered"),
    );
    rt.update(|s, _| owner(s).jump.filtered = false);
    settle(&mut rt);
    assert_preserved(&rt, "destinationFiltered cleared", None);

    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "transition outline_error",
        Some("timeline-outline-retry"),
    );
    rt.update(|s, _| owner(s).jump.retry = Some(retry_marker));
    settle(&mut rt);
    assert_preserved(&rt, "transition jump.retry", Some("timeline-jump-retry"));
    rt.update(|s, _| owner(s).jump.filtered = true);
    settle(&mut rt);
    assert_preserved(
        &rt,
        "transition destinationFiltered",
        Some("timeline-destination-filtered"),
    );
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    settle(&mut rt);
    let search_jump_snap = assert_preserved(
        &rt,
        "search open falls through to jump.retry",
        Some("timeline-jump-retry"),
    );
    let assert_search_filtered_alert = |snap: &Snapshot| {
        assert_eq!(
            snap.mounted_filtered_alerts.len(),
            1,
            "expected one mounted destinationFiltered alert"
        );
        assert_eq!(
            snap.visible_filtered_alerts, snap.mounted_filtered_alerts,
            "destinationFiltered alert must be completely visible without clipping"
        );
        assert!(
            snap.visible_filtered_alerts[0].contains("/history-search-body/"),
            "destinationFiltered alert must belong to history-search-body: {}",
            snap.visible_filtered_alerts[0]
        );
    };
    assert_search_filtered_alert(&search_jump_snap);
    rt.update(|s, _| owner(s).jump.retry = None);
    settle(&mut rt);
    let search_outline_snap = assert_preserved(
        &rt,
        "search open falls through to outline_error",
        Some("timeline-outline-retry"),
    );
    assert_search_filtered_alert(&search_outline_snap);
    rt.update(|s, _| search::close(s));
    settle(&mut rt);
    assert!(!owner(&mut rt.state).jump.filtered);
    let closed_snap = assert_preserved(
        &rt,
        "search closed clears destinationFiltered and keeps outline_error",
        Some("timeline-outline-retry"),
    );
    assert!(
        closed_snap.mounted_filtered_alerts.is_empty(),
        "no destinationFiltered alert (even clipped) may remain mounted after search closes: {:?}",
        closed_snap.mounted_filtered_alerts
    );
    let has_any_rail_marker = |snap: &Snapshot, id: &str| {
        let key = format!("{id}:User:0:false");
        snap.any_rail_keys.iter().any(|k| k == &key)
    };
    let has_rail_marker_key = |snap: &Snapshot, key: &str| snap.rail_keys.iter().any(|k| k == key);
    let has_rail_marker = |snap: &Snapshot, id: &str| {
        let key = format!("{id}:User:0:false");
        has_rail_marker_key(snap, &key)
    };
    let is_row_visible = |rt: &Runtime<State>, snap: &Snapshot, id: &str| {
        let hist = rt.presented("history").expect("history presented").0;
        rt.presented(id).is_some_and(|(row, _)| {
            row[3] > 0.0
                && row[1] + row[3] > hist[1] + 0.5
                && row[1] < hist[1] + hist[3] - 0.5
                && snap.visible_keys.iter().any(|k| k == id)
        })
    };
    let assert_bottom_snapshot = |rt: &Runtime<State>, label: &str| {
        let snap = snapshot(rt);
        assert_eq!(snap.path, expected_path, "{label}: history remounted");
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(true),
            "{label}: lost bottom follow"
        );
        snap
    };
    rt.update(|s, _| {
        let msg = user("row-mid");
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let mid_snap = assert_preserved(
        &rt,
        "mid-scroll append with outline_error keeps anchor and updates rail",
        Some("timeline-outline-retry"),
    );
    assert!(
        !is_row_visible(&rt, &mid_snap, "row-mid"),
        "row-mid must remain off-screen while anchored mid-transcript"
    );
    assert!(
        !has_any_rail_marker(&mid_snap, "row-mid"),
        "row-mid marker starts completely below the visible rail while anchored at row-4"
    );
    assert_eq!(
        owner(&mut rt.state)
            .markers
            .last()
            .map(|m| m.message.as_str()),
        Some("row-mid")
    );
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let cleared_snap = assert_preserved(&rt, "transition cleared", None);
    assert!(
        !has_any_rail_marker(&cleared_snap, "row-mid"),
        "row-mid marker must stay completely below the taller banner-free rail before returning to bottom"
    );

    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    let bottom_snap = assert_bottom_snapshot(&rt, "scroll to bottom");
    assert!(
        is_row_visible(&rt, &bottom_snap, "row-mid"),
        "row-mid must be visible after returning to bottom"
    );
    assert!(
        has_rail_marker(&bottom_snap, "row-mid"),
        "rail must reveal off-screen row-mid marker after returning to bottom"
    );
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-mid:User:0:false")
    );
    let offset_before_unlocked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    let offset_after_unlocked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-mid:User:0:false")
    );
    assert!(
        offset_after_unlocked_banner > offset_before_unlocked_banner + 10.0,
        "banner shrinking the rail must scroll to re-reveal unchanged active marker row-mid: before={offset_before_unlocked_banner}, after={offset_after_unlocked_banner}"
    );
    let outline_bottom_snap = assert_bottom_snapshot(&rt, "outline_error at bottom");
    assert!(
        has_rail_marker(&outline_bottom_snap, "row-mid"),
        "shrinking the rail for a banner must automatically re-reveal unchanged active marker row-mid"
    );
    let active_before_25 = owner(&mut rt.state).jump.active.clone();
    rt.update(|s, _| {
        let msg = user("row-25");
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let post_25_snap = assert_bottom_snapshot(&rt, "row-25 appended with outline_error");
    assert!(is_row_visible(&rt, &post_25_snap, "row-25"));
    let active_after_25 = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active reading-line marker after row-25");
    assert_ne!(Some(active_after_25.clone()), active_before_25);
    assert!(
        has_rail_marker_key(&post_25_snap, active_after_25.as_str()),
        "rail must automatically reveal active marker {active_after_25} while following bottom"
    );
    assert!(has_rail_marker(&post_25_snap, "row-25"));
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let _ = assert_bottom_snapshot(&rt, "outline_error cleared at bottom");
    rt.update(|s, _| {
        let msg: crate::history::Row = crate::history::decode_message(&json!({
            "id": "row-26",
            "type": "user",
            "text": "Long transcript below this anchor.\n\n".repeat(14)
        }))
        .unwrap()
        .into();
        s.messages.push(msg.clone());
        s.revision += 1;
        observe(s, &crate::transport::Event::Message((*msg).clone()));
    });
    settle(&mut rt);
    let post_26_snap = assert_bottom_snapshot(&rt, "row-26 appended after banner clears");
    assert!(is_row_visible(&rt, &post_26_snap, "row-26"));
    let active_after_26 = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active reading-line marker after row-26");
    assert_eq!(active_after_26, "row-26:User:0:false");
    assert!(
        has_rail_marker_key(&post_26_snap, active_after_26.as_str()),
        "rail must automatically reveal active marker {active_after_26} after banner clears"
    );
    assert!(
        !rune_theme_codenomad::timeline::fits(419.0) && rune_theme_codenomad::timeline::fits(420.0),
        "test expects TIMELINE_MIN_WIDTH boundary at 420 px"
    );
    rt.set_viewport((419.0, 600.0), 1.0);
    settle(&mut rt);
    assert!(
        rt.presented("timeline").is_none(),
        "viewport 1 px below TIMELINE_MIN_WIDTH must unmount the rail"
    );
    rt.set_viewport((420.0, 600.0), 1.0);
    settle(&mut rt);
    let remounted_snap = snapshot(&rt);
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 10.0
            && has_rail_marker(&remounted_snap, "row-26"),
        "widening back to TIMELINE_MIN_WIDTH must re-reveal row-26 on the remounted rail"
    );
    let assert_rail_integrity = |rt: &Runtime<State>, label: &str| {
        let elements = rt.elements();
        let rail = rt.presented("timeline").expect("timeline presented").0;
        let t = &rt.state.transcript_display.timeline;
        let at = t.scroll.get().at;
        let mut counts = std::collections::HashMap::<String, usize>::new();
        let mut overlaps = std::collections::HashMap::<String, f32>::new();
        let mut visible_counts = std::collections::HashMap::<String, usize>::new();
        for node in elements
            .iter()
            .filter(|n| n.path.contains("/timeline/") && n.role == "button")
        {
            let key = node
                .key
                .as_deref()
                .unwrap_or_else(|| panic!("{label}: rail button missing key"));
            *counts.entry(key.to_string()).or_default() += 1;
            let overlap =
                (node.rect[1] + node.rect[3]).min(rail[1] + rail[3]) - node.rect[1].max(rail[1]);
            overlaps.insert(key.to_string(), overlap);
            if overlap > 0.5 {
                assert!(
                    node.visible[2] > 0.0
                        && node.visible[3] > 0.0
                        && (node.visible[2] - node.rect[2]).abs() <= 0.5
                        && (node.visible[3] - overlap).abs() <= 1.0,
                    "{label}: overlapping rail marker {key} unexpectedly clipped: rect={:?}, visible={:?}, rail={rail:?}, overlap={overlap}",
                    node.rect,
                    node.visible
                );
                *visible_counts.entry(key.to_string()).or_default() += 1;
            }
        }
        for (key, count) in &counts {
            assert_eq!(*count, 1, "{label}: duplicate rail marker key {key}");
        }
        let range = rune_theme_codenomad::timeline::visible_markers(at, t.markers.len());
        assert!(!range.is_empty(), "{label}: empty visible marker range");
        let mut verified = 0usize;
        for m in &t.markers[range.clone()] {
            assert_eq!(
                counts.get(&m.id).copied(),
                Some(1),
                "{label}: expected visible rail marker {} missing or duplicated",
                m.id
            );
            let overlap = overlaps.get(&m.id).copied().unwrap_or(0.0);
            if overlap > 0.5 {
                assert_eq!(
                    visible_counts.get(&m.id).copied(),
                    Some(1),
                    "{label}: overlapping visible rail marker {} was clipped",
                    m.id
                );
                verified += 1;
            }
        }
        assert!(
            verified >= range.len().saturating_sub(2) && verified > 0,
            "{label}: expected interior visible rail markers verified (verified={verified}, range={range:?})"
        );
    };
    assert_rail_integrity(&rt, "remounted at TIMELINE_MIN_WIDTH");
    rt.set_viewport((800.0, 600.0), 1.0);
    settle(&mut rt);
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    settle(&mut rt);
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "history search must be open and mounted before showMessageTimeline toggle"
    );
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }))
    });
    settle(&mut rt);
    assert!(
        rt.presented("timeline").is_none(),
        "disabling showMessageTimeline while search is open must unmount the rail"
    );
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "disabling showMessageTimeline must keep history search open and mounted"
    );
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }))
    });
    settle(&mut rt);
    assert!(
        search::is_open(&rt.state) && rt.presented("history-search-body").is_some(),
        "re-enabling showMessageTimeline must keep history search open and mounted"
    );
    let reopened_snap = snapshot(&rt);
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 10.0
            && has_rail_marker(&reopened_snap, "row-26"),
        "re-enabling showMessageTimeline while search is open at identical geometry must re-reveal row-26"
    );
    assert_rail_integrity(&rt, "reopened with search open");
    rt.update(|s, _| search::close(s));
    settle(&mut rt);
    let before_up_snap = snapshot(&rt);
    assert!(
        !has_any_rail_marker(&before_up_snap, "row-8"),
        "row-8 must start completely above the visible rail before upward interior reveal"
    );
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-8", 0.0);
    });
    settle(&mut rt);
    let mid_up_at = owner(&mut rt.state).scroll.get().at;
    let mid_up_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-8:User:0:false")
    );
    let mid_up_rail = rt.presented("timeline").expect("timeline presented").0;
    let mid_up_marker = rt
        .presented("row-8:User:0:false")
        .expect("row-8 rail marker presented")
        .0;
    assert!(
        mid_up_at.offset[1] > 0.5
            && mid_up_at.offset[1] < mid_up_at.max[1] - 0.5
            && (mid_up_marker[1] - mid_up_rail[1]).abs() <= 2.0,
        "revealing mid-rail row-8 from bottom must align it to the top edge of the rail: offset={mid_up_at:?}, rail={mid_up_rail:?}, marker={mid_up_marker:?}"
    );
    assert!(
        has_rail_marker(&mid_up_snap, "row-8"),
        "rail must reveal mid-rail marker row-8 cleanly inside the viewport"
    );
    assert_rail_integrity(&rt, "interior upward reveal");
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-25", 0.0);
    });
    settle(&mut rt);
    let mid_down_at = owner(&mut rt.state).scroll.get().at;
    let mid_down_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-25:User:0:false")
    );
    let mid_down_rail = rt.presented("timeline").expect("timeline presented").0;
    let mid_down_marker = rt
        .presented("row-25:User:0:false")
        .expect("row-25 rail marker presented")
        .0;
    assert!(
        mid_down_at.offset[1] > mid_up_at.offset[1] + 5.0
            && mid_down_at.offset[1] < mid_down_at.max[1] - 0.5
            && ((mid_down_marker[1] + mid_down_marker[3]) - (mid_down_rail[1] + mid_down_rail[3]))
                .abs()
                <= 2.0,
        "revealing interior below-viewport row-25 must align it to the bottom edge of the rail: up={mid_up_at:?}, down={mid_down_at:?}, rail={mid_down_rail:?}, marker={mid_down_marker:?}"
    );
    assert!(
        has_rail_marker(&mid_down_snap, "row-25"),
        "rail must reveal interior marker row-25 cleanly inside the viewport"
    );
    assert_rail_integrity(&rt, "interior downward reveal");
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    // Manually browse the rail before clicking row-26 so settle() must clear browse mode.
    let browse_rail = rt.presented("timeline").expect("timeline presented").0;
    let offset_before_browse = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.wheel_xy(
        browse_rail[0] + browse_rail[2] / 2.0,
        browse_rail[1] + browse_rail[3] / 2.0,
        0.0,
        200.0,
    );
    settle(&mut rt);
    let offset_after_browse_up = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_after_browse_up < offset_before_browse - 100.0
            && owner(&mut rt.state).jump.is_browsing(),
        "wheeling the rail must actually scroll it and enter browse mode: before={offset_before_browse}, after={offset_after_browse_up}"
    );
    rt.wheel_xy(
        browse_rail[0] + browse_rail[2] / 2.0,
        browse_rail[1] + browse_rail[3] / 2.0,
        0.0,
        -200.0,
    );
    settle(&mut rt);
    assert!(
        owner(&mut rt.state).jump.is_browsing(),
        "browsing back down to row-26 must still be in browse mode before clicking"
    );
    let (lock_x, lock_y) = rt
        .find("row-26:User:0:false")
        .expect("visible row-26 rail button to click");
    rt.pointer_down(lock_x, lock_y);
    rt.pointer_up(lock_x, lock_y);
    settle(&mut rt);
    assert!(
        !owner(&mut rt.state).jump.is_browsing() && owner(&mut rt.state).jump.is_locked(),
        "clicking row-26 must lock selection and exit browse mode"
    );
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-4", -14.0);
    });
    settle(&mut rt);
    let pre_locked_snap = snapshot(&rt);
    assert!(
        is_row_visible(&rt, &pre_locked_snap, "row-4")
            && !is_row_visible(&rt, &pre_locked_snap, "row-26"),
        "transcript must be anchored at row-4 with locked row-26 off-screen before narrow round-trip"
    );
    rt.set_viewport((419.0, 600.0), 1.0);
    settle(&mut rt);
    assert!(rt.presented("timeline").is_none());
    let narrow_locked_snap = snapshot(&rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(false),
        "narrowing below TIMELINE_MIN_WIDTH must not jump history to bottom"
    );
    assert!(
        (anchor_offset(&rt).1 - expected_offset).abs() < 0.5
            && is_row_visible(&rt, &narrow_locked_snap, "row-4")
            && !is_row_visible(&rt, &narrow_locked_snap, "row-26")
            && owner(&mut rt.state).jump.is_locked(),
        "transcript anchor and locked row-26 must stay preserved while narrowed at 419 px"
    );
    rt.set_viewport((800.0, 600.0), 1.0);
    settle(&mut rt);
    let after_narrow_locked_snap = snapshot(&rt);
    assert_eq!(
        rt.scroll_at_bottom("history"),
        Some(false),
        "narrow/wide round-trip must not jump history to bottom"
    );
    assert!(
        (anchor_offset(&rt).1 - expected_offset).abs() < 0.5
            && is_row_visible(&rt, &after_narrow_locked_snap, "row-4")
            && !is_row_visible(&rt, &after_narrow_locked_snap, "row-26"),
        "transcript must remain anchored at row-4 with locked row-26 off-screen after narrow/wide round-trip"
    );
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-26:User:0:false"),
        "narrowing below TIMELINE_MIN_WIDTH and widening back must preserve locked row-26"
    );
    assert!(
        has_rail_marker(&after_narrow_locked_snap, "row-26"),
        "widening back after browsing + locking row-26 must re-reveal row-26 on the remounted rail"
    );
    assert_rail_integrity(&rt, "remounted with locked row-26");
    // A horizontal-only wheel event on the rail must leave positions untouched and not suppress reveal.
    let horiz_rail = rt.presented("timeline").expect("timeline presented").0;
    let rail_before_horiz = owner(&mut rt.state).scroll.get().at.offset[1];
    let anchor_before_horiz = anchor_offset(&rt).1;
    rt.wheel_xy(
        horiz_rail[0] + horiz_rail[2] / 2.0,
        horiz_rail[1] + horiz_rail[3] / 2.0,
        40.0,
        0.0,
    );
    settle(&mut rt);
    let offset_before_locked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        (offset_before_locked_banner - rail_before_horiz).abs() <= 0.5
            && (anchor_offset(&rt).1 - anchor_before_horiz).abs() <= 0.5
            && !owner(&mut rt.state).jump.is_browsing(),
        "horizontal-only wheel on rail must not move rail/transcript or set browse mode"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    settle(&mut rt);
    let offset_after_locked_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    let locked_snap = snapshot(&rt);
    assert_eq!(
        owner(&mut rt.state).jump.active.as_deref(),
        Some("row-26:User:0:false")
    );
    assert!(
        offset_after_locked_banner > offset_before_locked_banner + 10.0,
        "banner shrinking the rail must actually scroll to re-reveal bottom-edge locked row-26: before={offset_before_locked_banner}, after={offset_after_locked_banner}"
    );
    assert!(
        has_rail_marker(&locked_snap, "row-26"),
        "shrinking the rail while row-26 is locked must automatically keep row-26 fully visible"
    );
    assert_rail_integrity(&rt, "locked banner shrink");
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    let before_race = owner(&mut rt.state).scroll.get().at;
    let offset_before_wheel = before_race.offset[1];
    let viewport_before_wheel = before_race.viewport[1];
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let after_shrink_layout = owner(&mut rt.state).scroll.get().at;
    assert!(
        after_shrink_layout.viewport[1] < viewport_before_wheel - 10.0
            && (after_shrink_layout.offset[1] - offset_before_wheel).abs() <= 0.5,
        "banner shrink must measure a shorter rail before the next poll reveals: before={before_race:?}, after={after_shrink_layout:?}"
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    assert!(
        offset_before_wheel > 130.0,
        "precondition: rail offset must stay strictly interior across all wheel deltas: {offset_before_wheel}"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "colliding same-frame wheel_xy must engage RailWheelOverride ownership"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        25.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "follow-up delta within WHEEL_IDLE must still be handled by RailWheelOverride"
    );
    settle(&mut rt);
    let offset_after_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    let expected_wheel_offset = offset_before_wheel - 95.0;
    assert!(
        offset_after_wheel > 25.0 && (offset_after_wheel - expected_wheel_offset).abs() <= 2.0,
        "same-frame multi-delta wheel_xy and follow-up delta on the shrunk rail must all accumulate interior to bounds: before={offset_before_wheel}, expected={expected_wheel_offset}, actual={offset_after_wheel}"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        20.0,
    );
    settle(&mut rt);
    let offset_after_new_gesture = owner(&mut rt.state).scroll.get().at.offset[1];
    let expected_new_gesture = offset_after_wheel - 20.0;
    assert!(
        offset_after_new_gesture > 5.0
            && (offset_after_new_gesture - expected_new_gesture).abs() <= 2.0
            && !owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        "subsequent wheel gesture after idle timeout must scroll natively without RailWheelOverride ownership: before={offset_after_wheel}, expected={expected_new_gesture}, actual={offset_after_new_gesture}"
    );

    // Moving the pointer left into the transcript mid-owned-burst must stop scrolling the rail and
    // forward deltas to the transcript (accumulating multiple deltas within the same frame), and
    // returning to the rail in the same frame must keep accumulating onto the first rail delta.
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let rail_before_same_frame = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_before_same_frame = owner(&mut rt.state).scroll.get().viewport.offset[1];
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        45.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        35.0,
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        25.0,
    );
    rt.frame(0.016);
    let rail_after_same_frame = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_after_same_frame = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && ((rail_before_same_frame - rail_after_same_frame) - 65.0).abs() <= 2.0
            && ((hist_before_same_frame - hist_after_same_frame) - 80.0).abs() <= 2.0,
        "same-frame rail -> multi-delta transcript -> rail must accumulate both rail (65px) and transcript (80px) deltas: rail={rail_before_same_frame}->{rail_after_same_frame}, hist={hist_before_same_frame}->{hist_after_same_frame}"
    );

    // Drifting from an owned rail burst over an open floating search window must NOT scroll the
    // transcript behind it or run hand_scrolled(false) (which would clear browse and cancel jumps).
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let (cmd_tx, cmd_rx) = codenomad_client::bounded(8);
    rt.update(|s, _| {
        s.commands = Some(cmd_tx);
        owner(s).outline_error = false;
    });
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let sx = search_rect[0] + search_rect[2] / 2.0;
    let sy = search_rect[1] + search_rect[3] / 2.0;
    assert!(
        sx >= hist_rect[0]
            && sx <= hist_rect[0] + hist_rect[2]
            && sy >= hist_rect[1]
            && sy <= hist_rect[1] + hist_rect[3],
        "precondition: search overlay center ({sx}, {sy}) must overlap history {hist_rect:?}"
    );
    let hist_before_overlay = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_hit_y = (search_rect[1] + search_rect[3] + 12.0)
        .max(rail_rect[1] + 8.0)
        .min(rail_rect[1] + rail_rect[3] - 8.0);
    rt.wheel_xy(rail_rect[0] + rail_rect[2] / 2.0, rail_hit_y, 0.0, 40.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail wheel burst must be owned by RailWheelOverride before drifting over search"
    );
    rt.wheel_xy(sx, sy, 0.0, 60.0);
    rt.frame(0.016);
    let hist_after_overlay = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (hist_after_overlay - hist_before_overlay).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "wheel drifting over open search overlay must not scroll transcript or clear rail browse: hist={hist_before_overlay}->{hist_after_overlay}"
    );
    // Still inside the same owned burst, drifting onto an uncovered area of history MUST scroll.
    let uncovered_x = hist_rect[0] + hist_rect[2] / 2.0;
    let uncovered_y =
        (search_rect[1] + search_rect[3] + 24.0).min(hist_rect[1] + hist_rect[3] - 8.0);
    assert!(
        uncovered_y > search_rect[1] + search_rect[3] + 1.0
            && uncovered_y < hist_rect[1] + hist_rect[3],
        "precondition: uncovered history point ({uncovered_x}, {uncovered_y}) must lie below search {search_rect:?} inside history {hist_rect:?}"
    );
    rt.wheel_xy(uncovered_x, uncovered_y, 0.0, 35.0);
    rt.frame(0.016);
    let hist_after_uncovered = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_overlay - hist_after_uncovered) - 35.0).abs() <= 2.0,
        "same owned burst moving off search onto uncovered history must scroll transcript by 35px: hist={hist_before_overlay}->{hist_after_uncovered}"
    );
    // Drag the search window right so it overlaps the rail; wheeling on the overlap (including
    // during an owned rail burst started on an uncovered portion of the rail) must NOT scroll the
    // rail behind it.
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let drag_rect = rt
        .presented("history-search-drag")
        .expect("history-search-drag presented")
        .0;
    let drag_x = drag_rect[0] + drag_rect[2] / 2.0;
    let drag_y = drag_rect[1] + drag_rect[3] / 2.0;
    let shift_x = (rail_rect[0] + rail_rect[2] / 2.0) - (search_rect[0] + search_rect[2] - 8.0);
    let shift_y = (rail_rect[1] + 40.0 - search_rect[1]).max(0.0);
    rt.pointer_down(drag_x, drag_y);
    rt.pointer_move(drag_x + shift_x.max(20.0), drag_y + shift_y);
    rt.pointer_up(drag_x + shift_x.max(20.0), drag_y + shift_y);
    rt.frame(0.016);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let dragged_search = rt
        .presented("history-search")
        .expect("dragged history-search presented")
        .0;
    let overlap_x0 = dragged_search[0].max(rail_rect[0]);
    let overlap_x1 = (dragged_search[0] + dragged_search[2]).min(rail_rect[0] + rail_rect[2]);
    let overlap_y0 = dragged_search[1].max(rail_rect[1]);
    let overlap_y1 = (dragged_search[1] + dragged_search[3]).min(rail_rect[1] + rail_rect[3]);
    assert!(
        overlap_x1 - overlap_x0 > 2.0 && overlap_y1 - overlap_y0 > 2.0,
        "precondition: dragged search {dragged_search:?} must overlap rail {rail_rect:?}"
    );
    // Start an owned rail burst on an uncovered portion of the rail outside the dragged search window,
    // then drift directly onto the overlap with the search window.
    let uncovered_rail_y = if dragged_search[1] - rail_rect[1] >= 16.0 {
        rail_rect[1] + 8.0
    } else {
        (dragged_search[1] + dragged_search[3] + 12.0).min(rail_rect[1] + rail_rect[3] - 8.0)
    };
    assert!(
        uncovered_rail_y < dragged_search[1] - 1.0
            || uncovered_rail_y > dragged_search[1] + dragged_search[3] + 1.0,
        "precondition: uncovered_rail_y={uncovered_rail_y} must lie outside dragged_search={dragged_search:?} inside rail={rail_rect:?}"
    );
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        uncovered_rail_y,
        0.0,
        20.0,
    );
    rt.frame(0.016);
    let rail_before_covered = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail wheel burst must be owned before drifting onto overlapping search window"
    );
    rt.wheel_xy(
        (overlap_x0 + overlap_x1) / 2.0,
        (overlap_y0 + overlap_y1) / 2.0,
        0.0,
        50.0,
    );
    rt.frame(0.016);
    let rail_after_covered = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        (rail_after_covered - rail_before_covered).abs() <= 1.0,
        "wheel over search window overlapping the rail must not scroll the rail behind it: rail={rail_before_covered}->{rail_after_covered}"
    );
    rt.update(|s, _| {
        search::close(s);
        owner(s).outline_error = false;
    });
    settle(&mut rt);

    // Drifting from an owned rail burst onto an open rail preview tooltip (`timeline-peek`) must
    // scroll `timeline-peek` itself without scrolling the transcript behind it or clearing browse.
    // Give rows overflowing multi-line content so `timeline-peek` has vertical scroll range.
    rt.update(|s, tx| {
        s.window_size = [800.0, 600.0];
        owner(s).outline_error = false;
        let long_body = (0..40)
            .map(|line| format!("Preview line {line} with enough words to overflow the tooltip"))
            .collect::<Vec<_>>()
            .join("\n");
        for row in &mut s.messages {
            let id = row.id.clone();
            *row = crate::history::decode_message(&json!({
                "id": id,
                "type": "user",
                "text": long_body,
            }))
            .unwrap()
            .into();
        }
        s.revision += 1;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let marker_rect = rt
        .elements()
        .into_iter()
        .find(|n| {
            n.path.contains("/timeline/")
                && n.role == "button"
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
                && n.rect[1] >= rail_rect[1] + 24.0
                && n.rect[1] + n.rect[3] <= rail_rect[1] + rail_rect[3] - 24.0
        })
        .expect("visible rail marker to hover")
        .rect;
    rt.pointer_move(
        marker_rect[0] + marker_rect[2] / 2.0,
        marker_rect[1] + marker_rect[3] / 2.0,
    );
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let _peek_rect = rt
        .presented("timeline-peek")
        .expect("precondition: timeline-peek must open after hovering rail marker")
        .0;
    assert!(
        preview::is_shown(&rt.state),
        "precondition: preview::is_shown must be true"
    );
    let rail_at_max = owner(&mut rt.state).scroll.get().at;
    let at_bottom_edge = (rail_at_max.offset[1] - rail_at_max.max[1]).abs() <= 0.5;
    if !at_bottom_edge {
        rt.update(|s, tx| {
            rune_theme_codenomad::timeline::scroll_rail_to(owner(s).scroll.get().at.max[1], tx);
        });
        settle(&mut rt);
        let marker_rect = rt
            .elements()
            .into_iter()
            .find(|n| {
                n.path.contains("/timeline/")
                    && n.role == "button"
                    && n.visible[2] > 0.0
                    && n.visible[3] > 0.0
                    && n.rect[1] >= rail_rect[1] + 24.0
                    && n.rect[1] + n.rect[3] <= rail_rect[1] + rail_rect[3] - 24.0
            })
            .expect("visible rail marker at bottom")
            .rect;
        rt.pointer_move(
            marker_rect[0] + marker_rect[2] / 2.0,
            marker_rect[1] + marker_rect[3] / 2.0,
        );
        for _ in 0..30 {
            rt.frame(0.016);
        }
    }
    let peek_rect = rt
        .presented("timeline-peek")
        .expect("timeline-peek presented")
        .0;
    let px = (peek_rect[0].max(hist_rect[0])
        + (peek_rect[0] + peek_rect[2]).min(hist_rect[0] + hist_rect[2]))
        / 2.0;
    let py = (peek_rect[1].max(hist_rect[1])
        + (peek_rect[1] + peek_rect[3]).min(hist_rect[1] + hist_rect[3]))
        / 2.0;
    assert!(
        px >= peek_rect[0]
            && px <= peek_rect[0] + peek_rect[2]
            && px >= hist_rect[0]
            && px <= hist_rect[0] + hist_rect[2]
            && py >= peek_rect[1]
            && py <= peek_rect[1] + peek_rect[3]
            && py >= hist_rect[1]
            && py <= hist_rect[1] + hist_rect[3],
        "precondition: timeline-peek {peek_rect:?} must overlap history {hist_rect:?}"
    );
    let hist_before_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let peek_before = preview::scroll_offset(&rt.state);
    assert!(
        hist_before_peek > 100.0 && peek_before <= 0.5,
        "precondition: history mid-transcript ({hist_before_peek}) and timeline-peek at top ({peek_before})"
    );
    rt.update(|s, _| s.paging = true);
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        -30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing()
            && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride must own the burst while timeline-peek is still open"
    );
    rt.wheel_xy(px, py, 0.0, -55.0);
    rt.frame(0.016);
    let hist_after_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let peek_after = preview::scroll_offset(&rt.state);
    assert!(
        ((peek_after - peek_before) - 55.0).abs() <= 2.0
            && (hist_after_peek - hist_before_peek).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing()
            && preview::is_shown(&rt.state),
        "wheel drifting from owned rail burst over timeline-peek must scroll timeline-peek by 55px without scrolling transcript or clearing browse: peek={peek_before}->{peek_after}, hist={hist_before_peek}->{hist_after_peek}"
    );
    // In the same owned burst, moving off timeline-peek onto uncovered history MUST scroll history.
    let uncovered_hy = if peek_rect[1] - hist_rect[1] >= 24.0 {
        hist_rect[1] + 12.0
    } else {
        (peek_rect[1] + peek_rect[3] + 16.0).min(hist_rect[1] + hist_rect[3] - 8.0)
    };
    assert!(
        uncovered_hy < peek_rect[1] - 1.0 || uncovered_hy > peek_rect[1] + peek_rect[3] + 1.0,
        "precondition: uncovered history y={uncovered_hy} must lie outside timeline-peek={peek_rect:?}"
    );
    rt.wheel_xy(hist_rect[0] + hist_rect[2] / 2.0, uncovered_hy, 0.0, 35.0);
    rt.frame(0.016);
    let hist_after_off_peek = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_peek - hist_after_off_peek) - 35.0).abs() <= 2.0,
        "same owned burst moving off timeline-peek onto uncovered history must scroll transcript by 35px: hist={hist_before_peek}->{hist_after_off_peek}"
    );

    // Z-order overlap: when timeline-peek paints above history-search-body, wheeling over their
    // intersection must scroll timeline-peek and leave history-search-body and history untouched.
    rt.update(|s, _| {
        search::fixture_hits(s, 30);
        search::set_position(s, [20.0, peek_rect[1]]);
    });
    for _ in 0..8 {
        rt.frame(0.016);
    }
    let peek_rect_z = rt
        .presented("timeline-peek")
        .expect("timeline-peek presented for z-order check")
        .0;
    let body_rect_z = rt
        .presented("history-search-body")
        .expect("history-search-body presented for z-order check")
        .0;
    let search_rect_z = rt
        .presented("history-search")
        .expect("history-search presented for z-order check")
        .0;
    let z_x0 = peek_rect_z[0].max(body_rect_z[0]);
    let z_x1 = (peek_rect_z[0] + peek_rect_z[2]).min(body_rect_z[0] + body_rect_z[2]);
    let z_y0 = peek_rect_z[1].max(body_rect_z[1]);
    let z_y1 = (peek_rect_z[1] + peek_rect_z[3]).min(body_rect_z[1] + body_rect_z[3]);
    assert!(
        z_x1 - z_x0 > 4.0 && z_y1 - z_y0 > 4.0,
        "precondition: timeline-peek {peek_rect_z:?} must overlap history-search-body {body_rect_z:?}"
    );
    let peek_z_before = preview::scroll_offset(&rt.state);
    let body_z_before = search::body_scroll_offset(&rt.state);
    let hist_z_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_z_x = rail_rect[0] + rail_rect[2] / 2.0;
    let rail_z_y = if rail_z_x < search_rect_z[0] || rail_z_x > search_rect_z[0] + search_rect_z[2]
    {
        rail_rect[1] + rail_rect[3] / 2.0
    } else if search_rect_z[1] - rail_rect[1] >= 16.0 {
        rail_rect[1] + 8.0
    } else {
        (search_rect_z[1] + search_rect_z[3] + 8.0).min(rail_rect[1] + rail_rect[3] - 8.0)
    };
    rt.wheel_xy(rail_z_x, rail_z_y, 0.0, -30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride owns burst before z-order overlap check: taken={}, shown={}, rail_pt=({rail_z_x},{rail_z_y}), search={search_rect_z:?}, peek={peek_rect_z:?}",
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken,
        preview::is_shown(&rt.state)
    );
    rt.wheel_xy((z_x0 + z_x1) / 2.0, (z_y0 + z_y1) / 2.0, 0.0, -45.0);
    rt.frame(0.016);
    let peek_z_after = preview::scroll_offset(&rt.state);
    let body_z_after = search::body_scroll_offset(&rt.state);
    let hist_z_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((peek_z_after - peek_z_before) - 45.0).abs() <= 2.0
            && (body_z_after - body_z_before).abs() <= 1.0
            && (hist_z_after - hist_z_before).abs() <= 1.0,
        "overlapping timeline-peek above history-search-body must receive wheel (45px) while search body and history stay still: peek={peek_z_before}->{peek_z_after}, body={body_z_before}->{body_z_after}, hist={hist_z_before}->{hist_z_after}"
    );
    rt.update(|s, _| {
        s.paging = false;
        search::close(s);
    });
    rt.pointer_move(0.0, 0.0);
    for _ in 0..15 {
        rt.frame(0.02);
    }

    // An unrendered preview target (e.g., a non-resident Reasoning marker whose overlay returns
    // None and leaves bounds empty) must NEVER swallow wheel forwarding onto history.
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({"showThinkingBlocks": true}));
        owner(s).outline = Some(Arc::new(Outline {
            entries: vec![
                serde_json::from_value(json!({
                    "id": "cold-reason",
                    "seq": 1,
                    "type": "assistant",
                    "tools": 0,
                    "reasoning": 1,
                    "text": 0,
                }))
                .unwrap(),
            ],
            total: 1,
            cacheable: true,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
        owner(s).outline_error = true;
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    settle(&mut rt);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let reason_node = rt
        .elements()
        .into_iter()
        .find(|n| n.key.as_deref() == Some("cold-reason:Reasoning:0:false"))
        .expect("non-resident Reasoning marker presented");
    assert!(
        reason_node.visible[2] > 0.0 && reason_node.visible[3] > 0.0,
        "precondition: cold-reason marker must be visible in rail: rect={:?}, visible={:?}, rail={rail_rect:?}",
        reason_node.rect,
        reason_node.visible
    );
    rt.pointer_move(
        reason_node.visible[0] + reason_node.visible[2] / 2.0,
        reason_node.visible[1] + reason_node.visible[3] / 2.0,
    );
    for _ in 0..30 {
        rt.frame(0.016);
    }
    assert!(
        preview::is_shown(&rt.state) && rt.presented("timeline-peek").is_none(),
        "precondition: hovering non-resident Reasoning sets target without rendering timeline-peek"
    );
    let hist_before_reason = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(hist_before_reason > 100.0);
    rt.update(|s, _| s.paging = true);
    // Claim against the top rail stop (+30.0 at offset 0.0) so rail placement does not change and
    // preview::poll keeps the unrendered Reasoning target active across the handoff.
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        30.0,
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken && preview::is_shown(&rt.state),
        "precondition: RailWheelOverride must own burst while unrendered Reasoning target remains active"
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        35.0,
    );
    rt.frame(0.016);
    let hist_after_reason = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        preview::is_shown(&rt.state)
            && ((hist_before_reason - hist_after_reason) - 35.0).abs() <= 2.0,
        "unrendered Reasoning preview target must stay active without swallowing wheel forwarding onto history: shown={}, hist={hist_before_reason}->{hist_after_reason}",
        preview::is_shown(&rt.state)
    );
    rt.update(|s, _| {
        s.paging = false;
        crate::settings::fixture_transcript(s, json!({"showThinkingBlocks": false}));
        owner(s).outline = None;
        owner(s).outline_error = false;
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
    });
    rt.pointer_move(0.0, 0.0);
    for _ in 0..15 {
        rt.frame(0.02);
    }

    // Captured rail burst drifting onto a scrollable history-search results list MUST accumulate
    // multiple same-frame wheel deltas onto history-search-body without scrolling history behind it
    // or clearing browse.
    rt.update(|s, _| {
        owner(s).outline_error = false;
        search::fixture_hits(s, 30);
    });
    settle(&mut rt);
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let body_rect = rt
        .presented("history-search-body")
        .expect("history-search-body presented")
        .0;
    let search_rect = rt
        .presented("history-search")
        .expect("history-search presented")
        .0;
    let body_before = search::body_scroll_offset(&rt.state);
    let hist_before_body = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rail_hit_y = (search_rect[1] + search_rect[3] + 12.0)
        .max(rail_rect[1] + 8.0)
        .min(rail_rect[1] + rail_rect[3] - 8.0);
    rt.wheel_xy(rail_rect[0] + rail_rect[2] / 2.0, rail_hit_y, 0.0, 30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own burst before drifting onto scrollable search body"
    );
    rt.wheel_xy(
        body_rect[0] + body_rect[2] / 2.0,
        body_rect[1] + body_rect[3] / 2.0,
        0.0,
        -30.0,
    );
    rt.wheel_xy(
        body_rect[0] + body_rect[2] / 2.0,
        body_rect[1] + body_rect[3] / 2.0,
        0.0,
        -50.0,
    );
    rt.frame(0.016);
    let body_after = search::body_scroll_offset(&rt.state);
    let hist_after_body = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((body_after - body_before) - 80.0).abs() <= 2.0
            && (hist_after_body - hist_before_body).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "owned rail burst drifting onto scrollable history-search-body must accumulate two same-frame deltas (+80px) without scrolling transcript: body={body_before}->{body_after}, hist={hist_before_body}->{hist_after_body}"
    );
    // Drifting onto the history-search toolbar (inside search_rect but strictly above body_rect)
    // must NOT scroll the results list OR history behind it, while keeping browse active.
    let toolbar_y = search_rect[1] + (body_rect[1] - search_rect[1]) / 2.0;
    assert!(
        toolbar_y > search_rect[1] && toolbar_y < body_rect[1] - 2.0,
        "precondition: history-search toolbar band must sit strictly above body_rect: search={search_rect:?}, body={body_rect:?}"
    );
    rt.wheel_xy(search_rect[0] + search_rect[2] / 2.0, toolbar_y, 0.0, -60.0);
    rt.frame(0.016);
    let body_after_toolbar = search::body_scroll_offset(&rt.state);
    let hist_after_toolbar = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (body_after_toolbar - body_after).abs() <= 1.0
            && (hist_after_toolbar - hist_after_body).abs() <= 1.0
            && owner(&mut rt.state).jump.is_browsing(),
        "owned rail burst drifting onto history-search toolbar must not scroll results body or history: body={body_after}->{body_after_toolbar}, hist={hist_after_body}->{hist_after_toolbar}"
    );
    rt.update(|s, _| {
        search::close(s);
        owner(s).outline_error = false;
    });
    settle(&mut rt);

    // Mid-transcript: forwarded momentum deltas MUST still scroll history normally (momentum only
    // suppresses edge paging, not scrolling itself). Arm programmatic_rail first and assert
    // RailWheelOverride owns the burst before forwarding momentum.
    rt.update(|s, tx| navigation::select(s, "row-26:User:0:false", tx));
    settle(&mut rt);
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let hist_before_mom_mid = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        hist_before_mom_mid > 100.0,
        "precondition: history must be mid-transcript before momentum scroll check: {hist_before_mom_mid}"
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 30.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own the phased burst before mid-transcript momentum handoff"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut mid_mom_ev = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    mid_mom_ev.momentum = true;
    rt.wheel_event(mid_mom_ev);
    rt.frame(0.016);
    let hist_after_mom_mid = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        ((hist_before_mom_mid - hist_after_mom_mid) - 45.0).abs() <= 2.0,
        "forwarded momentum wheel mid-transcript must still scroll history by 45px: hist={hist_before_mom_mid}->{hist_after_mom_mid}"
    );
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);

    // At the top edge of history, forwarded momentum deltas must NOT trigger a Before page request,
    // while non-momentum deltas MUST dispatch Page(Before).
    rt.update(|s, tx| {
        s.can_older = true;
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    assert!(
        owner(&mut rt.state).scroll.get().viewport.offset[1] <= 0.5,
        "precondition: history must be at top edge before edge-forwarding check"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own the phased burst before top-edge momentum check"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut mom_ev = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    mom_ev.momentum = true;
    rt.wheel_event(mom_ev);
    rt.frame(0.016);
    assert!(
        !rt.state.paging && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel at top edge must not dispatch a page request"
    );
    // Starting near (not yet at) the top edge of history: a forwarded momentum wheel that crosses
    // onto 0.0 must scroll to 0.0 without triggering poll_edge -> Page(Before) via on_scroll_offset.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 20.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 20.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    let near_top_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (near_top_before - 20.0).abs() <= 1.0,
        "precondition: history near top edge (20px) before momentum arrival check: {near_top_before}"
    );
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.is_browsing(),
        "precondition: RailWheelOverride must own phased burst before near-top momentum arrival"
    );
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut near_mom = rune_theme_codenomad::timeline::WheelEvent::new(0.0, 45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    near_mom.momentum = true;
    rt.wheel_event(near_mom);
    for _ in 0..3 {
        rt.frame(0.016);
    }
    let near_top_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        near_top_after <= 0.5 && !rt.state.paging && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel arriving at top edge from 20px must land at 0.0 without triggering poll_edge Page(Before): offset={near_top_after}, paging={}",
        rt.state.paging
    );
    // Start a fresh non-momentum owned rail burst and drift to top edge of history.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, _| owner(s).outline_error = false);
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        45.0,
    );
    rt.frame(0.016);
    assert!(
        rt.state.paging
            && matches!(
                cmd_rx.try_recv(),
                Ok(crate::transport::Command::Page(
                    crate::transport::HistoryEdge::Before,
                    _,
                ))
            ),
        "forwarded non-momentum wheel at top edge must dispatch Page(Before)"
    );

    // Same-frame down (+100px) then up (-10px) from top edge (0.0) lands at 90px and must NOT
    // dispatch Page(Before) by reading the stale pre-frame 0.0 offset.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, tx| {
        s.paging = false;
        s.can_older = true;
        owner(s).outline_error = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    settle(&mut rt);
    while cmd_rx.try_recv().is_ok() {}
    rt.update(|s, _| owner(s).outline_error = true);
    rt.frame(0.016);
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        -100.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        10.0,
    );
    rt.frame(0.016);
    let bounce_offset = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (bounce_offset - 90.0).abs() <= 2.0 && !rt.state.paging && cmd_rx.try_recv().is_err(),
        "same-frame forwarded down 100px then up 10px from top edge must land at 90px without paging: offset={bounce_offset}, paging={}",
        rt.state.paging
    );

    // Detached history bottom edge: forwarded momentum arriving at max must NOT dispatch Page(After),
    // non-momentum at max MUST dispatch Page(After), and reversing upward MUST revoke it.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    let (detached_reader, _detached_lane) = crate::chat::reader::Reader::fixture_open();
    rt.update(|s, tx| {
        s.paging = false;
        s.can_older = false;
        s.phase = crate::Phase::Ready;
        s.reader = Some(detached_reader);
        s.history_detached = true;
        owner(s).outline_error = false;
        tx.instant();
        tx.scroll_to_bottom_instant("history");
    });
    settle(&mut rt);
    let max_bottom = owner(&mut rt.state).scroll.get().viewport.max[1];
    assert!(max_bottom > 200.0);
    // Select row-26 (bottom of rail), then position history at max_bottom - 20.0 at stable height
    // (no banner resize) and scroll the rail programmatically to 0.0 so reveal_active arms
    // programmatic_rail without shifting history's max[1].
    rt.update(|s, tx| {
        s.paging = false;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, max_bottom - 20.0);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(0.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    rt.frame(0.016);
    while cmd_rx.try_recv().is_ok() {}
    let pre_mom_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (pre_mom_vp.max[1] - pre_mom_vp.offset[1] - 20.0).abs() <= 1.0,
        "precondition: history must sit 20px above max before momentum arrival: offset={}/{}",
        pre_mom_vp.offset[1],
        pre_mom_vp.max[1]
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    // Arm a programmatic rail scroll on the exact frame the wheel arrives (without resizing history).
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        let target = sc.at.max[1].max(120.0);
        sc.programmatic_rail = Some(target);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(target, tx);
    });
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 40.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Began),
    );
    rt.frame(0.016);
    assert!(owner(&mut rt.state).scroll.get().last_rail_wheel_taken);
    rt.wheel_event(
        rune_theme_codenomad::timeline::WheelEvent::new(0.0, 0.0)
            .at(
                rail_rect[0] + rail_rect[2] / 2.0,
                rail_rect[1] + rail_rect[3] / 2.0,
            )
            .phase(rune_theme_codenomad::timeline::GesturePhase::Ended),
    );
    let mut bottom_mom = rune_theme_codenomad::timeline::WheelEvent::new(0.0, -45.0)
        .at(
            hist_rect[0] + hist_rect[2] / 2.0,
            hist_rect[1] + hist_rect[3] / 2.0,
        )
        .phase(rune_theme_codenomad::timeline::GesturePhase::Began);
    bottom_mom.momentum = true;
    rt.wheel_event(bottom_mom);
    for _ in 0..3 {
        rt.frame(0.016);
    }
    let bottom_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (bottom_vp.offset[1] - bottom_vp.max[1]).abs() <= 0.5
            && !rt.state.paging
            && cmd_rx.try_recv().is_err(),
        "forwarded momentum wheel arriving at bottom edge must land at max without dispatching Page(After): offset={}/{}, paging={}",
        bottom_vp.offset[1],
        bottom_vp.max[1],
        rt.state.paging
    );
    // Fresh non-momentum burst at bottom edge dispatches Page(After), then upward reversal revokes it.
    for _ in 0..10 {
        rt.frame(0.02);
    }
    rt.update(|s, tx| {
        s.paging = false;
        navigation::select(s, "row-26:User:0:false", tx);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        s.paging = false;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, max_bottom);
    });
    settle(&mut rt);
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(0.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(0.0, tx);
    });
    rt.frame(0.016);
    while cmd_rx.try_recv().is_ok() {}
    let pre_edge_vp = owner(&mut rt.state).scroll.get().viewport;
    assert!(
        (pre_edge_vp.max[1] - pre_edge_vp.offset[1]).abs() <= 0.5,
        "precondition: history must sit right at max before non-momentum edge paging: offset={}/{}",
        pre_edge_vp.offset[1],
        pre_edge_vp.max[1]
    );
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    rt.update(|s, tx| {
        let mut sc = owner(s).scroll.get();
        let target = sc.at.max[1].max(120.0);
        sc.programmatic_rail = Some(target);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(target, tx);
    });
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        -45.0,
    );
    rt.frame(0.016);
    let after_cancelled = match cmd_rx.try_recv() {
        Ok(crate::transport::Command::Page(crate::transport::HistoryEdge::After, cancelled)) => {
            cancelled
        }
        other => panic!(
            "forwarded non-momentum wheel at bottom edge must dispatch Page(After): {other:?}"
        ),
    };
    assert!(rt.state.paging && !after_cancelled.is_closed());
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        45.0,
    );
    rt.frame(0.016);
    assert!(
        after_cancelled.is_closed() && !rt.state.paging,
        "reversing forwarded wheel upward while Page(After) is in flight must revoke it"
    );
}

#[test]
fn narrow_window_cancels_rail_jump_and_admits_search_jump() {
    for reduced_motion in [false, true] {
        let mut s = crate::init();
        s.messages = vec![user("row-0")];
        let (tx, rx) = codenomad_client::bounded(4);
        s.commands = Some(tx);
        owner(&mut s).width = 800.0;
        owner(&mut s).online = true;
        owner(&mut s).outline = Some(Arc::new(Outline {
            entries: ["above-0", "above-1", "distant", "below-0", "row-0"]
                .into_iter()
                .enumerate()
                .map(|(seq, id)| {
                    serde_json::from_value(json!({
                        "id": id,
                        "seq": seq + 1,
                        "type": "user",
                        "tools": 0,
                        "reasoning": 0,
                        "text": 1,
                    }))
                    .unwrap()
                })
                .collect(),
            total: 5,
            cacheable: true,
            saved: None,
        }));
        owner(&mut s).changed = true;
        owner(&mut s).index_changed = true;
        let mut rt = Runtime::new(s, view, (800.0, 600.0), Env::new(false, 1.0));
        rt.poll = Some(crate::poll);
        rt.set_system_reduced_motion(reduced_motion);
        rt.frame(0.0);

        let page = crate::history::Page {
            rows: vec![
                user("above-0"),
                user("above-1"),
                user("distant"),
                user("below-0"),
            ],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        };

        // 1. A rail jump narrowed below 420px is rejected immediately by admit_window (!demanded)
        //    even before poll runs, and cancelled once poll sees the narrow width.
        rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
        let (rail_ticket, rail_cancelled) = match rx.try_recv().expect("rail jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            owner(s).width = 419.0;
            let mut accepted = false;
            navigation::admit_window(s, rail_ticket, page.clone(), || {
                accepted = true;
                true
            });
            assert!(
                !accepted && s.messages.iter().all(|m| m.id != "distant"),
                "rail jump must be rejected by admit_window once window is narrower than 420px"
            );
        });
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(
            rt.presented("timeline").is_none()
                && rail_cancelled.is_closed()
                && !owner(&mut rt.state).jump.has_flight(),
            "narrowing below 420px must cancel an in-flight rail jump"
        );

        // 2. A search jump narrowed below 420px remains alive, admits, aligns, and locks.
        rt.set_viewport((800.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
        let ticket = match rx.try_recv().expect("distant search jump dispatched") {
            crate::transport::Command::Anchor(jump) => jump.ticket,
            other => panic!("unexpected command: {other:?}"),
        };
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(rt.presented("timeline").is_none());
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            navigation::admit_window(s, ticket, page.clone(), || true);
        });
        for _ in 0..20 {
            rt.frame(0.016);
        }
        let hist = rt.presented("history").expect("history presented").0;
        let distant_row = rt
            .presented("distant")
            .expect("distant message presented")
            .0;
        assert!(
            !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.is_locked()
                && (distant_row[1] - hist[1]).abs() <= 2.0,
            "in-flight search jump must admit, align distant to top of history, and lock while narrowed: hist={hist:?}, distant={distant_row:?}"
        );
        // Move transcript away via instant jump (non-user) so reading line would select above-0 if unlocked.
        rt.update(|_, tx| {
            tx.instant();
            tx.scroll_key_to("above-0", 0.0);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.set_viewport((800.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(
            owner(&mut rt.state).jump.is_locked() && owner(&mut rt.state).jump.active.is_none(),
            "widening back must keep search jump locked rather than drifting to above-0"
        );

        // 3. Disabling timeline while narrowed with an in-flight search jump (and search closed)
        //    must reject stale responses even when a new jump is waiting later.
        rt.update(|s, tx| navigation::seek_message(s, "row-0", tx));
        let (ticket2, cancelled2) = match rx.try_recv().expect("second distant jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(owner(&mut rt.state).jump.has_flight());
        rt.update(|s, _| {
            crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
            navigation::admit_window(
                s,
                ticket2,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || panic!("search jump with timeline disabled and search closed must not admit"),
            );
            navigation::cancel_jump(s);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        assert!(
            cancelled2.is_closed()
                && !owner(&mut rt.state).jump.has_flight()
                && !owner(&mut rt.state).jump.is_locked(),
            "cancelling after disabling showMessageTimeline must close transport and clear flight"
        );
        rt.set_viewport((800.0, 600.0), 1.0);
        rt.update(|s, _| {
            crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }))
        });
        for _ in 0..15 {
            rt.frame(0.016);
        }
        assert!(
            !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.active.as_deref() == Some("above-0:User:0:false"),
            "re-enabling timeline must resume reading-line tracking cleanly without stranded flight"
        );
        rt.update(|s, tx| navigation::select(s, "row-0:User:0:false", tx));
        let ticket3 = match rx.try_recv().expect("third distant jump dispatched") {
            crate::transport::Command::Anchor(jump) => jump.ticket,
            other => panic!("unexpected command: {other:?}"),
        };
        assert_ne!(ticket3, ticket2);
        let mut stale_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket2,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    stale_accepted = true;
                    true
                },
            );
        });
        assert!(
            !stale_accepted
                && owner(&mut rt.state).jump.has_flight()
                && rt.state.messages.iter().all(|m| m.id != "row-0"),
            "stale ticket from before suspension must be rejected while a newer jump waits"
        );
        let mut fresh_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket3,
                crate::history::Page {
                    rows: vec![user("row-0")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    fresh_accepted = true;
                    true
                },
            );
        });
        for _ in 0..15 {
            rt.frame(0.016);
        }
        assert!(
            fresh_accepted
                && !owner(&mut rt.state).jump.has_flight()
                && owner(&mut rt.state).jump.is_locked()
                && rt.presented("body-row-0").is_some(),
            "newer jump ticket must admit cleanly after stale ticket rejection"
        );

        // 4. Manual transcript touch pan (measured on_scroll_offset move) while narrowed with an
        //    in-flight distant search jump must cancel the ticket and reject a late response.
        rt.update(|s, tx| {
            s.messages = (0..10).map(|i| user(&format!("scroll-row-{i}"))).collect();
            s.revision += 1;
            tx.instant();
            tx.scroll_to_instant("history", 0.0, 200.0);
        });
        for _ in 0..10 {
            rt.frame(0.016);
        }
        rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
        let (ticket_pan, cancelled_pan) = match rx.try_recv().expect("narrow pan jump dispatched") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
        rt.set_viewport((419.0, 600.0), 1.0);
        for _ in 0..20 {
            rt.frame(0.016);
        }
        assert!(owner(&mut rt.state).jump.has_flight());
        let hist = rt.presented("history").expect("history presented").0;
        let narrow_offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
        assert!(
            narrow_offset_before > 80.0,
            "precondition: transcript must have upward scroll room before narrow touch pan: {narrow_offset_before}"
        );
        let hx = hist[0] + hist[2] / 2.0;
        let hy = hist[1] + hist[3] / 2.0;
        rt.touch(9, TouchPhase::Started, hx, hy, 1.0);
        rt.touch(9, TouchPhase::Moved, hx, hy + 20.0, 1.016);
        rt.touch(9, TouchPhase::Moved, hx, hy + 80.0, 1.032);
        rt.frame(0.016);
        rt.touch(9, TouchPhase::Ended, hx, hy + 80.0, 1.25);
        for _ in 0..10 {
            rt.frame(0.016);
        }
        let narrow_offset_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
        assert!(
            narrow_offset_after < narrow_offset_before - 30.0
                && cancelled_pan.is_closed()
                && !owner(&mut rt.state).jump.has_flight(),
            "measured touch pan while narrowed must cancel in-flight distant jump via on_scroll_offset: offset={narrow_offset_before}->{narrow_offset_after}"
        );
        let mut late_pan_accepted = false;
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                ticket_pan,
                crate::history::Page {
                    rows: vec![user("distant")],
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                || {
                    late_pan_accepted = true;
                    true
                },
            );
        });
        assert!(
            !late_pan_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
            "late response after narrow manual transcript scroll must not replace current transcript"
        );
    }
}

#[test]
fn reprojection_shifting_locked_marker_index_keeps_rail_revealed() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({ "showThinkingBlocks": true }));
    let mut messages = Vec::new();
    for i in 0..25 {
        let row: crate::history::Row = crate::history::decode_message(&json!({
            "id": format!("think-{i}"),
            "type": "assistant",
            "time": { "completed": 1 },
            "content": [
                { "type": "reasoning", "text": format!("Thought {i}") },
                { "type": "text", "text": format!("Answer {i}") }
            ]
        }))
        .unwrap()
        .into();
        messages.push(row);
    }
    messages.push(user("locked-target"));
    s.messages = messages;
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "locked-target:User:0:false", tx));
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let idx_before = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker before filter");
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        idx_before >= 45 && owner(&mut rt.state).jump.is_locked() && offset_before > 100.0,
        "locked-target must start deep in the rail: idx={idx_before}, offset={offset_before}"
    );
    let check_revealed = |rt: &Runtime<State>, label: &str| {
        let rail = rt.presented("timeline").expect("timeline presented").0;
        let btn = rt
            .elements()
            .into_iter()
            .find(|n| n.key.as_deref() == Some("locked-target:User:0:false"))
            .unwrap_or_else(|| panic!("{label}: locked-target button missing"));
        assert!(
            btn.visible[2] > 0.0
                && btn.visible[3] > 0.0
                && btn.rect[1] >= rail[1] - 1.0
                && btn.rect[1] + btn.rect[3] <= rail[1] + rail[3] + 1.0,
            "{label}: locked-target button must remain revealed inside rail={rail:?}, rect={:?}, visible={:?}",
            btn.rect,
            btn.visible
        );
    };
    check_revealed(&rt, "before hiding reasoning");

    // Hide reasoning blocks before locked-target, shifting its marker index downward.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showThinkingBlocks": false }));
        filters_changed(s);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let idx_after_hide = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker after hiding reasoning");
    assert!(
        idx_after_hide + 20 <= idx_before
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("locked-target:User:0:false"),
        "hiding earlier reasoning markers must shift locked-target index down while keeping lock: before={idx_before}, after={idx_after_hide}"
    );
    check_revealed(&rt, "after hiding reasoning");

    // Show reasoning blocks again, shifting locked-target back down below the rail viewport.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showThinkingBlocks": true }));
        filters_changed(s);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let idx_after_show = owner(&mut rt.state)
        .markers
        .iter()
        .position(|m| m.id == "locked-target:User:0:false")
        .expect("locked-target marker after re-showing reasoning");
    assert_eq!(idx_after_show, idx_before);
    assert!(
        owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("locked-target:User:0:false"),
        "re-showing reasoning markers must keep locked-target locked and active"
    );
    check_revealed(&rt, "after re-showing reasoning");
}

#[test]
fn browsing_rail_during_distant_jump_keeps_manual_rail_position() {
    let mut s = crate::init();
    let (tx, rx) = codenomad_client::bounded(4);
    s.commands = Some(tx);
    s.messages = (0..40).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    let mut entries: Vec<_> = (0..40)
        .map(|i| {
            serde_json::from_value(json!({
                "id": format!("row-{i}"),
                "seq": i + 1,
                "type": "user",
                "tools": 0,
                "reasoning": 0,
                "text": 1,
            }))
            .unwrap()
        })
        .collect();
    entries.push(
        serde_json::from_value(json!({
            "id": "distant-end",
            "seq": 41,
            "type": "user",
            "tools": 0,
            "reasoning": 0,
            "text": 1,
        }))
        .unwrap(),
    );
    entries.push(
        serde_json::from_value(json!({
            "id": "distant-tail",
            "seq": 42,
            "type": "user",
            "tools": 0,
            "reasoning": 0,
            "text": 1,
        }))
        .unwrap(),
    );
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries,
        total: 42,
        cacheable: true,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 400.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    // Start at the top of the transcript so the rail begins at offset 0 and distant-end is off-screen.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("row-0", 0.0);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail_visible_key = |rt: &Runtime<State>, key: &str| {
        let rail = rt.presented("timeline").expect("timeline presented").0;
        rt.elements().into_iter().any(|n| {
            n.key.as_deref() == Some(key)
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
                && n.rect[1] >= rail[1] - 1.0
                && n.rect[1] + n.rect[3] <= rail[1] + rail[3] + 1.0
        })
    };
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] <= 1.0
            && !rail_visible_key(&rt, "distant-end:User:0:false"),
        "precondition: rail must start at top with distant-end off-screen"
    );
    // Start a distant jump to the end of the rail.
    rt.update(|s, tx| navigation::select(s, "distant-end:User:0:false", tx));
    let ticket = match rx.try_recv().expect("distant jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let offset_at_end = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_at_end > 200.0 && rail_visible_key(&rt, "distant-end:User:0:false"),
        "rail must reveal distant-end before admission: offset={offset_at_end}"
    );
    // Manually wheel the rail upward while the distant jump is still in flight.
    let rail = rt.presented("timeline").expect("timeline presented").0;
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 260.0);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let browsed_offset = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        browsed_offset < offset_at_end - 150.0
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).jump.has_flight(),
        "wheeling the rail during flight must scroll, enter browse mode, and keep jump in flight: before={offset_at_end}, after={browsed_offset}"
    );
    // Admit the distant jump response; distant-end must align and lock while keeping manual rail browse.
    let mut accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(
            s,
            ticket,
            crate::history::Page {
                rows: vec![user("distant-end")],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            || {
                accepted = true;
                true
            },
        );
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist = rt.presented("history").expect("history presented").0;
    let distant_body = rt
        .presented("body-distant-end")
        .expect("distant-end body presented")
        .0;
    let offset_after_settle = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        accepted
            && !owner(&mut rt.state).jump.has_flight()
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("distant-end:User:0:false")
            && (distant_body[1] - hist[1]).abs() <= 2.0
            && owner(&mut rt.state).jump.is_browsing()
            && (offset_after_settle - browsed_offset).abs() <= 1.0,
        "settling a distant jump must admit, align, and lock distant-end while preserving manual rail browse: browsed={browsed_offset}, after={offset_after_settle}, hist={hist:?}, body={distant_body:?}"
    );
    // Clicking an unavailable (offline) marker while browsing must keep browse mode and rail position.
    rt.update(|s, tx| {
        owner(s).online = false;
        navigation::select(s, "row-0:User:0:false", tx);
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let offset_after_offline = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).jump.retry.is_some()
            && owner(&mut rt.state).jump.is_browsing()
            && (offset_after_offline - browsed_offset).abs() <= 1.0,
        "failed/offline click during rail browse must not snap the rail away: browsed={browsed_offset}, after={offset_after_offline}"
    );
    // A valid online distant jump from browse mode to an off-screen target must exit browse mode
    // and reveal the target in the rail even before the page is admitted.
    assert!(
        !rail_visible_key(&rt, "distant-tail:User:0:false"),
        "precondition: distant-tail must be off-screen before selecting"
    );
    rt.update(|s, tx| {
        owner(s).online = true;
        navigation::select(s, "distant-tail:User:0:false", tx);
    });
    match rx.try_recv().expect("online distant-tail jump dispatched") {
        crate::transport::Command::Anchor(jump) => assert_eq!(jump.message, "distant-tail"),
        other => panic!("unexpected command: {other:?}"),
    }
    for _ in 0..45 {
        rt.frame(0.016);
    }
    assert!(
        !owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).jump.has_flight()
            && rail_visible_key(&rt, "distant-tail:User:0:false"),
        "valid distant jump from browse mode must clear browse and reveal off-screen target before admission"
    );
}

#[test]
fn restore_search_filtered_notice_survives_disabled_timeline_and_reveal_defers_for_input() {
    use codenomad_client::search::{Hit, Kind};

    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({ "showMessageTimeline": false, "showThinkingBlocks": false }),
    );
    let row: crate::history::Row = crate::history::decode_message(&json!({
        "id": "hidden-thought",
        "type": "assistant",
        "time": { "completed": 1 },
        "content": [
            { "type": "reasoning", "text": "Hidden needle" },
            { "type": "text", "text": "Visible answer" }
        ]
    }))
    .unwrap()
    .into();
    s.messages = vec![row];
    let mut hit = crate::chat::search_hit::SearchHit::new(
        &Hit {
            session: "s".into(),
            message: "hidden-thought".into(),
            role: "assistant".into(),
            part: 0,
            kind: Kind::Reasoning,
            excerpt: "Hidden needle".into(),
        },
        "Hidden needle",
        false,
    );
    hit.restore_pending = true;
    s.transcript_display.search_highlight = Some(hit);
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.update(|s, _| navigation::restore_search(s));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some(),
        "disabled timeline without search must not erase restore_search filtered banner"
    );

    // Disabling showMessageTimeline after narrowing (live=true, search CLOSED) must NOT erase a
    // restored search highlight or its pending alignment while the transcript stays shown;
    // rail-originated filtered notices still clear cleanly when disabling showMessageTimeline.
    let mut s = crate::init();
    s.messages = (0..30)
        .map(|i| {
            if i == 1 {
                crate::history::decode_message(&json!({
                    "id": "m-1",
                    "type": "user",
                    "text": format!("{}m-1 match line\n\n{}", "Preface line.\n\n".repeat(4), "Tail line.\n\n".repeat(6))
                }))
                .unwrap()
                .into()
            } else {
                user(&format!("m-{i}"))
            }
        })
        .collect();
    owner(&mut s).width = 800.0;
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: vec![
            serde_json::from_value(json!({
                "id": "m-0",
                "seq": 1,
                "type": "user",
                "tools": 0,
                "reasoning": 0,
                "text": 1,
            }))
            .unwrap(),
        ],
        total: 1,
        cacheable: false,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 420.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        let mut restored = crate::chat::search_hit::SearchHit::new(
            &Hit {
                session: "s".into(),
                message: "m-1".into(),
                role: "user".into(),
                part: 0,
                kind: Kind::Text,
                excerpt: "m-1".into(),
            },
            "m-1",
            false,
        );
        restored.restore_pending = true;
        s.transcript_display.search_highlight = Some(restored);
        navigation::restore_search(s);
    });
    rt.set_viewport((419.0, 420.0), 1.0);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    assert!(
        rt.presented("timeline").is_none()
            && owner(&mut rt.state).outline.is_none()
            && rt.state.transcript_display.search_highlight.is_some(),
        "narrowing must drop non-cacheable outline immediately while keeping restored search highlight"
    );
    // Move the transcript away from m-1 first so the second restore_search must actually re-align.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("m-29", 0.0);
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist_away = rt.presented("history").expect("history presented").0;
    assert!(
        rt.presented("m-1")
            .is_none_or(|(r, _)| (r[1] - hist_away[1]).abs() > 20.0),
        "precondition: m-1 must be scrolled away before second restore_search"
    );
    rt.update(|s, _| {
        if let Some(hit) = s.transcript_display.search_highlight.as_mut() {
            hit.restore_pending = true;
        }
        navigation::restore_search(s);
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist_restored = rt.presented("history").expect("history presented").0;
    let m1_row = rt.presented("m-1").expect("restored m-1 row presented").0;
    assert!(
        rt.state.transcript_display.search_highlight.is_some()
            && (m1_row[1] - hist_restored[1]).abs() <= 2.0,
        "disabling showMessageTimeline while on the conversation must preserve restored search highlight and apply its alignment: hist={hist_restored:?}, m1={m1_row:?}"
    );

    // Real rail-originated destinationFiltered refusal must be cleared when showMessageTimeline is disabled.
    let mut s = crate::init();
    s.messages = vec![
        user("m-keep"),
        crate::history::decode_message(&json!({
            "id": "tool-msg",
            "type": "assistant",
            "content": [
                { "type": "tool", "id": "t-read", "name": "read", "state": { "status": "completed", "input": {} } }
            ],
        }))
        .unwrap()
        .into(),
    ];
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 0.0);
    });
    rt.frame(0.016);
    // Hide the read tool without reprojecting yet, then click the still-present rail marker so
    // navigation::select() triggers a genuine rail-originated filtered refusal without moving history.
    let local_hist_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(
            s,
            json!({ "showMessageTimeline": true, "toolCallExpansionDefaults": { "tools": { "read": "hidden" } } }),
        );
        navigation::select(s, "tool-msg:Tool:0:false", tx);
    });
    rt.frame(0.016);
    let local_hist_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some()
            && (local_hist_after - local_hist_before).abs() <= 0.5,
        "rail click on a now-hidden destination must show timeline-destination-filtered without scrolling history: hist={local_hist_before}->{local_hist_after}"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_none(),
        "disabling showMessageTimeline must clear a rail-originated destinationFiltered alert"
    );

    // Distant rail-originated destinationFiltered refusal (landing from an outline click via
    // admit_window) must reject the page without installing it, keep messages intact, and clear
    // when showMessageTimeline is disabled.
    let mut s = crate::init();
    let (distant_tx, distant_rx) = codenomad_client::bounded(4);
    s.commands = Some(distant_tx);
    s.messages = vec![user("m-keep")];
    crate::settings::fixture_transcript(
        &mut s,
        json!({ "showMessageTimeline": true, "toolCallExpansionDefaults": { "tools": { "read": "hidden" } } }),
    );
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: [
            json!({ "id": "distant-tool", "seq": 1, "type": "assistant", "tools": 1, "reasoning": 0, "text": 0 }),
            json!({ "id": "m-keep", "seq": 2, "type": "user", "tools": 0, "reasoning": 0, "text": 1 }),
        ]
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap())
        .collect(),
        total: 2,
        cacheable: true,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant-tool:Tool:0:false", tx));
    let distant_ticket = match distant_rx.try_recv().expect("distant rail jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    let distant_page = crate::history::Page {
        rows: vec![
            crate::history::decode_message(&json!({
                "id": "distant-tool",
                "type": "assistant",
                "content": [
                    { "type": "tool", "id": "t-distant", "name": "read", "state": { "status": "completed", "input": {} } }
                ],
            }))
            .unwrap()
            .into(),
            user("m-keep"),
        ],
        older: None,
        newer: None,
        running: false,
        user_file_references: false,
    };
    let mut distant_accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(s, distant_ticket, distant_page.clone(), || {
            distant_accepted = true;
            true
        });
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !distant_accepted
            && rt.state.messages.len() == 1
            && rt.state.messages[0].id == "m-keep"
            && owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_some(),
        "distant rail landing on a filtered destination must reject the page without installing it and show timeline-destination-filtered: accepted={distant_accepted}, messages={}",
        rt.state.messages.len()
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.filtered
            && rt.presented("timeline-destination-filtered").is_none(),
        "disabling showMessageTimeline must clear a distant rail-originated destinationFiltered alert"
    );

    // Directly exercise reveal_active deferral with an isolated deferred frame and immediate wake check.
    let mut s = crate::init();
    s.messages = (0..40).map(|i| user(&format!("m-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before > 100.0,
        "rail must start scrolled toward bottom before selecting m-0: {offset_before}"
    );
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "m-0:User:0:false", tx));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        rt.wake_deadline().is_none()
            && (owner(&mut rt.state).scroll.get().at.offset[1] - offset_before).abs() <= 0.5,
        "precondition: no pending wake and rail still at bottom before reveal_active"
    );
    let mut deferred = true;
    let mut clock_at_defer = 0.0;
    rt.update(|s, tx| {
        clock_at_defer = tx.clock();
        deferred = !navigation::reveal_active(s, tx, true);
    });
    rt.frame(0.016);
    let wake = rt
        .wake_deadline()
        .expect("reveal_active(input_waiting=true) must schedule an immediate wake");
    assert!(
        deferred
            && wake <= clock_at_defer + 0.02
            && owner(&mut rt.state)
                .scroll
                .get()
                .programmatic_rail
                .is_none()
            && (owner(&mut rt.state).scroll.get().at.offset[1] - offset_before).abs() <= 0.5,
        "isolated frame after reveal_active(input_waiting=true) must schedule an immediate wake without scrolling: clock={clock_at_defer}, wake={wake}"
    );
    let mut revealed = false;
    rt.update(|s, tx| {
        revealed = navigation::reveal_active(s, tx, false);
    });
    assert!(
        revealed
            && owner(&mut rt.state)
                .scroll
                .get()
                .programmatic_rail
                .is_some(),
        "reveal_active(input_waiting=false) must schedule the reveal glide"
    );
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let m0_visible = rt.elements().into_iter().any(|n| {
        n.key.as_deref() == Some("m-0:User:0:false")
            && n.visible[2] > 0.0
            && n.visible[3] > 0.0
            && n.rect[1] >= rail[1] - 1.0
            && n.rect[1] + n.rect[3] <= rail[1] + rail[3] + 1.0
    });
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] < offset_before - 100.0 && m0_visible,
        "reveal_active(input_waiting=false) must move the rail upward and make m-0 visible"
    );
}

#[test]
fn touch_pan_on_rail_enters_browse_mode_without_snapping_back() {
    let mut s = crate::init();
    s.messages = (0..40).map(|i| user(&format!("tp-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 360.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let offset_before = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "rail must start scrolled toward bottom and not browsing: {offset_before}"
    );
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let x = rail[0] + rail[2] / 2.0;
    let y0 = rail[1] + 40.0;
    rt.touch(1, TouchPhase::Started, x, y0, 1.0);
    for step in 1..=10 {
        rt.touch(
            1,
            TouchPhase::Moved,
            x,
            y0 + step as f32 * 18.0,
            1.0 + step as f64 * 0.016,
        );
        // Force an instant commit on the same frame to distinguish rail_scrolled() from user_scrolled().
        rt.update(|_, tx| tx.instant());
        rt.frame(0.016);
    }
    rt.touch(1, TouchPhase::Ended, x, y0 + 180.0, 1.35);
    for _ in 0..20 {
        rt.frame(0.016);
    }
    let offset_after_pan = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_after_pan < offset_before - 80.0 && owner(&mut rt.state).jump.is_browsing(),
        "touch pan on the rail must scroll upward and enter browse mode via on_scroll_offset: before={offset_before}, after={offset_after_pan}"
    );
    // Showing a banner shrinks the rail; browse mode must keep the manually panned position.
    rt.update(|s, _| owner(s).outline_error = true);
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let offset_after_banner = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).jump.is_browsing()
            && (offset_after_banner - offset_after_pan).abs() <= 1.0,
        "banner resize must not snap a touch-browsed rail back to the active marker: panned={offset_after_pan}, after={offset_after_banner}"
    );
    // Unmounting the rail (narrowing below TIMELINE_MIN_WIDTH) discards Rune's scroll state, so
    // browse mode must clear and widening back must re-reveal the active marker instead of 0.0.
    rt.set_viewport((419.0, 360.0), 1.0);
    for _ in 0..20 {
        rt.frame(0.016);
    }
    assert!(
        rt.presented("timeline").is_none() && !owner(&mut rt.state).jump.is_browsing(),
        "unmounting the rail must clear browse mode: presented={:?}, browsing={}",
        rt.presented("timeline"),
        owner(&mut rt.state).jump.is_browsing()
    );
    rt.set_viewport((800.0, 360.0), 1.0);
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail_after_remount = rt.presented("timeline").expect("timeline remounted").0;
    let active_key = owner(&mut rt.state)
        .jump
        .active
        .clone()
        .expect("active marker after remount");
    let active_visible = rt.elements().into_iter().any(|n| {
        n.key.as_deref() == Some(active_key.as_str())
            && n.visible[2] > 0.0
            && n.visible[3] > 0.0
            && n.rect[1] >= rail_after_remount[1] - 1.0
            && n.rect[1] + n.rect[3] <= rail_after_remount[1] + rail_after_remount[3] + 1.0
    });
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 100.0 && active_visible,
        "remounting a previously browsed rail must re-reveal active marker {active_key}"
    );

    // Concurrent touch pan arriving right before a pending reveal_active must NOT be overwritten
    // and must transition into browse mode.
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let x = rail[0] + rail[2] / 2.0;
    let y0 = rail[1] + 40.0;
    let offset_before_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        offset_before_race > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail near bottom and not browsing before touch/reveal race"
    );
    // Arm an off-screen active target (tp-0 at top, offset 0) without polling yet so the next
    // poll() frame calls reveal_active() -> glide_rail_to() on the exact frame the touch pan arrives.
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    assert_eq!(
        rune_theme_codenomad::timeline::reveal_target(0, owner(&mut rt.state).scroll.get().at),
        Some(0.0),
        "precondition: tp-0 reveal target must be 0.0 before touch/reveal race"
    );
    rt.poll = Some(crate::poll);
    rt.touch(2, TouchPhase::Started, x, y0, 3.0);
    rt.touch(2, TouchPhase::Moved, x, y0 + 20.0, 3.016);
    rt.touch(2, TouchPhase::Moved, x, y0 + 90.0, 3.032);
    rt.frame(0.016);
    let during_race = owner(&mut rt.state).scroll.get().at.offset[1];
    let touch_glide_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    rt.touch(2, TouchPhase::Ended, x, y0 + 90.0, 3.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        touch_glide_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && during_race >= 200.0
            && (after_race - during_race).abs() <= 5.0,
        "same-frame headless touch/reveal race must interrupt the glide without snapping to 0.0 and enter browse mode: interrupted={touch_glide_interrupted}, before={offset_before_race}, during={during_race}, after={after_race}"
    );
    // Mid-glide touch pan: once a reveal glide is already in-flight, a touch pan must interrupt
    // the glide, enter browse mode, and preserve its ~82px pan displacement with no snap/clamp.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_glide_before_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_glide_before_touch > 120.0,
        "precondition: reveal glide must be mid-flight before mid-glide touch pan: offset={mid_glide_before_touch}"
    );
    rt.touch(4, TouchPhase::Started, x, y0, 4.0);
    rt.touch(4, TouchPhase::Moved, x, y0 + 20.0, 4.016);
    rt.touch(4, TouchPhase::Moved, x, y0 + 90.0, 4.032);
    rt.frame(0.016);
    let during_mid_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    let mid_touch_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    rt.touch(4, TouchPhase::Ended, x, y0 + 90.0, 4.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_mid_touch = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        mid_touch_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && ((mid_glide_before_touch - during_mid_touch) - 82.0).abs() <= 12.0
            && (after_mid_touch - during_mid_touch).abs() <= 5.0,
        "mid-glide touch pan must interrupt the glide and preserve its ~82px displacement: interrupted={mid_touch_interrupted}, before={mid_glide_before_touch}, during={during_mid_touch}, after={after_mid_touch}"
    );

    // Concurrent WheelOwner::Vertical burst crossing from transcript onto the rail right before a
    // reveal must also enter browse mode and halt the interrupted reveal glide cleanly.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let hist = rt.presented("history").expect("history presented").0;
    assert!(
        owner(&mut rt.state).scroll.get().at.offset[1] > 200.0
            && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail at bottom before WheelOwner::Vertical race"
    );
    // Latch WheelOwner::Vertical on history first.
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 20.0);
    rt.frame(0.016);
    // Arm an off-screen active marker (tp-0) without polling yet, then send a continuing vertical
    // wheel tick directly on the rail (within WHEEL_IDLE) so Rune moves the rail pre-poll right
    // before reveal_active fires.
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    assert_eq!(
        rune_theme_codenomad::timeline::reveal_target(0, owner(&mut rt.state).scroll.get().at),
        Some(0.0),
        "precondition: tp-0 reveal target must be 0.0 before WheelOwner::Vertical race"
    );
    let before_wheel_race = owner(&mut rt.state).scroll.get().at.offset[1];
    rt.poll = Some(crate::poll);
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 50.0);
    rt.frame(0.016);
    let wheel_glide_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let after_wheel_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        wheel_glide_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && after_wheel_race >= 200.0
            && after_wheel_race < 304.0,
        "same-frame headless WheelOwner::Vertical race must interrupt the glide without snapping to 0.0 and enter browse mode: interrupted={wheel_glide_interrupted}, before={before_wheel_race}, after={after_wheel_race}"
    );
    // Mid-glide WheelOwner::Vertical burst: once a reveal glide is already in-flight, a continuing
    // vertical wheel tick crossing from history onto the rail must interrupt the glide and preserve
    // its ~50px wheel delta with no snap/clamp.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 20.0);
    rt.frame(0.016);
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_before_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_before_wheel > 100.0,
        "precondition: reveal glide must be mid-flight before mid-glide WheelOwner::Vertical tick: offset={mid_before_wheel}"
    );
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, 50.0);
    rt.frame(0.016);
    let mid_wheel_interrupted = owner(&mut rt.state).scroll.get().rail_glide_interrupted;
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let after_mid_wheel = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        mid_wheel_interrupted
            && owner(&mut rt.state).jump.is_browsing()
            && owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && (after_mid_wheel - (mid_before_wheel - 50.0)).abs() <= 15.0,
        "mid-glide WheelOwner::Vertical tick must interrupt the glide and preserve its ~50px wheel delta: interrupted={mid_wheel_interrupted}, before={mid_before_wheel}, after={after_mid_wheel}"
    );

    // A non-timeline subsystem (search::poll) returning changed=true on the same crate::poll frame
    // causes main.rs to call tx.instant(); poll_reveal must defer on that frame so a concurrent
    // touch pan is never overwritten by a snapped glide.
    static TRACKED_POLL_CHANGED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    fn tracked_poll(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
        let changed = crate::poll(s, now, tx);
        TRACKED_POLL_CHANGED.store(changed, std::sync::atomic::Ordering::SeqCst);
        changed
    }
    rt.update(|s, tx| {
        owner(s).backend = Some(codenomad_client::backend::Backend {
            client: codenomad_client::http::Http::new().unwrap(),
            base: "http://127.0.0.1:9/".into(),
            workspace: "w".into(),
            session: "s".into(),
            client_id: "c".into(),
            session_directory: None,
            fresh_mode: false,
        });
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let before_instant_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        before_instant_race > 200.0 && !owner(&mut rt.state).jump.is_browsing(),
        "precondition: rail near bottom before search::poll changed=true deferral check"
    );
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.update(|s, _| search::deliver_result(s));
    TRACKED_POLL_CHANGED.store(false, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.touch(3, TouchPhase::Started, x, y0, 5.0);
    rt.touch(3, TouchPhase::Moved, x, y0 + 20.0, 5.016);
    rt.touch(3, TouchPhase::Moved, x, y0 + 90.0, 5.032);
    rt.frame(0.016);
    let early_poll_changed = TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst);
    let early_scroll = owner(&mut rt.state).scroll.get();
    let during_instant_race = early_scroll.at.offset[1];
    let deferred_on_instant = early_scroll.programmatic_rail.is_none()
        && early_scroll.rail_glide.is_none()
        && !early_scroll.rail_glide_interrupted;
    rt.poll = Some(crate::poll);
    rt.touch(3, TouchPhase::Ended, x, y0 + 90.0, 5.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_instant_race = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        early_poll_changed
            && deferred_on_instant
            && owner(&mut rt.state).jump.is_browsing()
            && during_instant_race < before_instant_race - 50.0
            && (after_instant_race - during_instant_race).abs() <= 5.0,
        "poll_reveal must defer when search::poll causes crate::poll to call tx.instant(): changed={early_poll_changed}, deferred={deferred_on_instant}, interrupted={}, before={before_instant_race}, during={during_instant_race}, after={after_instant_race}",
        early_scroll.rail_glide_interrupted
    );
    rt.update(|s, _| search::close(s));
    rt.frame(0.016);

    // Changing target mid-glide must halt Rune's in-flight glide instead of letting it run to the
    // obsolete aim: (a) clearing active via seek_message to a distant hit, and (b) switching active
    // to a marker already visible in the current rail viewport.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let start_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(start_halt_a > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0)
            && mid_halt_a > 60.0
            && mid_halt_a < start_halt_a - 1.0,
        "precondition: glide toward tp-0 must be mid-flight before seek_message: start={start_halt_a}, mid={mid_halt_a}, glide={:?}",
        owner(&mut rt.state).scroll.get().rail_glide
    );
    let (halt_cmd_tx, _halt_cmd_rx) = codenomad_client::bounded(4);
    rt.update(|s, tx| {
        s.commands = Some(halt_cmd_tx);
        owner(s).online = true;
        navigation::seek_message(s, "distant-search-hit", tx);
    });
    assert!(
        owner(&mut rt.state).jump.active.is_none(),
        "precondition: seek_message to distant hit must clear active"
    );
    for _ in 0..40 {
        rt.frame(0.016);
    }
    let end_halt_a = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && end_halt_a > 50.0
            && (end_halt_a - mid_halt_a).abs() <= 25.0,
        "clearing active mid-glide via seek_message must halt the obsolete Rune glide instead of reaching 0.0: mid={mid_halt_a}, end={end_halt_a}"
    );

    // (b) Switching active to a marker already visible at the current mid-glide position must also
    // halt the obsolete glide.
    rt.update(|s, tx| {
        navigation::cancel_search(s);
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    let start_halt_b = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(start_halt_b > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_at_b = owner(&mut rt.state).scroll.get().at;
    let mid_halt_b = mid_at_b.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0)
            && mid_halt_b > 60.0
            && mid_halt_b < start_halt_b - 1.0,
        "precondition: glide toward tp-0 must be mid-flight before switching to visible marker: start={start_halt_b}, mid={mid_halt_b}"
    );
    let visible_idx = (0..40)
        .find(|&idx| rune_theme_codenomad::timeline::reveal_target(idx, mid_at_b).is_none())
        .expect("a marker already visible at mid-glide offset");
    rt.update(|s, tx| {
        navigation::select(s, &format!("tp-{visible_idx}:User:0:false"), tx);
    });
    for _ in 0..40 {
        rt.frame(0.016);
    }
    let end_halt_b = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide.is_none()
            && end_halt_b > 50.0
            && (end_halt_b - mid_halt_b).abs() <= 25.0,
        "switching active mid-glide to an already-visible marker must halt the obsolete glide: mid={mid_halt_b}, end={end_halt_b}"
    );

    // Late-subsystem changed=true (shell::notifications::poll at the tail of crate::poll, after
    // Display::poll / files::poll / git::poll) must STILL defer poll_reveal on that tx.instant() frame.
    // Settle the notification settings fixture first and verify a quiet frame reports changed=false
    // so only shell::notifications::poll produces changed=true on the tested frame.
    rt.update(|s, tx| {
        crate::settings::notification_fixture(s);
        crate::settings::notification_test_config(s, None);
        navigation::select(s, "tp-39:User:0:false", tx);
    });
    for _ in 0..45 {
        rt.frame(0.016);
    }
    TRACKED_POLL_CHANGED.store(true, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.frame(0.016);
    assert!(
        !TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst),
        "precondition: settings::poll and all earlier subsystems must be quiet (changed=false) before emitting notification"
    );
    rt.poll = Some(crate::poll);
    let before_late_instant = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(before_late_instant > 200.0 && !owner(&mut rt.state).jump.is_browsing());
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.update(|s, _| {
        crate::shell::notifications::emit_outcome(
            s,
            crate::shell::notifications::Category::Settings,
            None,
            "late-poll-change",
            true,
        );
    });
    TRACKED_POLL_CHANGED.store(false, std::sync::atomic::Ordering::SeqCst);
    rt.poll = Some(tracked_poll);
    rt.touch(5, TouchPhase::Started, x, y0, 6.0);
    rt.touch(5, TouchPhase::Moved, x, y0 + 20.0, 6.016);
    rt.touch(5, TouchPhase::Moved, x, y0 + 90.0, 6.032);
    rt.frame(0.016);
    let late_poll_changed = TRACKED_POLL_CHANGED.load(std::sync::atomic::Ordering::SeqCst);
    let late_scroll = owner(&mut rt.state).scroll.get();
    let during_late_instant = late_scroll.at.offset[1];
    let deferred_on_late_instant = late_scroll.programmatic_rail.is_none()
        && late_scroll.rail_glide.is_none()
        && !late_scroll.rail_glide_interrupted;
    rt.poll = Some(crate::poll);
    rt.touch(5, TouchPhase::Ended, x, y0 + 90.0, 6.25);
    for _ in 0..30 {
        rt.frame(0.016);
    }
    let after_late_instant = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        late_poll_changed
            && deferred_on_late_instant
            && owner(&mut rt.state).jump.is_browsing()
            && during_late_instant < before_late_instant - 50.0
            && (after_late_instant - during_late_instant).abs() <= 5.0,
        "poll_reveal must defer when a late subsystem (shell::notifications::poll) causes crate::poll to call tx.instant(): changed={late_poll_changed}, deferred={deferred_on_late_instant}, interrupted={}, before={before_late_instant}, during={during_late_instant}, after={after_late_instant}",
        late_scroll.rail_glide_interrupted
    );

    // Zero-drag touch tap on the rail mid-glide halts Rune's glide without changing offset; the
    // stall watchdog must detect the halted glide and resume revealing the active marker.
    rt.update(|s, tx| navigation::select(s, "tp-39:User:0:false", tx));
    for _ in 0..45 {
        rt.frame(0.016);
    }
    rt.poll = None;
    rt.update(|s, tx| navigation::select(s, "tp-0:User:0:false", tx));
    rt.frame(0.016);
    rt.poll = Some(crate::poll);
    for _ in 0..2 {
        rt.frame(0.016);
    }
    let mid_tap = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        owner(&mut rt.state).scroll.get().rail_glide == Some(0.0) && mid_tap > 80.0,
        "precondition: reveal glide toward tp-0 must be mid-flight before zero-drag tap: offset={mid_tap}"
    );
    // Tap strictly in a gap between rail markers (outside every marker button rect) without dragging.
    let mut rail_buttons: Vec<[f32; 4]> = rt
        .elements()
        .into_iter()
        .filter(|n| {
            n.path.contains("/timeline/")
                && n.role == "button"
                && n.visible[2] > 0.0
                && n.visible[3] > 0.0
        })
        .map(|n| n.rect)
        .collect();
    rail_buttons.sort_by(|a, b| a[1].total_cmp(&b[1]));
    let tap_y = rail_buttons
        .windows(2)
        .find_map(|pair| {
            let gap = pair[1][1] - (pair[0][1] + pair[0][3]);
            let mid = pair[0][1] + pair[0][3] + gap / 2.0;
            (gap >= 1.0 && mid >= rail[1] + 1.0 && mid <= rail[1] + rail[3] - 1.0).then_some(mid)
        })
        .expect("visible gap between two adjacent rail marker buttons");
    assert!(
        rail_buttons
            .iter()
            .all(|b| { !(x >= b[0] && x <= b[0] + b[2] && tap_y >= b[1] && tap_y <= b[1] + b[3]) }),
        "precondition: tap point ({x}, {tap_y}) must lie in the gap between rail markers"
    );
    rt.touch(6, TouchPhase::Started, x, tap_y, 7.0);
    rt.touch(6, TouchPhase::Ended, x, tap_y, 7.032);
    rt.frame(0.016);
    let stalled_after_tap = owner(&mut rt.state).scroll.get().at.offset[1];
    let stall_wake = rt.wake_deadline().expect("50ms watchdog wake scheduled");
    let stall_dt = stall_wake - rt.clock;
    assert!(
        !rt.animating && stalled_after_tap > 80.0 && stall_dt > 0.0 && stall_dt <= 0.06,
        "zero-drag tap must stall mid-flight (!animating) and schedule the ~50ms watchdog wake (not 500ms long-press): animating={}, offset={stalled_after_tap}, dt={stall_dt}",
        rt.animating
    );
    // Advance strictly via the ~50ms watchdog wakes until the watchdog itself restarts the glide.
    let mut watchdog_wakes = 0usize;
    let mut restarted = false;
    for _ in 0..80 {
        let off = owner(&mut rt.state).scroll.get().at.offset[1];
        if off <= 1.0 {
            break;
        }
        if rt.animating {
            if watchdog_wakes > 0 && !restarted {
                restarted = true;
            }
            rt.frame(0.016);
        } else if let Some(deadline) = rt.wake_deadline() {
            let dt = deadline - rt.clock;
            assert!(
                dt > 0.0 && dt <= 0.06,
                "stall watchdog wake must remain bounded at ~50ms (not 500ms long-press): dt={dt}"
            );
            watchdog_wakes += 1;
            rt.frame(dt.max(0.016));
        } else {
            panic!(
                "stall watchdog stopped scheduling wakes before rail reached tp-0: offset={off}"
            );
        }
    }
    let after_tap_recovery = owner(&mut rt.state).scroll.get().at.offset[1];
    assert!(
        watchdog_wakes >= 1
            && restarted
            && !owner(&mut rt.state).jump.is_browsing()
            && after_tap_recovery <= 1.0,
        "zero-drag touch tap mid-glide must recover via 50ms watchdog wakes and finish revealing tp-0: wakes={watchdog_wakes}, restarted={restarted}, mid={mid_tap}, stalled={stalled_after_tap}, after={after_tap_recovery}"
    );

    // Distant jump in flight: a vertical wheel burst starting on the rail must be claimed by
    // RailWheelOverride (WheelOwner::Handler, never WheelOwner::Vertical), so crossing onto the
    // transcript immediately cancels the distant jump and rejects its late admit_window.
    let (claim_tx, claim_rx) = codenomad_client::bounded(4);
    rt.update(|s, tx| {
        s.commands = Some(claim_tx);
        owner(s).online = true;
        navigation::seek_message(s, "distant-claimed", tx);
    });
    let (claim_ticket, claim_cancelled) = match claim_rx.try_recv().expect("distant jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let rail = rt.presented("timeline").expect("timeline presented").0;
    let hist = rt.presented("history").expect("history presented").0;
    rt.wheel_xy(rail[0] + rail[2] / 2.0, rail[1] + rail[3] / 2.0, 0.0, -30.0);
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).scroll.get().last_rail_wheel_taken
            && owner(&mut rt.state).jump.has_flight(),
        "wheel starting on rail during an in-flight distant jump must be claimed by RailWheelOverride while keeping flight alive"
    );
    rt.wheel_xy(hist[0] + hist[2] / 2.0, hist[1] + hist[3] / 2.0, 0.0, 40.0);
    rt.frame(0.016);
    let mut claim_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        claim_ticket,
        crate::history::Page {
            rows: vec![user("distant-claimed")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            claim_accepted = true;
            true
        },
    );
    assert!(
        claim_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !claim_accepted
            && rt.state.messages.iter().all(|m| m.id != "distant-claimed"),
        "drifting a rail wheel burst onto the transcript during a distant jump must cancel the jump and reject late admission"
    );

    // Successful resident search jump while history-search is open locks with no rail marker;
    // closing search via Escape without scrolling must unlock the rail and immediately highlight
    // the reading line's active marker again.
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    assert!(search::is_open(&rt.state));
    rt.update(|s, tx| navigation::seek_message(s, "tp-10", tx));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.is_none(),
        "precondition: successful search jump while search is open locks without a rail marker"
    );
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Escape,
                mods: rune::Mods::default(),
            },
            tx,
        ));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state)
            && !owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.active.as_deref() == Some("tp-10:User:0:false"),
        "closing open search via Escape after a successful jump must unlock the rail and restore active marker tp-10: open={}, locked={}, active={:?}",
        search::is_open(&rt.state),
        owner(&mut rt.state).jump.is_locked(),
        owner(&mut rt.state).jump.active
    );
}

#[test]
fn disabling_timeline_while_search_open_cancels_rail_jump_and_clears_retry_banner() {
    let mut s = crate::init();
    let (tx, rx) = codenomad_client::bounded(4);
    s.commands = Some(tx);
    s.messages = vec![user("row-0")];
    owner(&mut s).width = 800.0;
    owner(&mut s).online = true;
    owner(&mut s).refresh = false;
    owner(&mut s).backend = Some(codenomad_client::backend::Backend {
        client: codenomad_client::http::Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "w".into(),
        session: "s".into(),
        client_id: "c".into(),
        session_directory: None,
        fresh_mode: false,
    });
    owner(&mut s).outline = Some(Arc::new(Outline {
        entries: ["distant", "row-0"]
            .into_iter()
            .enumerate()
            .map(|(seq, id)| {
                serde_json::from_value(json!({
                    "id": id,
                    "seq": seq + 1,
                    "type": "user",
                    "tools": 0,
                    "reasoning": 0,
                    "text": 1,
                }))
                .unwrap()
            })
            .collect(),
        total: 2,
        cacheable: false,
        saved: None,
    }));
    owner(&mut s).changed = true;
    owner(&mut s).index_changed = true;
    let mut rt = Runtime::new(s, view, (800.0, 500.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    // Start a rail jump, open history search, then disable timeline (keeping rail width >= 420px
    // so narrowing does not already cancel the rail jump).
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (ticket, cancelled) = match rx.try_recv().expect("rail jump dispatched") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state) && owner(&mut rt.state).jump.has_flight(),
        "precondition: search open and rail jump still in flight before disabling timeline"
    );
    // Disable showMessageTimeline WITHOUT stepping poll() first: admit_window's own origin guard
    // must reject the rail-originated response before poll() has a chance to cancel it.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    let mut accepted = false;
    navigation::admit_window(
        &mut rt.state,
        ticket,
        crate::history::Page {
            rows: vec![user("distant")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            accepted = true;
            true
        },
    );
    assert!(
        !accepted
            && owner(&mut rt.state).jump.has_flight()
            && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump after showMessageTimeline is disabled even before poll() cancels it"
    );
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && owner(&mut rt.state).outline.is_none(),
        "disabling timeline while search is open must keep search open, cancel the rail jump, and drop uncacheable outline"
    );

    // Also test disabling at normal width (800 px) while search is OPEN:
    // 1a. Non-cacheable outline with folded markers + active scan + locked rail selection (NO retry)
    //     must all be cleared immediately by poll()/cancel_rail_jump() while keeping search open.
    rt.set_viewport((800.0, 500.0), 1.0);
    rt.update(|s, _| {
        s.messages.push(
            crate::history::decode_message(&json!({
                "id": "folded-msg",
                "type": "assistant",
                "content": [
                    { "type": "text", "text": "part one" },
                    { "type": "tool", "id": "t1", "name": "read", "state": { "status": "completed", "input": {} } },
                    { "type": "text", "text": "part two" },
                ],
            }))
            .unwrap()
            .into(),
        );
        crate::settings::fixture_transcript(
            s,
            json!({
                "showMessageTimeline": true,
                "toolCallExpansionDefaults": { "tools": { "read": "hidden" } },
            }),
        );
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let (scan_cancel, scan_cancelled) = codenomad_client::bounded(1);
    let (_scan_tx, scan_rx) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        let t = owner(s);
        t.outline = Some(Arc::new(Outline {
            entries: vec![
                serde_json::from_value(json!({
                    "id": "distant",
                    "seq": 1,
                    "type": "user",
                    "tools": 0,
                    "reasoning": 0,
                    "text": 1,
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "id": "row-0",
                    "seq": 2,
                    "type": "user",
                    "tools": 0,
                    "reasoning": 0,
                    "text": 1,
                }))
                .unwrap(),
                serde_json::from_value(json!({
                    "id": "folded-msg",
                    "seq": 3,
                    "type": "assistant",
                    "tools": 1,
                    "reasoning": 0,
                    "text": 2,
                }))
                .unwrap(),
            ],
            total: 3,
            cacheable: false,
            saved: None,
        }));
        t.changed = true;
        t.index_changed = true;
        t.scan = Some((scan_cancel, scan_rx));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "row-0:User:0:false", tx));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).outline.is_some()
            && !owner(&mut rt.state).folded.is_empty()
            && !scan_cancelled.is_closed()
            && owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.retry.is_none(),
        "precondition (locked without retry) at 800 px with search open: outline, folded, scan, and locked rail selection present"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).outline.is_none()
            && owner(&mut rt.state).markers.is_empty()
            && owner(&mut rt.state).folded.is_empty()
            && scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && !owner(&mut rt.state).jump.is_locked(),
        "disabling timeline at normal width while search is open must cancel scan, free uncacheable outline+folded, and clear locked rail selection without retry"
    );

    // 1b. Rail retry WITHOUT locked selection while search is OPEN must also be cleared immediately
    //     by cancel_rail_jump() and unmount timeline-jump-retry on a single poll frame.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        owner(s).jump.retry = Some(Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        }));
    });
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && !owner(&mut rt.state).jump.is_locked()
            && owner(&mut rt.state).jump.retry.is_some()
            && rt.presented("timeline-jump-retry").is_some(),
        "precondition (retry without lock) with search open: retry banner present"
    );
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        search::is_open(&rt.state)
            && owner(&mut rt.state).jump.retry.is_none()
            && rt.presented("timeline-jump-retry").is_none(),
        "disabling timeline with search open must clear rail retry without lock and unmount retry banner on one poll frame"
    );

    // 2. A search-originated jump started BEFORE disabling showMessageTimeline must survive the
    //    toggle, admit, and align cleanly to the target row.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant", tx));
    let search_ticket = match rx.try_recv().expect("search jump dispatched") {
        crate::transport::Command::Anchor(jump) => jump.ticket,
        other => panic!("unexpected command: {other:?}"),
    };
    assert!(navigation::pending_search(&mut rt.state));
    rt.update(|s, _| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": false }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(
        search::is_open(&rt.state) && navigation::pending_search(&mut rt.state),
        "search jump started before disabling showMessageTimeline must survive the toggle"
    );
    let mut search_accepted = false;
    rt.update(|s, _| {
        navigation::admit_window(
            s,
            search_ticket,
            crate::history::Page {
                rows: vec![
                    user("above-0"),
                    user("above-1"),
                    user("distant"),
                    user("below-0"),
                ],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            || {
                search_accepted = true;
                true
            },
        );
    });
    for _ in 0..15 {
        rt.frame(0.016);
    }
    let hist = rt.presented("history").expect("history presented").0;
    let distant_row = rt
        .presented("distant")
        .expect("search jump distant row presented")
        .0;
    assert!(
        search_accepted
            && !owner(&mut rt.state).jump.has_flight()
            && (distant_row[1] - hist[1]).abs() <= 2.0,
        "search-originated jump surviving showMessageTimeline=false must admit AND align to distant: hist={hist:?}, row={distant_row:?}"
    );

    // 3. Disabling showMessageTimeline with search closed cancels a rail jump.retry and unmounts
    //    timeline-jump-retry immediately on the next frame.
    rt.update(|s, _| {
        search::close(s);
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, _| {
        owner(s).jump.retry = Some(Marker::from(timeline::Marker {
            message: "distant",
            kind: MarkerKind::User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        }));
    });
    rt.frame(0.016);
    assert!(rt.presented("timeline-jump-retry").is_some());
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "disabling showMessageTimeline must clear jump.retry and unmount timeline-jump-retry immediately"
    );

    // 4. Opening a Files preview hides the conversation: both search and rail jumps must be
    //    rejected pre-poll by admit_window() and cancelled by poll() -> suspend().
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({ "showMessageTimeline": true }));
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant-behind-preview", tx));
    let (preview_search_ticket, preview_search_cancelled) =
        match rx.try_recv().expect("search jump") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
        s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
            &codenomad_client::search::Hit {
                session: "s".into(),
                message: "row-0".into(),
                role: "user".into(),
                part: 0,
                kind: codenomad_client::search::Kind::Text,
                excerpt: "row-0".into(),
            },
            "row-0",
            false,
        ));
    });
    let mut behind_preview_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        preview_search_ticket,
        crate::history::Page {
            rows: vec![user("distant-behind-preview")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            behind_preview_accepted = true;
            true
        },
    );
    assert!(
        !behind_preview_accepted
            && rt
                .state
                .messages
                .iter()
                .all(|m| m.id != "distant-behind-preview"),
        "admit_window must reject a search jump once a Files preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        preview_search_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !search::is_open(&rt.state)
            && rt.state.transcript_display.search_highlight.is_none(),
        "poll() must suspend timeline/search and cancel in-flight jump when a Files preview opens"
    );
    // Closing the Files preview must NOT resurrect the closed search window.
    rt.update(|s, _| s.files = None);
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state) && rt.presented("history-search").is_none(),
        "closing Files preview must keep history search closed"
    );

    // 5. A rail-originated jump behind a Files preview must also be rejected pre-poll and cancelled on poll.
    rt.update(|s, _| {
        s.messages.retain(|m| m.id != "distant");
        s.revision += 1;
        owner(s).online = true;
        owner(s).outline = Some(Arc::new(Outline {
            entries: ["distant", "row-0"]
                .into_iter()
                .enumerate()
                .map(|(seq, id)| {
                    serde_json::from_value(json!({
                        "id": id,
                        "seq": seq + 1,
                        "type": "user",
                        "tools": 0,
                        "reasoning": 0,
                        "text": 1,
                    }))
                    .unwrap()
                })
                .collect(),
            total: 2,
            cacheable: false,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
    });
    for _ in 0..3 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (preview_rail_ticket, preview_rail_cancelled) = match rx.try_recv().expect("rail jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let (files_scan_cancel, files_scan_cancelled) = codenomad_client::bounded(1);
    let (_files_scan_out, files_scan_inbox) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        owner(s).scan = Some((files_scan_cancel, files_scan_inbox));
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    let mut rail_behind_files_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        preview_rail_ticket,
        crate::history::Page {
            rows: vec![user("distant")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            rail_behind_files_accepted = true;
            true
        },
    );
    assert!(
        !rail_behind_files_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump once a Files preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        preview_rail_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && files_scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && owner(&mut rt.state).outline.is_none(),
        "poll() must cancel an in-flight rail jump and outline scan and drop uncacheable outline when a Files preview opens"
    );
    rt.update(|s, _| s.files = None);
    for _ in 0..5 {
        rt.frame(0.016);
    }

    // 6. Opening a Git preview hides the conversation identically: reject both rail and search
    //    jumps pre-poll, cancel on poll(), and keep search closed after closing the Git preview.
    rt.update(|s, tx| {
        s.messages.retain(|m| m.id != "distant");
        s.revision += 1;
        owner(s).online = true;
        owner(s).outline = Some(Arc::new(Outline {
            entries: ["distant", "row-0"]
                .into_iter()
                .enumerate()
                .map(|(seq, id)| {
                    serde_json::from_value(json!({
                        "id": id,
                        "seq": seq + 1,
                        "type": "user",
                        "tools": 0,
                        "reasoning": 0,
                        "text": 1,
                    }))
                    .unwrap()
                })
                .collect(),
            total: 2,
            cacheable: false,
            saved: None,
        }));
        owner(s).changed = true;
        owner(s).index_changed = true;
        super::structure_changed(s);
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::select(s, "distant:User:0:false", tx));
    let (git_rail_ticket, git_rail_cancelled) = match rx.try_recv().expect("git rail jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    let (git_scan_cancel, git_scan_cancelled) = codenomad_client::bounded(1);
    let (_git_scan_out, git_scan_inbox) = codenomad_client::bounded(1);
    rt.update(|s, _| {
        owner(s).scan = Some((git_scan_cancel, git_scan_inbox));
        crate::git::fixture_open_preview(s);
    });
    assert!(
        crate::git::has_preview(&rt.state),
        "precondition: Git preview must be active"
    );
    let mut git_rail_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        git_rail_ticket,
        crate::history::Page {
            rows: vec![user("distant")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            git_rail_accepted = true;
            true
        },
    );
    assert!(
        !git_rail_accepted && rt.state.messages.iter().all(|m| m.id != "distant"),
        "admit_window must reject a rail jump once a Git preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        git_rail_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && git_scan_cancelled.is_closed()
            && owner(&mut rt.state).scan.is_none()
            && owner(&mut rt.state).outline.is_none()
            && !search::is_open(&rt.state),
        "poll() must suspend timeline/search, cancel in-flight rail jump and outline scan, and drop uncacheable outline when a Git preview opens"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !crate::git::has_preview(&rt.state)
            && !search::is_open(&rt.state)
            && rt.presented("history-search").is_none(),
        "closing Git preview must keep history search closed"
    );
    // Also verify a search-originated jump behind a Git preview.
    rt.update(|s, tx| {
        assert!(search::keys(
            s,
            &rune::KeyEvent {
                key: rune::Key::Command('f'),
                mods: rune::Mods {
                    ctrl: true,
                    ..Default::default()
                },
            },
            tx,
        ));
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| navigation::seek_message(s, "distant-behind-git", tx));
    let (git_search_ticket, git_search_cancelled) = match rx.try_recv().expect("git search jump") {
        crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
        other => panic!("unexpected command: {other:?}"),
    };
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    let mut git_search_accepted = false;
    navigation::admit_window(
        &mut rt.state,
        git_search_ticket,
        crate::history::Page {
            rows: vec![user("distant-behind-git")],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
        || {
            git_search_accepted = true;
            true
        },
    );
    assert!(
        !git_search_accepted
            && rt
                .state
                .messages
                .iter()
                .all(|m| m.id != "distant-behind-git"),
        "admit_window must reject a search jump once a Git preview opens, even before poll() runs"
    );
    rt.frame(0.016);
    assert!(
        git_search_cancelled.is_closed()
            && !owner(&mut rt.state).jump.has_flight()
            && !search::is_open(&rt.state),
        "poll() must suspend timeline/search and cancel in-flight search jump when a Git preview opens"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !search::is_open(&rt.state) && rt.presented("history-search").is_none(),
        "closing Git preview after search jump must keep history search closed"
    );

    // 7. Isolate has_pending_or_locked: with the rail already disabled (live=false, visible=false)
    //    and history search closed, opening a Files or Git preview must still call suspend() to
    //    cancel a pending jump or locked search state.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    for _ in 0..5 {
        rt.frame(0.016);
    }
    assert!(
        !owner(&mut rt.state).live && !owner(&mut rt.state).visible && !search::is_open(&rt.state),
        "precondition: rail already inactive and search closed before isolated Files/Git preview suspension"
    );
    // (a) Files preview suspends a pending jump when rail is already inactive.
    rt.update(|s, tx| navigation::seek_message(s, "distant-no-rail-files", tx));
    let (_no_rail_files_ticket, no_rail_files_cancelled) =
        match rx.try_recv().expect("search jump with rail disabled") {
            crate::transport::Command::Anchor(jump) => (jump.ticket, jump.cancelled),
            other => panic!("unexpected command: {other:?}"),
        };
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    rt.frame(0.016);
    assert!(
        no_rail_files_cancelled.is_closed() && !owner(&mut rt.state).jump.has_flight(),
        "opening Files preview when rail is already inactive must suspend via has_pending_or_locked"
    );
    rt.update(|s, _| s.files = None);
    for _ in 0..3 {
        rt.frame(0.016);
    }
    // (b) Git preview suspends a locked search selection when rail is already inactive.
    rt.update(|s, tx| {
        if s.messages.iter().all(|m| m.id != "row-0") {
            s.messages.push(user("row-0"));
            s.revision += 1;
        }
        navigation::seek_message(s, "row-0", tx);
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.is_locked()
            && !owner(&mut rt.state).live
            && !owner(&mut rt.state).visible
            && !search::is_open(&rt.state),
        "precondition: locked search jump with inactive rail and closed search before Git preview"
    );
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    rt.frame(0.016);
    assert!(
        !owner(&mut rt.state).jump.is_locked(),
        "opening Git preview when rail is already inactive must clear locked search jump via has_pending_or_locked"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    rt.frame(0.016);
    // (c) Isolate jump.retry alone (no flight, unlocked, inactive rail, closed search) for both
    //     Files and Git previews.
    let retry_marker = || Marker {
        id: String::new(),
        message: "retry-only".into(),
        kind: MarkerKind::User,
        ordinal: 0,
        continued: false,
        omitted_before: false,
        tool: None,
    };
    rt.update(|s, _| {
        owner(s).jump.retry = Some(retry_marker());
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_some()
            && rt.presented("timeline-jump-retry").is_some()
            && !owner(&mut rt.state).jump.has_flight()
            && !owner(&mut rt.state).jump.is_locked()
            && !owner(&mut rt.state).live
            && !owner(&mut rt.state).visible
            && !search::is_open(&rt.state),
        "precondition: standalone jump.retry banner mounted with inactive rail and closed search before Files preview"
    );
    rt.update(|s, _| {
        let mut files = crate::files::Ui::new(
            crate::backend::Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: "test".into(),
                session: "s".into(),
                client_id: "c".into(),
                session_directory: None,
                fresh_mode: false,
            },
            "/synthetic".into(),
            s.reads.clone(),
            s.wake.clone(),
        );
        files.open("notes.md".into());
        s.files = Some(files);
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "opening Files preview when rail is already inactive must clear standalone jump.retry via suspend() changed=true"
    );
    rt.update(|s, _| {
        s.files = None;
        owner(s).jump.retry = Some(retry_marker());
    });
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_some() && rt.presented("timeline-jump-retry").is_some()
    );
    rt.update(|s, _| crate::git::fixture_open_preview(s));
    rt.frame(0.016);
    assert!(
        owner(&mut rt.state).jump.retry.is_none() && rt.presented("timeline-jump-retry").is_none(),
        "opening Git preview when rail is already inactive must clear standalone jump.retry via suspend() changed=true"
    );
    rt.update(|s, _| crate::git::close_preview(s));
    rt.frame(0.016);
}

#[test]
fn toggling_rail_at_fixed_width_keeps_inner_passage_anchored() {
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({ "showMessageTimeline": true }));
    let long_intro = "Reflowing opening paragraph with plenty of words so narrowing by forty pixels wraps onto extra lines. ".repeat(18);
    let second_block = "Anchored second paragraph inside the same long message. ".repeat(8);
    let tail_block = "Trailing text below the anchored passage. ".repeat(14);
    let long_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id": "long-msg",
        "type": "assistant",
        "time": { "completed": 1 },
        "content": [
            { "type": "text", "text": long_intro },
            { "type": "text", "text": second_block },
            { "type": "text", "text": tail_block }
        ]
    }))
    .unwrap()
    .into();
    s.messages = vec![user("head"), long_msg, user("tail")];
    owner(&mut s).width = 500.0;
    let mut rt = Runtime::new(s, view, (500.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    // Scroll to the second text block inside `long-msg` so `reading.passage` tracks fragment 1, not the message top.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..10 {
        rt.frame(0.016);
    }
    let hist_before = rt.presented("history").expect("history presented").0;
    let frag0_before = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented before rail hide")
        .0;
    let before = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented before rail hide")
        .0;
    let before_rel = before[1] - hist_before[1];
    assert!(
        before_rel.abs() <= 4.0,
        "precondition: fragment-long-msg:1 aligned near top of history before toggling rail: before={before:?}, hist={hist_before:?}"
    );
    // Hide the rail at fixed window width (800px): history widens by 40px and fragment 0 reflows shorter,
    // yet keep_passage must hold fragment 1 at its reading offset.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": false }));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_none());
    let hist_after_hide = rt.presented("history").expect("history presented").0;
    let frag0_after_hide = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after rail hide")
        .0;
    let after_hide = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after rail hide")
        .0;
    let after_hide_rel = after_hide[1] - hist_after_hide[1];
    assert!(
        hist_after_hide[2] > hist_before[2] + 30.0
            && frag0_after_hide[3] < frag0_before[3] - 10.0
            && (after_hide_rel - before_rel).abs() <= 2.0,
        "hiding rail at fixed width must widen history, reflow fragment 0 shorter, and keep fragment 1 anchored: hist_w={}->{}, frag0_h={}->{}, rel={before_rel}->{after_hide_rel}",
        hist_before[2],
        hist_after_hide[2],
        frag0_before[3],
        frag0_after_hide[3]
    );
    // Show the rail again at fixed window width (800px): history narrows by 40px and fragment 0 reflows taller,
    // yet keep_passage must keep fragment 1 anchored.
    crate::settings::fixture_transcript(&mut rt.state, json!({ "showMessageTimeline": true }));
    for _ in 0..10 {
        rt.frame(0.016);
    }
    assert!(rt.presented("timeline").is_some());
    let hist_after_show = rt.presented("history").expect("history presented").0;
    let frag0_after_show = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after rail show")
        .0;
    let after_show = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after rail show")
        .0;
    let after_show_rel = after_show[1] - hist_after_show[1];
    assert!(
        hist_after_show[2] < hist_after_hide[2] - 30.0
            && frag0_after_show[3] > frag0_after_hide[3] + 10.0
            && (after_show_rel - before_rel).abs() <= 2.0,
        "showing rail at fixed width must narrow history, reflow fragment 0 taller, and keep fragment 1 anchored: hist_w={}->{}, frag0_h={}->{}, rel={before_rel}->{after_show_rel}",
        hist_after_hide[2],
        hist_after_show[2],
        frag0_after_hide[3],
        frag0_after_show[3]
    );

    // Narrowing across the 420px threshold hides the rail inside on_layout_tx: Frame 1 measures
    // 419px and enqueues Action::Layout; Frame 2 executes on_layout_tx (unmounting the rail BEFORE
    // timeline::poll sees 419px) and must keep fragment 1 anchored on that very first unmounted frame.
    rt.set_viewport((419.0, 320.0), 1.0);
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_some());
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_none());
    let hist_narrow = rt.presented("history").expect("history presented").0;
    let frag0_narrow = rt
        .presented("fragment-long-msg:0")
        .expect("opening block presented after narrowing")
        .0;
    let after_narrow = rt
        .presented("fragment-long-msg:1")
        .expect("second block presented after narrowing")
        .0;
    let after_narrow_rel = after_narrow[1] - hist_narrow[1];
    assert!(
        frag0_narrow[3] > frag0_after_show[3] + 10.0
            && (after_narrow_rel - before_rel).abs() <= 2.0,
        "narrowing across 420px must keep inner passage anchored on the very first frame the rail unmounts: frag0_h={}->{}, rel={before_rel}->{after_narrow_rel}",
        frag0_after_show[3],
        frag0_narrow[3]
    );
}

#[test]
fn same_frame_rail_then_transcript_wheel_clears_browse() {
    let mut s = crate::init();
    s.messages = (0..30).map(|i| user(&format!("row-{i}"))).collect();
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|s, tx| {
        s.paging = true;
        tx.instant();
        tx.scroll_to_instant("history", 0.0, 300.0);
        let mut sc = owner(s).scroll.get();
        sc.programmatic_rail = Some(200.0);
        owner(s).scroll.set(sc);
        rune_theme_codenomad::timeline::scroll_rail_to(200.0, tx);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    let rail_rect = rt.presented("timeline").expect("timeline presented").0;
    let hist_rect = rt.presented("history").expect("history presented").0;
    let rail_before = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(rail_before > 50.0 && hist_before > 100.0);
    // In a single frame during pagination, wheel on rail first, then drift onto transcript.
    // Even though on_scroll_offset fires in DOM order (history before timeline), wheel_last_rail
    // must preserve chronological order and clear browse.
    rt.wheel_xy(
        rail_rect[0] + rail_rect[2] / 2.0,
        rail_rect[1] + rail_rect[3] / 2.0,
        0.0,
        40.0,
    );
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        -40.0,
    );
    rt.frame(0.016);
    rt.frame(0.016);
    let rail_after = owner(&mut rt.state).scroll.get().at.offset[1];
    let hist_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        (rail_before - rail_after) > 20.0
            && (hist_after - hist_before) > 20.0
            && !owner(&mut rt.state).jump.is_browsing(),
        "same-frame rail -> transcript wheel during pagination must clear browse despite DOM scroll order: rail={rail_before}->{rail_after}, hist={hist_before}->{hist_after}, browse={}",
        owner(&mut rt.state).jump.is_browsing()
    );
}

#[test]
fn rail_arrival_does_not_overwrite_queued_transcript_wheel() {
    let mut s = crate::init();
    let long_intro = "Reflowing opening paragraph with plenty of words so toggling the rail wraps onto extra lines. ".repeat(18);
    let second_block = "Second paragraph below the opening text. ".repeat(10);
    let tail_block = "Trailing text below the second block. ".repeat(16);
    let long_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id": "long-msg",
        "type": "assistant",
        "time": { "completed": 1 },
        "content": [
            { "type": "text", "text": long_intro },
            { "type": "text", "text": second_block },
            { "type": "text", "text": tail_block }
        ]
    }))
    .unwrap()
    .into();
    s.messages = vec![user("head"), long_msg, user("tail")];
    owner(&mut s).width = 800.0;
    let mut rt = Runtime::new(s, view, (800.0, 320.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    for _ in 0..10 {
        rt.frame(0.016);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("long-msg/fragment-long-msg:1", 0.0);
    });
    for _ in 0..5 {
        rt.frame(0.016);
    }
    // Simulate the rail being absent before an outline/marker update arrives (settings::poll settled).
    rt.update(|s, _| {
        let t = owner(s);
        t.markers.clear();
        t.has_raw_markers = false;
        t.changed = false;
        t.refresh = false;
    });
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_none());
    let hist_rect = rt.presented("history").expect("history presented").0;
    let frag1_before = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented")
        .0;
    let offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    assert!(
        offset_before > 100.0 && (frag1_before[1] - hist_rect[1]).abs() <= 2.0,
        "precondition: fragment-long-msg:1 aligned at top before rail arrival: offset={offset_before}, rel={}",
        frag1_before[1] - hist_rect[1]
    );
    // First verify the control case (input_waiting=false): rail arrival calls keep_passage and
    // snaps fragment-long-msg:1 back to rel=0 even if a wheel notch arrives on the same frame.
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, false));
    rt.update(|s, _| {
        owner(s).changed = true;
        owner(s).index_changed = true;
    });
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        60.0,
    );
    rt.frame(0.016);
    let hist_ctrl = rt.presented("history").expect("history presented").0;
    let frag1_ctrl = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after control arrival")
        .0;
    assert!(
        rt.presented("timeline").is_some() && (frag1_ctrl[1] - hist_ctrl[1]).abs() <= 2.0,
        "control: without input_waiting, rail arrival snaps fragment-long-msg:1 back to rel=0: rel={}",
        frag1_ctrl[1] - hist_ctrl[1]
    );
    // Reset to rail-absent state, align fragment-long-msg:1 at top, then repeat with
    // input_waiting=true (as Rune's native/web hosts set when wheel input is queued):
    // timeline::poll must skip keep_passage so the user's upward wheel moves history (~60px).
    rt.poll = Some(crate::poll);
    rt.update(|s, _| {
        let t = owner(s);
        t.markers.clear();
        t.has_raw_markers = false;
        t.changed = false;
        t.refresh = false;
    });
    rt.frame(0.016);
    assert!(rt.presented("timeline").is_none());
    let hist_rect = rt.presented("history").expect("history presented").0;
    let offset_before = owner(&mut rt.state).scroll.get().viewport.offset[1];
    rt.poll = Some(|s, _, tx| super::poll_with_input(s, tx, true));
    rt.update(|s, _| {
        owner(s).changed = true;
        owner(s).index_changed = true;
    });
    rt.wheel_xy(
        hist_rect[0] + hist_rect[2] / 2.0,
        hist_rect[1] + hist_rect[3] / 2.0,
        0.0,
        60.0,
    );
    rt.frame(0.016);
    let hist_after = rt.presented("history").expect("history presented").0;
    let frag1_after = rt
        .presented("fragment-long-msg:1")
        .expect("fragment 1 presented after arrival")
        .0;
    let offset_after = owner(&mut rt.state).scroll.get().viewport.offset[1];
    let rel_after = frag1_after[1] - hist_after[1];
    assert!(
        rt.presented("timeline").is_some()
            && (offset_before - offset_after) >= 30.0
            && rel_after >= 40.0,
        "rail arrival with queued transcript wheel (input_waiting=true) must not overwrite user scroll with keep_passage: shown={}, offset={offset_before}->{offset_after}, rel_after={rel_after}",
        rt.presented("timeline").is_some()
    );
}

pub(crate) fn set_outline_error(s: &mut State, width: f32, error: bool) {
    let t = owner(s);
    t.width = width;
    t.changed = true;
    t.outline_error = error;
}

pub(crate) fn set_filtered_notice(s: &mut State, filtered: bool) {
    owner(s).jump.filtered = filtered;
}

pub(crate) fn rail_scroll_offset(s: &State) -> f32 {
    s.transcript_display.timeline.scroll.get().at.offset[1]
}
