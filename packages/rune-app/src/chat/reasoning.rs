use super::{actions::Display, document};
use crate::{
    State,
    content::{Reasoning, TextProvenance},
    screen,
    settings::{self, TranscriptRow},
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};

pub(crate) fn block_key(message: &str, ordinal: usize) -> String {
    format!("reasoning-{message}:{ordinal}")
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

pub(super) fn view(s: &State, message: &str, parts: &[crate::content::Part]) -> Option<El> {
    let mode = settings::transcript_mode(s, TranscriptRow::Thinking);
    if mode == "hidden" {
        return None;
    }
    let mut reasoning = parts.iter().filter_map(|part| match part {
        crate::content::Part::Reasoning(part) if part.visible() => Some(part),
        _ => None,
    });
    let first = reasoning.next()?;
    let last = reasoning.clone().next_back().unwrap_or(first);
    let key = block_key(message, first.ordinal);
    let expanded = s.transcript_display.expanded(&key, mode == "expanded")
        || std::iter::once(first).chain(reasoning.clone()).any(|part| {
            super::search_hit::query(
                s,
                message,
                codenomad_client::search::Kind::Reasoning,
                part.part_index,
            )
            .is_some_and(|q| q.active)
        });
    let title = last.text.trim().strip_prefix("**").and_then(|source| {
        let (title, rest) = source.split_once("**")?;
        (!title.is_empty()
            && !title.contains(['*', '\n'])
            && (rest.is_empty() || rest.starts_with("\n\n") || rest.starts_with("\r\n\r\n")))
        .then_some(title.trim())
    });
    let duration = std::iter::once(first)
        .chain(reasoning.clone())
        .filter_map(|part| part.created.zip(part.completed))
        .filter_map(|(start, end)| end.checked_sub(start))
        .fold(0u64, u64::saturating_add);
    let base = if last.provenance != TextProvenance::Closed {
        t("messageBlock.reasoning.thinkingLabel").into()
    } else if duration >= 1_000 {
        let (unit, count) = match duration {
            3_600_000.. => ("hours", duration / 3_600_000),
            60_000.. => ("minutes", duration / 60_000),
            _ => ("seconds", duration / 1_000),
        };
        catalogue::format(
            locale(),
            &format!(
                "messageBlock.reasoning.thoughtFor.{unit}.{}",
                if count == 1 { "one" } else { "other" }
            ),
            &[("count", &count.to_string())],
        )
    } else {
        t("messageBlock.reasoning.thoughtLabel").into()
    };
    let toggle = key.clone();
    let header = layout::action_row()
        .child(
            layout::button(
                &base,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        )
        .children(title.map(|title| text(title.chars().take(250).collect::<String>())));
    let mut group = col()
        .key(key.clone())
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header);
    if expanded {
        group = group.children(std::iter::once(first).chain(reasoning).map(|part| {
            let fragment = block_key(message, part.ordinal);
            let pane = body(s, message, &fragment, part);
            if part.ordinal == first.ordinal {
                pane
            } else {
                pane.key(fragment)
            }
        }));
    }
    Some(group)
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
            document::search_limit(query),
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
