use crate::{history::valid_id, transport::WorkspaceEvent};
use serde_json::Value;

pub(super) fn decode(
    workspace: &str,
    without_session: bool,
    frame: &Value,
) -> Option<WorkspaceEvent> {
    let id = frame["instanceId"].as_str()?;
    if !valid_id(id) || id != workspace {
        return None;
    }
    let event = &frame["event"];
    match frame["type"].as_str()? {
        "instance.event" if event["type"] == "rpc.codenomad.missions.changed" => {
            let data = &event["data"];
            let mission = data["missionID"].as_str()?;
            let revision = data["revision"].as_u64()?;
            if mission.is_empty() || mission.encode_utf16().count() > 100 || revision >= 1 << 53 {
                return None;
            }
            Some(WorkspaceEvent::MissionChanged {
                workspace_id: id.into(),
                mission_id: mission.into(),
                revision,
            })
        }
        "instance.eventStatus" if without_session && frame["status"] == "connected" => {
            Some(WorkspaceEvent::MissionsReconnected {
                workspace_id: id.into(),
            })
        }
        "instance.event" if event["type"].as_str().is_some_and(activity) => {
            Some(WorkspaceEvent::MissionActivityChanged {
                workspace_id: id.into(),
            })
        }
        _ => None,
    }
}

fn activity(kind: &str) -> bool {
    matches!(
        kind,
        "session.created"
            | "session.forked"
            | "session.moved"
            | "session.deleted"
            | "session.compaction.started"
            | "session.compaction.ended"
            | "session.compaction.failed"
            | "session.execution.started"
            | "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted"
    ) || ["session.inbox.", "shell.", "form.", "permission."]
        .iter()
        .any(|prefix| kind.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relays_qualified_journal_and_reconnect_events_only() {
        let mut frame = json!({"type":"instance.event","instanceId":"owned","event":{
            "type":"rpc.codenomad.missions.changed","data":{"missionID":"msn_one","revision":7}}});
        assert_eq!(
            decode("owned", false, &frame),
            Some(WorkspaceEvent::MissionChanged {
                workspace_id: "owned".into(),
                mission_id: "msn_one".into(),
                revision: 7,
            })
        );
        assert_eq!(
            decode("owned", true, &frame),
            decode("owned", false, &frame)
        );
        assert_eq!(decode("", true, &frame), None);
        assert_eq!(decode("foreign", false, &frame), None);
        frame["event"]["data"]["revision"] = json!(9007199254740992u64);
        assert_eq!(decode("owned", true, &frame), None);
        let status =
            json!({"type":"instance.eventStatus","instanceId":"owned","status":"connected"});
        assert_eq!(
            decode("owned", true, &status),
            Some(WorkspaceEvent::MissionsReconnected {
                workspace_id: "owned".into()
            })
        );
        assert_eq!(
            decode("owned", false, &status),
            None,
            "conversation streams already forward AgentHint"
        );
    }

    #[test]
    fn the_existing_stream_dispatches_mission_changes_outside_the_session_filter() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "owned".into();
            backend.session = "ses_chat".into();
            let (out, incoming) = crate::bounded(2);
            let state = crate::stream::State::default();
            let frame = r#"{"type":"instance.event","instanceId":"owned","event":{"type":"rpc.codenomad.missions.changed","data":{"missionID":"msn_target","revision":8}}}"#;
            crate::stream::dispatch(&backend, 4, &out, &state, "test", "message", frame).await.unwrap();
            assert!(matches!(incoming.try_recv(), Ok(crate::recovery::Input::Workspace(4,
                WorkspaceEvent::MissionChanged { revision:8, .. }))));
            assert!(incoming.is_empty());
        });
    }
}
