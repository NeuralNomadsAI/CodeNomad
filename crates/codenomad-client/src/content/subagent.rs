use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct SubagentReport {
    pub child: String,
    pub state: String,
    pub body: String,
    pub created: u64,
}

pub(crate) fn decode(native: &Value) -> Option<SubagentReport> {
    let raw = native["text"].as_str()?.trim_end();
    let (header, body) = raw.split_once('\n')?;
    let (closing, rest) = if let Some(rest) = header.strip_prefix("<subagent sessionID=\"") {
        ("\n</subagent>", rest)
    } else if let Some(rest) =
        header.strip_prefix("<background-result kind=\"subagent\" sessionID=\"")
    {
        ("\n</background-result>", rest)
    } else {
        return None;
    };
    let (child, tail) = rest.split_once('"')?;
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
            "text": "<subagent sessionID=\"child1\" state=\"completed\" description=\"Check \"foo\"\" >\nDone\n</subagent>"
        }))
        .unwrap();
        assert_eq!(legacy.child, "child1");
        assert_eq!(legacy.state, "completed");
        assert_eq!(legacy.body, "Done");

        let modern = decode(&json!({
            "time": { "created": 200 },
            "text": "<background-result kind=\"subagent\" sessionID=\"child2\" state=\"error\" description=\"Verify \"bar\"\">\nFailed\n</background-result>"
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
