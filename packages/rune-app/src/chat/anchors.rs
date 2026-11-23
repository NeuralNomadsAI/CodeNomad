//! Resolve structural identities to keys actually built by the transcript.
use crate::{State, content::Part, history::Row};
use codenomad_client::timeline::{Marker, MarkerKind::*};

pub(crate) struct Block<'a> {
    pub marker: Marker<'a>,
    pub key: String,
    pub reveal: usize,
}

pub(crate) fn blocks<'a>(row: &'a Row, steps: usize, hidden: bool) -> Vec<Block<'a>> {
    let mut out = Vec::new();
    let mut push = |kind, ordinal, continued, key, reveal, tool_name| {
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
            if row.body.is_empty() {
                row.id.clone()
            } else {
                format!("body-{}", row.id)
            },
            0,
            None,
        );
        return out;
    }
    let (head, tail) = super::transcript::part_window(row.parts.len(), steps);
    let mut text = 0;
    let mut run = 0;
    let mut tool = 0;
    let mut in_text = false;
    let mut shown = false;
    let mut first_at = 0;
    for (i, part) in row.parts.iter().enumerate() {
        let omitted = i >= head && i < tail;
        match part {
            Part::Text(part) => {
                let fragment = text;
                text += 1;
                if part.text.trim().is_empty() {
                    continue;
                }
                if !in_text {
                    run += 1;
                    first_at = i;
                    shown = false;
                }
                in_text = true;
                if !omitted && (!shown || i >= tail && first_at < head && head < tail) {
                    push(
                        Assistant,
                        run - 1,
                        shown,
                        format!("fragment-{}:{fragment}", row.id),
                        if !shown && first_at >= head && first_at < tail {
                            extra_steps(first_at)
                        } else {
                            0
                        },
                        None,
                    );
                    shown = true;
                    if i >= tail {
                        first_at = i;
                    }
                } else if omitted && hidden && first_at == i {
                    push(
                        Assistant,
                        run - 1,
                        false,
                        format!("fragment-{}:{fragment}", row.id),
                        extra_steps(i),
                        None,
                    );
                }
            }
            Part::Tool(call) => {
                in_text = false;
                if !omitted || hidden {
                    push(
                        Tool,
                        tool,
                        false,
                        super::tools::tool_key(&row.id, &call.id),
                        if omitted { extra_steps(i) } else { 0 },
                        Some(call.name.as_str()),
                    );
                }
                tool += 1;
            }
            _ => {}
        }
    }
    out
}

fn extra_steps(index: usize) -> usize {
    let step = super::transcript::PART_LIMIT;
    (index - step / 2) / step + 1
}

pub(crate) fn reveal(s: &mut State, id: &str, steps: usize) {
    let gap = format!("parts-gap-{id}");
    while s.transcript_display.steps(&gap) < steps {
        super::actions::Display::reveal_next(s, &gap);
    }
}

pub(crate) fn steps(s: &State, id: &str) -> usize {
    s.transcript_display.steps(&format!("parts-gap-{id}"))
}
