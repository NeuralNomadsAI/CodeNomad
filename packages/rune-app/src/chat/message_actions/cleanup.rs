use crate::{State, content::Part};
use codenomad_client::message_actions::{
    MAX_PRUNE_INDEX, MAX_PRUNE_MESSAGES, PruneKind, PruneMessageTarget, PrunePartIdentity,
    PrunePartTarget,
};
use std::collections::{HashMap, HashSet};

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

pub(super) fn has_response_part(row: &crate::Message) -> bool {
    if row.parts.is_empty() {
        non_blank(&row.body)
    } else {
        row.parts.iter().any(is_response_part)
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

/// Count native reasoning digests once per message in O(N) so duplicate reasoning blocks
/// stay unambiguous without quadratic re-scans.
pub(in crate::chat) fn reasoning_digest_counts(row: &crate::Message) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for part in &row.parts {
        if let Part::Reasoning(reasoning) = part
            && let Some(digest) = reasoning.identity.as_deref()
        {
            *counts.entry(digest).or_insert(0) += 1;
        }
    }
    counts
}

fn part_identity_with_counts(
    part: &Part,
    reasoning_counts: &HashMap<&str, usize>,
) -> Option<PrunePartIdentity> {
    match part {
        Part::Tool(tool) => Some(PrunePartIdentity::Tool {
            id: tool.id.clone(),
            name: tool.name.clone(),
        }),
        Part::Reasoning(reasoning) => {
            let digest = reasoning.identity.as_deref()?;
            (reasoning_counts.get(digest) == Some(&1)).then(|| PrunePartIdentity::Reasoning {
                digest: digest.to_owned(),
            })
        }
        _ => None,
    }
}

/// Collect the contiguous multi-message technical run preceding a completed assistant response.
/// Finds the last response part in the full record (refusing fallback when omitted by a gap),
/// anchors at the first rendered part of that final content row (splitting on nonempty reasoning
/// regardless of Thinking visibility to match Solid), and scans backward across adjacent assistant
/// messages up to user turns, response boundaries, body-only responses or omitted gaps.
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
        let Some(last) = row.parts.iter().rposition(is_response_part) else {
            return Vec::new();
        };
        if last >= head && last < tail {
            return Vec::new();
        }
        // Anchor at the first rendered content part of the final content row. Solid splits content
        // rows on nonempty reasoning before hiding its card, while treating empty reasoning and
        // filtered-out tools as transparent for content-row grouping.
        let mut block_start = last;
        let mut scan = last;
        while scan > 0 {
            scan -= 1;
            if scan >= head && scan < tail {
                break;
            }
            match &row.parts[scan] {
                part if is_response_part(part) => block_start = scan,
                Part::Tool(tool) if super::super::tools::visible(s, &row.id, tool) => break,
                Part::Reasoning(part) if part.visible() => break,
                _ => {}
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
        let reasoning_counts = reasoning_digest_counts(current);
        let mut parts: Vec<PrunePartTarget> = Vec::new();
        let mut seen = HashSet::new();
        let mut stopped = false;
        for idx in (0..limit).rev() {
            if idx >= head && idx < tail {
                stopped = true;
                break;
            }
            match &current.parts[idx] {
                part @ Part::Tool(tool) => {
                    if !current.completed {
                        return Vec::new();
                    }
                    let Some(index) = valid_index(tool.part_index) else {
                        return Vec::new();
                    };
                    let Some(identity) = part_identity_with_counts(part, &reasoning_counts) else {
                        return Vec::new();
                    };
                    if seen.insert(index) {
                        parts.push(PrunePartTarget {
                            index,
                            kind: PruneKind::Tool,
                            identity,
                        });
                    }
                }
                part @ Part::Reasoning(reasoning) => {
                    if !current.completed {
                        return Vec::new();
                    }
                    let Some(index) = valid_index(reasoning.part_index) else {
                        return Vec::new();
                    };
                    let Some(identity) = part_identity_with_counts(part, &reasoning_counts) else {
                        return Vec::new();
                    };
                    if seen.insert(index) {
                        parts.push(PrunePartTarget {
                            index,
                            kind: PruneKind::Reasoning,
                            identity,
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

/// Collect deletable technical parts inside a single completed assistant message that has no
/// response prose/file, preserving single-tool and single-reasoning cleanup without crossing rows.
pub(super) fn message_targets(s: &State, message_id: &str) -> Vec<PruneMessageTarget> {
    let rows = s.transcript_display.messages.visible(&s.messages);
    let Some(row) = rows.iter().find(|row| row.id == message_id) else {
        return Vec::new();
    };
    if row.role != "assistant" || !row.completed || has_response_part(row) {
        return Vec::new();
    }
    let (head, tail) = window(s, row);
    let reasoning_counts = reasoning_digest_counts(row);
    let mut parts = Vec::new();
    let mut seen = HashSet::new();
    for (idx, part) in row.parts.iter().enumerate() {
        if idx >= head && idx < tail {
            continue;
        }
        let (part_index, kind) = match part {
            Part::Tool(tool) => (tool.part_index, PruneKind::Tool),
            Part::Reasoning(reasoning) => (reasoning.part_index, PruneKind::Reasoning),
            _ => continue,
        };
        let Some(index) = valid_index(part_index) else {
            return Vec::new();
        };
        let Some(identity) = part_identity_with_counts(part, &reasoning_counts) else {
            return Vec::new();
        };
        if seen.insert(index) {
            parts.push(PrunePartTarget {
                index,
                kind,
                identity,
            });
        }
    }
    if parts.is_empty() {
        return Vec::new();
    }
    parts.sort_unstable_by_key(|part| part.index);
    vec![PruneMessageTarget {
        message: row.id.clone(),
        parts,
    }]
}

/// Accumulates exact `(message_id, part_index, kind, identity)` targets for a technical group run
/// without rescanning the message; callers supply precomputed reasoning digest counts once per row.
#[derive(Default)]
pub(in crate::chat) struct GroupPrune {
    invalid: bool,
    messages: Vec<PruneMessageTarget>,
    seen_messages: HashSet<String>,
    current_row: Option<(String, HashSet<u64>, HashSet<PrunePartIdentity>)>,
}

impl GroupPrune {
    pub(in crate::chat) fn push(
        &mut self,
        row: &crate::Message,
        part_index: Option<usize>,
        kind: PruneKind,
        part: &Part,
        reasoning_counts: Option<&HashMap<&str, usize>>,
    ) {
        if self.invalid {
            return;
        }
        if !row.completed {
            self.invalid = true;
            return;
        }
        let Some(index) = valid_index(part_index) else {
            self.invalid = true;
            return;
        };
        let switching = self
            .current_row
            .as_ref()
            .is_none_or(|(id, _, _)| id != &row.id);
        if switching {
            if self.messages.len() >= MAX_PRUNE_MESSAGES
                || !self.seen_messages.insert(row.id.clone())
            {
                self.invalid = true;
                return;
            }
            self.messages.push(PruneMessageTarget {
                message: row.id.clone(),
                parts: Vec::new(),
            });
            self.current_row = Some((row.id.clone(), HashSet::new(), HashSet::new()));
        }
        let (_, seen_indexes, seen_identities) = self.current_row.as_mut().expect("active row");
        let identity = match part {
            Part::Tool(tool) => Some(PrunePartIdentity::Tool {
                id: tool.id.clone(),
                name: tool.name.clone(),
            }),
            Part::Reasoning(reasoning) => reasoning
                .identity
                .as_deref()
                .filter(|digest| {
                    reasoning_counts.and_then(|counts| counts.get(*digest)) == Some(&1)
                })
                .map(|digest| PrunePartIdentity::Reasoning {
                    digest: digest.to_owned(),
                }),
            _ => None,
        };
        let Some(identity) = identity else {
            self.invalid = true;
            return;
        };
        if !seen_indexes.insert(index) || !seen_identities.insert(identity.clone()) {
            self.invalid = true;
            return;
        }
        self.messages
            .last_mut()
            .expect("pushed entry")
            .parts
            .push(PrunePartTarget {
                index,
                kind,
                identity,
            });
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
