//! SSE adapters share scoped decoding, epoch fencing and bounded dispatch.
use crate::transport::{DirectoryChange, WorkspaceEvent};
use crate::{Sender, backend::Backend, history::Result, recovery::Input, runtime};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};
mod catalogue;
pub use catalogue::{AttentionHint, CatalogueChanges, CatalogueWatch};
#[cfg(target_arch = "wasm32")]
#[path = "stream_browser.rs"]
mod browser;

const NATIVE_EVENT_LIMIT: usize = 256 * 1024;
// A storage event includes the UI state owner, which can hold 1 MiB of Stats.
const OWNER_EVENT_LIMIT: usize = 2 * 1024 * 1024;

fn storage_owner(value: &Value) -> Option<crate::settings::Owner> {
    if !matches!(value["owner"].as_str(), Some("ui" | "*")) {
        return None;
    }
    match value["type"].as_str()? {
        "storage.configChanged" => Some(crate::settings::Owner::Config),
        "storage.stateChanged" => Some(crate::settings::Owner::State),
        _ => None,
    }
}

#[derive(Default)]
pub struct State {
    pub cancelled: AtomicBool,
    pub version: AtomicU64,
    pub alive: AtomicBool,
    pub running: AtomicBool,
    pub upstream: AtomicBool,
    preferences: Option<(Sender<crate::transport::Event>, crate::Wake)>,
    catalogue: Option<Arc<catalogue::Signals>>,
    placement: Option<(Sender<()>, crate::Receiver<()>)>,
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn owner_changes_invalidate_the_intended_consumers_without_recovering_history() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            let (out, recovery) = crate::bounded(4);
            let (send, events) = crate::bounded(4);
            let state = State::observing_preferences(send, Arc::new(|| {}));
            opened(1, &out, &state).await.unwrap();
            assert!(matches!(recovery.try_recv().unwrap(), Input::Opened(1)));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let stamp = state.version.load(SeqCst);
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                r#"{"owner":"ui","type":"storage.stateChanged","value":{}}"#,
            )
            .await
            .unwrap();
            assert!(recovery.is_empty() && state.valid(stamp));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::State)
            ));
            let data = json!({"owner":"ui","type":"storage.configChanged",
                              "value":{"padding":"x".repeat(NATIVE_EVENT_LIMIT)}});
            dispatch(
                &backend,
                1,
                &out,
                &state,
                "integration-test",
                "message",
                &data.to_string(),
            )
            .await
            .unwrap();
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Preferences(crate::settings::Owner::Config)
            ));
            assert!(matches!(
                events.try_recv().unwrap(),
                crate::transport::Event::Workspace(WorkspaceEvent::UiPreferencesChanged)
            ));
            assert!(events.is_empty() && recovery.is_empty() && state.valid(stamp));
        });
}
impl State {
    pub(crate) fn observing_preferences(
        out: Sender<crate::transport::Event>,
        wake: crate::Wake,
    ) -> Self {
        Self {
            preferences: Some((out, wake)),
            placement: Some(crate::bounded(1)),
            ..Self::default()
        }
    }

    pub(crate) async fn placement_changed(&self) {
        if let Some((_, changed)) = &self.placement {
            let _ = changed.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    }

    async fn notify_preferences(
        &self,
        owner: crate::settings::Owner,
        out: &Sender<Input>,
    ) -> Result<()> {
        if let Some((events, wake)) = &self.preferences {
            crate::transport::publish(events, wake, crate::transport::Event::Preferences(owner))
                .await;
        } else {
            out.send(Input::Preferences(owner)).await?;
        }
        Ok(())
    }

    async fn storage_changed(
        &self,
        epoch: u64,
        owner: crate::settings::Owner,
        out: &Sender<Input>,
    ) -> Result<()> {
        self.notify_preferences(owner, out).await?;
        if owner == crate::settings::Owner::Config {
            let event = WorkspaceEvent::UiPreferencesChanged;
            if let Some((events, wake)) = &self.preferences {
                crate::transport::publish(events, wake, crate::transport::Event::Workspace(event))
                    .await;
            } else {
                out.send(Input::Workspace(epoch, event)).await?;
            }
        }
        Ok(())
    }
    pub fn valid(&self, version: u64) -> bool {
        self.version.load(SeqCst) == version
            && self.alive.load(SeqCst)
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn a_matching_move_cancels_the_body_before_waiting_for_queue_space() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            backend.workspace = "project".into();
            backend.session = "session".into();
            let (out, inbox) = crate::bounded(1);
            let (events, _receiver) = crate::bounded(1);
            let state = State::observing_preferences(events, Arc::new(|| {}));
            out.try_send(Input::Opened(1)).ok().unwrap();
            let move_event = json!({"type":"instance.event","instanceId":"project","event":{
                "type":"session.moved","data":{"sessionID":"session"}
            }});
            let payload = move_event.to_string();
            let mut dispatch_move = std::pin::pin!(dispatch(
                &backend, 1, &out, &state, "stream", "message", &payload
            ));
            assert!(
                futures_lite::future::poll_once(&mut dispatch_move)
                    .await
                    .is_none()
            );
            assert!(
                futures_lite::future::poll_once(state.placement_changed())
                    .await
                    .is_some()
            );
            assert!(matches!(inbox.try_recv().unwrap(), Input::Opened(1)));
            dispatch_move.await.unwrap();
            assert!(matches!(inbox.try_recv().unwrap(), Input::Native(1, _, _)));
        });
}

pub fn start(backend: Backend, epoch: u64, out: Sender<Input>, state: Arc<State>) {
    state.running.store(true, SeqCst);
    runtime::spawn(async move {
        let result = read(&backend, epoch, &out, &state).await;
        state.alive.store(false, SeqCst);
        state.running.store(false, SeqCst);
        state.version.fetch_add(1, SeqCst);
        let expired = result
            .as_ref()
            .is_err_and(crate::http::authentication_expired);
        if result.is_err() {
            eprintln!("Rune event stream unavailable");
        }
        let _ = out
            .send(if expired {
                Input::AuthenticationRequired(epoch)
            } else {
                Input::Closed(epoch)
            })
            .await;
        if let Some(wake) = state.preferences.as_ref().map(|(_, wake)| wake.clone()) {
            drop(state);
            wake();
        }
    });
}

pub(crate) async fn read(
    backend: &Backend,
    epoch: u64,
    out: &Sender<Input>,
    state: &State,
) -> Result<()> {
    #[cfg(not(target_arch = "wasm32"))]
    return futures_lite::future::race(read_native(backend, epoch, out, state), async {
        while !state.cancelled.load(SeqCst) && !out.is_closed() {
            runtime::sleep(Duration::from_millis(25)).await;
        }
        Ok(())
    })
    .await;
    #[cfg(target_arch = "wasm32")]
    browser::read(backend, epoch, out, state).await
}

pub(super) async fn opened(epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    if let Some(signals) = &state.catalogue {
        signals.reconnected();
    }
    state.alive.store(true, SeqCst);
    state.upstream.store(true, SeqCst);
    out.send(Input::Opened(epoch)).await?;
    if state.preferences.is_some() {
        state
            .notify_preferences(crate::settings::Owner::Config, out)
            .await?;
        state
            .notify_preferences(crate::settings::Owner::State, out)
            .await?;
    }
    Ok(())
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
    if data.len() > OWNER_EVENT_LIMIT {
        return Err("oversized SSE event".into());
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
        if data.len() > NATIVE_EVENT_LIMIT && storage_owner(&value).is_none() {
            return Err("oversized SSE event".into());
        }
        signals.observe(&value);
        return Ok(());
    }
    if let Some(owner) = storage_owner(&value) {
        return state.storage_changed(epoch, owner, out).await;
    }
    if data.len() > NATIVE_EVENT_LIMIT {
        return Err("oversized SSE event".into());
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
    let own = value["instanceId"] == b.workspace;
    let native = &value["event"];
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
            && let Some(event) = session_attention(native, &b.session)
        {
            out.send(Input::Workspace(epoch, event)).await?;
        }
        let version = state.version.fetch_add(1, SeqCst) + 1;
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

fn session_attention(event: &Value, session: &str) -> Option<WorkspaceEvent> {
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

fn workspace_event(b: &Backend, value: &Value) -> Option<WorkspaceEvent> {
    let id = value["workspaceId"].as_str()?;
    if id != b.workspace || !crate::history::valid_id(id) {
        return None;
    }
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

#[cfg(not(target_arch = "wasm32"))]
async fn read_native(b: &Backend, epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    use futures_lite::StreamExt;
    let connection = format!("stream-{epoch}");
    let response = b
        .client
        .get(format!("{}api/events", b.base))
        .query(&[
            ("clientId", b.client_id.as_str()),
            ("connectionId", connection.as_str()),
            ("userFiles", crate::attachments::USER_FILES_REFERENCE),
        ])
        .timeout(Duration::from_secs(86400))
        .send()
        .await?
        .error_for_status()?;
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.starts_with("text/event-stream"))
    {
        return Err("expected event stream".into());
    }
    opened(epoch, out, state).await?;
    let mut chunks = response.bytes_stream();
    let mut parser = Parser::default();
    while let Some(chunk) = chunks.next().await {
        for byte in chunk? {
            if let Some((kind, data)) = parser.byte(byte)? {
                dispatch(b, epoch, out, state, &connection, &kind, &data).await?;
            }
        }
    }
    Err("event stream ended".into())
}

#[cfg(any(not(target_arch = "wasm32"), test))]
#[derive(Default)]
struct Parser {
    line: Vec<u8>,
    data: String,
    kind: String,
}
#[cfg(any(not(target_arch = "wasm32"), test))]
impl Parser {
    fn byte(&mut self, byte: u8) -> Result<Option<(String, String)>> {
        if byte != b'\n' {
            if self.line.len() >= OWNER_EVENT_LIMIT + b"data: ".len() {
                return Err("oversized SSE line".into());
            }
            self.line.push(byte);
            return Ok(None);
        }
        let bytes = std::mem::take(&mut self.line);
        let line = std::str::from_utf8(&bytes)?.trim_end_matches('\r');
        if line.is_empty() {
            return Ok(Some((
                std::mem::take(&mut self.kind),
                std::mem::take(&mut self.data),
            )));
        }
        if let Some(kind) = line.strip_prefix("event:") {
            self.kind = kind.trim().into();
        } else if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            if self.data.len() + data.len() + 1 > OWNER_EVENT_LIMIT {
                return Err("oversized SSE event".into());
            }
            self.data.push_str(data);
            self.data.push('\n');
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_unicode_crlf_and_multiline_event_preserve_named_ping_and_data() {
        let mut parser = Parser::default();
        let input = "event: codenomad.client.ping\r\ndata: été 🦀\r\ndata: next\r\n\r\n";
        let frames = input
            .bytes()
            .filter_map(|b| parser.byte(b).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            frames,
            [("codenomad.client.ping".into(), "été 🦀\nnext\n".into())]
        );
    }
    #[test]
    fn oversized_line_and_event_fail_before_unbounded_growth() {
        let mut parser = Parser::default();
        for _ in 0..OWNER_EVENT_LIMIT + b"data: ".len() {
            parser.byte(b'x').unwrap();
        }
        assert!(parser.byte(b'x').is_err());
        let mut parser = Parser {
            data: "x".repeat(OWNER_EVENT_LIMIT),
            ..Default::default()
        };
        for b in b"data: x" {
            parser.byte(*b).unwrap();
        }
        assert!(parser.byte(b'\n').is_err());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn large_owner_invalidation_does_not_close_the_conversation_stream() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            let (out, recovery) = crate::bounded(4);
            let state = State::default();
            let body = json!({"owner":"ui","type":"storage.stateChanged","value":{"serviceUsage":"x".repeat(1024*1024)}}).to_string();
            let mut parser = Parser::default();
            let wire = format!("data: {body}\n\ndata: {{\"type\":\"ignored\"}}\n\n");
            for (kind, data) in wire.bytes().filter_map(|byte| parser.byte(byte).unwrap()) {
                dispatch(&backend, 1, &out, &state, "test", &kind, &data).await.unwrap();
            }
            assert!(matches!(recovery.try_recv(), Ok(Input::Preferences(crate::settings::Owner::State))));
            assert!(recovery.is_empty());
            let foreign = json!({"type":"instance.event","value":"x".repeat(NATIVE_EVENT_LIMIT)}).to_string();
            assert!(dispatch(&backend, 1, &out, &state, "test", "", &foreign).await.is_err());
        });
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "stream_workspace_tests.rs"]
mod workspace_tests;
