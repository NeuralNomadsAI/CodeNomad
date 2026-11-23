//! Native notification event decoding.
use crate::transport::WorkspaceEvent;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

pub(super) fn other_notice(event: &Value) -> Option<WorkspaceEvent> {
    let id = || {
        event["id"]
            .as_str()
            .filter(|id| crate::history::valid_id(id))
            .map(str::to_owned)
    };
    match event["type"].as_str()? {
        "session.compaction.ended" => Some(WorkspaceEvent::SessionCompacted { id: id()? }),
        "tui.toast.show" => {
            let data = &event["data"];
            let variant = data["variant"].as_str()?;
            let body = data["message"].as_str()?.trim();
            if body.is_empty() {
                return None;
            }
            Some(WorkspaceEvent::OpenCodeNotice {
                id: id()?,
                title: data["title"]
                    .as_str()
                    .map(|title| title.chars().take(256).collect()),
                body: body.chars().take(4096).collect(),
                error: variant == "error",
                duration_ms: data["duration"]
                    .as_f64()
                    .filter(|ms| ms.is_finite() && *ms >= 0.0)
                    .map(|ms| ms.min(f64::from(i32::MAX)) as u32),
            })
        }
        _ => None,
    }
}

#[test]
fn decodes_a_toast_duration_without_changing_the_default_for_invalid_values() {
    for (duration, expected) in [
        (json!(1800), Some(1800)),
        (json!(0), Some(0)),
        (json!(null), None),
        (json!(-4), None),
        (json!("1000"), None),
    ] {
        let event = json!({"id":"evt_notice", "type":"tui.toast.show",
            "data":{"message":"Hello","variant":"info","duration":duration}});
        assert!(
            matches!(other_notice(&event), Some(WorkspaceEvent::OpenCodeNotice { duration_ms, .. }) if duration_ms == expected)
        );
    }
}

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
