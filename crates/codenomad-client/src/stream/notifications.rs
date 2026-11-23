//! Native notification event decoding.
use crate::transport::WorkspaceEvent;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

pub(super) fn session_attention(event: &Value, session: &str) -> Option<WorkspaceEvent> {
    let data = &event["data"];
    let kind = event["type"].as_str()?;
    if kind == "form.created" {
        let form = &data["form"];
        return (form["sessionID"] == session)
            .then(|| attention_request(true, &form["id"]))
            .flatten();
    }
    if data["sessionID"] != session {
        return None;
    }
    if kind == "permission.asked" {
        return attention_request(false, data.get("id").unwrap_or(&data["permissionID"]));
    }
    let notice = match kind {
        "session.execution.succeeded" | "session.execution.failed" => Some(event["id"].as_str()?),
        "session.execution.interrupted" if event["data"]["reason"] == "inactivity" => {
            Some(event["id"].as_str()?)
        }
        "session.execution.started"
        | "session.step.started"
        | "session.execution.interrupted"
        | "session.retry.scheduled"
        | "session.compaction.started" => None,
        _ => return None,
    };
    if notice.is_some_and(|id| !crate::history::valid_id(id)) {
        return None;
    }
    Some(WorkspaceEvent::SessionExecution {
        notice: notice.map(str::to_owned),
    })
}

fn attention_request(form: bool, id: &Value) -> Option<WorkspaceEvent> {
    Some(WorkspaceEvent::SessionRequest {
        form,
        id: id
            .as_str()
            .filter(|id| crate::history::valid_id(id))?
            .into(),
    })
}

#[test]
fn terminal_notifications_include_failures_but_exclude_manual_stops_and_shutdown() {
    for (kind, reason, expected) in [
        ("session.execution.succeeded", "", Some("terminal")),
        (
            "session.execution.interrupted",
            "inactivity",
            Some("terminal"),
        ),
        ("session.execution.interrupted", "manual", None),
        ("session.execution.interrupted", "shutdown", None),
        ("session.retry.scheduled", "", None),
        ("session.compaction.started", "", None),
        ("session.execution.failed", "", Some("terminal")),
        ("session.execution.started", "", None),
    ] {
        let event =
            json!({"id":"terminal","type":kind,"data":{"sessionID":"session","reason":reason}});
        assert!(
            matches!(session_attention(&event, "session"), Some(WorkspaceEvent::SessionExecution { notice })
            if notice.as_deref() == expected)
        );
    }
}
