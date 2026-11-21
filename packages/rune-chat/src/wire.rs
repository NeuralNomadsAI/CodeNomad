use crate::{Message, transport::Event};
use serde_json::Value;
#[cfg(test)]
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
            body: String::new(),
        })),
        "session.text.delta" => Some(Event::Delta(
            data["assistantMessageID"]
                .as_str()
                .filter(|id| crate::history::valid_id(id))?
                .into(),
            data["delta"].as_str()?.into(),
        )),
        "session.execution.succeeded" | "session.execution.interrupted" => Some(Event::Done),
        "session.execution.failed" | "session.deleted" | "session.revert.committed" => {
            Some(Event::Failed)
        }
        _ => None,
    }
}
