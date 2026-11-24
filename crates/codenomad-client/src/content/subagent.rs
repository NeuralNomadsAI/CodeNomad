use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentReport {
    pub child: String,
    pub state: String,
    pub body: String,
    pub created: u64,
}

pub(super) fn decode(native: &Value) -> Option<SubagentReport> {
    let raw = native["text"].as_str()?.trim_end();
    let (header, body) = raw.split_once('\n')?;
    let (child, tail) = header
        .strip_prefix("<subagent sessionID=\"")?
        .split_once('"')?;
    let (state, attributes) = tail.strip_prefix(" state=\"")?.split_once('"')?;
    if !crate::history::valid_id(child)
        || !matches!(state, "running" | "completed" | "error" | "cancelled")
        || !attributes.ends_with('>')
    {
        return None;
    }
    Some(SubagentReport {
        child: child.into(),
        state: state.into(),
        body: body.strip_suffix("\n</subagent>")?.into(),
        created: native["time"]["created"].as_u64().unwrap_or(0),
    })
}
