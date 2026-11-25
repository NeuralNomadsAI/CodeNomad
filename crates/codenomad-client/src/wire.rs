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
            usage: None,
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
        "session.reasoning.started" | "session.reasoning.delta" | "session.reasoning.ended" => {
            use crate::content::ReasoningEvent;
            let id = data["assistantMessageID"]
                .as_str()
                .filter(|id| crate::history::valid_id(id))?;
            let ordinal = data["ordinal"].as_u64().filter(|ordinal| *ordinal < 1000)? as usize;
            let event = match e["type"].as_str()? {
                "session.reasoning.started" => ReasoningEvent::Start {
                    ordinal,
                    at: e["created"].as_u64()?,
                },
                "session.reasoning.delta" => ReasoningEvent::Delta {
                    ordinal,
                    text: data["delta"].as_str()?.into(),
                },
                _ => ReasoningEvent::End {
                    ordinal,
                    at: e["created"].as_u64()?,
                    text: data["text"].as_str()?.into(),
                },
            };
            Some(Event::Reasoning(id.into(), event))
        }
        "session.synthetic" => {
            let id = data["messageID"]
                .as_str()
                .or_else(|| e["id"].as_str())
                .filter(|id| crate::history::valid_id(id))?;
            let text = data["text"].as_str()?;
            if text.len() > 256 * 1024 {
                return None;
            }
            let created = e["created"]
                .as_u64()
                .or_else(|| data["time"]["created"].as_u64())?;
            let report = crate::content::decode_subagent_report(&serde_json::json!({
                "text": text,
                "time": { "created": created },
            }))?;
            Some(Event::Message(Message {
                id: id.into(),
                role: "synthetic".into(),
                completed: true,
                body: String::new(),
                usage: None,
                parts: vec![crate::content::Part::SubagentReport(report)],
            }))
        }
        "session.execution.succeeded" | "session.execution.interrupted" => Some(Event::Done),
        "session.execution.failed" | "session.deleted" | "session.revert.committed" => {
            Some(Event::Failed)
        }
        _ => None,
    }
}
