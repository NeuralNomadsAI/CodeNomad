use super::{Part, TextFit, TextProvenance};
use crate::Message;
use serde_json::Value;

/// A native reasoning fragment, identified by its ordinal within the assistant step.
#[derive(Clone, Debug, PartialEq)]
pub struct Reasoning {
    pub part_index: Option<usize>,
    pub ordinal: usize,
    pub text: String,
    pub units: usize,
    pub retained_units: usize,
    pub provenance: TextProvenance,
    pub created: Option<u64>,
    pub completed: Option<u64>,
    pub identity: Option<String>,
}

#[derive(Debug)]
pub enum ReasoningEvent {
    Start {
        ordinal: usize,
        at: u64,
    },
    Delta {
        ordinal: usize,
        text: String,
    },
    End {
        ordinal: usize,
        at: u64,
        text: String,
    },
}

pub fn apply_window(rows: &mut [crate::history::Row], id: &str, event: &ReasoningEvent) -> TextFit {
    let Some(index) = rows.iter().position(|row| row.id == id) else {
        return TextFit::Repair;
    };
    let outside: usize = rows
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, row)| super::reasoning_bytes(&row.parts))
        .sum();
    let row_bytes = super::reasoning_bytes(&rows[index].parts);
    let budget = crate::history::WINDOW_BYTES
        .saturating_sub(outside)
        .min(crate::history::MAX_BYTES.max(row_bytes));
    apply(std::sync::Arc::make_mut(&mut rows[index]), event, budget)
}

impl Reasoning {
    pub fn visible(&self) -> bool {
        self.units > self.retained_units || !self.text.trim().is_empty()
    }
}

fn apply(row: &mut Message, event: &ReasoningEvent, capacity: usize) -> TextFit {
    if row.role != "assistant" || row.completed {
        return TextFit::Drop;
    }
    let ordinal = match event {
        ReasoningEvent::Start { ordinal, .. }
        | ReasoningEvent::Delta { ordinal, .. }
        | ReasoningEvent::End { ordinal, .. } => *ordinal,
    };
    let count = row
        .parts
        .iter()
        .filter(|p| matches!(p, Part::Reasoning(_)))
        .count();
    if let ReasoningEvent::Start { at, .. } = event {
        return if ordinal < count {
            TextFit::Drop
        } else if ordinal != count || row.parts.len() >= 1000 {
            TextFit::Repair
        } else {
            row.parts.push(Part::Reasoning(Reasoning {
                part_index: None,
                ordinal,
                text: String::new(),
                units: 0,
                retained_units: 0,
                provenance: TextProvenance::Live,
                created: Some(*at),
                completed: None,
                identity: None,
            }));
            TextFit::Applied
        };
    }
    if ordinal.saturating_add(1) < count {
        return TextFit::Drop;
    }
    let other_bytes: usize = row
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Reasoning(part) if part.ordinal != ordinal => Some(part.text.len()),
            _ => None,
        })
        .sum();
    let budget = capacity.saturating_sub(other_bytes);
    let Some(part) = row.parts.iter_mut().rev().find_map(|part| match part {
        Part::Reasoning(part) if part.ordinal == ordinal => Some(part),
        _ => None,
    }) else {
        return TextFit::Repair;
    };
    if part.provenance == TextProvenance::Closed {
        return TextFit::Drop;
    }
    match event {
        ReasoningEvent::Delta { text, .. } => {
            part.identity = None;
            if part.retained_units == part.units {
                let cut = text
                    .floor_char_boundary(text.len().min(budget.saturating_sub(part.text.len())));
                part.retained_units += text[..cut].encode_utf16().count();
                part.text.push_str(&text[..cut]);
            }
            part.units = part.units.saturating_add(text.encode_utf16().count());
        }
        ReasoningEvent::End { at, text, .. } => {
            part.identity = None;
            let cut = text.floor_char_boundary(text.len().min(budget));
            part.text.clear();
            part.text.push_str(&text[..cut]);
            part.retained_units = part.text.encode_utf16().count();
            part.units = text.encode_utf16().count();
            part.completed = Some(*at);
            part.provenance = TextProvenance::Closed;
        }
        _ => return TextFit::Repair,
    }
    TextFit::Applied
}

pub(super) fn decode(part: &Value, ordinal: usize, index: usize, row_completed: bool) -> Reasoning {
    let created = part["time"]["created"].as_u64();
    let completed = part["time"]["completed"].as_u64();
    let text = part["text"].as_str().unwrap_or_default();
    Reasoning {
        part_index: Some(index),
        ordinal,
        text: text.into(),
        units: text.encode_utf16().count(),
        retained_units: text.encode_utf16().count(),
        provenance: if row_completed || completed.is_some() {
            TextProvenance::Closed
        } else if text.is_empty() {
            TextProvenance::Live
        } else {
            TextProvenance::Partial
        },
        created,
        completed,
        identity: Some(crate::message_actions::reasoning_part_digest(part)),
    }
}

#[cfg(test)]
#[test]
fn decoded_window_keeps_reasoning_ordinals_separate_from_prose() {
    use serde_json::json;

    let page = crate::history::decode(json!({"status":"window","latest":true,"messages":[
        {"id":"step","type":"assistant","content":[
            {"type":"reasoning","text":""},
            {"type":"text","text":"Visible reply"},
            {"type":"reasoning","text":"Working","native":{},"time":{"created":25}},
            {"type":"reasoning","text":"Settled","time":{"created":30,"completed":50}}
        ]}
    ]}))
    .unwrap();
    let row = &page.rows[0];
    assert_eq!(row.body, "Visible reply");
    let [
        Part::Reasoning(first),
        Part::Text(_),
        Part::Reasoning(working),
        Part::Reasoning(settled),
    ] = row.parts.as_slice()
    else {
        panic!("native order")
    };
    assert_eq!([first.ordinal, working.ordinal, settled.ordinal], [0, 1, 2]);
    assert_eq!(working.provenance, TextProvenance::Partial);
    assert_eq!(settled.provenance, TextProvenance::Closed);
    assert_eq!((settled.created, settled.completed), (Some(30), Some(50)));
}

#[cfg(test)]
#[test]
fn live_reasoning_keeps_the_same_ordinal_until_the_authoritative_end() {
    use crate::transport::Event;
    use serde_json::json;
    let mut row = crate::history::decode_message(&json!({"id":"step","type":"assistant"})).unwrap();
    row.body = "Reply".into();
    let decode = |kind, extra| {
        let mut native = json!({"type":kind,"created":100,"data":extra});
        native["data"]["assistantMessageID"] = json!("step");
        let Some(Event::Reasoning(_, event)) = crate::wire::decode_native(&native) else {
            panic!("native reasoning event");
        };
        event
    };
    let start = decode("session.reasoning.started", json!({"ordinal":0}));
    let delta = decode(
        "session.reasoning.delta",
        json!({"ordinal":0,"delta":"Preview"}),
    );
    let end = decode(
        "session.reasoning.ended",
        json!({"ordinal":0,"text":"Final thought"}),
    );
    assert_eq!(apply(&mut row, &delta, 1024), TextFit::Repair);
    assert_eq!(apply(&mut row, &start, 1024), TextFit::Applied);
    assert_eq!(apply(&mut row, &start, 1024), TextFit::Drop);
    assert_eq!(apply(&mut row, &delta, 1024), TextFit::Applied);
    assert_eq!(apply(&mut row, &end, 1024), TextFit::Applied);
    assert_eq!(apply(&mut row, &delta, 1024), TextFit::Drop);
    assert_eq!(row.body, "Reply");
    assert!(
        matches!(&row.parts[..], [Part::Reasoning(r)] if r.ordinal == 0 && r.text == "Final thought" && r.provenance == TextProvenance::Closed)
    );
}

#[cfg(test)]
#[test]
fn live_reasoning_grows_past_256_kib_and_counts_unretained_units() {
    use serde_json::json;
    let mut row = crate::history::decode_message(&json!({"id":"step","type":"assistant"})).unwrap();
    let capacity = 320 * 1024 + 1;
    assert_eq!(
        apply(
            &mut row,
            &ReasoningEvent::Start { ordinal: 0, at: 1 },
            capacity
        ),
        TextFit::Applied
    );
    for text in [
        "a".repeat(256 * 1024),
        "b".repeat(64 * 1024),
        "🦀".into(),
        "c".into(),
    ] {
        assert_eq!(
            apply(
                &mut row,
                &ReasoningEvent::Delta { ordinal: 0, text },
                capacity
            ),
            TextFit::Applied
        );
    }
    assert!(matches!(&row.parts[..], [Part::Reasoning(part)]
        if part.text.len() == 320 * 1024 && part.units == 320 * 1024 + 3));
}
