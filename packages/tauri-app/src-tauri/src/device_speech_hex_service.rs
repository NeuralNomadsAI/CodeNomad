use crate::{device_speech::SpeechError, device_speech_worker::OwnedChild};
use parking_lot::{Condvar, Mutex, MutexGuard};
use serde::Deserialize;
use std::{
    fs,
    io::{self, BufRead, BufReader, Read},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[path = "device_speech_hex_http.rs"]
mod http;
use http::{await_reply, Endpoint, RejectProxy};
#[path = "device_speech_hex_files.rs"]
mod files;
use files::Snapshot;

const IDLE: Duration = Duration::from_secs(180);
const STARTUP: Duration = Duration::from_secs(10);
const PREWARM: Duration = Duration::from_secs(120);
const WATCH: Duration = Duration::from_secs(1);
// Hex loads on transcription, not /health. This sample needs no microphone or downloads.
const SILENCE: &[u8] = b"RIFF\x26\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\x00\x7d\0\0\x02\0\x10\0data\x02\0\0\0\0\0";

#[derive(Deserialize)]
pub(super) struct Installation {
    executable: PathBuf,
    support: PathBuf,
    key: String,
    version: String,
    model: String,
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    #[cfg(test)]
    #[serde(skip)]
    args: Option<Vec<PathBuf>>,
}

#[derive(Default)]
pub(super) struct HexService {
    state: Arc<State>,
}

#[derive(Default)]
struct State {
    instance: Mutex<Option<Instance>>,
    changed: Condvar,
    generation: AtomicU64,
}

impl State {
    fn retire(&self, state: &mut MutexGuard<'_, Option<Instance>>) {
        let id = state.as_ref().map(|entry| entry.id);
        // Give the synthetic request a brief drain window before forcing a
        // Windows GPU load to stop. Leave Hex's crash guard intact.
        let stop = Instant::now() + Duration::from_secs(2);
        while cfg!(windows) {
            let Some(deadline) = state
                .as_ref()
                .filter(|entry| Some(entry.id) == id)
                .and_then(|entry| entry.warming_until)
            else {
                break;
            };
            let delay = deadline.min(stop).saturating_duration_since(Instant::now());
            if delay.is_zero() {
                break;
            }
            self.changed.wait_for(state, delay);
        }
        if state.as_ref().map(|entry| entry.id) == id {
            state.take();
        }
        self.changed.notify_all();
    }
}

impl HexService {
    pub(super) fn stop(&self) {
        self.request_stop();
        self.state.retire(&mut self.state.instance.lock());
    }

    pub(super) fn request_stop(&self) {
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        self.state.changed.notify_all();
    }

    pub(super) fn dictate(
        &self,
        installation: Installation,
        selected: impl Fn() -> bool + Send + Sync + 'static,
        cancelled: impl Fn() -> bool,
        audio: impl FnOnce(&dyn Fn() -> bool) -> Option<Vec<u8>>,
    ) -> Result<String, SpeechError> {
        self.run(installation, selected, cancelled, audio, IDLE)
    }

    fn run(
        &self,
        mut installation: Installation,
        selected: impl Fn() -> bool + Send + Sync + 'static,
        cancelled: impl Fn() -> bool,
        audio: impl FnOnce(&dyn Fn() -> bool) -> Option<Vec<u8>>,
        idle: Duration,
    ) -> Result<String, SpeechError> {
        let snapshot = Snapshot::read(
            std::mem::take(&mut installation.directories),
            std::mem::take(&mut installation.files),
        )
        .map_err(|_| {
            self.stop();
            SpeechError::Unavailable
        })?;
        let version = installation.version.clone();
        let (id, generation, starting) = {
            let mut state = self.state.instance.lock();
            let generation = self.state.generation.load(Ordering::Acquire);
            if !selected() || cancelled() {
                return Err(SpeechError::Failed);
            }
            if state.as_mut().is_some_and(|entry| {
                entry.generation != generation || entry.key != installation.key || entry.expired()
            }) {
                self.state.retire(&mut state);
            }
            if !selected()
                || cancelled()
                || generation != self.state.generation.load(Ordering::Acquire)
            {
                return Err(SpeechError::Failed);
            }
            if let Some(entry) = state.as_mut() {
                entry.idle = None;
                (entry.id, generation, None)
            } else {
                let (entry, ready) = Instance::start(installation, generation)?;
                let id = entry.id;
                *state = Some(entry);
                (id, generation, Some(ready))
            }
        };
        let selected = Arc::new(selected);
        if let Some(ready) = starting {
            self.watch(id, selected.clone());
            self.prewarm(id, ready, version);
        }
        let interrupted = || {
            cancelled()
                || self.state.generation.load(Ordering::Acquire) != generation
                || self
                    .state
                    .instance
                    .lock()
                    .as_ref()
                    .is_none_or(|entry| entry.id != id)
        };
        let mut uploaded = false;
        let result = (|| {
            let wav = audio(&interrupted).ok_or(SpeechError::Failed)?;
            let endpoint = self.await_warm(id, &cancelled)?;
            if !selected() || interrupted() {
                return Err(SpeechError::Failed);
            }
            if !snapshot.unchanged() {
                return Err(SpeechError::Unavailable);
            }
            uploaded = true;
            endpoint.transcribe(wav, &interrupted, Duration::from_secs(150))
        })();
        let cancelled = cancelled();
        let mut state = self.state.instance.lock();
        let Some(entry) = state.as_mut().filter(|entry| entry.id == id) else {
            return Err(SpeechError::Failed);
        };
        if self.state.generation.load(Ordering::Acquire) == generation
            && selected()
            && (result.is_ok() && !cancelled || cancelled && !uploaded)
        {
            // Cancellation before upload abandons only the capture. Interrupting
            // Hex's synthetic GPU load would look like a driver crash to Hex.
            entry.idle = Some(Instant::now() + idle);
        } else {
            self.state.retire(&mut state);
        }
        self.state.changed.notify_all();
        if cancelled || !selected() || self.state.generation.load(Ordering::Acquire) != generation {
            Err(SpeechError::Failed)
        } else {
            result
        }
    }

    fn await_warm(&self, id: Uuid, cancelled: &impl Fn() -> bool) -> Result<Endpoint, SpeechError> {
        let mut state = self.state.instance.lock();
        while let Some(entry) = state.as_ref().filter(|entry| entry.id == id) {
            if cancelled() || self.state.generation.load(Ordering::Acquire) != entry.generation {
                break;
            }
            if let Some(endpoint) = &entry.endpoint {
                return Ok(endpoint.clone());
            }
            self.state
                .changed
                .wait_for(&mut state, Duration::from_millis(25));
        }
        Err(SpeechError::Failed)
    }

    fn prewarm(&self, id: Uuid, ready: Receiver<Result<Endpoint, SpeechError>>, version: String) {
        let shared = self.state.clone();
        thread::spawn(move || {
            let interrupted = || {
                shared
                    .instance
                    .lock()
                    .as_ref()
                    .is_none_or(|entry| entry.id != id)
            };
            let result = (|| {
                let expires = Instant::now() + STARTUP;
                let endpoint = await_reply(ready, &interrupted, expires)?;
                endpoint.health(&version, &interrupted, expires)?;
                {
                    let mut state = shared.instance.lock();
                    let entry = state
                        .as_mut()
                        .filter(|entry| {
                            entry.id == id
                                && entry.generation == shared.generation.load(Ordering::Acquire)
                        })
                        .ok_or(SpeechError::Failed)?;
                    entry.warming_until = Some(Instant::now() + PREWARM);
                }
                endpoint.transcribe(SILENCE.to_vec(), &interrupted, PREWARM)?;
                Ok::<_, SpeechError>(endpoint)
            })();
            let mut state = shared.instance.lock();
            if let Some(entry) = state.as_mut().filter(|entry| entry.id == id) {
                entry.warming_until = None;
                match result {
                    Ok(endpoint) => entry.endpoint = Some(endpoint),
                    Err(_) => {
                        state.take();
                    }
                }
                shared.changed.notify_all();
            }
        });
    }

    fn watch(&self, id: Uuid, selected: Arc<impl Fn() -> bool + Send + Sync + 'static>) {
        let shared = self.state.clone();
        thread::spawn(move || {
            let mut state = shared.instance.lock();
            while let Some(entry) = state.as_mut().filter(|entry| entry.id == id) {
                if shared.generation.load(Ordering::Acquire) != entry.generation
                    || !selected()
                    || entry.expired()
                {
                    shared.retire(&mut state);
                    return;
                }
                let delay = entry.idle.map_or(WATCH, |deadline| {
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(WATCH)
                });
                shared.changed.wait_for(&mut state, delay);
            }
        });
    }
}

impl Drop for HexService {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Instance {
    id: Uuid,
    generation: u64,
    key: String,
    process: Option<OwnedChild>,
    log: PathBuf,
    _proxy: RejectProxy,
    endpoint: Option<Endpoint>,
    idle: Option<Instant>,
    warming_until: Option<Instant>,
}

impl Instance {
    fn expired(&mut self) -> bool {
        self.idle.is_some_and(|deadline| Instant::now() >= deadline)
            || self.process.as_mut().is_some_and(OwnedChild::finished)
    }

    fn start(
        install: Installation,
        generation: u64,
    ) -> Result<(Self, Receiver<Result<Endpoint, SpeechError>>), SpeechError> {
        let proxy = RejectProxy::start()?;
        let address = format!("http://{}", proxy.addr);
        let mut command = Command::new(&install.executable);
        #[cfg(test)]
        let args = install
            .args
            .unwrap_or_else(|| vec!["service".into(), "--embedded".into()]);
        #[cfg(not(test))]
        let args = ["service", "--embedded"];
        command
            .args(args)
            .current_dir(install.executable.parent().ok_or(SpeechError::Failed)?)
            .env_clear()
            .envs(
                [
                    "HOME",
                    "USERPROFILE",
                    "SYSTEMROOT",
                    "WINDIR",
                    "SystemDrive",
                    "TEMP",
                    "TMP",
                    "TMPDIR",
                ]
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
            )
            .env("HEX_APPLICATION_SUPPORT_DIR", &install.support)
            .env("HTTPS_PROXY", &address)
            .env("HTTP_PROXY", &address)
            .env("ALL_PROXY", &address)
            .env("RUST_LOG", "error");
        let mut process = OwnedChild::start(command)?;
        let pid = process.child.id();
        let stdout = process.child.stdout.take().ok_or(SpeechError::Failed)?;
        let (send, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let mut line = Vec::new();
            let ready = match (&mut stdout).take(2049).read_until(b'\n', &mut line) {
                Ok(_) if line.last() == Some(&b'\n') => {
                    Endpoint::from_ready(&line, pid, install.model)
                }
                _ => Err(SpeechError::Failed),
            };
            let _ = send.send(ready);
            let _ = io::copy(&mut stdout, &mut io::sink());
        });
        Ok((
            Self {
                id: Uuid::new_v4(),
                generation,
                key: install.key,
                process: Some(process),
                log: install
                    .support
                    .join("logs")
                    .join(format!("embedded-{pid}.ndjson")),
                _proxy: proxy,
                endpoint: None,
                idle: None,
                warming_until: None,
            },
            receive,
        ))
    }
}

#[cfg(test)]
#[path = "device_speech_hex_service_tests.rs"]
mod tests;

impl Drop for Instance {
    fn drop(&mut self) {
        drop(self.process.take());
        if self
            .log
            .parent()
            .and_then(|p| p.symlink_metadata().ok())
            .is_some_and(|m| m.file_type().is_dir())
        {
            let _ = fs::remove_file(&self.log);
        }
    }
}
