//! Native session relay, child observations and scoped lifecycle hints.
use super::{Backend, Input, Result, Sender, SeqCst, State, children, mission_events};
use crate::transport::WorkspaceEvent;
use serde_json::Value;

pub(super) async fn relay(
    b: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
    value: &Value,
) -> Result<()> {
    let own = value["instanceId"] == b.workspace;
    let native = &value["event"];
    if own && value["type"] == "instance.event" {
        children::observe(b, native);
    } else if own && value["type"] == "instance.eventStatus" && value["status"] == "connected" {
        b.client.children().invalidate(b, None);
    }
    // A conversation move revokes its reader before any send and relays SessionMoved itself.
    if !(own && native["type"] == "session.moved" && native["data"]["sessionID"] == b.session)
        && let Some(event) = mission_events::decode(&b.workspace, value)
    {
        out.send(Input::Workspace(epoch, event)).await?;
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
    } else if own && value["type"] == "instance.event" && native["type"] == "vcs.branch.updated" {
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
            Input::Available(epoch, version)
        } else {
            Input::Unavailable(epoch)
        })
        .await?;
    } else if own && value["type"] == "instance.dataChanged" {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(Input::Hint(epoch, version)).await?;
    } else if own
        && value["type"] == "instance.event"
        && native["type"] == "session.synthetic"
        && native["data"]["sessionID"] == b.session
    {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(Input::Hint(epoch, version)).await?;
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
        out.send(Input::Native(epoch, version, native.clone()))
            .await?;
    }
    Ok(())
}
