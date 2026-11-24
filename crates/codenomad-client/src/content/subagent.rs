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
    let (closing, rest) = if let Some(rest) = header.strip_prefix("<subagent ") {
        ("\n</subagent>", rest)
    } else if let Some(rest) = header.strip_prefix("<background-result ") {
        ("\n</background-result>", rest)
    } else {
        return None;
    };
    let attrs = rest.strip_suffix('>')?;
    let mut child = None;
    let mut state = None;
    let mut kind = None;
    let mut cursor = attrs;
    while !cursor.is_empty() {
        cursor = cursor.trim_start();
        let (name, after_name) = cursor.split_once("=\"")?;
        let (value, tail) = after_name.split_once('"')?;
        match name {
            "sessionID" => child = Some(value),
            "state" => state = Some(value),
            "kind" => kind = Some(value),
            _ => {}
        }
        cursor = tail;
    }
    if closing == "\n</background-result>" && kind != Some("subagent") {
        return None;
    }
    let child = child.filter(|id| crate::history::valid_id(id))?;
    let state = state.filter(|s| matches!(*s, "running" | "completed" | "error" | "cancelled"))?;
    Some(SubagentReport {
        child: child.into(),
        state: state.into(),
        body: body.strip_suffix(closing)?.into(),
        created: native["time"]["created"].as_u64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::decode;
    use serde_json::json;

    #[test]
    fn decodes_subagent_and_background_result_reports_with_matching_closing_tags() {
        let legacy = decode(&json!({
            "time": { "created": 100 },
            "text": "<subagent sessionID=\"child1\" state=\"completed\">\nDone\n</subagent>"
        }))
        .unwrap();
        assert_eq!(legacy.child, "child1");
        assert_eq!(legacy.state, "completed");
        assert_eq!(legacy.body, "Done");

        let modern = decode(&json!({
            "time": { "created": 200 },
            "text": "<background-result kind=\"subagent\" sessionID=\"child2\" state=\"error\" description=\"x\">\nFailed\n</background-result>"
        }))
        .unwrap();
        assert_eq!(modern.child, "child2");
        assert_eq!(modern.state, "error");
        assert_eq!(modern.body, "Failed");

        assert!(
            decode(&json!({
                "time": { "created": 300 },
                "text": "<background-result kind=\"shell\" sessionID=\"child2\" state=\"completed\">\nNope\n</background-result>"
            }))
            .is_none()
        );
        assert!(
            decode(&json!({
                "time": { "created": 300 },
                "text": "<background-result kind=\"subagent\" sessionID=\"child2\" state=\"completed\">\nMismatch\n</subagent>"
            }))
            .is_none()
        );
    }
}
