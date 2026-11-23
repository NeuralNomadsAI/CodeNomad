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
