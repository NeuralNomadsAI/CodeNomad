//! Native session relay, child observations and scoped lifecycle hints.
use super::{Backend, Input, Result, Sender, SeqCst, State, children, mission_events};
use crate::{inbox::InboxWire, transport::WorkspaceEvent};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64};

/// Advance `inbox` ingress, `upstream` disconnect state, and `history_revision` synchronously on
/// frame arrival before any routing queue or side send.
pub(super) fn note_inbox_frame(
    workspace: &str,
    session: &str,
    inbox: &InboxWire,
    history_revision: Option<&AtomicU64>,
    upstream: Option<&AtomicBool>,
    disconnect_mark: Option<&AtomicU64>,
    data: &str,
) -> u64 {
    if data.len() > super::limits::FRAME_LIMIT {
        if let Some(rev) = history_revision {
            rev.fetch_add(1, SeqCst);
        }
        return inbox.record_ingress();
    }
    if data.is_empty()
        || !(data.contains("session.inbox.")
            || data.contains("instance.eventStatus")
            || data.contains("server.connected")
            || data.contains("session.moved")
            || data.contains("session.deleted")
            || data.contains("session.revert.")
            || data.contains("session.compaction.")
            || data.contains("\\u"))
    {
        return 0;
    }
    serde_json::from_str::<Value>(data.trim())
        .ok()
        .map_or(0, |value| {
            note_inbox_value(
                workspace,
                session,
                inbox,
                history_revision,
                upstream,
                disconnect_mark,
                &value,
            )
        })
}

fn matches_history_boundary(workspace: &str, session: &str, value: &Value) -> bool {
    if value["instanceId"] != workspace {
        return false;
    }
    if value["type"] == "instance.eventStatus" {
        return value["status"] != "connected";
    }
    if value["type"] != "instance.event" {
        return false;
    }
    let native = &value["event"];
    let own_session =
        native["data"]["sessionID"] == session || native["data"]["form"]["sessionID"] == session;
    own_session
        && matches!(
            native["type"].as_str(),
            Some(
                "session.moved"
                    | "session.deleted"
                    | "session.revert.committed"
                    | "session.revert.staged"
                    | "session.revert.cleared"
                    | "session.inbox.cancelled"
                    | "session.inbox.delivered"
                    | "session.compaction.started"
                    | "session.compaction.ended"
                    | "session.compaction.failed"
            )
        )
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
    history_revision: Option<&AtomicU64>,
    upstream: Option<&AtomicBool>,
    disconnect_mark: Option<&AtomicU64>,
    value: &Value,
) -> u64 {
    let mark = if matches_inbox_value(workspace, session, value) {
        inbox.record_ingress()
    } else {
        0
    };
    if value["instanceId"] == workspace
        && value["type"] == "instance.eventStatus"
        && value["status"] != "connected"
    {
        if let Some(dm) = disconnect_mark {
            dm.fetch_max(mark, SeqCst);
        }
        if let Some(up) = upstream {
            up.store(false, SeqCst);
        }
    }
    if let Some(rev) = history_revision
        && matches_history_boundary(workspace, session, value)
    {
        rev.fetch_add(1, SeqCst);
    }
    mark
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
    let own_session_event = own
        && value["type"] == "instance.event"
        && (native["data"]["sessionID"] == b.session
            || native["data"]["form"]["sessionID"] == b.session);
    if own_session_event
        && matches!(
            native["type"].as_str(),
            Some("session.moved" | "session.deleted")
        )
    {
        // Closing the signal before any send fences reads and prompts even if the relay inbox is full.
        state.close_placement();
    }
    if own_session_event
        && matches!(
            native["type"].as_str(),
            Some(
                "session.moved"
                    | "session.deleted"
                    | "session.revert.committed"
                    | "session.revert.staged"
                    | "session.revert.cleared"
                    | "session.inbox.cancelled"
                    | "session.inbox.delivered"
                    | "session.compaction.started"
                    | "session.compaction.ended"
                    | "session.compaction.failed"
            )
        )
    {
        // Bump history_revision before awaiting any channel send so boundary events fence concurrent offers immediately.
        state.history_revision.fetch_add(1, SeqCst);
    }
    if own && value["type"] == "instance.event" {
        if native["type"] == "session.deleted" && native["data"]["sessionID"] == b.session {
            state.notify_session_deleted();
        }
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
    if own && value["type"] == "instance.event" && native["type"] == "vcs.branch.updated" {
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
        let apply_ready = ready && inbox_mark >= state.disconnect_mark.load(SeqCst);
        let was_ready = if ready {
            if apply_ready {
                state.upstream.swap(true, SeqCst)
            } else {
                state.upstream.load(SeqCst)
            }
        } else {
            state.upstream.swap(false, SeqCst)
        };
        if (ready && apply_ready != was_ready) || (!ready && was_ready) {
            state.history_revision.fetch_add(1, SeqCst);
        }
        if apply_ready && !was_ready {
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
            || (native["type"] == "form.created"
                && native["data"]["form"]["sessionID"] == "global")
            || (matches!(
                native["type"].as_str(),
                Some("form.replied" | "form.cancelled")
            ) && native["data"]["sessionID"] == "global")
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

            // Project-owned global form events must relay to the active session so the dock refreshes.
            for event in [
                json!({
                    "type": "form.created",
                    "location": {"directory": "/repo"},
                    "data": {"form": {"id": "frm_global", "sessionID": "global"}}
                }),
                json!({
                    "type": "form.replied",
                    "location": {"directory": "/repo"},
                    "data": {"id": "frm_global", "sessionID": "global"}
                }),
                json!({
                    "type": "form.cancelled",
                    "location": {"directory": "/repo"},
                    "data": {"id": "frm_global", "sessionID": "global"}
                }),
            ] {
                relay(
                    &backend,
                    1,
                    &out,
                    &state,
                    &json!({"type": "instance.event", "instanceId": "project", "event": event}),
                    0,
                )
                .await
                .unwrap();
                let mut saw_native = false;
                while let Ok(item) = inbox.try_recv() {
                    if matches!(item, Input::Native(1, _, _, ref native) if native["type"] == event["type"])
                    {
                        saw_native = true;
                    }
                }
                assert!(
                    saw_native,
                    "global form event {} must be relayed",
                    event["type"]
                );
            }
        });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn session_deleted_closes_placement_before_waiting_on_a_full_relay_channel() {
    use serde_json::json;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(1);
            let (events_tx, _events_rx) = crate::bounded(1);
            let state = std::sync::Arc::new(State::observing_preferences(
                events_tx,
                std::sync::Arc::new(|| {}),
            ));
            out.send(Input::Opened(1)).await.unwrap();
            let payload = json!({
                "type": "instance.event",
                "instanceId": "project",
                "event": {"type": "session.deleted", "data": {"sessionID": "session"}}
            });
            let relay_task = tokio::spawn({
                let out = out.clone();
                let state = state.clone();
                async move { relay(&backend, 1, &out, &state, &payload, 0).await }
            });
            // Even while relay awaits space in the full inbox for StatsChanged, placement is closed.
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while !state.placement_closed() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("placement must close before relay waits on the full channel");
            assert!(
                !relay_task.is_finished(),
                "relay must still be blocked on the full inbox"
            );
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while !relay_task.is_finished() {
                    if inbox.try_recv().is_err() {
                        tokio::task::yield_now().await;
                    }
                }
            })
            .await
            .expect("relay task must finish once inbox is drained");
            relay_task.await.unwrap().unwrap();
            assert!(state.placement_closed());
        });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn revert_staged_and_cleared_bump_history_revision_while_normal_deltas_do_not() {
    use serde_json::json;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(8);
            let state = State::default();
            super::opened(1, &out, &state).await.unwrap();
            state.upstream.store(true, SeqCst);
            let _ = inbox.try_recv();

            let rev0 = state.history_revision.load(SeqCst);
            let ver0 = state.version.load(SeqCst);
            relay(
                &backend,
                1,
                &out,
                &state,
                &json!({
                    "type": "instance.event",
                    "instanceId": "project",
                    "event": {"type": "message.part.updated", "data": {"sessionID": "session"}}
                }),
                0,
            )
            .await
            .unwrap();
            assert!(!state.valid(ver0));
            assert!(
                state.history_current(rev0),
                "normal streaming delta must not invalidate history_revision"
            );

            for kind in [
                "session.revert.staged",
                "session.revert.cleared",
                "session.inbox.cancelled",
                "session.inbox.delivered",
                "session.compaction.started",
                "session.compaction.ended",
            ] {
                while inbox.try_recv().is_ok() {}
                let frame = json!({
                    "type": "instance.event",
                    "instanceId": "project",
                    "event": {"type": kind, "data": {"sessionID": "session"}}
                });
                let before_wire = state.history_revision.load(SeqCst);
                let _ = note_inbox_frame(
                    &backend.workspace,
                    &backend.session,
                    &state.inbox,
                    Some(state.history_revision.as_ref()),
                    Some(state.upstream.as_ref()),
                    Some(state.disconnect_mark.as_ref()),
                    &frame.to_string(),
                );
                assert!(
                    !state.history_current(before_wire),
                    "{kind} must invalidate history_revision synchronously on wire ingress"
                );
                let before = state.history_revision.load(SeqCst);
                relay(&backend, 1, &out, &state, &frame, 0).await.unwrap();
                assert!(
                    !state.history_current(before),
                    "{kind} must invalidate history_revision"
                );
            }

            let connected_frame = json!({
                "type": "instance.eventStatus",
                "instanceId": "project",
                "status": "connected"
            });
            let earlier_connected_mark = note_inbox_frame(
                &backend.workspace,
                &backend.session,
                &state.inbox,
                Some(state.history_revision.as_ref()),
                Some(state.upstream.as_ref()),
                Some(state.disconnect_mark.as_ref()),
                &connected_frame.to_string(),
            );
            let before_disconnect = state.history_revision.load(SeqCst);
            let disconnect_frame = json!({
                "type": "instance.eventStatus",
                "instanceId": "project",
                "status": "disconnected"
            });
            let disconnect_mark = note_inbox_frame(
                &backend.workspace,
                &backend.session,
                &state.inbox,
                Some(state.history_revision.as_ref()),
                Some(state.upstream.as_ref()),
                Some(state.disconnect_mark.as_ref()),
                &disconnect_frame.to_string(),
            );
            assert!(disconnect_mark > earlier_connected_mark);
            assert!(
                !state.upstream.load(SeqCst),
                "instance.eventStatus disconnect must clear upstream synchronously on wire ingress"
            );
            let after_disconnect = state.history_revision.load(SeqCst);
            assert_ne!(
                after_disconnect, before_disconnect,
                "instance.eventStatus disconnect must increment history_revision synchronously on wire ingress"
            );
            assert!(
                !state.history_current(after_disconnect),
                "history_current must stay false even with the post-disconnect revision while upstream is false"
            );
            // A queued earlier connected status or Opened must NOT flip upstream back to true
            // while a newer wire disconnect is pending in the queue.
            while inbox.try_recv().is_ok() {}
            relay(
                &backend,
                1,
                &out,
                &state,
                &connected_frame,
                earlier_connected_mark,
            )
            .await
            .unwrap();
            assert!(
                !state.upstream.load(SeqCst),
                "stale queued connected status must not re-enable upstream past a newer wire disconnect"
            );
            while inbox.try_recv().is_ok() {}
            super::opened_at(1, &out, &state, earlier_connected_mark)
                .await
                .unwrap();
            assert!(
                !state.upstream.load(SeqCst),
                "stale queued Opened must not re-enable upstream past a newer wire disconnect"
            );
            // A later connected status after the disconnect cleanly restores upstream.
            while inbox.try_recv().is_ok() {}
            let later_connected_mark = note_inbox_frame(
                &backend.workspace,
                &backend.session,
                &state.inbox,
                Some(state.history_revision.as_ref()),
                Some(state.upstream.as_ref()),
                Some(state.disconnect_mark.as_ref()),
                &connected_frame.to_string(),
            );
            relay(
                &backend,
                1,
                &out,
                &state,
                &connected_frame,
                later_connected_mark,
            )
            .await
            .unwrap();
            assert!(
                state.upstream.load(SeqCst),
                "a newer connected status after disconnect must restore upstream"
            );
        });
}
