use super::*;
use crate::{Message, Phase, content, history, init};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use rune_theme_codenomad::layout::Layout;
use serde_json::{Value, json};

#[test]
fn token_line_counts_distinct_technical_rows_and_precedes_trailing_tools() {
    let row = |id: &str, input, content: Value| {
        history::decode_message(&json!({
            "id":id,"type":"assistant","time":{"completed":1},
            "tokens":{"input":input,"output":10,"reasoning":9,"cache":{"read":8,"write":7}},
            "cost":0.004, "content":content,
        }))
        .unwrap()
        .into()
    };
    let tech = json!({"type":"tool","id":"work","name":"read","state":{
        "status":"completed","input":{"filePath":"trailing.txt"}
    }});
    let prose = |text: &str| json!({"type":"text","text":text});
    let user = history::decode_message(&json!({"id":"user","type":"user","text":"Ask"})).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![
        row("old", 1000, json!([tech])),
        user.into(),
        row(
            "prior",
            20,
            json!([tech,{"type":"reasoning","text":"Thinking"}]),
        ),
        row("answer", 50, json!([prose("Answer text"), tech])),
    ];
    let total = response_total(&state, 3, 0).unwrap();
    assert_eq!((total.input, total.cache_read), (70, 16));
    assert_eq!(total.cost, 0.008);
    assert!(
        message(&state, 3, 0).is_none(),
        "default visibility is hidden"
    );

    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.update(|s, _| crate::settings::fixture_message_usage(s, "collapsed"));
    rt.frame(0.0);
    let tree = rt.accessibility_json().to_string();
    let usage = tree.find("Input: 70").expect("collapsed usage");
    assert!(
        tree.find("Answer text").unwrap() < usage && usage < tree.rfind("trailing.txt").unwrap()
    );
    assert!(!tree.contains("Reasoning: 18"));
    let (x, y) = rt.find("toggle-message-usage-answer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Reasoning: 18")
    );
}

#[test]
fn status_tokens_accessible_name_contains_its_visible_heading_and_included_cost() {
    let mut rt = Runtime::new(
        init(),
        |s, _| {
            crate::strings::with_locale("en", || {
                rune::col()
                    .full_width()
                    .child(disclosure(
                        s,
                        family::KEY.into(),
                        Usage {
                            input: 1250,
                            ..Usage::default()
                        },
                        true,
                        false,
                        false,
                    ))
                    .child(disclosure(
                        s,
                        "status-included".into(),
                        Usage {
                            input: 9876,
                            output: 543,
                            reasoning: 20,
                            ..Usage::default()
                        },
                        true,
                        false,
                        true,
                    ))
            })
        },
        (600.0, 200.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let value = rt.accessibility_json().to_string();
    assert!(
        value.contains("Tokens. ")
            && value.contains("Input: 1,250")
            && value.contains("Cost: Included"),
        "{value}"
    );
}

#[test]
fn token_lines_toggle_by_enter_space_and_chip_click_and_ellipsize_narrow() {
    let msg = history::decode_message(&json!({
        "id": "answer",
        "type": "assistant",
        "time": { "completed": 1 },
        "tokens": { "input": 1234567, "output": 23456, "reasoning": 500, "cache": { "read": 2400, "write": 48 } },
        "cost": 12.34,
        "content": [{ "type": "text", "text": "Answer text" }],
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![msg.into()];
    crate::settings::fixture_message_usage(&mut state, "collapsed");

    let key_press = |rt: &mut Runtime<State>, key: Key| {
        let ev = KeyEvent {
            key,
            mods: Mods::default(),
        };
        rt.key(ev.clone());
        rt.key_up(ev);
        for _ in 0..4 {
            rt.frame(1.0 / 60.0);
        }
    };

    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                rune::col()
                    .full_width()
                    .children(message(s, 0, 0))
                    .child(disclosure(
                        s,
                        family::KEY.into(),
                        Usage {
                            input: 1_234_567,
                            output: 23_456,
                            reasoning: 500,
                            cost: 12.34,
                            ..Usage::default()
                        },
                        true,
                        false,
                        false,
                    ))
            })
        },
        (220.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);

    let summary = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("summary-message-usage-answer"))
        .expect("collapsed message usage must expose an ellipsized summary node");
    assert!(summary.truncate, "collapsed summary must truncate");
    assert!(
        summary.text_cut,
        "collapsed summary must ellipsize at 220px: {:?}",
        summary.target
    );
    assert!(
        summary.target[0] >= -0.5 && summary.target[0] + summary.target[2] <= 220.5,
        "collapsed summary overflowed 220px: {:?}",
        summary.target
    );
    assert!(
        rt.elements()
            .iter()
            .all(|el| el.target[0] >= -0.5 && el.target[0] + el.target[2] <= 220.5),
        "narrow collapsed token row overflowed 220px"
    );
    assert_eq!(
        rt.elements()
            .iter()
            .filter(|el| el.role == "button")
            .count(),
        2,
        "message and status token lines must each be one button with no nested buttons"
    );
    let collapsed_a11y = rt.accessibility_json().to_string();
    assert!(
        collapsed_a11y.contains("\"collapsed\""),
        "collapsed disclosures must expose collapsed state: {collapsed_a11y}"
    );

    let focused_key = |rt: &mut Runtime<State>| -> Option<String> {
        let mut out = None;
        rt.update(|_, tx| out = tx.focused().map(str::to_owned));
        out
    };

    // Focus the message toggle and press Enter -> expands, keeps focus.
    rt.update(|_, tx| tx.focus("toggle-message-usage-answer", true));
    rt.frame(0.0);
    key_press(&mut rt, Key::Enter);
    let expanded_a11y = rt.accessibility_json().to_string();
    assert!(
        expanded_a11y.contains("Reasoning: 500") && expanded_a11y.contains("\"expanded\""),
        "Enter must expand the message token disclosure and expose expanded state: {expanded_a11y}"
    );
    assert_eq!(
        focused_key(&mut rt).as_deref(),
        Some("toggle-message-usage-answer"),
        "focus must remain on the disclosure after Enter"
    );

    let chevron = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("chevron-message-usage-answer"))
        .expect("chevron element");
    let chips: Vec<_> = rt
        .elements()
        .into_iter()
        .filter(|el| {
            el.key
                .as_deref()
                .is_some_and(|k| k.starts_with("chip-message-usage-answer-"))
        })
        .collect();
    assert_eq!(chips.len(), 6, "expanded message row must render 6 chips");
    assert!(
        chips
            .iter()
            .all(|c| c.target[0] >= -0.5 && c.target[0] + c.target[2] <= 220.5),
        "expanded chips overflowed 220px: {:?}",
        chips.iter().map(|c| c.target).collect::<Vec<_>>()
    );
    let rows: std::collections::BTreeSet<i32> =
        chips.iter().map(|c| c.target[1].round() as i32).collect();
    assert!(
        rows.len() > 1,
        "expanded chips must wrap at 220px: {rows:?}"
    );
    let chevron_mid = chevron.target[1] + chevron.target[3] * 0.5;
    let first_chip_mid = chips[0].target[1] + chips[0].target[3] * 0.5;
    assert!(
        (chevron_mid - first_chip_mid).abs() < 1.0,
        "chevron must stay aligned with the first chip row: chevron={:?} first_chip={:?}",
        chevron.target,
        chips[0].target
    );

    // At desktop width (900px), expanded message chips stay on a single row beside the chevron.
    rt.set_viewport((900.0, 400.0), 1.0);
    rt.frame(1.0 / 60.0);
    let desktop_chips: Vec<_> = rt
        .elements()
        .into_iter()
        .filter(|el| {
            el.key
                .as_deref()
                .is_some_and(|k| k.starts_with("chip-message-usage-answer-"))
        })
        .collect();
    let desktop_rows: std::collections::BTreeSet<i32> = desktop_chips
        .iter()
        .map(|c| c.target[1].round() as i32)
        .collect();
    assert_eq!(
        desktop_rows.len(),
        1,
        "expanded message chips must stay on one row at 900px: {desktop_rows:?}"
    );
    rt.set_viewport((220.0, 400.0), 1.0);
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }

    // Press Space -> collapses, keeps focus.
    key_press(&mut rt, Key::Text(" ".into()));
    assert!(
        !rt.accessibility_json()
            .to_string()
            .contains("Reasoning: 500"),
        "Space must collapse the message token disclosure"
    );
    assert_eq!(
        focused_key(&mut rt).as_deref(),
        Some("toggle-message-usage-answer"),
        "focus must remain on the disclosure after Space"
    );

    // Clicking on the chips area (right half of the row) must also toggle.
    let toggle = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("toggle-message-usage-answer"))
        .expect("toggle element");
    let click_x = toggle.target[0] + toggle.target[2] * 0.7;
    let click_y = toggle.target[1] + toggle.target[3] * 0.5;
    rt.pointer_down(click_x, click_y);
    rt.pointer_up(click_x, click_y);
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Reasoning: 500"),
        "clicking the summary chips area must expand the disclosure"
    );

    // Status disclosure: Enter expands, Space collapses, focus stays, no overflow at 220px.
    rt.update(|_, tx| tx.focus("toggle-status-usage", true));
    rt.frame(0.0);
    key_press(&mut rt, Key::Enter);
    assert!(
        rt.state.transcript_display.toggled(family::KEY),
        "Enter must expand Status tokens"
    );
    assert_eq!(focused_key(&mut rt).as_deref(), Some("toggle-status-usage"));
    assert!(
        rt.elements()
            .iter()
            .all(|el| el.target[0] >= -0.5 && el.target[0] + el.target[2] <= 220.5),
        "expanded Status tokens overflowed 220px"
    );
    key_press(&mut rt, Key::Text(" ".into()));
    assert!(
        !rt.state.transcript_display.toggled(family::KEY),
        "Space must collapse Status tokens"
    );

    // RTL narrow check: no overflow and ellipsized in RTL (both narrow message and Status).
    let mut rtl = Runtime::new(
        init(),
        |s, _| {
            crate::strings::with_locale("he", || {
                rune::col()
                    .full_width()
                    .locale_direction("he")
                    .child(disclosure(
                        s,
                        "rtl-msg".into(),
                        Usage {
                            input: 1_234_567,
                            output: 23_456,
                            reasoning: 500,
                            cache_read: 2400,
                            cache_write: 48,
                            cost: 12.34,
                        },
                        false,
                        false,
                        false,
                    ))
                    .child(disclosure(
                        s,
                        "rtl-status".into(),
                        Usage {
                            input: 1_234_567,
                            output: 23_456,
                            reasoning: 500,
                            cost: 12.34,
                            ..Usage::default()
                        },
                        true,
                        false,
                        false,
                    ))
            })
        },
        (160.0, 200.0),
        Env::new(false, 1.0),
    );
    rtl.frame(0.0);
    for key in ["summary-rtl-msg", "summary-rtl-status"] {
        let strip = rtl
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some(key))
            .expect("RTL summary strip");
        assert!(
            strip.truncate && strip.text_cut,
            "RTL narrow summary {key} must ellipsize: {:?}",
            strip.target
        );
    }
    assert!(
        rtl.elements()
            .iter()
            .all(|el| el.target[0] >= -0.5 && el.target[0] + el.target[2] <= 160.5),
        "RTL narrow collapsed token line overflowed 160px"
    );
    rtl.set_viewport((900.0, 200.0), 1.0);
    rtl.frame(1.0 / 60.0);
    for key in ["summary-rtl-msg", "summary-rtl-status"] {
        let wide = rtl
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some(key))
            .expect("RTL wide summary strip");
        assert!(
            !wide.text_cut,
            "RTL wide 900px summary {key} must not ellipsize"
        );
    }
}

#[test]
fn response_total_respects_boundaries_synthetics_content_blocks_and_omitted_part_gaps() {
    let row = |id: &str, input: u64, content_json: Value| -> crate::history::Row {
        history::decode_message(&json!({
            "id": id,
            "type": "assistant",
            "time": { "completed": 1 },
            "tokens": { "input": input, "output": 5, "reasoning": 2, "cache": { "read": 1, "write": 1 } },
            "cost": 0.01,
            "content": content_json,
        }))
        .unwrap()
        .into()
    };
    let tool = |id: &str| {
        json!({
            "type": "tool",
            "id": id,
            "name": "read",
            "state": { "status": "completed", "input": { "filePath": "a.txt" } }
        })
    };
    let prose = |text: &str| json!({ "type": "text", "text": text });

    // 1. Body-only assistant response (parts empty, non-empty body) stops the walk.
    let mut s = init();
    s.phase = Phase::Ready;
    let body_only = Message {
        id: "body-only".into(),
        role: "assistant".into(),
        completed: true,
        body: "Earlier plain answer".into(),
        usage: Some(Usage {
            input: 900,
            ..Usage::default()
        }),
        parts: vec![],
    };
    s.messages = vec![
        row("before-body-only", 500, json!([tool("t0")])),
        body_only.into(),
        row("after-body-only", 30, json!([tool("t1")])),
        row("answer", 40, json!([prose("Done")])),
    ];
    let total = response_total(&s, 3, 0).unwrap();
    assert_eq!(
        total.input, 70,
        "body-only assistant answer must bound response_total"
    );

    // 2. User stops the walk; compaction, system, synthetic subagent report, U+FEFF blank text,
    //    and usage-less streaming rows stay transparent like Solid.
    let user = history::decode_message(&json!({"id":"u0","type":"user","text":"Hi"})).unwrap();
    let compaction = Message {
        id: "cmp".into(),
        role: "compaction".into(),
        completed: true,
        body: "Compacted".into(),
        usage: None,
        parts: vec![],
    };
    let system = Message {
        id: "sys".into(),
        role: "system".into(),
        completed: true,
        body: "Notice".into(),
        usage: None,
        parts: vec![],
    };
    let synthetic = Message {
        id: "syn".into(),
        role: "synthetic".into(),
        completed: true,
        body: String::new(),
        usage: None,
        parts: vec![Part::SubagentReport(content::SubagentReport {
            child: "child".into(),
            state: "completed".into(),
            body: "Done".into(),
            created: 1,
        })],
    };
    let streaming_tech: crate::history::Row = history::decode_message(&json!({
        "id": "mid-streaming",
        "type": "assistant",
        "content": [tool("t-mid")],
    }))
    .unwrap()
    .into();
    s.messages = vec![
        row("before-user", 800, json!([tool("t-old")])),
        user.into(),
        row("tech-0", 60, json!([tool("t-0")])),
        compaction.into(),
        system.into(),
        row("tech-1", 100, json!([tool("t-1"), prose(" \u{feff} ")])),
        synthetic.into(),
        streaming_tech,
        row("answer-2", 25, json!([prose("Final")])),
    ];
    let total = response_total(&s, 8, 0).unwrap();
    assert_eq!(
        total.input, 185,
        "user stops the walk while compaction, system, synthetic, blank text and usage-less technical rows stay transparent"
    );

    // 3. Consecutive text parts in the final answer stay in one content block (Solid starts
    //    technical cleanup at startPartId), so preceding tool steps are included.
    s.messages = vec![
        row("prior-tool", 120, json!([tool("t-multi")])),
        row("two-texts", 30, json!([prose("Part 1"), prose("Part 2")])),
    ];
    assert_eq!(
        response_total(&s, 1, 1).unwrap().input,
        150,
        "consecutive text fragments in the final answer block must include prior tool steps"
    );
    // An intervening tool inside the same message separates the earlier text into a boundary.
    s.messages = vec![
        row("prior-tool-2", 120, json!([tool("t-before")])),
        row(
            "split-texts",
            30,
            json!([
                prose("Earlier"),
                tool("t-in"),
                prose("Part 1"),
                prose("Part 2")
            ]),
        ),
    ];
    assert_eq!(
        response_total(&s, 1, 3).unwrap().input,
        30,
        "earlier text separated by a tool in the same message still bounds the cleanup walk"
    );

    // 4. Omitted-parts gap (`parts-gap-`) in the current message stops before the gap, then joins after reveal.
    let mut many_parts: Vec<Value> = (0..1005).map(|i| tool(&format!("t-{i}"))).collect();
    many_parts.push(prose("After gap"));
    s.messages = vec![
        row("pre-gap", 400, json!([tool("t-pre")])),
        row("big", 60, Value::Array(many_parts)),
    ];
    let final_idx = s.messages[1].parts.len() - 1;
    assert_eq!(
        response_total(&s, 1, final_idx).unwrap().input,
        60,
        "parts-gap in current message must stop before earlier technical rows"
    );
    super::super::actions::Display::reveal_next(&mut s, "parts-gap-big");
    assert_eq!(
        response_total(&s, 1, final_idx).unwrap().input,
        460,
        "revealing parts-gap-big must reconnect the earlier technical row"
    );

    // 5. Omitted-parts gap in an earlier message includes that message (its visible tail has tools)
    //    but stops before messages prior to the gap.
    let big_prior_parts: Vec<Value> = (0..1005).map(|i| tool(&format!("p-{i}"))).collect();
    s.messages = vec![
        row("before-big-prior", 700, json!([tool("t-earliest")])),
        row("big-prior", 200, Value::Array(big_prior_parts)),
        row("answer-after-big", 50, json!([prose("After big prior")])),
    ];
    assert_eq!(
        response_total(&s, 2, 0).unwrap().input,
        250,
        "gap in prior technical message keeps its visible tail's usage but stops before earlier messages"
    );

    // 6. Named Part::File bounds the walk like Solid; unnamed Part::File does not.
    let named_file = Message {
        id: "file-msg".into(),
        role: "assistant".into(),
        completed: true,
        body: String::new(),
        usage: Some(Usage {
            input: 333,
            ..Usage::default()
        }),
        parts: vec![Part::File(content::File {
            id: "file-1".into(),
            name: Some("spec.md".into()),
            mime: "text/markdown".into(),
            reference: None,
            picture: None,
        })],
    };
    let unnamed_file = Message {
        id: "unnamed-file-msg".into(),
        role: "assistant".into(),
        completed: true,
        body: String::new(),
        usage: None,
        parts: vec![Part::File(content::File {
            id: "file-2".into(),
            name: None,
            mime: "application/octet-stream".into(),
            reference: None,
            picture: None,
        })],
    };
    s.messages = vec![
        row("before-file", 600, json!([tool("t-before-file")])),
        named_file.into(),
        row("after-file", 15, json!([tool("t-after-file")])),
        unnamed_file.into(),
        row("answer-file", 35, json!([prose("After file")])),
    ];
    assert_eq!(
        response_total(&s, 4, 0).unwrap().input,
        50,
        "named Part::File must bound response_total while unnamed Part::File stays transparent"
    );
}
