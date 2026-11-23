//! Resolve structural identities to keys actually built by the transcript.
use crate::{State, content::Part, history::Row};
use codenomad_client::timeline::{Marker, MarkerKind::*};

pub(crate) struct Block<'a> {
    pub marker: Marker<'a>,
    pub key: String,
    pub reveal: usize,
    pub text: &'a str,
    pub part: Option<usize>,
}

pub(super) fn context(row: &crate::Message) -> Option<(String, &'static str)> {
    let label = match row.role.as_str() {
        "compaction" => "messageTimeline.segment.compaction.label",
        "system" => "messageBlock.system.label",
        _ => return None,
    };
    Some((format!("context-{}", row.id), label))
}

pub(crate) fn blocks(row: &crate::Message, steps: usize, hidden: bool) -> Vec<Block<'_>> {
    let mut out = Vec::new();
    let mut push = |kind, ordinal, continued, key, reveal, tool_name, text, part| {
        out.push(Block {
            marker: Marker {
                message: &row.id,
                kind,
                ordinal,
                continued,
                omitted_before: false,
                tool_name,
            },
            key,
            reveal,
            text,
            part,
        });
    };
    if row.role != "assistant" || row.parts.is_empty() {
        let kind = match row.role.as_str() {
            "user" => User,
            "assistant" => Assistant,
            "compaction" => Compaction,
            "system" => System,
            _ => return out,
        };
        push(
            kind,
            0,
            false,
            if let Some((key, _)) = context(row) {
                key
            } else if row.body.is_empty() {
                row.id.clone()
            } else {
                format!("body-{}", row.id)
            },
            0,
            None,
            row.body.as_str(),
            None,
        );
        return out;
    }
    let (head, tail) = super::transcript::part_window(row.parts.len(), steps);
    let mut text = 0;
    let mut runs = [0, 0];
    let mut tool = 0;
    let mut current = None;
    let mut segment = None;
    let mut first_at = 0;
    for (i, part) in row.parts.iter().enumerate() {
        let omitted = i >= head && i < tail;
        let (kind, family, key, source) = match part {
            Part::Text(part) => {
                let fragment = text;
                text += 1;
                if part.text.trim().is_empty() {
                    continue;
                }
                (
                    Assistant,
                    0,
                    format!("fragment-{}:{fragment}", row.id),
                    part.text.as_str(),
                )
            }
            Part::Reasoning(part) if part.visible() => (
                Reasoning,
                1,
                super::reasoning::block_key(&row.id, part.ordinal),
                part.text.as_str(),
            ),
            Part::Reasoning(_) => continue,
            Part::Tool(call) => {
                current = None;
                if !omitted || hidden {
                    push(
                        Tool,
                        tool,
                        false,
                        super::tools::tool_key(&row.id, &call.id),
                        if omitted { extra_steps(i) } else { 0 },
                        Some(call.name.as_str()),
                        call.name.as_str(),
                        Some(i),
                    );
                }
                tool += 1;
                continue;
            }
            _ => {
                current = None;
                continue;
            }
        };
        if current != Some(kind) {
            runs[family] += 1;
            current = Some(kind);
            segment = None;
            first_at = i;
        }
        let back = head < tail && i >= tail;
        let hidden_start = (head..tail).contains(&first_at);
        if !omitted && segment != Some(back) {
            push(
                kind,
                runs[family] - 1,
                segment.is_some(),
                key,
                if hidden_start {
                    extra_steps(first_at)
                } else {
                    0
                },
                None,
                source,
                Some(i),
            );
            segment = Some(back);
        } else if omitted && hidden && first_at == i {
            push(
                kind,
                runs[family] - 1,
                false,
                key,
                extra_steps(i),
                None,
                source,
                Some(i),
            );
        }
    }
    if head < tail
        && let Some(after) = out
            .iter_mut()
            .find(|block| block.part.is_some_and(|part| part >= tail))
    {
        after.marker.omitted_before = true;
    }
    out
}

pub(crate) fn reasoning_key(row: &Row, steps: usize, run: u64, continued: bool) -> Option<String> {
    let (head, tail) = super::transcript::part_window(row.parts.len(), steps);
    super::reasoning::run_anchor(row, head..tail, run.try_into().ok()?, continued)
}

pub(crate) fn tool_group(s: &State, row: &Row, steps: usize, index: usize) -> Option<String> {
    let (head, tail) = super::transcript::part_window(row.parts.len(), steps);
    let (start, end) = if head >= tail {
        (0, row.parts.len())
    } else if index < head {
        (0, head)
    } else if index >= tail {
        (tail, row.parts.len())
    } else {
        return None;
    };
    super::tool_groups::anchor(s, &row.id, &row.parts[start..end], index - start)
}

pub(super) fn reasoning_changed(
    rows: &[Row],
    id: &str,
    event: &crate::content::ReasoningEvent,
) -> bool {
    use crate::content::ReasoningEvent;
    match event {
        ReasoningEvent::End { .. } => true,
        ReasoningEvent::Delta { ordinal, text } if !text.trim().is_empty() => rows
            .iter()
            .find(|row| row.id == id)
            .and_then(|row| {
                row.parts.iter().rev().find_map(|part| match part {
                    Part::Reasoning(part) if part.ordinal == *ordinal => Some(!part.visible()),
                    _ => None,
                })
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn extra_steps(index: usize) -> usize {
    let step = super::transcript::PART_LIMIT;
    (index - step / 2) / step + 1
}

pub(crate) fn reveal_parts(s: &mut State, id: &str, steps: usize) {
    let gap = format!("parts-gap-{id}");
    while s.transcript_display.steps(&gap) < steps {
        super::actions::Display::reveal_next(s, &gap);
    }
}

pub(crate) fn steps(s: &State, id: &str) -> usize {
    s.transcript_display.steps(&format!("parts-gap-{id}"))
}
