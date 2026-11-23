//! A rail projects native structure; resident markers come from the rendered transcript.
use super::{Entry, Kind};
use crate::history::Result;
use std::collections::{HashMap, HashSet};

const MAX_MARKERS: usize = 500_000;
const PART_LIMIT: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MarkerKind {
    User,
    Assistant,
    Reasoning,
    Tool,
    Compaction,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marker<'a> {
    pub message: &'a str,
    pub kind: MarkerKind,
    pub ordinal: u64,
    pub continued: bool,
    pub omitted_before: bool,
    pub tool_name: Option<&'a str>,
}

/// Even a resident row with no visible markers shadows its indexed projection.
pub struct Resident<'a> {
    pub message: &'a str,
    pub markers: &'a [Marker<'a>],
}

/// Indexed rows follow native sequence; resident markers use transcript order.
pub fn project<'a>(index: &'a [Entry], resident: &[Resident<'a>]) -> Result<Vec<Marker<'a>>> {
    let positions: HashMap<_, _> = index
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let owned: HashSet<_> = resident.iter().map(|row| row.message).collect();
    let mut result = Vec::new();
    let mut next = 0;
    for row in resident {
        if let Some(&at) = positions.get(row.message).filter(|&&at| at >= next) {
            append_indexed(&index[next..at], &owned, &mut result)?;
            next = at + 1;
        }
        if row.markers.len() > MAX_MARKERS.saturating_sub(result.len()) {
            return Err("timeline marker budget reached".into());
        }
        result.extend_from_slice(row.markers);
    }
    append_indexed(&index[next..], &owned, &mut result)?;
    Ok(result)
}

fn append_indexed<'a>(
    rows: &'a [Entry],
    owned: &HashSet<&str>,
    out: &mut Vec<Marker<'a>>,
) -> Result<()> {
    let mut push = |marker| {
        if out.len() >= MAX_MARKERS {
            return Err("timeline marker budget reached".into());
        }
        out.push(marker);
        Ok(())
    };
    for row in rows.iter().filter(|row| !owned.contains(row.id.as_str())) {
        markers(row, &mut push)?;
    }
    Ok(())
}

fn markers<'a>(entry: &'a Entry, out: &mut impl FnMut(Marker<'a>) -> Result<()>) -> Result<()> {
    use MarkerKind::*;
    let marker = |kind, ordinal, continued, omitted_before| Marker {
        message: &entry.id,
        kind,
        ordinal,
        continued,
        omitted_before,
        tool_name: (kind == Tool)
            .then(|| entry.tool_name.as_deref().map(str::trim))
            .flatten()
            .filter(|name| !name.is_empty()),
    };
    match entry.kind {
        Kind::User => out(marker(User, 0, false, false)),
        Kind::Compaction => out(marker(Compaction, 0, false, false)),
        Kind::System => out(marker(System, 0, false, false)),
        Kind::Assistant => {
            let Some(layout) = &entry.layout else {
                if entry.reasoning != 0 {
                    out(marker(Reasoning, 0, false, false))?;
                }
                if entry.text != Some(0) {
                    out(marker(Assistant, 0, false, false))?;
                }
                // Counts-only indexes lack the order of parts beyond the initial display bound.
                for ordinal in 0..entry.tools.min(PART_LIMIT) {
                    out(marker(Tool, ordinal, false, false))?;
                }
                return Ok(());
            };
            let kind = |byte| match byte {
                b'T' => Some((Assistant, 0)),
                b'R' => Some((Reasoning, 1)),
                b'X' => Some((Tool, 2)),
                _ => None,
            };
            let (head, tail) = layout.split_once('-').unwrap_or((layout, ""));
            let mut ordinals = [0u64; 3];
            for byte in head.bytes() {
                let (part, index) = kind(byte).ok_or("invalid outline marker")?;
                out(marker(part, ordinals[index], false, false))?;
                ordinals[index] += 1;
            }
            if let Some(omitted) = &entry.omitted {
                let skipped = [
                    omitted.text,
                    omitted.reasoning,
                    entry.tools.saturating_sub(
                        ordinals[2] + tail.bytes().filter(|&b| b == b'X').count() as u64,
                    ),
                ];
                for (ordinal, count) in ordinals.iter_mut().zip(skipped) {
                    *ordinal += count;
                }
                for (i, byte) in tail.bytes().enumerate() {
                    let (part, index) = kind(byte).ok_or("invalid outline marker")?;
                    if i == 0 && omitted.continues && part != Tool {
                        let ordinal = ordinals[index]
                            .checked_sub(1)
                            .ok_or("outline continuation has no run")?;
                        out(marker(part, ordinal, skipped[index] == 0, true))?;
                    } else {
                        out(marker(part, ordinals[index], false, i == 0))?;
                        ordinals[index] += 1;
                    }
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests;
