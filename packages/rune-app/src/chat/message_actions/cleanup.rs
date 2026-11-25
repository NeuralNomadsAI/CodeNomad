use crate::{State, content::Part};
use codenomad_client::message_actions::{
    MAX_PRUNE_INDEX, MAX_PRUNE_MESSAGES, PruneKind, PruneMessageTarget, PrunePartTarget,
};
use std::collections::HashSet;

fn non_blank(text: &str) -> bool {
    !text
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .is_empty()
}

fn is_response_part(part: &Part) -> bool {
    match part {
        Part::Text(text) => non_blank(&text.text),
        Part::File(file) => file.name.as_deref().is_some_and(non_blank),
        _ => false,
    }
}

fn valid_index(index: Option<usize>) -> Option<u64> {
    index
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value <= MAX_PRUNE_INDEX)
}

fn window(s: &State, message: &crate::Message) -> (usize, usize) {
    let steps = s
        .transcript_display
        .steps(&format!("parts-gap-{}", message.id));
    super::super::transcript::part_window(message.parts.len(), steps)
}

/// Collect the contiguous multi-message technical run preceding a completed assistant response.
/// Matches Solid's `technicalCleanupTranscript` + `getTechnicalCleanupParts` boundaries:
/// stops at user messages, omitted-part gaps, response text/named files, and body-only responses.
pub(super) fn response_targets(s: &State, message_id: &str) -> Vec<PruneMessageTarget> {
    let rows = s.transcript_display.messages.visible(&s.messages);
    let Some(target_row) = rows.iter().position(|row| row.id == message_id) else {
        return Vec::new();
    };
    let row = &rows[target_row];
    if row.role != "assistant" || !row.completed {
        return Vec::new();
    }
    let end = if row.parts.is_empty() {
        if !non_blank(&row.body) {
            return Vec::new();
        }
        0
    } else {
        let (head, tail) = window(s, row);
        let Some(last) = row
            .parts
            .iter()
            .enumerate()
            .rev()
            .find(|(idx, part)| (*idx < head || *idx >= tail) && is_response_part(part))
            .map(|(idx, _)| idx)
        else {
            return Vec::new();
        };
        // Rewind to the start of the response content block containing the final response part.
        let mut block_start = last;
        while block_start > 0 {
            let prev = block_start - 1;
            if prev >= head && prev < tail {
                break;
            }
            match &row.parts[prev] {
                Part::Tool(_) => break,
                Part::Reasoning(part) if part.visible() => break,
                _ => block_start = prev,
            }
        }
        block_start
    };

    let mut collected: Vec<PruneMessageTarget> = Vec::new();
    'rows: for i in (0..=target_row).rev() {
        let current = &rows[i];
        if current.role == "user" {
            break;
        }
        if current.role != "assistant" {
            continue;
        }
        if current.parts.is_empty() {
            if i != target_row && non_blank(&current.body) {
                break;
            }
            continue;
        }
        let (head, tail) = window(s, current);
        let limit = if i == target_row {
            end
        } else {
            current.parts.len()
        };
        let mut parts: Vec<PrunePartTarget> = Vec::new();
        let mut seen = HashSet::new();
        let mut stopped = false;
        for idx in (0..limit).rev() {
            if idx >= head && idx < tail {
                stopped = true;
                break;
            }
            match &current.parts[idx] {
                Part::Tool(tool) => {
                    if !current.completed {
                        return Vec::new();
                    }
                    let Some(index) = valid_index(tool.part_index) else {
                        return Vec::new();
                    };
                    if seen.insert(index) {
                        parts.push(PrunePartTarget {
                            index,
                            kind: PruneKind::Tool,
                        });
                    }
                }
                Part::Reasoning(reasoning) => {
                    if !current.completed {
                        return Vec::new();
                    }
                    let Some(index) = valid_index(reasoning.part_index) else {
                        return Vec::new();
                    };
                    if seen.insert(index) {
                        parts.push(PrunePartTarget {
                            index,
                            kind: PruneKind::Reasoning,
                        });
                    }
                }
                part if is_response_part(part) => {
                    stopped = true;
                    break;
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            parts.sort_unstable_by_key(|part| part.index);
            collected.push(PruneMessageTarget {
                message: current.id.clone(),
                parts,
            });
            if collected.len() > MAX_PRUNE_MESSAGES {
                return Vec::new();
            }
        }
        if stopped {
            break 'rows;
        }
    }
    collected.reverse();
    collected
}

/// Accumulates exact `(message_id, part_index, kind)` targets for a technical group run.
#[derive(Default)]
pub(in crate::chat) struct GroupPrune {
    invalid: bool,
    messages: Vec<PruneMessageTarget>,
}

impl GroupPrune {
    pub(in crate::chat) fn push(
        &mut self,
        message: &str,
        completed: bool,
        part_index: Option<usize>,
        kind: PruneKind,
    ) {
        if self.invalid {
            return;
        }
        if !completed {
            self.invalid = true;
            return;
        }
        let Some(index) = valid_index(part_index) else {
            self.invalid = true;
            return;
        };
        let entry = match self.messages.last_mut() {
            Some(last) if last.message == message => last,
            _ => {
                if self.messages.len() >= MAX_PRUNE_MESSAGES
                    || self.messages.iter().any(|old| old.message == message)
                {
                    self.invalid = true;
                    return;
                }
                self.messages.push(PruneMessageTarget {
                    message: message.to_owned(),
                    parts: Vec::new(),
                });
                self.messages.last_mut().expect("pushed entry")
            }
        };
        if entry.parts.iter().any(|old| old.index == index) {
            self.invalid = true;
            return;
        }
        entry.parts.push(PrunePartTarget { index, kind });
    }

    pub(in crate::chat) fn finish(mut self, allow: bool) -> Vec<PruneMessageTarget> {
        if !allow || self.invalid {
            return Vec::new();
        }
        for target in &mut self.messages {
            target.parts.sort_unstable_by_key(|part| part.index);
        }
        self.messages
    }
}
