//! Native session relay, child observations and scoped lifecycle hints.
use super::{Backend, Input, Result, Sender, SeqCst, State, children, mission_events};
use crate::{inbox::InboxWire, transport::WorkspaceEvent};
use serde_json::Value;

/// Advance `inbox` ingress synchronously on frame arrival before any routing queue or side send.
pub(super) fn note_inbox_frame(
    workspace: &str,
    session: &str,
    inbox: &InboxWire,
    data: &str,
) -> u64 {
    if data.len() > super::limits::FRAME_LIMIT {
        return inbox.record_ingress();
    }
    if data.is_empty()
        || !(data.contains("session.inbox.")
            || data.contains("instance.eventStatus")
            || data.contains("server.connected")
            || data.contains("session.moved")
            || data.contains("session.deleted")
            || data.contains("session.revert.")
            || data.contains("\\u"))
    {
        return 0;
    }
    serde_json::from_str::<Value>(data.trim())
        .ok()
        .map_or(0, |value| {
            note_inbox_value(workspace, session, inbox, &value)
        })
}

fn matches_inbox_value(workspace: &str, session: &str, value: &Value) -> bool {
    if value["instanceId"] != workspace {
        return false;
    }
    let native = &value["event"];
    value["type"] == "instance.eventStatus"
        || (value["type"] == "instance.event"
            && (native["type"] == "server.connected"
                || (native["data"]["sessionID"] == session
                    && native["type"].as_str().is_some_and(|kind| {
                        kind.starts_with("session.inbox.")
                            || matches!(
                                kind,
                                "session.moved"
                                    | "session.deleted"
                                    | "session.revert.staged"
                                    | "session.revert.cleared"
                                    | "session.revert.committed"
                            )
                    }))))
}

pub(super) fn note_inbox_value(
    workspace: &str,
    session: &str,
    inbox: &InboxWire,
    value: &Value,
) -> u64 {
    if matches_inbox_value(workspace, session, value) {
        inbox.record_ingress()
    } else {
        0
    }
}

pub(super) async fn relay(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    value: &Value,
    inbox_mark: u64,
) -> Result<()> {
    let own = value["instanceId"] == b.workspace;
    let native = &value["event"];
    if own && value["type"] == "instance.event" {
        children::observe(b, native);
        if let Some(urgent) = native["type"]
            .as_str()
            .and_then(crate::settings::stats::event)
        {
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::StatsChanged {
                    workspace_id: b.workspace.clone(),
                    urgent,
                },
            ))
            .await?;
        }
        if (native["data"]["sessionID"] == b.session || native["type"] == "tui.toast.show")
            && let Some(event) = super::notifications::other_notice(native)
        {
            out.send(Input::Workspace(epoch, event)).await?;
        }
        let root = match native["type"].as_str() {
            Some("server.connected") => Some(None),
            Some("session.permissions") => native["data"]["sessionID"]
                .as_str()
                .filter(|id| crate::history::valid_id(id))
                .map(|id| Some(id.to_owned())),
            _ => None,
        };
        if let Some(root) = root {
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::PermissionModeChanged { root },
            ))
            .await?;
        }
    } else if own && value["type"] == "instance.eventStatus" && value["status"] == "connected" {
        b.client.children().invalidate_all(b);
    }
    // A conversation move revokes its reader before any send and relays SessionMoved itself.
    if !(own && native["type"] == "session.moved" && native["data"]["sessionID"] == b.session)
        && let Some(event) = mission_events::decode(&b.workspace, b.session.is_empty(), value)
    {
        out.send(Input::Workspace(epoch, event)).await?;
    }
    if own
        && value["type"] == "instance.event"
        && native["data"]["sessionID"] != b.session
        && crate::content::FamilyChange::tracks(native)
    {
        return Ok(out.send(Input::Native(epoch, 0, 0, native.clone())).await?);
    }
    let catalogues = (own && value["type"] == "instance.event")
        .then(|| match native["type"].as_str() {
            Some("command.updated") => Some(WorkspaceEvent::CommandsChanged),
            Some("agent.updated" | "skill.updated") => Some(WorkspaceEvent::MentionsChanged),
            Some("config.updated" | "plugin.updated" | "models-dev.refreshed") => {
                Some(WorkspaceEvent::ComposerCataloguesChanged)
            }
            _ => None,
        })
        .flatten();
    if let Some(event) = catalogues {
        out.send(Input::Workspace(epoch, event)).await?;
    }
    if own && value["type"] == "instance.event" {
        match native["type"].as_str() {
            Some("plugin.updated") => {
                let directory = native["location"]["directory"]
                    .as_str()
                    .filter(|p| crate::absolute_server_path(p))
                    .map(str::to_owned);
                out.send(Input::Workspace(
                    epoch,
                    WorkspaceEvent::PluginsChanged {
                        workspace_id: Some(b.workspace.clone()),
                        directory,
                    },
                ))
                .await?;
            }
            Some("config.updated") => {
                out.send(Input::Workspace(
                    epoch,
                    WorkspaceEvent::PluginsChanged {
                        workspace_id: Some(b.workspace.clone()),
                        directory: None,
                    },
                ))
                .await?;
                out.send(Input::Workspace(
                    epoch,
                    WorkspaceEvent::McpStatusChanged {
                        workspace_id: Some(b.workspace.clone()),
                    },
                ))
                .await?;
            }
            Some(
                "mcp.status.changed"
                | "mcp.resources.changed"
                | "integration.updated"
                | "credential.updated"
                | "credential.switched",
            ) => {
                out.send(Input::Workspace(
                    epoch,
                    WorkspaceEvent::McpStatusChanged {
                        workspace_id: Some(b.workspace.clone()),
                    },
                ))
                .await?;
            }
            _ => {}
        }
    }
    if own
        && value["type"] == "instance.event"
        && matches!(
            native["type"].as_str(),
            Some("vcs.branch.updated" | "worktree.updated")
        )
    {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::WorktreesChanged {
                workspace_id: b.workspace.clone(),
            },
        ))
        .await?;
    } else if own && value["type"] == "instance.event" && native["type"] == "filesystem.changed" {
        out.send(Input::Workspace(
            epoch,
            WorkspaceEvent::NativeFilesystemChanged {
                workspace_id: b.workspace.clone(),
            },
        ))
        .await?;
    } else if own && value["type"] == "instance.eventStatus" {
        let ready = value["status"] == "connected";
        let was_ready = state.upstream.swap(ready, SeqCst);
        if ready != was_ready {
            state.history_revision.fetch_add(1, SeqCst);
        }
        if ready && !was_ready {
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::ComposerCataloguesChanged,
            ))
            .await?;
            out.send(Input::Workspace(
                epoch,
                WorkspaceEvent::ProvidersChanged {
                    workspace_id: b.workspace.clone(),
                },
            ))
            .await?;
        }
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(if ready {
            Input::Available(epoch, version, inbox_mark)
        } else {
            Input::Unavailable(epoch, inbox_mark)
        })
        .await?;
    } else if own
        && value["type"] == "instance.event"
        && native["type"] == "session.synthetic"
        && native["data"]["sessionID"] == b.session
    {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        if native["data"]["text"]
            .as_str()
            .is_some_and(|t| t.len() <= 256 * 1024)
        {
            out.send(Input::Native(epoch, version, 0, native.clone()))
                .await?;
        } else {
            out.send(Input::Hint(epoch, version, 0)).await?;
        }
    } else if own
        && value["type"] == "instance.event"
        && !matches!(
            native["type"].as_str(),
            Some(
                "session.created"
                    | "session.forked"
                    | "session.renamed"
                    | "session.archived"
                    | "session.unarchived"
                    | "worktree.updated"
            )
        )
        && (native["data"]["sessionID"] == b.session
            || native["data"]["form"]["sessionID"] == b.session
            || native["type"] == "server.connected")
    {
        if crate::history::valid_id(&b.session)
            && let Some(event) = super::session_attention(native, &b.session)
        {
            out.send(Input::Workspace(epoch, event)).await?;
        }
        let version = state.version.fetch_add(1, SeqCst) + 1;
        if matches!(
            native["type"].as_str(),
            Some("session.moved" | "session.deleted" | "session.revert.committed")
        ) {
            state.history_revision.fetch_add(1, SeqCst);
        }
        if native["type"] == "session.moved"
            && native["data"]["sessionID"] == b.session
            && let Some((cancel, _)) = &state.placement
        {
            // Closing the signal fences the current body and every later read on this wire.
            cancel.close();
        }
        out.send(Input::Native(epoch, version, inbox_mark, native.clone()))
            .await?;
    } else if own
        && value["type"] == "instance.event"
        && native["data"]["sessionID"] != b.session
        && crate::content::FamilyChange::tracks(native)
    {
        out.send(Input::Native(epoch, 0, 0, native.clone())).await?;
    }
    Ok(())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn instance_storage_updates_leave_the_window_valid_but_native_hints_do_not() {
    use serde_json::json;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(2);
            let state = State::default();
            super::opened(1, &out, &state).await.unwrap();
            assert!(matches!(inbox.try_recv().unwrap(), Input::Opened(1)));
            let stamp = state.version.load(SeqCst);
            relay(
                &backend,
                1,
                &out,
                &state,
                &json!({
                    "type":"instance.dataChanged", "instanceId":"project",
                    "data":{"messageHistory":["attempt"],"agentModelSelections":{}}
                }),
                0,
            )
            .await
            .unwrap();
            assert!(state.valid(stamp));
            assert!(inbox.is_empty());

            relay(
                &backend,
                1,
                &out,
                &state,
                &json!({
                    "type":"instance.event", "instanceId":"project",
                    "event":{"type":"session.synthetic","data":{"sessionID":"session"}}
                }),
                0,
            )
            .await
            .unwrap();
            assert!(!state.valid(stamp));
            assert!(matches!(inbox.try_recv().unwrap(), Input::Hint(1, _, _)));
        });
}
