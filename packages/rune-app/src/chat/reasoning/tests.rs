use super::*;

fn settle(rt: &mut rune::Runtime<State>) {
    for _ in 0..240 {
        let active = rt.frame(1.0 / 60.0);
        if !active && !rt.animating {
            return;
        }
    }
    panic!("runtime did not settle within 240 frames");
}

#[test]
fn reasoning_group_uses_native_block_keys_and_reveals_its_parts() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let row = crate::history::decode_message(&json!({
        "id":"step","type":"assistant","time":{"completed":4000},"content":[
            {"type":"reasoning","text":""},
            {"type":"reasoning","text":"First private thought","time":{"created":1000,"completed":2000}},
            {"type":"reasoning","text":"**Summary**\n\nSecond private thought","time":{"created":2000,"completed":4000}},
            {"type":"text","text":"Public reply"},
            {"type":"reasoning","text":"A separate reasoning run"}
        ]
    })).unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    s.messages.push(row.into());
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Thought")
            && tree.contains("Summary")
            && tree.contains("2 steps")
            && tree.contains("3s")
    );
    assert!(!tree.contains("First private thought"));
    assert!(rt.find(&block_key("step", 3)).is_some());
    let key = block_key("step", 1);
    let (x, y) = rt.find(&format!("toggle-{key}")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find(&block_key("step", 2)).is_some());
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("First private thought") && tree.contains("Second private thought"));
    assert!(tree.contains("Public reply"));
}

#[test]
fn rail_reasoning_ordinals_count_visible_runs_not_fragments() {
    use serde_json::json;
    let row = crate::history::decode_message(&json!({"id":"step","type":"assistant","content":[
        {"type":"reasoning","text":""},
        {"type":"reasoning","text":"A"},
        {"type":"text","text":"Reply"},
        {"type":"reasoning","text":"B"}
    ]}))
    .unwrap();
    assert_eq!(run_anchor(&row, 0..0, 0, false), Some(block_key("step", 1)));
    assert_eq!(run_anchor(&row, 0..0, 1, false), Some(block_key("step", 2)));
    assert_eq!(run_anchor(&row, 0..2, 0, false), None);
}

#[test]
fn live_reasoning_updates_the_counter_and_coalesces_long_revealed_text() {
    use crate::{content::ReasoningEvent, transport::Event};
    use rune::{Env, Runtime};
    use serde_json::json;
    let long = "Sample reasoning line. ".repeat(550);
    let row = crate::history::decode_message(&json!({
        "id":"step","type":"assistant","content":[{"type":"reasoning","text":long}]
    }))
    .unwrap();
    let (out, incoming) = crate::bounded(8);
    let mut s = crate::init();
    s.messages.push(row.into());
    s.incoming = Some(incoming);
    s.phase = crate::Phase::Streaming;
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    Display::set_expanded(&mut s, "reasoning-step:0", true);
    let mut rt = Runtime::new(s, crate::view, (960.0, 800.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    let notice = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("reasoning-step:0-body-notice"))
            .unwrap()
            .text
    };
    let before = notice(&rt);
    let append = |text: &str| {
        out.try_send(Event::Reasoning(
            "step".into(),
            ReasoningEvent::Delta {
                ordinal: 0,
                text: text.into(),
            },
        ))
        .unwrap()
    };
    append(" FIRST");
    rt.frame(0.01);
    assert_ne!(notice(&rt), before);
    rt.update(|s, _| Display::reveal_next(s, "reasoning-step:0-body"));
    rt.frame(0.01);
    let rendered = |rt: &Runtime<State>| {
        rt.elements()
            .into_iter()
            .filter_map(|e| e.text)
            .any(|text| text.contains("WAITING-TAIL"))
    };
    append(" WAITING-TAIL");
    rt.frame(0.01);
    assert!(!rendered(&rt));
    rt.frame(0.21);
    assert!(rendered(&rt));
    out.try_send(Event::Reasoning(
        "step".into(),
        ReasoningEvent::End {
            ordinal: 0,
            at: 1000,
            text: "Settled final reasoning".into(),
        },
    ))
    .unwrap();
    rt.frame(0.01);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Settled final reasoning")
    );
}

#[test]
fn reasoning_groups_merge_across_adjacent_messages_and_sum_duration() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let first = crate::history::decode_message(&json!({
        "id":"step1","type":"assistant","time":{"completed":91_000},"content":[
            {"type":"reasoning","text":"**Initial**\n\nFirst step thought","time":{"created":1_000,"completed":91_000}}
        ]
    }))
    .unwrap();
    let second_live = crate::history::decode_message(&json!({
        "id":"step2","type":"assistant","content":[
            {"type":"reasoning","text":"**Final plan**\n\nSecond step thought","time":{"created":92_000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    // Reasoning still groups across messages even when tool grouping is disabled.
    crate::settings::fixture_transcript(
        &mut s,
        json!({"showThinkingBlocks":true,"toolGroupVisibility":"hidden"}),
    );
    s.messages = vec![first.into(), second_live.into()];
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Thinking"));
    assert!(tree.contains("Final plan"));
    assert!(tree.contains("2 steps"));
    assert!(tree.contains("1m 30s"));
    assert!(!tree.contains("First step thought"));
    assert!(!tree.contains("Second step thought"));
    assert!(rt.find("toggle-reasoning-step1:0").is_some());
    assert!(rt.find("toggle-reasoning-step2:0").is_none());

    // Settling the second step updates the shared header to the summed duration across both messages.
    rt.update(|s, _| {
        let second_done = crate::history::decode_message(&json!({
            "id":"step2","type":"assistant","time":{"completed":95_000},"content":[
                {"type":"reasoning","text":"**Final plan**\n\nSecond step thought","time":{"created":92_000,"completed":95_000}}
            ]
        }))
        .unwrap();
        s.messages[1] = second_done.into();
        s.revision += 1;
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Thought"));
    assert!(tree.contains("1m 33s"));
    assert!(tree.contains("Final plan"));
    assert!(tree.contains("2 steps"));

    // Expanding the first header reveals both messages' fragments under their native block keys.
    let (x, y) = rt.find("toggle-reasoning-step1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("First step thought") && tree.contains("Second step thought"));
    assert!(rt.find(&block_key("step1", 0)).is_some());
    assert!(rt.find(&block_key("step2", 0)).is_some());
    assert!(rt.find("toggle-reasoning-step2:0").is_none());

    // Prepending an older page with a contiguous reasoning message keeps the group open under
    // the new head key, and clicking the new head collapses the whole group.
    rt.update(|s, _| {
        let older = crate::history::decode_message(&json!({
            "id":"step0","type":"assistant","time":{"completed":500},"content":[
                {"type":"reasoning","text":"Older thought","time":{"created":0,"completed":500}}
            ]
        }))
        .unwrap();
        s.messages.insert(0, older.into());
        s.revision += 1;
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Older thought") && tree.contains("Second step thought"));
    assert!(rt.find("toggle-reasoning-step0:0").is_some());
    let (x, y) = rt.find("toggle-reasoning-step0:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(!tree.contains("Older thought") && !tree.contains("Second step thought"));

    // Duration rounding uses exact quotient/remainder and whitespace-only titles fall back.
    assert_eq!(extract_title("**   **\n\nBody"), None);
    crate::strings::with_locale("en", || {
        assert_eq!(
            crate::chat::tools::duration::caption(1_499, false).as_deref(),
            Some("1s")
        );
        assert_eq!(
            crate::chat::tools::duration::caption(1_500, false).as_deref(),
            Some("2s")
        );
        assert!(crate::chat::tools::duration::caption(u64::MAX, false).is_some());
    });
}

#[test]
fn hidden_tools_and_blank_fragments_are_transparent_for_reasoning_groups() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let m1 = crate::history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":2000},"content":[
            {"type":"reasoning","text":"Step one","time":{"created":1000,"completed":2000}},
            {"type":"tool","id":"r1","name":"read","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap();
    let m2 = crate::history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":5000},"content":[
            {"type":"text","text":"   "},
            {"type":"reasoning","text":""},
            {"type":"reasoning","text":"Step two","time":{"created":3000,"completed":5000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "showThinkingBlocks":true,
            "toolCallExpansionDefaults":{"tools":{"read":"hidden"}}
        }),
    );
    s.messages = vec![m1.into(), m2.into()];
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Thought") && tree.contains("Thoughts") && tree.contains("3s"));
    assert!(tree.contains("2 steps"));
    assert!(rt.find("toggle-reasoning-m1:0").is_some());
    assert!(rt.find("toggle-reasoning-m2:1").is_none());

    // Making the intervening tool visible splits the reasoning group into two headers.
    rt.update(|s, _| {
        crate::settings::fixture_transcript(
            s,
            json!({
                "showThinkingBlocks":true,
                "toolCallExpansionDefaults":{"tools":{"read":"collapsed"}}
            }),
        );
        s.revision += 1;
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find("toggle-reasoning-m1:0").is_some());
    assert!(rt.find("toggle-reasoning-m2:1").is_some());

    // Hidden rows (hidden thinking, hidden system messages) stay transparent so adjacent tools
    // still group, matching Solid; visible non-empty reasoning splits them while blank reasoning
    // stays transparent.
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":false}));
    let read_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id":"t1","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    let hidden_thought_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id":"t2","type":"assistant","time":{"completed":2},"content":[
            {"type":"reasoning","text":"Hidden thought"}
        ]
    }))
    .unwrap()
    .into();
    let hidden_system_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id":"t3","type":"system","content":[{"type":"text","text":"Hidden system"}]
    }))
    .unwrap()
    .into();
    let grep_msg: crate::history::Row = crate::history::decode_message(&json!({
        "id":"t4","type":"assistant","time":{"completed":3},"content":[
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    let rows = vec![read_msg, hidden_thought_msg, hidden_system_msg, grep_msg];
    assert_eq!(
        crate::chat::anchors::collapsed_group_target(&s, &rows, 3, 0, 0),
        Some(("t1".into(), "group-tool-t1:1:a".into()))
    );
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    assert!(crate::chat::anchors::collapsed_group_target(&s, &rows, 3, 0, 0).is_none());

    // Within a mixed message that stays visible because of its tools, non-empty reasoning still
    // splits adjacent exploration tools even when thinking is hidden (matching Solid), while a
    // blank reasoning fragment stays transparent.
    let mixed_hidden_thought: crate::history::Row = crate::history::decode_message(&json!({
        "id":"mixed","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{}}},
            {"type":"reasoning","text":"Non-empty thought"},
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":false}));
    assert!(
        crate::chat::anchors::collapsed_group_target(
            &s,
            std::slice::from_ref(&mixed_hidden_thought),
            0,
            0,
            2,
        )
        .is_none()
    );
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    let with_blank_thought: crate::history::Row = crate::history::decode_message(&json!({
        "id":"joined","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{}}},
            {"type":"reasoning","text":"   "},
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    assert_eq!(
        crate::chat::anchors::collapsed_group_target(
            &s,
            std::slice::from_ref(&with_blank_thought),
            0,
            0,
            2,
        ),
        Some(("joined".into(), "group-tool-joined:1:a".into()))
    );
}

#[test]
fn collapsed_cross_message_reasoning_anchors_and_search_expand_the_shared_group() {
    use codenomad_client::search::{Hit, Kind as SearchKind};
    use rune::{Env, Runtime};
    use serde_json::json;
    let m1 = crate::history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1000},"content":[
            {"type":"reasoning","text":"First thought","time":{"created":0,"completed":1000}}
        ]
    }))
    .unwrap();
    let m2 = crate::history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2000},"content":[
            {"type":"reasoning","text":"Needle in second step","time":{"created":1000,"completed":2000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    s.messages = vec![m1.into(), m2.into()];
    s.phase = crate::Phase::Ready;

    // Collapsed jump targeting the second message's reasoning resolves to the shared group header.
    assert_eq!(
        crate::chat::anchors::collapsed_group_target(&s, &s.messages, 1, 0, 0),
        Some(("m1".into(), block_key("m1", 0)))
    );

    // Search restoration expands the shared group in shared state so the user can collapse it
    // again even while the search highlight remains active.
    let mut hit = crate::chat::search_hit::SearchHit::new(
        &Hit {
            session: "s1".into(),
            message: "m2".into(),
            role: "assistant".into(),
            kind: SearchKind::Reasoning,
            part: 0,
            excerpt: "Needle".into(),
        },
        "Needle",
        false,
    );
    hit.restore_pending = true;
    s.transcript_display.search_highlight = Some(hit);
    crate::timeline::restore_search(&mut s);
    assert!(crate::chat::anchors::collapsed_group_target(&s, &s.messages, 1, 0, 0).is_none());

    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find(&block_key("m2", 0)).is_some());
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Needle in second step")
    );

    // Clicking the group toggle collapses the group even while search_highlight stays active,
    // and clearing search_highlight keeps a search-opened group closed.
    let (x, y) = rt.find("toggle-reasoning-m1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find(&block_key("m2", 0)).is_none());

    // A trailing reasoning fragment inside an active assistant message stays Thinking even if
    // its fragment provenance is closed, until message completion or a following visible part.
    let mut streaming = crate::history::decode_message(&json!({
        "id":"live","type":"assistant","content":[
            {"type":"reasoning","text":"Still streaming"}
        ]
    }))
    .unwrap();
    if let crate::content::Part::Reasoning(fragment) = &mut streaming.parts[0] {
        fragment.provenance = TextProvenance::Closed;
    }
    rt.update(|s, _| {
        s.transcript_display.search_highlight = None;
        s.messages = vec![streaming.into()];
        s.revision += 1;
    });
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Thinking") && !tree.contains("\"Thought\""));
}

#[test]
fn expanded_reasoning_group_renders_collapsible_subcards_with_own_title_and_duration() {
    use rune::{Env, Runtime};
    use serde_json::json;

    let m1 = crate::history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":91_000},"content":[
            {"type":"reasoning","text":"**Inspecting state**\n\nFirst body details","time":{"created":1_000,"completed":91_000}}
        ]
    }))
    .unwrap();
    let m2 = crate::history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":95_000},"content":[
            {"type":"reasoning","text":"**Checking edge**\n\nSecond body details","time":{"created":92_000,"completed":95_000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    s.messages = vec![m1.into(), m2.into()];
    s.phase = crate::Phase::Ready;

    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);

    // Group starts collapsed: only the shared group header is shown.
    assert!(rt.find("toggle-reasoning-m1:0").is_some());
    assert!(rt.find("toggle-card-reasoning-m1:0").is_none());
    assert!(rt.find("toggle-card-reasoning-m2:0").is_none());

    // Expanding the group reveals both individual sub-cards expanded by default,
    // each with its own extracted title, own duration, and stripped body (without **Title**).
    let (x, y) = rt.find("toggle-reasoning-m1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(rt.find("toggle-card-reasoning-m1:0").is_some());
    assert!(rt.find("toggle-card-reasoning-m2:0").is_some());
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Inspecting state") && tree.contains("1m 30s"));
    assert!(tree.contains("Checking edge") && tree.contains("3s"));
    assert!(tree.contains("First body details") && tree.contains("Second body details"));
    assert!(!tree.contains("**Inspecting state**") && !tree.contains("**Checking edge**"));

    // Collapsing sub-card 1 hides only its own body while keeping its header and sub-card 2 open.
    let (x, y) = rt.find("toggle-card-reasoning-m1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Inspecting state") && tree.contains("1m 30s"));
    assert!(!tree.contains("First body details"));
    assert!(tree.contains("Second body details"));

    // Re-expanding sub-card 1 restores its body, and sub-card 2 in the continuation message
    // can also be collapsed independently.
    let (x, y) = rt.find("toggle-card-reasoning-m1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("First body details")
    );
    let (x, y) = rt.find("toggle-card-reasoning-m2:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("First body details"));
    assert!(tree.contains("Checking edge") && tree.contains("3s"));
    assert!(!tree.contains("Second body details"));
}

#[test]
fn search_hit_force_expands_collapsed_subcard_without_permanent_override() {
    use codenomad_client::search::{Hit, Kind as SearchKind};
    use rune::{Env, Runtime};
    use serde_json::json;

    let m1 = crate::history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":2000},"content":[
            {"type":"reasoning","text":"**Step one**\n\nAlpha body","time":{"created":0,"completed":1000}},
            {"type":"reasoning","text":"**Step two**\n\nNeedle inside step two","time":{"created":1000,"completed":2000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(&mut s, json!({"showThinkingBlocks":true}));
    s.messages = vec![m1.into()];
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);

    // Open the group, then manually collapse sub-card 2.
    let (x, y) = rt.find("toggle-reasoning-m1:0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    let (x, y) = rt.find("toggle-card-reasoning-m1:1").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Needle inside step two")
    );

    // Selecting a search hit on sub-card 2 force-expands it.
    rt.update(|s, _| {
        s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
            &Hit {
                session: "s1".into(),
                message: "m1".into(),
                role: "assistant".into(),
                kind: SearchKind::Reasoning,
                part: 1,
                excerpt: "Needle".into(),
            },
            "Needle",
            false,
        ));
        s.revision += 1;
    });
    settle(&mut rt);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Needle inside step two")
    );

    // User can still collapse and re-open the sub-card during search, and clearing search restores
    // its pre-search collapsed state.
    let (x, y) = rt.find("toggle-card-reasoning-m1:1").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Needle inside step two")
    );
    let (x, y) = rt.find("toggle-card-reasoning-m1:1").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Needle inside step two")
    );
    rt.update(|s, _| {
        s.transcript_display.search_highlight = None;
        s.revision += 1;
    });
    settle(&mut rt);
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Needle inside step two")
    );
}

#[test]
fn standalone_and_title_only_reasoning_cards_match_solid_summary_rules() {
    use rune::{Env, Runtime};
    use serde_json::json;

    let still = parse_summary("**Still thinking**");
    assert_eq!(
        (still.title.as_deref(), still.body),
        (Some("Still thinking"), "")
    );
    let inspecting = parse_summary("**Inspecting**\n\nChecking timeline.");
    assert_eq!(
        (inspecting.title.as_deref(), inspecting.body),
        (Some("Inspecting"), "Checking timeline.")
    );
    let plain = parse_summary("Plain reasoning");
    assert_eq!(
        (plain.title.as_deref(), plain.body),
        (None, "Plain reasoning")
    );

    // Truncated reasoning with a stripped title preserves the exact unretained tail count.
    let truncated = Reasoning {
        part_index: Some(0),
        ordinal: 0,
        text: "**Title**\n\nBody".into(),
        units: 1015,
        retained_units: 15,
        provenance: TextProvenance::Closed,
        created: None,
        completed: None,
    };
    let summary = parse_summary(&truncated.text);
    assert_eq!(body_totals(&truncated, &summary), (4, 1004));

    let standalone = crate::history::decode_message(&json!({
        "id":"single","type":"assistant","time":{"completed":5000},"content":[
            {"type":"reasoning","text":"**Single title**\n\nSingle body","time":{"created":1000,"completed":5000}}
        ]
    }))
    .unwrap();
    let title_only = crate::history::decode_message(&json!({
        "id":"only","type":"assistant","time":{"completed":2000},"content":[
            {"type":"reasoning","text":"**Title only**","time":{"created":0,"completed":2000}}
        ]
    }))
    .unwrap();
    let mut s = crate::init();
    crate::settings::fixture_transcript(
        &mut s,
        json!({"showThinkingBlocks":true,"thinkingBlocksExpansion":"expanded"}),
    );
    s.messages = vec![
        standalone.into(),
        crate::history::decode_message(&json!({
            "id":"sep","type":"assistant","time":{"completed":2000},"content":[{"type":"text","text":"Split"}]
        }))
        .unwrap()
        .into(),
        title_only.into(),
    ];
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    settle(&mut rt);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Single title") && tree.contains("4s") && tree.contains("Single body"));
    assert!(!tree.contains("**Single title**"));
    assert!(!tree.contains("1 step"));
    assert!(rt.find("toggle-reasoning-single:0").is_some());
    assert!(rt.find("toggle-card-reasoning-single:0").is_none());
    assert!(tree.contains("Title only") && tree.contains("2s"));
    let only_toggle = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("toggle-reasoning-only:0"))
        .unwrap();
    assert!(!only_toggle.focusable);
    assert_eq!(only_toggle.expanded, Some(false));
    assert!(tree.contains("\"disabled\""));
}
