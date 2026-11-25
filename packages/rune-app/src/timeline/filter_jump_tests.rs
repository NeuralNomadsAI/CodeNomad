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
use rune_theme_codenomad::layout::Layout;
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
            matches!(target.landing(&s, &row, 0), Landing::Visible(..)),
            visible
        );
        assert_eq!(
            matches!(target.landing(&s, &row, 0), Landing::Filtered),
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

#[test]
fn search_highlight_marks_other_visible_messages_without_opening_their_collapsed_cards() {
    let m1 = row(json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [{"type": "text", "text": "Needle in active message"}]
    }));
    let m2 = row(json!({
        "id": "m2", "type": "assistant", "time": {"completed": 2},
        "content": [
            {"type": "text", "text": "Needle in other prose"},
            {"type": "tool", "id": "r_open", "name": "read", "state": {"status": "completed", "content": [{"type": "text", "text": "Needle in open tool"}]}},
            {"type": "reasoning", "text": "Needle in open thought"},
            {"type": "tool", "id": "g1", "name": "grep", "state": {"status": "completed", "content": [{"type": "text", "text": "first"}]}},
            {"type": "tool", "id": "g2", "name": "grep", "state": {"status": "completed", "content": [{"type": "text", "text": "Needle in collapsed group"}]}},
            {"type": "tool", "id": "b_closed", "name": "bash", "state": {"status": "completed", "content": [{"type": "text", "text": "Needle in collapsed card"}]}}
        ]
    }));
    let sys_open =
        row(json!({"id": "sys_open", "type": "system", "text": "Needle in open system"}));
    let sys_closed =
        row(json!({"id": "sys_closed", "type": "system", "text": "Needle in closed system"}));

    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "toolGroupVisibility": "collapsed",
            "showThinkingBlocks": true,
            "thinkingBlocksExpansion": "expanded",
            "systemMessagesVisibility": "collapsed",
            "toolCallExpansionDefaults": {"tools": {"read": "expanded", "bash": "collapsed", "grep": "collapsed"}}
        }),
    );
    s.messages = vec![m1, m2, sys_open, sys_closed];
    let mut rt = Runtime::new(
        s,
        |s, _| {
            crate::strings::with_locale("en", || {
                rune::col()
                    .full_width()
                    .children((0..s.messages.len()).map(|i| crate::chat::transcript::message(s, i)))
            })
        },
        (960.0, 1200.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.016);

    // Open sys_open manually while leaving sys_closed collapsed; also warm hold_frame caches.
    let (x, y) = rt.find("toggle-context-sys_open").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.5);

    let rect_of = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("missing element key {key}"))
            .rect
    };
    let marks_in = |rt: &Runtime<State>, active: bool, bounds: [f32; 4]| {
        rt.elements()
            .into_iter()
            .filter(|node| {
                node.role == "mark"
                    && node.label.as_deref() == Some("Needle")
                    && (node.key.as_deref() == Some("history-search-match")) == active
                    && node.rect[2] > 0.0
                    && node.rect[3] > 0.0
                    && {
                        let cx = node.rect[0] + node.rect[2] * 0.5;
                        let cy = node.rect[1] + node.rect[3] * 0.5;
                        cx >= bounds[0]
                            && cx <= bounds[0] + bounds[2]
                            && cy >= bounds[1]
                            && cy <= bounds[1] + bounds[3]
                    }
            })
            .count()
    };

    let viewport = [0.0, 0.0, 960.0, 1200.0];
    assert_eq!(marks_in(&rt, true, viewport), 0);
    assert_eq!(marks_in(&rt, false, viewport), 0);

    // Activate search targeting m1 part 0.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(highlight("m1", Kind::Text, 0));
    });
    rt.frame(0.016);

    let m1_rect = rect_of(&rt, "m1");
    let m2_prose = rect_of(&rt, "fragment-m2:0");
    let m2_tool = rect_of(&rt, "tool-m2:6:r_open");
    let m2_thought = rect_of(&rt, "reasoning-m2:0");
    let sys_open_rect = rect_of(&rt, "context-sys_open");

    assert_eq!(marks_in(&rt, true, viewport), 1);
    assert_eq!(marks_in(&rt, true, m1_rect), 1);
    assert_eq!(marks_in(&rt, false, m1_rect), 0);
    assert!(rt.find("history-search-match").is_some());

    // Other visible messages receive secondary marks without stealing the active highlight.
    assert_eq!(marks_in(&rt, true, m2_prose), 0);
    assert_eq!(marks_in(&rt, false, m2_prose), 1);
    assert_eq!(marks_in(&rt, true, m2_tool), 0);
    assert_eq!(marks_in(&rt, false, m2_tool), 1);
    assert_eq!(marks_in(&rt, true, m2_thought), 0);
    assert_eq!(marks_in(&rt, false, m2_thought), 1);
    assert_eq!(marks_in(&rt, true, sys_open_rect), 0);
    assert_eq!(marks_in(&rt, false, sys_open_rect), 1);

    // Collapsed group, collapsed tool card, and collapsed system card in other messages stay closed.
    assert!(rt.find("tool-m2:2:g2").is_none());
    let a11y = rt.accessibility_json().to_string();
    assert!(!a11y.contains("Needle in collapsed card"));
    assert!(!a11y.contains("Needle in closed system"));

    // Moving the active hit to the system message transfers the active anchor and demotes m1.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(highlight("sys_open", Kind::Text, 0));
    });
    rt.frame(0.016);
    assert_eq!(marks_in(&rt, true, viewport), 1);
    assert_eq!(marks_in(&rt, true, sys_open_rect), 1);
    assert_eq!(marks_in(&rt, false, sys_open_rect), 0);
    assert_eq!(marks_in(&rt, true, m1_rect), 0);
    assert_eq!(marks_in(&rt, false, m1_rect), 1);
    assert_eq!(marks_in(&rt, false, m2_prose), 1);
    assert_eq!(marks_in(&rt, false, m2_tool), 1);
    assert_eq!(marks_in(&rt, false, m2_thought), 1);

    // Clearing the search removes all highlights (including inside hold_frame-cached cards).
    rt.update(|s, _| s.transcript_display.search_highlight = None);
    rt.frame(0.016);
    assert_eq!(marks_in(&rt, true, viewport), 0);
    assert_eq!(marks_in(&rt, false, viewport), 0);
}

#[test]
fn search_highlights_cover_rich_tools_long_streaming_reasoning_deep_system_and_unique_task_anchor()
{
    let long_stream = format!("Needle in long stream\n{}", "x".repeat(12_000));
    let deep_system = format!("{}\nNeedle deep in system", "s".repeat(52_000));
    let edit_diff = "--- a/demo.rs\n+++ b/demo.rs\n@@ -1,2 +1,2 @@\n-old\n+Needle in edit diff\n";
    let patch_diff = "--- a/p.rs\n+++ b/p.rs\n@@ -1,2 +1,2 @@\n-before\n+Needle in patch diff\n";
    let m1 = row(json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [
            {"type": "tool", "id": "t_active", "name": "task", "state": {
                "status": "completed",
                "input": {"description": "Run", "prompt": "Needle in task prompt"},
                "content": [{"type": "text", "text": "Task done"}]
            }}
        ]
    }));
    let m2 = row(json!({
        "id": "m2", "type": "assistant",
        "content": [
            {"type": "tool", "id": "ws_open", "name": "websearch", "state": {
                "status": "completed",
                "content": [{"type": "text", "text": "## [Result](https://example.com/a)\nNeedle in websearch snippet"}]
            }},
            {"type": "tool", "id": "ed_open", "name": "edit", "state": {
                "status": "completed",
                "input": {"filePath": "demo.rs"},
                "metadata": {"diff": edit_diff}
            }},
            {"type": "tool", "id": "ap_open", "name": "apply_patch", "state": {
                "status": "completed",
                "metadata": {"files": [{"relativePath": "p.rs", "diff": patch_diff}]}
            }},
            {"type": "reasoning", "text": long_stream}
        ]
    }));
    let sys_deep = row(json!({"id": "sys_deep", "type": "system", "text": deep_system}));

    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "toolGroupVisibility": "collapsed",
            "toolInputsVisibility": "collapsed",
            "showThinkingBlocks": true,
            "thinkingBlocksExpansion": "expanded",
            "systemMessagesVisibility": "collapsed",
            "toolCallExpansionDefaults": {
                "tools": {"task": "collapsed", "websearch": "expanded", "edit": "expanded", "other": "expanded"}
            }
        }),
    );
    s.messages = vec![m1, m2, sys_deep];
    let mut rt = Runtime::new(
        s,
        |s, _| {
            crate::strings::with_locale("en", || {
                rune::col()
                    .full_width()
                    .children((0..s.messages.len()).map(|i| crate::chat::transcript::message(s, i)))
            })
        },
        (960.0, 2400.0),
        Env::new(false, 1.0),
    );
    // Warm hold_frame caches and reveal streaming reasoning past TOOL_LIMIT so it enters hold_frame.
    rt.frame(0.016);
    let (x, y) = rt.find("reveal-reasoning-m2:0-body").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.5);

    let rect_of = |rt: &Runtime<State>, key: &str| {
        rt.elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("missing element key {key}"))
            .rect
    };
    let marks_in = |rt: &Runtime<State>, active: bool, bounds: [f32; 4]| {
        rt.elements()
            .into_iter()
            .filter(|node| {
                node.role == "mark"
                    && node.label.as_deref() == Some("Needle")
                    && (node.key.as_deref() == Some("history-search-match")) == active
                    && node.rect[2] > 0.0
                    && node.rect[3] > 0.0
                    && {
                        let cx = node.rect[0] + node.rect[2] * 0.5;
                        let cy = node.rect[1] + node.rect[3] * 0.5;
                        cx >= bounds[0]
                            && cx <= bounds[0] + bounds[2]
                            && cy >= bounds[1]
                            && cy <= bounds[1] + bounds[3]
                    }
            })
            .count()
    };
    let viewport = [0.0, 0.0, 960.0, 2400.0];

    // Selecting a Tool hit at part 0 on m1 (task) must place only one active anchor on m1
    // (never duplicating it in collapsed/expanded tool_input) and must mark m2's part 0 websearch,
    // edit diff, apply_patch diff, and >TOOL_LIMIT streaming reasoning as secondary only.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(highlight("m1", Kind::Tool, 0));
    });
    rt.frame(0.5);

    let t_active = crate::chat::tools::tool_key("m1", "t_active");
    let m1_rect = rect_of(&rt, "m1");

    assert_eq!(marks_in(&rt, true, viewport), 1);
    assert_eq!(marks_in(&rt, true, m1_rect), 1);
    // Collapsed tool_input stays closed because task::body already claimed the active anchor.
    assert!(rt.find(&format!("copy-{t_active}-input")).is_none());
    // Even if tool_input is manually expanded on the active task card, the anchor remains unique.
    let (x, y) = rt.find(&format!("toggle-{t_active}-tool_input")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.5);
    let m1_rect = rect_of(&rt, "m1");
    let m2_ws = rect_of(&rt, &crate::chat::tools::tool_key("m2", "ws_open"));
    let m2_ed = rect_of(&rt, &crate::chat::tools::tool_key("m2", "ed_open"));
    let m2_ap = rect_of(&rt, &crate::chat::tools::tool_key("m2", "ap_open"));
    let m2_thought = rect_of(&rt, "reasoning-m2:0");
    assert_eq!(marks_in(&rt, true, viewport), 1);
    assert_eq!(marks_in(&rt, true, m1_rect), 1);
    assert_eq!(marks_in(&rt, false, m1_rect), 1);

    assert_eq!(marks_in(&rt, true, m2_ws), 0);
    assert_eq!(marks_in(&rt, false, m2_ws), 1);
    assert_eq!(marks_in(&rt, true, m2_ed), 0);
    assert_eq!(marks_in(&rt, false, m2_ed), 1);
    assert_eq!(marks_in(&rt, true, m2_ap), 0);
    assert_eq!(marks_in(&rt, false, m2_ap), 1);
    assert_eq!(marks_in(&rt, true, m2_thought), 0);
    assert_eq!(marks_in(&rt, false, m2_thought), 1);

    // Selecting a deep system message hit (> PROSE_LIMIT) reveals the match and marks it active.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(highlight("sys_deep", Kind::Text, 0));
    });
    rt.frame(0.5);
    assert!(rt.find("history-search-match").is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Needle deep in system")
    );
    assert_eq!(
        rt.elements()
            .into_iter()
            .filter(|n| n.role == "mark" && n.key.as_deref() == Some("history-search-match"))
            .count(),
        1
    );

    // Clearing search invalidates cached hold_frame cards and removes every search mark.
    rt.update(|s, _| s.transcript_display.search_highlight = None);
    rt.frame(0.5);
    assert!(rt.find("history-search-match").is_none());
    assert_eq!(
        rt.elements()
            .into_iter()
            .filter(|n| n.role == "mark" && n.label.as_deref() == Some("Needle"))
            .count(),
        0
    );
}
