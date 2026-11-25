use super::{navigation, owner, poll};
use crate::{
    State,
    chat::search_hit::SearchHit,
    history::{self, Page, Row},
};
use codenomad_client::{
    bounded,
    search::{Hit, Kind},
};
use rune::{Env, Runtime};
use serde_json::{Value, json};

fn row(value: Value) -> Row {
    history::decode_message(&value).unwrap().into()
}

fn tool_row() -> Row {
    row(
        json!({"id":"tools","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed"}},
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","content":[{"type":"text","text":"Needle"}]}},
            {"type":"reasoning","text":"Needle in reasoning"}
        ]}),
    )
}

fn highlight(message: &str, kind: Kind, part: u64) -> SearchHit {
    SearchHit::new(
        &Hit {
            session: "session".into(),
            message: message.into(),
            role: "assistant".into(),
            part,
            kind,
            excerpt: "Needle".into(),
        },
        "Needle",
        false,
    )
}

#[test]
fn hidden_arguments_refuse_only_hits_without_a_rendered_occurrence() {
    use crate::chat::search_hit::Landing;
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"toolInputsVisibility":"hidden"}));
    let target = highlight("test", Kind::Tool, 0);
    for (output, visible) in [("Other output", false), ("Needle also in the output", true)] {
        let row = row(json!({"id":"test","type":"assistant","content":[
            {"type":"tool","id":"call","name":"grep","state":{"status":"completed","input":{"extra":"Needle"},"content":[{"type":"text","text":output}]}}
        ]}));
        assert_eq!(
            matches!(
                target.landing(&s, std::slice::from_ref(&row), &row, 0),
                Landing::Visible(..)
            ),
            visible
        );
        assert_eq!(
            matches!(
                target.landing(&s, std::slice::from_ref(&row), &row, 0),
                Landing::Filtered
            ),
            !visible
        );
    }
}

fn runtime(rows: Vec<Row>) -> Runtime<State> {
    let mut s = crate::init();
    s.messages = rows;
    owner(&mut s).width = 800.;
    owner(&mut s).changed = true;
    let mut rt = Runtime::new(
        s,
        |s, cx| rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx)),
        (800., 600.),
        Env::new(false, 1.),
    );
    rt.frame(0.016);
    rt
}

#[test]
fn filtered_search_refuses_tool_reasoning_and_system_without_a_window_or_reveal() {
    let mut rt = runtime(vec![
        tool_row(),
        row(json!({"id":"sys","type":"system","text":"Needle"})),
    ]);
    let (send, requests) = bounded(1);
    rt.state.commands = Some(send);
    for (message, kind, part) in [
        ("tools", Kind::Tool, 1),
        ("tools", Kind::Reasoning, 2),
        ("sys", Kind::Text, 0),
    ] {
        rt.update(|s, tx| {
            crate::settings::fixture_transcript(
                s,
                json!({
                    "showThinkingBlocks":false, "systemMessagesVisibility":"hidden",
                    "toolCallExpansionDefaults":{"tools":{"grep":"hidden"}}
                }),
            );
            s.transcript_display.search_highlight = Some(highlight(message, kind, part));
            navigation::seek_message(s, message, tx);
            assert!(owner(s).jump.filtered);
            assert!(s.transcript_display.search_highlight.is_none());
        });
        assert!(requests.try_recv().is_err());
    }
}

#[test]
fn a_group_opens_for_its_search_hit_and_closes_when_the_hit_clears() {
    let mut rt = runtime(vec![tool_row()]);
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({"toolGroupVisibility":"collapsed"}));
        poll(s, tx);
        navigation::select(s, "tools:Tool:1:false", tx);
    });
    rt.frame(0.016);
    assert!(rt.find("toggle-group-tool-tools:1:a").is_some());
    assert!(rt.find("tool-tools:1:b").is_none());
    rt.update(|s, tx| {
        s.transcript_display.search_highlight = Some(highlight("tools", Kind::Tool, 1));
        navigation::seek_message(s, "tools", tx);
    });
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_some());
    assert!(rt.find("history-search-match").is_some());
    rt.update(|s, _| s.transcript_display.search_highlight = None);
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_none());
}

#[test]
fn reopening_a_tool_group_during_search_does_not_persist_after_search_clears() {
    let mut rt = runtime(vec![tool_row()]);
    rt.update(|s, tx| {
        crate::settings::fixture_transcript(s, json!({"toolGroupVisibility":"collapsed"}));
        poll(s, tx);
    });
    rt.frame(0.016);
    let toggle = "toggle-group-tool-tools:1:a";
    assert!(rt.find(toggle).is_some());
    assert!(rt.find("tool-tools:1:b").is_none());

    rt.update(|s, tx| {
        s.transcript_display.search_highlight = Some(highlight("tools", Kind::Tool, 1));
        navigation::seek_message(s, "tools", tx);
    });
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_some());

    // Collapse the search-opened group, then reopen it manually while the hit is still active.
    let (x, y) = rt.find(toggle).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_none());

    let (x, y) = rt.find(toggle).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_some());

    // Clearing the search must restore the pre-search collapsed state instead of leaking expansion.
    rt.update(|s, _| s.transcript_display.search_highlight = None);
    rt.frame(0.016);
    assert!(rt.find("tool-tools:1:b").is_none());
}

#[test]
fn inferred_websearch_prompt_admits_hidden_websearch_in_timeline_and_search() {
    crate::platform::block_on(async {
        let web = row(
            json!({"id":"web","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","id":"ws_old","name":"websearch","state":{"status":"completed","content":[{"type":"text","text":"Needle old"}]}},
                {"type":"tool","id":"ws_active","name":"websearch","state":{"status":"running","content":[{"type":"text","text":"Needle active"}]}}
            ]}),
        );
        let mut rt = runtime(vec![web]);
        rt.update(|s, tx| {
            crate::settings::fixture_transcript(
                s,
                json!({"toolCallExpansionDefaults":{"tools":{"websearch":"hidden"}}}),
            );
            let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let mut agent = crate::agent::Ui::new(crate::agent::start(backend, s.wake.clone()));
            agent.forms = crate::agent_api::forms(
                &json!({"data":[{
                    "id":"form-ws","sessionID":"session","title":"Choose search provider",
                    "fields":[{"key":"provider"}],"metadata":{"kind":"websearch.provider"}
                }]}),
                "session",
            )
            .unwrap();
            s.agent = Some(agent);
            owner(s).changed = true;
            poll(s, tx);
        });
        rt.frame(0.016);

        // Rendering keeps only the latest inferred websearch call visible.
        assert!(rt.find("tool-web:6:ws_old").is_none());
        assert!(rt.find("tool-web:9:ws_active").is_some());

        // Search hit on the rendered inferred websearch is admitted; earlier hidden call stays refused.
        rt.update(|s, tx| {
            s.transcript_display.search_highlight = Some(highlight("web", Kind::Tool, 1));
            navigation::seek_message(s, "web", tx);
            assert!(!owner(s).jump.filtered);
            assert!(owner(s).jump.retry.is_none());
            assert!(s.transcript_display.search_highlight.is_some());
        });
        rt.frame(0.016);
        assert!(rt.find("history-search-match").is_some());

        rt.update(|s, tx| {
            s.transcript_display.search_highlight = Some(highlight("web", Kind::Tool, 0));
            navigation::seek_message(s, "web", tx);
            assert!(owner(s).jump.filtered);
            assert!(s.transcript_display.search_highlight.is_none());
        });

        // Cross-session destination checks (&[]) must never infer against the source session's form.
        rt.update(|s, _| {
            use crate::chat::search_hit::Landing;
            let other = row(json!({"id":"other","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","id":"ws_other","name":"websearch","state":{"status":"completed","content":[{"type":"text","text":"Needle"}]}}
            ]}));
            assert!(matches!(
                highlight("other", Kind::Tool, 0).landing(s, &[], &other, 0),
                Landing::Filtered
            ));
        });

        // Timeline rail retains and admits the inferred websearch marker, while hiding the older one.
        rt.update(|s, tx| {
            let ids: Vec<&str> = owner(s).markers.iter().map(|m| m.id.as_str()).collect();
            assert!(ids.contains(&"web:Tool:1:false"));
            assert!(!ids.contains(&"web:Tool:0:false"));
            navigation::select(s, "web:Tool:1:false", tx);
            assert!(!owner(s).jump.filtered);
            assert!(owner(s).jump.retry.is_none());
            assert_eq!(
                owner(s).jump.requested_active.as_deref(),
                Some("web:Tool:1:false")
            );
        });

        // A historical remote window (newer: Some) must not infer the active session's form onto an
        // older hidden websearch call.
        let (send, requests) = bounded(1);
        rt.state.commands = Some(send);
        let past = row(
            json!({"id":"past","type":"assistant","time":{"completed":1},"content":[
                {"type":"tool","id":"ws_past","name":"websearch","state":{"status":"completed","content":[{"type":"text","text":"Needle past"}]}}
            ]}),
        );
        rt.update(|s, tx| {
            owner(s).online = true;
            owner(s).markers.push(super::Marker::from(
                crate::chat::anchors::blocks(&past, 0, false)[0].marker,
            ));
            navigation::select(s, "past:Tool:0:false", tx);
        });
        let crate::transport::Command::Anchor(jump) = requests.try_recv().unwrap() else {
            panic!("expected anchor")
        };
        rt.update(|s, _| {
            navigation::admit_window(
                s,
                jump.ticket,
                Page {
                    rows: vec![past],
                    older: None,
                    newer: Some("newer-cursor".into()),
                    running: false,
                    user_file_references: false,
                },
                || panic!("historical hidden websearch must not be admitted"),
            );
            assert!(owner(s).jump.filtered);
            assert_eq!(s.messages[0].id, "web");
        });
    });
}

#[test]
fn a_filter_changed_during_a_marker_jump_rejects_the_unpublished_page() {
    let old = row(json!({"id":"old","type":"user","text":"Keep this window"}));
    let mut rt = runtime(vec![old]);
    let (send, requests) = bounded(1);
    rt.state.commands = Some(send);
    rt.update(|s, tx| {
        owner(s).online = true;
        owner(s).markers.push(super::Marker::from(
            crate::chat::anchors::blocks(&tool_row(), 0, false)[1].marker,
        ));
        navigation::select(s, "tools:Tool:1:false", tx);
    });
    let crate::transport::Command::Anchor(jump) = requests.try_recv().unwrap() else {
        panic!("expected anchor")
    };
    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({"toolCallExpansionDefaults":{"tools":{"grep":"hidden"}}}),
        );
        navigation::admit_window(
            s,
            jump.ticket,
            Page {
                rows: vec![tool_row()],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            || panic!("filtered page reached the reader"),
        );
        assert!(owner(s).jump.filtered);
        assert_eq!(s.messages[0].id, "old");
    });
}
