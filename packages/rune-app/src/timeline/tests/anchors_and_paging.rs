use super::*;

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
