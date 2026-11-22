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
pub use catalogue::{CatalogueChanges, CatalogueWatch};
#[cfg(target_arch = "wasm32")]
#[path = "stream_browser.rs"]
mod browser;

#[derive(Default)]
pub struct State {
    pub cancelled: AtomicBool,
    pub version: AtomicU64,
    pub alive: AtomicBool,
    pub upstream: AtomicBool,
    catalogue: Option<Arc<catalogue::Signals>>,
}
impl State {
    pub fn valid(&self, version: u64) -> bool {
        self.version.load(SeqCst) == version
            && self.alive.load(SeqCst)
            && self.upstream.load(SeqCst)
            && !self.cancelled.load(SeqCst)
    }
}
pub fn start(backend: Backend, epoch: u64, out: Sender<Input>, state: Arc<State>) {
    runtime::spawn(async move {
        #[cfg(not(target_arch = "wasm32"))]
        let result =
            futures_lite::future::race(read_native(&backend, epoch, &out, &state), async {
                while !state.cancelled.load(SeqCst) && !out.is_closed() {
                    runtime::sleep(Duration::from_millis(25)).await;
                }
                Ok(())
            })
            .await;
        #[cfg(target_arch = "wasm32")]
        let result = browser::read(&backend, epoch, &out, &state).await;
        state.alive.store(false, SeqCst);
        state.version.fetch_add(1, SeqCst);
        if result.is_err() {
            eprintln!("Rune event stream unavailable");
        }
        let _ = out.send(Input::Closed(epoch)).await;
    });
}

pub(super) async fn opened(epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    if let Some(signals) = &state.catalogue {
        signals.invalidate(None);
    }
    state.alive.store(true, SeqCst);
    state.upstream.store(true, SeqCst);
    out.send(Input::Opened(epoch)).await?;
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
    if data.len() > 262144 {
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
        signals.observe(&value);
        return Ok(());
    }
    if let Some(event) = workspace_event(b, &value) {
        out.send(Input::Workspace(epoch, event)).await?;
        return Ok(());
    }
    let own = value["instanceId"] == b.workspace;
    let native = &value["event"];
    if own && value["type"] == "instance.eventStatus" {
        let ready = value["status"] == "connected";
        state.upstream.store(ready, SeqCst);
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(if ready {
            Input::Hint(epoch, version)
        } else {
            Input::Unavailable(epoch)
        })
        .await?;
    } else if own && value["type"] == "instance.dataChanged" {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(Input::Hint(epoch, version)).await?;
    } else if own
        && value["type"] == "instance.event"
        && (native["data"]["sessionID"] == b.session
            || native["data"]["form"]["sessionID"] == b.session
            || native["type"] == "server.connected")
    {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(Input::Native(epoch, version, native.clone()))
            .await?;
    }
    Ok(())
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
        .query(&[("clientId", &b.client_id), ("connectionId", &connection)])
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
            if self.line.len() >= 262144 {
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
            if self.data.len() + data.len() + 1 > 262144 {
                return Err("oversized SSE event".into());
            }
            self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
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
        for _ in 0..262144 {
            parser.byte(b'x').unwrap();
        }
        assert!(parser.byte(b'x').is_err());
        let mut parser = Parser {
            data: "x".repeat(262144),
            ..Default::default()
        };
        for b in b"data: x" {
            parser.byte(*b).unwrap();
        }
        assert!(parser.byte(b'\n').is_err());
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "stream_workspace_tests.rs"]
mod workspace_tests;
