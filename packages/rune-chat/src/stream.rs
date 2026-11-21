use crate::{backend::Backend, history::Result, recovery::Input};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
        mpsc::SyncSender,
    },
    time::Duration,
};
#[derive(Default)]
pub struct State {
    pub cancelled: AtomicBool,
    pub version: AtomicU64,
    pub alive: AtomicBool,
    pub upstream: AtomicBool,
}
impl State {
    pub fn valid(&self, version: u64) -> bool {
        self.version.load(SeqCst) == version
            && self.alive.load(SeqCst)
            && self.upstream.load(SeqCst)
    }
}
pub fn start(backend: Backend, epoch: u64, out: SyncSender<Input>, state: Arc<State>) {
    std::thread::spawn(move || {
        let result = read(&backend, epoch, &out, &state);
        state.alive.store(false, SeqCst);
        state.version.fetch_add(1, SeqCst);
        if let Err(error) = result {
            eprintln!("Rune stream: {error}");
        }
        let _ = out.send(Input::Closed(epoch));
    });
}
fn read(b: &Backend, epoch: u64, out: &SyncSender<Input>, state: &State) -> Result<()> {
    let connection = format!("stream-{epoch}");
    let response = b
        .client
        .get(format!("{}api/events", b.base))
        .query(&[("clientId", &b.client_id), ("connectionId", &connection)])
        .timeout(Duration::from_secs(86400))
        .send()?
        .error_for_status()?;
    state.alive.store(true, SeqCst);
    state.upstream.store(true, SeqCst);
    out.send(Input::Opened(epoch))?;
    let mut reader = BufReader::new(response);
    let (mut line, mut data, mut kind) = (String::new(), String::new(), String::new());
    loop {
        line.clear();
        if reader.by_ref().take(262145).read_line(&mut line)? == 0 {
            return Err("event stream ended".into());
        }
        if line.len() > 262144 {
            return Err("oversized SSE line".into());
        }
        if state.cancelled.load(SeqCst) {
            return Ok(());
        }
        if line.trim().is_empty() {
            if kind == "codenomad.client.ping" {
                b.client
                    .post(format!("{}api/client-connections/pong", b.base))
                    .json(&json!({"clientId":b.client_id,"connectionId":connection}))
                    .send()?
                    .error_for_status()?;
            } else if !data.is_empty() {
                let value: Value = serde_json::from_str(data.trim())?;
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
                    })?;
                } else if own && value["type"] == "instance.dataChanged" {
                    let version = state.version.fetch_add(1, SeqCst) + 1;
                    out.send(Input::Hint(epoch, version))?;
                } else if own
                    && value["type"] == "instance.event"
                    && (native["data"]["sessionID"] == b.session
                        || native["type"] == "server.connected")
                {
                    let version = state.version.fetch_add(1, SeqCst) + 1;
                    out.send(Input::Native(epoch, version, native.clone()))?;
                }
            }
            data.clear();
            kind.clear();
        } else if let Some(value) = line.strip_prefix("event:") {
            kind = value.trim().into();
        } else if let Some(value) = line.strip_prefix("data:") {
            if data.len() + value.len() + 1 > 262144 {
                return Err("oversized SSE event".into());
            }
            data.push_str(value);
            data.push('\n');
        }
    }
}
