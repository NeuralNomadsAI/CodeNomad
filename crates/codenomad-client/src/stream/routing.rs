//! Envelope dispatch before the session-scoped relay.
use super::{
    Backend, Input, Result, Sender, State,
    limits::{FRAME_LIMIT, reread},
    sessions,
};
use crate::transport::{DirectoryChange, WorkspaceEvent};
use serde_json::{Value, json};

fn storage_owner(value: &Value) -> Option<crate::settings::Owner> {
    if value["type"] == "storage.configChanged" && value["owner"] == "server" {
        return Some(crate::settings::Owner::Server);
    }
    if !matches!(value["owner"].as_str(), Some("ui" | "*")) {
        return None;
    }
    match value["type"].as_str()? {
        "storage.configChanged" => Some(crate::settings::Owner::Config),
        "storage.stateChanged" => Some(crate::settings::Owner::State),
        _ => None,
    }
}

pub(super) async fn dispatch(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    kind: &str,
    data: &str,
) -> Result<()> {
    if data.len() > FRAME_LIMIT {
        return reread(epoch, out, state).await;
    }
    if kind == "codenomad.client.ping" {
        b.client
            .post(format!("{}api/client-connections/pong", b.base))
            .json(&json!({"clientId":b.client_id,"connectionId":connection}))
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    if data.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(data.trim())?;
    if let Some(signals) = &state.catalogue {
        signals.observe(&value);
        return Ok(());
    }
    if let Some(owner) = storage_owner(&value) {
        return state.storage_changed(epoch, owner, out).await;
    }
    if value["type"] == "memory.changed" {
        out.send(Input::Workspace(epoch, WorkspaceEvent::MemoryChanged))
            .await?;
        return Ok(());
    }
    if value["type"] == "instance.event"
        && let Some(id) = crate::settings::provider_change(&value)
        && id == b.workspace
    {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::ProvidersChanged {
                workspace_id: id.into(),
            },
        ))
        .await?;
    }
    if let Some(event) = workspace_event(b, &value) {
        out.send(Input::Workspace(epoch, event)).await?;
        return Ok(());
    }
    sessions::relay(b, epoch, out, state, &value).await
}

fn workspace_event(b: &Backend, value: &Value) -> Option<WorkspaceEvent> {
    let event = parse_workspace_event(value)?;
    let workspace_id = match &event {
        WorkspaceEvent::Stopped { workspace_id }
        | WorkspaceEvent::WorktreesChanged { workspace_id }
        | WorkspaceEvent::FilesChanged { workspace_id, .. } => workspace_id.as_str(),
        _ => return None,
    };
    (workspace_id == b.workspace).then_some(event)
}

pub(super) fn parse_workspace_event(value: &Value) -> Option<WorkspaceEvent> {
    let id = value["workspaceId"]
        .as_str()
        .filter(|id| crate::history::valid_id(id))?;
    match value["type"].as_str()? {
        "workspace.stopped" => Some(WorkspaceEvent::Stopped {
            workspace_id: id.into(),
        }),
        "workspace.worktreesChanged" => Some(WorkspaceEvent::WorktreesChanged {
            workspace_id: id.into(),
        }),
        "workspace.filesChanged" => {
            let changes = value["changes"]
                .as_array()?
                .iter()
                .map(|change| {
                    let directory = change["directory"].as_str()?;
                    let path = change["path"].as_str()?;
                    if !crate::absolute_server_path(directory)
                        || crate::files::relative(path, true, directory).is_err()
                    {
                        return None;
                    }
                    Some(DirectoryChange {
                        directory: directory.into(),
                        path: path.into(),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            Some(WorkspaceEvent::FilesChanged {
                workspace_id: id.into(),
                changes,
            })
        }
        _ => None,
    }
}
