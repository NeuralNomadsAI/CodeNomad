use super::{Part, TextFit, TextProvenance};
use crate::Message;
use serde_json::Value;

/// A native reasoning fragment, identified by its ordinal within the assistant step.
#[derive(Clone, Debug, PartialEq)]
pub struct Reasoning {
    pub ordinal: usize,
    pub text: String,
    pub provenance: TextProvenance,
    pub created: Option<u64>,
    pub completed: Option<u64>,
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

pub fn apply(row: &mut Message, event: &ReasoningEvent) -> TextFit {
    const LIVE_BYTES: usize = 256 * 1024;
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
                ordinal,
                text: String::new(),
                provenance: TextProvenance::Live,
                created: Some(*at),
                completed: None,
            }));
            TextFit::Applied
        };
    }
    if ordinal.saturating_add(1) < count {
        return TextFit::Drop;
    }
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
        ReasoningEvent::Delta { text, .. }
            if part.text.len().saturating_add(text.len()) <= LIVE_BYTES =>
        {
            part.text.push_str(text)
        }
        ReasoningEvent::End { at, text, .. } if text.len() <= LIVE_BYTES => {
            part.text.clone_from(text);
            part.completed = Some(*at);
            part.provenance = TextProvenance::Closed;
        }
        _ => return TextFit::Repair,
    }
    TextFit::Applied
}

pub(super) fn decode(part: &Value, ordinal: usize, row_completed: bool) -> Reasoning {
    let created = part["time"]["created"].as_u64();
    let completed = part["time"]["completed"].as_u64();
    let text = part["text"].as_str().unwrap_or_default();
    Reasoning {
        ordinal,
        text: text.into(),
        provenance: if row_completed || completed.is_some() {
            TextProvenance::Closed
        } else if text.is_empty() {
            TextProvenance::Live
        } else {
            TextProvenance::Partial
        },
        created,
        completed,
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
    assert_eq!(apply(&mut row, &delta), TextFit::Repair);
    assert_eq!(apply(&mut row, &start), TextFit::Applied);
    assert_eq!(apply(&mut row, &start), TextFit::Drop);
    assert_eq!(apply(&mut row, &delta), TextFit::Applied);
    assert_eq!(apply(&mut row, &end), TextFit::Applied);
    assert_eq!(apply(&mut row, &delta), TextFit::Drop);
    assert_eq!(row.body, "Reply");
    assert!(
        matches!(&row.parts[..], [Part::Reasoning(r)] if r.ordinal == 0 && r.text == "Final thought" && r.provenance == TextProvenance::Closed)
    );
}
