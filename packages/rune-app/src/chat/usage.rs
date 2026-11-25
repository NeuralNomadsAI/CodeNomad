use crate::{
    Message, State,
    content::{Part, Usage},
    screen,
    strings::t,
};
use rune::El;
use rune_theme_codenomad::usage as theme;
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
};
pub(crate) mod family;

fn text_part(part: &Part) -> bool {
    matches!(part, Part::Text(text) if !text.text.trim().is_empty())
}

fn boundary(part: &Part) -> bool {
    text_part(part) || matches!(part, Part::File(_))
}

pub(super) fn last_text(row: &Message) -> Option<usize> {
    (row.role == "assistant" && row.usage.is_some())
        .then(|| row.parts.iter().rposition(text_part))
        .flatten()
}

fn response_total(s: &State, index: usize, final_text: usize) -> Option<Usage> {
    let row = s.messages.get(index)?;
    let mut usage = row.usage?;
    for (i, row) in s.messages[..=index].iter().enumerate().rev() {
        if i != index {
            if row.role != "assistant" && row.role != "synthetic" {
                break;
            }
            if row.role == "assistant" && row.parts.is_empty() && !row.body.trim().is_empty() {
                break;
            }
        }
        let (head, tail) = super::transcript::part_window(
            row.parts.len(),
            s.transcript_display.steps(&format!("parts-gap-{}", row.id)),
        );
        let end = if i == index {
            final_text
        } else {
            row.parts.len()
        };
        let mut technical = false;
        let mut stop = false;
        for (at, part) in row.parts[..end].iter().enumerate().rev() {
            if (head..tail).contains(&at) || boundary(part) {
                stop = true;
                break;
            }
            technical |= matches!(part, Part::Tool(_) | Part::Reasoning(_));
        }
        if technical
            && i != index
            && let Some(previous) = row.usage
        {
            usage = usage.plus(previous);
        }
        if stop {
            break;
        }
    }
    Some(usage)
}

pub(super) fn message(s: &State, index: usize, final_text: usize) -> Option<El> {
    let visibility = crate::settings::message_usage_visibility(s);
    if visibility == "hidden" {
        return None;
    }
    let usage = response_total(s, index, final_text)?;
    let key = format!("message-usage-{}", s.messages[index].id);
    Some(disclosure(
        s,
        key,
        usage,
        false,
        visibility == "expanded",
        false,
    ))
}

pub(crate) fn session(s: &State) -> Option<El> {
    let agent = s.agent.as_ref()?;
    let mut usage = agent.usage?;
    let included = agent.current.as_ref().is_some_and(|model| {
        model["providerID"]
            .as_str()
            .zip(model["id"].as_str())
            .is_some_and(|(provider, id)| agent.includes_cost(provider, id))
    });
    if included {
        usage.cost = 0.0;
    }
    let mut panel = rune::col()
        .full_width()
        .separate(Space::Sm)
        .child(disclosure(
            s,
            family::KEY.into(),
            usage,
            true,
            false,
            included,
        ));
    let totals = &s.transcript_display.usage_family;
    if !s.transcript_display.toggled(family::KEY) {
        return Some(panel);
    }
    if let Some((total, complete)) =
        totals.including(usage, |provider, id| agent.includes_cost(provider, id))
    {
        if !complete {
            panel = panel.child(rune::text(t("contextUsagePanel.partialTotal")).role("status"));
        }
        let tokens = [
            counter(t("contextUsagePanel.labels.totalInput"), total.input),
            counter(t("contextUsagePanel.labels.totalOutput"), total.output),
            money(t("contextUsagePanel.labels.totalCost"), total.cost, true),
            counter(
                t("contextUsagePanel.labels.totalReasoning"),
                total.reasoning,
            ),
        ];
        panel = panel.child(
            rune_theme_codenomad::layout::action_row()
                .key("status-thread-usage")
                .children(
                    tokens
                        .into_iter()
                        .map(|(name, value, full)| theme::metric(name, &value, &full)),
                ),
        );
    }
    if totals.loading() {
        panel = panel.child(rune::text(t("rune.loading")).role("status"));
    } else if totals.failed {
        panel = panel.child(
            layout::action_row()
                .child(rune::text(t("contextUsagePanel.totalUnavailable")).role("status"))
                .child(layout::button(
                    t("sessionList.loadError.retry"),
                    false,
                    screen::action(&s.input_scope, |s| {
                        s.transcript_display.usage_family.refresh()
                    }),
                )),
        );
    }
    Some(panel)
}

fn disclosure(
    s: &State,
    key: String,
    usage: Usage,
    session: bool,
    open: bool,
    included: bool,
) -> El {
    let expanded = if session {
        s.transcript_display.toggled(&key)
    } else {
        s.transcript_display.expanded(&key, open)
    };
    let toggle = key.clone();
    let mut entries = vec![
        token("input", usage.input, session),
        token("output", usage.output, session),
    ];
    if expanded {
        entries.push(token("reasoning", usage.reasoning, session));
        if !session {
            entries.push(token("cacheRead", usage.cache_read, false));
            entries.push(token("cacheWrite", usage.cache_write, false));
        }
    }
    let cost_label = t(if session {
        "contextUsagePanel.labels.cost"
    } else {
        "messageBlock.usage.cost"
    });
    entries.push(if included {
        let value = t("contextUsagePanel.included");
        (cost_label, value.into(), value.into())
    } else {
        money(cost_label, usage.cost, session)
    });
    let label = t(if expanded {
        "messageBlock.usage.collapseAriaLabel"
    } else {
        "messageBlock.usage.expandAriaLabel"
    });
    let title = session.then(|| t("instanceShell.rightPanel.sections.tokens"));
    let detail = entries
        .iter()
        .map(|(label, _, full)| format!("{label}: {full}"))
        .collect::<Vec<_>>()
        .join(", ");
    let accessible = if let Some(title) = title {
        format!("{title}. {label}. {detail}")
    } else {
        format!("{label}. {detail}")
    };
    let metrics: Vec<_> = entries
        .iter()
        .map(|(label, value, full)| theme::Metric { label, value, full })
        .collect();
    theme::disclosure(
        &key,
        &accessible,
        title,
        expanded,
        &metrics,
        screen::action(&s.input_scope, move |s| {
            if session {
                super::actions::Display::toggle(s, &toggle);
            } else {
                super::actions::Display::set_expanded(s, &toggle, !expanded);
            }
        }),
    )
}

fn token(kind: &str, count: u64, session: bool) -> (&'static str, String, String) {
    let prefix = if session && kind != "reasoning" {
        "contextUsagePanel.labels"
    } else {
        "messageBlock.usage"
    };
    counter(t(&format!("{prefix}.{kind}")), count)
}

fn money(label: &'static str, cost: f64, session: bool) -> (&'static str, String, String) {
    let value = theme::numbers::usd(crate::strings::locale(), cost, !session);
    (label, value.clone(), value)
}

fn counter(label: &'static str, count: u64) -> (&'static str, String, String) {
    let locale = crate::strings::locale();
    (
        label,
        theme::numbers::compact(locale, count),
        theme::numbers::exact(locale, count),
    )
}

#[cfg(test)]
#[test]
fn token_line_counts_distinct_technical_rows_and_precedes_trailing_tools() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::{Value, json};

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

#[cfg(test)]
#[test]
fn status_tokens_accessible_name_contains_its_visible_heading() {
    use rune::{Env, Runtime};
    let mut rt = Runtime::new(
        crate::init(),
        |s, _| {
            crate::strings::with_locale("en", || {
                disclosure(
                    s,
                    family::KEY.into(),
                    Usage {
                        input: 1250,
                        ..Usage::default()
                    },
                    true,
                    false,
                    false,
                )
            })
        },
        (600.0, 200.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let value = rt.accessibility_json().to_string();
    assert!(
        value.contains("Tokens. ") && value.contains("Input: 1,250"),
        "{value}"
    );
}

#[cfg(test)]
#[test]
fn token_lines_toggle_by_enter_space_and_chip_click_and_ellipsize_narrow() {
    use crate::{Phase, history, init};
    use rune::{Direction, Env, Key, KeyEvent, Mods, Runtime};
    use serde_json::json;

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

    // 1. Enter & Space on focused disclosure toggle and keep focus; clicking the chips area toggles too.
    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                rune::col()
                    .w_full()
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

    // Narrow collapsed summary must not overflow 220px and must ellipsize.
    let summary = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("summary-message-usage-answer"))
        .expect("collapsed message usage must expose an ellipsized summary node");
    assert!(summary.truncate, "collapsed summary must truncate");
    assert!(
        summary.text_cut,
        "collapsed summary must ellipsize at 220px: {:?}",
        summary.rect
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

    // Expanded at 220px: chips wrap onto multiple rows without overflow, and the chevron stays on the first chip row.
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

    // RTL narrow check: no overflow and ellipsized in RTL (both narrow message and 220px Status).
    let mut rtl = Runtime::new(
        init(),
        |s, _| {
            crate::strings::with_locale("he", || {
                rune::col()
                    .w_full()
                    .dir(Direction::Rtl)
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

#[cfg(test)]
#[test]
fn response_total_respects_boundaries_synthetics_and_omitted_part_gaps() {
    use crate::{Message, Phase, content, history, init};
    use serde_json::{Value, json};

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

    // 1. Body-only assistant response (parts empty, non-empty body), compaction, and Part::File stop the walk.
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

    // 2. Compaction boundary stops the walk; synthetic subagent report and blank text are transparent.
    let compaction = Message {
        id: "cmp".into(),
        role: "compaction".into(),
        completed: true,
        body: "Compacted".into(),
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
        row("before-cmp", 800, json!([tool("t-old")])),
        compaction.into(),
        row("tech-1", 100, json!([tool("t-1"), prose("   ")])),
        synthetic.into(),
        streaming_tech,
        row("answer-2", 25, json!([prose("Final")])),
    ];
    let total = response_total(&s, 5, 0).unwrap();
    assert_eq!(
        total.input, 125,
        "compaction stops the walk while synthetic, blank text and usage-less technical rows stay transparent"
    );

    // 3. Omitted-parts gap (`parts-gap-`) in the current message stops before the gap, then joins after reveal.
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
    super::actions::Display::reveal_next(&mut s, "parts-gap-big");
    assert_eq!(
        response_total(&s, 1, final_idx).unwrap().input,
        460,
        "revealing parts-gap-big must reconnect the earlier technical row"
    );

    // 4. Omitted-parts gap in an earlier message includes that message (its visible tail has tools) but stops before messages prior to the gap.
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

    // 5. Part::File boundary stops the walk just like response text.
    let file_boundary = Message {
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
    s.messages = vec![
        row("before-file", 600, json!([tool("t-before-file")])),
        file_boundary.into(),
        row("after-file", 15, json!([tool("t-after-file")])),
        row("answer-file", 35, json!([prose("After file")])),
    ];
    assert_eq!(
        response_total(&s, 3, 0).unwrap().input,
        50,
        "Part::File must bound response_total"
    );
}
