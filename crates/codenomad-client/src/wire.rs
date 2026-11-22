use crate::{Message, transport::Event};
use serde_json::Value;
pub fn decode_event(v: &Value, workspace: &str, session: &str) -> Option<Event> {
    if v["type"] != "instance.event" || v["instanceId"] != workspace {
        return None;
    }
    let e = &v["event"];
    let data = &e["data"];
    if data["sessionID"] != session {
        return None;
    }
    decode_native(e)
}
pub fn decode_native(e: &Value) -> Option<Event> {
    let data = &e["data"];
    match e["type"].as_str()? {
        "session.step.started" => Some(Event::Message(Message {
            id: data["assistantMessageID"]
                .as_str()
                .filter(|id| crate::history::valid_id(id))?
                .into(),
            role: "assistant".into(),
            completed: false,
            body: String::new(),
            parts: vec![],
        })),
        "session.text.started" | "session.text.delta" | "session.text.ended" => Some(Event::Text(
            data["assistantMessageID"]
                .as_str()
                .filter(|id| crate::history::valid_id(id))?
                .into(),
            {
                let ordinal = if data["ordinal"].is_null() {
                    None
                } else {
                    Some(data["ordinal"].as_u64().filter(|o| *o < 1000)? as usize)
                };
                match e["type"].as_str()? {
                    "session.text.started" => crate::content::TextEvent::Start { ordinal },
                    "session.text.delta" => crate::content::TextEvent::Delta {
                        ordinal,
                        text: data["delta"].as_str()?.into(),
                    },
                    _ => crate::content::TextEvent::End {
                        ordinal,
                        text: data["text"].as_str()?.into(),
                    },
                }
            },
        )),
        "session.execution.succeeded" | "session.execution.interrupted" => Some(Event::Done),
        "session.execution.failed" | "session.deleted" | "session.revert.committed" => {
            Some(Event::Failed)
        }
        _ => None,
    }
}
