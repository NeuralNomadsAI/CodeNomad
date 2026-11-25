use super::{actions::Display, document};
use crate::{
    State,
    content::{Reasoning, TextProvenance},
    screen,
    settings::TranscriptRow,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};
use std::borrow::Cow;

pub(crate) fn block_key(message: &str, ordinal: usize) -> String {
    format!("reasoning-{message}:{ordinal}")
}

pub(super) fn duration_ms(part: &Reasoning) -> u64 {
    part.created
        .zip(part.completed)
        .and_then(|(start, end)| end.checked_sub(start))
        .unwrap_or(0)
}

pub(super) fn extract_title(text: &str) -> Option<String> {
    text.trim().strip_prefix("**").and_then(|source| {
        let (title, rest) = source.split_once("**")?;
        (!title.is_empty()
            && !title.contains(['*', '\n'])
            && (rest.is_empty() || rest.starts_with("\n\n") || rest.starts_with("\r\n\r\n")))
        .then(|| title.trim().chars().take(250).collect())
    })
}

pub(super) struct GroupView<'a> {
    pub key: &'a str,
    pub count: usize,
    pub duration_ms: u64,
    pub title: Option<&'a str>,
    pub completed: bool,
    pub expanded: bool,
    pub first: bool,
}

/// Resolve a rail run to the first displayed fragment of its visible segment.
pub(crate) fn run_anchor(
    message: &crate::Message,
    omitted: std::ops::Range<usize>,
    run: usize,
    continuation: bool,
) -> Option<String> {
    use crate::content::Part;
    let mut next = 0;
    let mut current = None;
    let mut emitted = false;
    for (index, part) in message.parts.iter().enumerate() {
        match part {
            Part::Reasoning(part) if part.visible() => {
                let ordinal = *current.get_or_insert_with(|| {
                    let ordinal = next;
                    next += 1;
                    emitted = false;
                    ordinal
                });
                if ordinal == run && !omitted.contains(&index) {
                    let resumed = emitted && index >= omitted.end && !omitted.is_empty();
                    if (!emitted || resumed) && continuation == resumed {
                        return Some(block_key(&message.id, part.ordinal));
                    }
                    emitted = true;
                }
            }
            Part::Reasoning(_) => {}
            Part::Text(text) if text.text.trim().is_empty() => {}
            _ => current = None,
        }
    }
    None
}

pub(super) fn view_chunk<'a>(
    s: &State,
    message: &'a str,
    parts: &[crate::content::Part],
    start: usize,
    group: GroupView<'_>,
    marker: &mut impl FnMut(Option<usize>) -> Option<codenomad_client::timeline::Marker<'a>>,
) -> Option<El> {
    if !super::anchors::reasoning_visible(s) {
        return None;
    }
    if !group.first && !group.expanded {
        return None;
    }
    let mut first_marker = marker(Some(start));
    if !group.first {
        let mut container = col()
            .full_width()
            .pad(Space::Sm)
            .separate(Space::Sm)
            .inset_surface();
        let mut any = false;
        for (offset, part) in parts.iter().enumerate() {
            let crate::content::Part::Reasoning(part) = part else {
                continue;
            };
            if !part.visible() {
                continue;
            }
            let block_marker = if !any {
                first_marker.take()
            } else {
                marker(Some(start + offset))
            };
            any = true;
            let fragment = block_key(message, part.ordinal);
            let pane = body(s, message, &fragment, part);
            container = container.child(super::reading::passage(
                s,
                pane,
                message,
                fragment,
                Some(TranscriptRow::Thinking),
                block_marker,
            ));
        }
        return any.then_some(container);
    }
    let base: Cow<'static, str> = if !group.completed {
        t("messageBlock.reasoning.thinkingLabel").into()
    } else if group.duration_ms >= 1_000 {
        let seconds = (group.duration_ms + 500) / 1_000;
        let (unit, count) = if seconds >= 3_600 {
            ("hours", seconds / 3_600)
        } else if seconds >= 60 {
            ("minutes", seconds / 60)
        } else {
            ("seconds", seconds)
        };
        catalogue::format(
            locale(),
            &format!(
                "messageBlock.reasoning.thoughtFor.{unit}.{}",
                if count == 1 { "one" } else { "other" }
            ),
            &[("count", &count.to_string())],
        )
        .into()
    } else {
        t("messageBlock.reasoning.thoughtLabel").into()
    };
    let steps = (group.count > 1).then(|| {
        catalogue::format(
            locale(),
            if group.count == 1 {
                "messageBlock.reasoning.steps.one"
            } else {
                "messageBlock.reasoning.steps.other"
            },
            &[("count", &group.count.to_string())],
        )
    });
    let toggle = group.key.to_owned();
    let expanded = group.expanded;
    let header = layout::action_row()
        .child(
            layout::button(
                &base,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{}", group.key))
            .expanded(expanded),
        )
        .children(group.title.map(text))
        .children(steps.map(text));
    let mut container = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header);
    if expanded {
        let mut is_first_visible = true;
        for (offset, part) in parts.iter().enumerate() {
            let crate::content::Part::Reasoning(part) = part else {
                continue;
            };
            if !part.visible() {
                continue;
            }
            let fragment = block_key(message, part.ordinal);
            let pane = body(s, message, &fragment, part);
            if is_first_visible {
                is_first_visible = false;
                container = container.child(pane);
            } else {
                container = container.child(super::reading::passage(
                    s,
                    pane,
                    message,
                    fragment,
                    Some(TranscriptRow::Thinking),
                    marker(Some(start + offset)),
                ));
            }
        }
    }
    Some(super::reading::passage(
        s,
        container,
        message,
        group.key.to_owned(),
        Some(TranscriptRow::Thinking),
        first_marker.take(),
    ))
}

fn body(s: &State, message: &str, key: &str, part: &Reasoning) -> El {
    let query = super::search_hit::query(
        s,
        message,
        codenomad_client::search::Kind::Reasoning,
        part.part_index,
    );
    markdown::tool_pane(
        document::window_with_total(
            s,
            format!("{key}-body"),
            &[&part.text],
            document::search_limit_for(s, key, query),
            Some((part.retained_units, part.units)),
            |shown, units| {
                let build = || {
                    rune_theme_codenomad::timeline::search::ink(text(shown), shown, query)
                        .full_width()
                        .wrap()
                        .content_direction()
                        .selectable(true)
                };
                if part.provenance != TextProvenance::Closed && units > document::TOOL_LIMIT {
                    markdown::hold_frame(
                        format!("{key}-stream"),
                        (
                            s.transcript_display.stream_version(),
                            s.transcript_display.steps(&format!("{key}-body")),
                            std::rc::Rc::as_ptr(&s.input_scope) as usize,
                            s.transcript_display
                                .search_highlight
                                .as_ref()
                                .filter(|hit| hit.message == message),
                        ),
                        build,
                    )
                } else {
                    build()
                }
            },
        ),
        false,
    )
}

#[cfg(test)]
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
    assert!(tree.contains("Thought for 3 seconds") && tree.contains("Summary"));
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
#[test]
fn reasoning_groups_merge_across_adjacent_messages_and_sum_duration() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let first = crate::history::decode_message(&json!({
        "id":"step1","type":"assistant","time":{"completed":2500},"content":[
            {"type":"reasoning","text":"**Initial**\n\nFirst step thought","time":{"created":1000,"completed":2500}}
        ]
    }))
    .unwrap();
    let second_live = crate::history::decode_message(&json!({
        "id":"step2","type":"assistant","content":[
            {"type":"reasoning","text":"**Final plan**\n\nSecond step thought","time":{"created":3000}}
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
    assert!(!tree.contains("First step thought"));
    assert!(!tree.contains("Second step thought"));
    assert!(rt.find("toggle-reasoning-step1:0").is_some());
    assert!(rt.find("toggle-reasoning-step2:0").is_none());

    // Settling the second step updates the shared header to the summed duration across both messages.
    rt.update(|s, _| {
        let second_done = crate::history::decode_message(&json!({
            "id":"step2","type":"assistant","time":{"completed":5500},"content":[
                {"type":"reasoning","text":"**Final plan**\n\nSecond step thought","time":{"created":3000,"completed":5500}}
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
    assert!(tree.contains("Thought for 4 seconds"));
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
}

#[cfg(test)]
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
    assert!(tree.contains("Thought for 3 seconds"));
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

    // Conversely, a non-empty reasoning fragment splits exploration tools even when thinking is
    // hidden, whereas a blank reasoning fragment remains transparent.
    let s = crate::init();
    let with_real_thought: crate::history::Row = crate::history::decode_message(&json!({
        "id":"split","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{}}},
            {"type":"reasoning","text":"Non-empty thought"},
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    let with_blank_thought: crate::history::Row = crate::history::decode_message(&json!({
        "id":"joined","type":"assistant","time":{"completed":1},"content":[
            {"type":"tool","id":"a","name":"read","state":{"status":"completed","input":{}}},
            {"type":"reasoning","text":"   "},
            {"type":"tool","id":"b","name":"grep","state":{"status":"completed","input":{}}}
        ]
    }))
    .unwrap()
    .into();
    assert!(
        super::anchors::collapsed_group_target(
            &s,
            std::slice::from_ref(&with_real_thought),
            0,
            0,
            0,
        )
        .is_none()
    );
    assert_eq!(
        super::anchors::collapsed_group_target(
            &s,
            std::slice::from_ref(&with_blank_thought),
            0,
            0,
            2,
        ),
        Some(("joined".into(), "group-tool-joined:1:a".into()))
    );
}

#[cfg(test)]
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
        super::anchors::collapsed_group_target(&s, &s.messages, 1, 0, 0),
        Some(("m1".into(), block_key("m1", 0)))
    );

    // An active search hit inside the second message expands the shared group and exposes m2's key.
    s.transcript_display.search_highlight = Some(super::search_hit::SearchHit::new(
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
    ));
    assert!(super::anchors::collapsed_group_target(&s, &s.messages, 1, 0, 0).is_none());

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
}
