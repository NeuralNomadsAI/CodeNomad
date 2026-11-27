//! Envelope dispatch before the session-scoped relay.
use super::{Backend, Input, Result, Sender, State, limits::FRAME_LIMIT, sessions};
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

#[cfg(test)]
pub(super) async fn dispatch(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    kind: &str,
    data: &str,
) -> Result<()> {
    dispatch_marked(b, epoch, out, state, connection, kind, data, 0).await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_marked(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    connection: &str,
    kind: &str,
    data: &str,
    inbox_mark: u64,
) -> Result<()> {
    if data.len() > FRAME_LIMIT {
        return super::limits::reread_marked(epoch, out, state, inbox_mark).await;
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
    let mark = if inbox_mark > 0 {
        inbox_mark
    } else {
        sessions::note_inbox_value(
            &b.workspace,
            &b.session,
            &state.inbox,
            Some(state.history_revision.as_ref()),
            Some(state.upstream.as_ref()),
            Some(state.disconnect_mark.as_ref()),
            &value,
        )
    };
    if value["instanceId"] == b.workspace
        && state.provider_usage.is_some()
        && value["type"] == "instance.event"
        && value["event"]["type"] == "provider.updated"
    {
        let directory = value["event"]["location"]["directory"]
            .as_str()
            .map(str::to_owned);
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::ProviderUsageRefresh(directory),
        ))
        .await?;
    }
    if value["type"] == "storage.configChanged"
        && matches!(value["owner"].as_str(), Some("providerAccounts" | "*"))
        && !b.workspace.is_empty()
    {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::ProvidersChanged {
                workspace_id: b.workspace.clone(),
            },
        ))
        .await?;
        if value["owner"] == "providerAccounts" {
            return Ok(());
        }
    }
    if let Some(owner) = storage_owner(&value) {
        return state.storage_changed(epoch, owner, out).await;
    }
    if value["type"] == "permission.receiptsChanged"
        && value["instanceId"] == b.workspace
        && value["sessionId"] == b.session
    {
        let message = match &value["messageId"] {
            Value::Null => None,
            Value::String(id) if crate::history::valid_id(id) => Some(id.clone()),
            _ => return Ok(()),
        };
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::PermissionReceiptsChanged { message },
        ))
        .await?;
        return Ok(());
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
    if let Some(event) = parse_temporary_changed(&value) {
        out.send(Input::Workspace(epoch, event)).await?;
        return Ok(());
    }
    if value["type"] == "instance.event"
        && let Some(id) = crate::settings::mission_catalog_change(&value)
        && id == b.workspace
    {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::MissionCatalogChanged {
                workspace_id: id.into(),
            },
        ))
        .await?;
    }
    if value["type"] == "instance.event"
        && let Some((id, session_id)) = crate::settings::integrations::session_stream_event(&value)
        && id == b.workspace
    {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::IntegrationsChanged {
                workspace_id: id.into(),
                session_id: session_id.map(str::to_owned),
            },
        ))
        .await?;
    }
    if let Some(event) = workspace_event(b, &value) {
        if matches!(event, WorkspaceEvent::Stopped { .. }) {
            state.close_placement();
        }
        out.send(Input::Workspace(epoch, event)).await?;
        return Ok(());
    }
    sessions::relay(b, epoch, out, state, &value, mark).await
}

fn workspace_event(b: &Backend, value: &Value) -> Option<WorkspaceEvent> {
    if value["workspaceId"].as_str() != Some(b.workspace.as_str()) {
        return None;
    }
    parse_workspace_event(value)
}

pub(super) fn parse_detached_workspace_event(value: &Value) -> Option<WorkspaceEvent> {
    if storage_owner(value) == Some(crate::settings::Owner::Config) {
        return Some(WorkspaceEvent::UiPreferencesChanged);
    }
    if let Some(event) = parse_temporary_changed(value) {
        return Some(event);
    }
    if let Some(event) = parse_workspace_event(value) {
        return Some(event);
    }
    if value["type"] == "instance.eventStatus" {
        let id = value["instanceId"]
            .as_str()
            .filter(|id| crate::history::valid_id(id))?;
        return Some(WorkspaceEvent::NativeStreamStatus {
            workspace_id: id.into(),
            connected: value["status"] == "connected",
        });
    }
    if value["type"] != "instance.event" {
        return None;
    }
    let id = value["instanceId"]
        .as_str()
        .filter(|id| crate::history::valid_id(id))?;
    match value["event"]["type"].as_str()? {
        "vcs.branch.updated" | "worktree.updated" => Some(WorkspaceEvent::WorktreesChanged {
            workspace_id: id.into(),
        }),
        "filesystem.changed" => Some(WorkspaceEvent::NativeFilesystemChanged {
            workspace_id: id.into(),
        }),
        "plugin.updated" => {
            let directory = value["event"]["location"]["directory"]
                .as_str()
                .filter(|p| crate::absolute_server_path(p))
                .map(str::to_owned);
            Some(WorkspaceEvent::PluginsChanged {
                workspace_id: Some(id.into()),
                directory,
            })
        }
        "config.updated" => Some(WorkspaceEvent::ServicesConfigChanged {
            workspace_id: id.into(),
        }),
        "mcp.status.changed"
        | "mcp.resources.changed"
        | "integration.updated"
        | "credential.updated"
        | "credential.switched" => Some(WorkspaceEvent::McpStatusChanged {
            workspace_id: Some(id.into()),
        }),
        _ => None,
    }
}

fn parse_temporary_changed(value: &Value) -> Option<WorkspaceEvent> {
    if value["type"].as_str()? != "workspace.temporaryChanged" {
        return None;
    }
    let folders = crate::temporary_workspaces::parse_folders(&value["folders"]).ok()?;
    Some(WorkspaceEvent::TemporaryChanged { folders })
}

pub(super) fn parse_workspace_event(value: &Value) -> Option<WorkspaceEvent> {
    let id = value["workspaceId"]
        .as_str()
        .filter(|id| crate::history::valid_id(id))?;
    match value["type"].as_str()? {
        "workspace.stopped" => Some(WorkspaceEvent::Stopped {
            workspace_id: id.into(),
            deleted: value["reason"].as_str() == Some("deleted"),
            temporary_retained: value["temporaryRetained"].as_bool().unwrap_or(false),
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn server_connected_advances_inbox_version_before_blocked_providers_send() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "ws".into();
            backend.session = "ses".into();
            let state = Arc::new(State::default());
            let (out_tx, out_rx) = crate::bounded(1);
            // Pre-fill channel so routing::dispatch blocks on the ProvidersChanged side send.
            out_tx.send(Input::Hint(1, 0, 0)).await.unwrap();
            let before = state.inbox.ingress();
            let frame = json!({
                "type": "instance.event",
                "instanceId": "ws",
                "event": { "type": "server.connected", "data": {} }
            })
            .to_string();
            let task = {
                let backend = backend.clone();
                let out_tx = out_tx.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    dispatch(&backend, 1, &out_tx, &state, "c1", "message", &frame).await
                })
            };
            tokio::time::timeout(Duration::from_secs(2), async {
                while state.inbox.ingress() == before {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("server.connected must advance inbox_version before awaiting side sends");
            assert!(
                !task.is_finished(),
                "dispatch should still be blocked on the full ProvidersChanged channel"
            );
            drop(out_rx);
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        });
    }
}
