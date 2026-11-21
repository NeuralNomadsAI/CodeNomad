use crate::device_speech_hex::{decode_wav, valid_audio_encoding, HexDriver};
#[cfg(target_os = "linux")]
use crate::device_speech_ipc::remote_microphone::RemoteMicrophone;
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[path = "device_speech_preference.rs"]
mod preference;
use preference::Store;
#[cfg(target_os = "linux")]
#[path = "device_speech_microphone.rs"]
mod microphone;

const LEASE: Duration = Duration::from_secs(30);
const MAX_TEXT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Engine {
    Api,
    Hex,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechError {
    Unavailable,
    Busy,
    NotOwned,
    PlanChanged,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MicrophonePurpose {
    Dictation,
    Test,
    Conversation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Request {
    Read {},
    Select {
        engine: Engine,
    },
    Prepare {
        #[serde(rename = "planId")]
        plan_id: String,
    },
    Start {
        locale: String,
        #[serde(default, deserialize_with = "provided")]
        engine: Option<Engine>,
        #[serde(rename = "microphoneLeaseId", default, deserialize_with = "provided")]
        microphone_lease_id: Option<String>,
    },
    ClaimMicrophone {
        id: String,
        purpose: MicrophonePurpose,
    },
    ReleaseMicrophone {
        id: String,
    },
    Status {
        id: String,
    },
    Finish {
        id: String,
        wav: String,
    },
    Cancel {
        id: String,
    },
    #[cfg(target_os = "linux")]
    AuthorizeApiMicrophone {
        id: String,
    },
    #[cfg(target_os = "linux")]
    RevokeApiMicrophone {
        id: String,
    },
}

fn provided<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

impl Request {
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Prepare { plan_id } => valid_plan_id(plan_id),
            Self::Start {
                locale,
                engine,
                microphone_lease_id,
            } => {
                valid_locale(locale)
                    && *engine != Some(Engine::Api)
                    && microphone_lease_id
                        .as_deref()
                        .is_none_or(|id| engine.is_some() && microphone_id(id).is_some())
            }
            Self::ClaimMicrophone { id, .. } | Self::ReleaseMicrophone { id } => {
                microphone_id(id).is_some()
            }
            Self::Finish { id, wav } => valid_id(id) && valid_audio_encoding(wav),
            Self::Status { id } | Self::Cancel { id } => valid_id(id),
            #[cfg(target_os = "linux")]
            Self::AuthorizeApiMicrophone { id } | Self::RevokeApiMicrophone { id } => valid_id(id),
            _ => true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HexComponent {
    Engine,
    Model,
    Vad,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Missing {
    pub(crate) component: HexComponent,
    pub(crate) download_bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Plan {
    pub(crate) id: String,
    pub(crate) missing: Vec<Missing>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Hex {
    Unavailable,
    Ready { plan: Plan },
    NeedsPreparation { plan: Plan },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Operation {
    Starting,
    Recording,
    Transcribing,
    Verifying,
    Downloading {
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
    },
    Stopping,
    Prepared,
    Cancelled,
    Transcribed {
        text: String,
    },
    Error {
        error: SpeechError,
    },
}

impl Operation {
    fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Prepared | Self::Cancelled | Self::Transcribed { .. } | Self::Error { .. }
        )
    }
}

pub(crate) trait Driver: Send + Sync {
    /// Bounded read-only discovery. The plan id binds components, retained bytes and approved sources.
    fn capabilities(&self) -> Hex;
    fn prepare(&self, plan: Plan, control: Control) -> Result<(), SpeechError>;
    /// Return only after inference has stopped.
    fn dictate(&self, control: Control) -> Result<String, SpeechError>;
}

#[derive(Clone)]
pub(crate) struct Control(Arc<(Mutex<Slot>, Condvar)>);

impl Control {
    pub(crate) fn cancelled(&self) -> bool {
        self.0 .0.lock().cancelled
    }

    pub(crate) fn wait_for_audio(&self) -> Option<Vec<u8>> {
        let (lock, wake) = &*self.0;
        let mut slot = lock.lock();
        while !slot.cancelled && !slot.finish {
            wake.wait_for(&mut slot, Duration::from_millis(100));
        }
        if slot.cancelled {
            None
        } else {
            slot.audio.take()
        }
    }

    pub(crate) fn progress(&self, value: Operation) {
        let mut slot = self.0 .0.lock();
        if !slot.cancelled
            && !slot.state.terminal()
            && matches!(
                (slot.kind, &value),
                (
                    Kind::Prepare,
                    Operation::Downloading { .. } | Operation::Verifying
                ) | (
                    Kind::Dictation,
                    Operation::Recording | Operation::Transcribing
                )
            )
            && !(slot.finish && matches!(value, Operation::Recording))
        {
            slot.state = value;
        }
    }

    fn monitor(&self) {
        let (lock, wake) = &*self.0;
        let mut slot = lock.lock();
        loop {
            let now = Instant::now();
            if slot.state.terminal() {
                if slot.owner.is_none() || now >= slot.expires {
                    slot.forget();
                    return;
                }
                let remaining = slot.expires - now;
                wake.wait_for(&mut slot, remaining);
            } else if slot.cancelled {
                wake.wait(&mut slot);
            } else if now >= slot.deadline {
                slot.cancel(Some(SpeechError::Failed));
            } else if now >= slot.expires {
                slot.cancel(None);
            } else {
                let remaining = slot.deadline.min(slot.expires) - now;
                wake.wait_for(&mut slot, remaining);
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Prepare = 0,
    Dictation = 1,
}

struct Slot {
    owner: Option<String>,
    id: String,
    kind: Kind,
    state: Operation,
    expires: Instant,
    deadline: Instant,
    finish: bool,
    audio: Option<Vec<u8>>,
    #[cfg(target_os = "linux")]
    microphone_claimed: bool,
    cancelled: bool,
    reason: Option<SpeechError>,
}

impl Slot {
    fn forget(&mut self) {
        self.owner = None;
        self.state = Operation::Cancelled;
    }

    fn cancel(&mut self, reason: Option<SpeechError>) {
        if !self.cancelled && !self.state.terminal() {
            self.cancelled = true;
            self.reason = reason;
            self.state = Operation::Stopping;
            self.audio = None;
        }
    }
}

struct MicrophoneLease {
    owner: String,
    id: Uuid,
    purpose: MicrophonePurpose,
    expires_at: Option<Instant>,
}

impl MicrophoneLease {
    fn matches(&self, owner: &str, id: Option<Uuid>, purpose: MicrophonePurpose) -> bool {
        self.owner == owner && Some(self.id) == id && self.purpose == purpose
    }
}

// Admission holds this mutex before reading the native operation/recorder phases
// or issuing a WebKit permit. Drivers publish closure through their own phase lock.
#[derive(Default)]
struct Slots {
    operations: [Option<Control>; 2],
    microphone: Option<MicrophoneLease>,
}

impl Slots {
    fn expire_microphone(&mut self, now: Instant) {
        if self
            .microphone
            .as_ref()
            .and_then(|lease| lease.expires_at)
            .is_some_and(|expires| now >= expires)
        {
            self.microphone = None;
        }
    }

    fn active(&self, kind: Kind) -> bool {
        self.operations[kind as usize]
            .as_ref()
            .is_some_and(|entry| !entry.0 .0.lock().state.terminal())
    }
}

pub(crate) struct DeviceSpeech {
    store: Store,
    hex: Option<Arc<dyn Driver>>,
    slots: Mutex<Slots>,
    #[cfg(target_os = "linux")]
    api_microphone: microphone::ApiMicrophone,
    #[cfg(target_os = "linux")]
    remote_microphone: RemoteMicrophone,
}

impl DeviceSpeech {
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn authorize_remote_renderer_microphone(&self, owner: &str) -> bool {
        let mut slots = self.slots.lock();
        slots.expire_microphone(Instant::now());
        if let Some(lease) = slots
            .microphone
            .as_mut()
            .filter(|lease| lease.owner == owner)
        {
            lease.expires_at = None;
            return true;
        }
        false
    }

    pub(crate) fn new(path: PathBuf, hex: Option<Arc<dyn Driver>>) -> Self {
        Self {
            store: Store(path),
            hex,
            slots: Mutex::default(),
            #[cfg(target_os = "linux")]
            api_microphone: Default::default(),
            #[cfg(target_os = "linux")]
            remote_microphone: Default::default(),
        }
    }

    pub(crate) fn with_hex(mut self, root: PathBuf) -> Self {
        self.hex = Some(Arc::new(HexDriver::new(root)));
        self
    }

    fn native_microphone_busy(&self, slots: &Slots) -> Option<MicrophonePurpose> {
        if slots.active(Kind::Dictation) {
            return Some(MicrophonePurpose::Dictation);
        }
        #[cfg(target_os = "linux")]
        if let Some(purpose) = self.remote_microphone.busy() {
            return Some(purpose.microphone_purpose());
        }
        None
    }

    fn capabilities(&self) -> Hex {
        self.hex
            .as_ref()
            .map_or(Hex::Unavailable, |hex| hex.capabilities())
    }

    pub(crate) fn preferred_engine(&self) -> Result<Option<Engine>, SpeechError> {
        self.store.read().map(|preference| preference.engine)
    }

    pub(crate) fn request(&self, owner: &str, input: Request) -> Result<Value, SpeechError> {
        self.request_with_microphone_scope(owner, input, false)
    }

    pub(crate) fn request_remote(&self, owner: &str, input: Request) -> Result<Value, SpeechError> {
        self.request_with_microphone_scope(owner, input, true)
    }

    fn request_with_microphone_scope(
        &self,
        owner: &str,
        input: Request,
        remote: bool,
    ) -> Result<Value, SpeechError> {
        let mut slots = self.slots.lock();
        let now = Instant::now();
        slots.expire_microphone(now);
        for entry in &mut slots.operations {
            let expired = entry.as_ref().is_some_and(|entry| {
                let slot = entry.0 .0.lock();
                slot.state.terminal() && slot.expires <= Instant::now()
            });
            if expired {
                entry.take();
            }
        }
        let snapshot = |engine, hex| json!({ "engine": engine, "hex": hex });
        match input {
            Request::ClaimMicrophone { id, purpose } => {
                let id = microphone_id(&id).ok_or(SpeechError::Unavailable)?;
                let busy = self
                    .native_microphone_busy(&slots)
                    .or_else(|| slots.microphone.as_ref().map(|lease| lease.purpose));
                if busy.is_none() {
                    slots.microphone = Some(MicrophoneLease {
                        owner: owner.into(),
                        id,
                        purpose,
                        expires_at: remote.then(|| now + Duration::from_secs(10)),
                    });
                }
                Ok(json!({ "busy": busy }))
            }
            Request::ReleaseMicrophone { id } => {
                let lease_id = microphone_id(&id).ok_or(SpeechError::Unavailable)?;
                if slots
                    .microphone
                    .as_ref()
                    .is_some_and(|lease| lease.owner == owner && lease.id == lease_id)
                {
                    slots.microphone = None;
                    #[cfg(target_os = "linux")]
                    self.api_microphone.revoke(Some(owner), Some(&id));
                }
                Ok(Value::Null)
            }
            #[cfg(target_os = "linux")]
            Request::AuthorizeApiMicrophone { .. } | Request::RevokeApiMicrophone { .. } => {
                // These requests additionally require the IPC caller's document.
                Err(SpeechError::Unavailable)
            }
            Request::Read {} => Ok(snapshot(self.store.read()?.engine, self.capabilities())),
            Request::Select { engine } => {
                if slots.active(Kind::Prepare) {
                    return Err(SpeechError::Busy);
                }
                let caps = self.capabilities();
                if engine == Engine::Hex && !matches!(caps, Hex::Ready { .. }) {
                    return Err(SpeechError::Unavailable);
                }
                self.store.select(engine, None)?;
                Ok(snapshot(Some(engine), caps))
            }
            Request::Prepare { plan_id } => {
                if slots.active(Kind::Prepare) {
                    return Err(SpeechError::Busy);
                }
                let hex = self.hex.clone().ok_or(SpeechError::Unavailable)?;
                let (plan, needs_preparation) = match hex.capabilities() {
                    Hex::Ready { plan } => (plan, false),
                    Hex::NeedsPreparation { plan } => (plan, true),
                    Hex::Unavailable => return Err(SpeechError::Unavailable),
                };
                if plan.id != plan_id {
                    return Err(SpeechError::PlanChanged);
                }
                let revision = self.store.read()?.revision;
                let store = self.store.clone();
                Self::begin(
                    &mut slots.operations,
                    owner,
                    Kind::Prepare,
                    move |control| {
                        if needs_preparation {
                            hex.prepare(plan, control.clone())?;
                        }
                        if !matches!(hex.capabilities(), Hex::Ready { .. }) {
                            return Err(SpeechError::Failed);
                        }
                        // Linearize selection against host-side cancellation.
                        let mut slot = control.0 .0.lock();
                        if slot.cancelled {
                            return Ok(Operation::Cancelled);
                        }
                        store.select(Engine::Hex, Some(&revision))?;
                        slot.state = Operation::Prepared;
                        slot.expires = Instant::now() + LEASE;
                        control.0 .1.notify_all();
                        Ok(Operation::Prepared)
                    },
                )
            }
            Request::Start {
                microphone_lease_id,
                ..
            } => {
                if self.native_microphone_busy(&slots).is_some() {
                    return Err(SpeechError::Busy);
                }
                if self.preferred_engine()? != Some(Engine::Hex) {
                    return Err(SpeechError::Unavailable);
                }
                if let Some(lease) = &slots.microphone {
                    if !lease.matches(
                        owner,
                        microphone_lease_id.as_deref().and_then(microphone_id),
                        MicrophonePurpose::Dictation,
                    ) {
                        return Err(SpeechError::Busy);
                    }
                } else if microphone_lease_id.is_some() {
                    return Err(SpeechError::NotOwned);
                }
                let hex = self.hex.clone().ok_or(SpeechError::Unavailable)?;
                if !matches!(hex.capabilities(), Hex::Ready { .. }) {
                    return Err(SpeechError::Unavailable);
                }
                Self::begin(
                    &mut slots.operations,
                    owner,
                    Kind::Dictation,
                    move |control| {
                        let text = hex.dictate(control)?;
                        if text.len() > MAX_TEXT {
                            return Err(SpeechError::Failed);
                        }
                        Ok(Operation::Transcribed { text })
                    },
                )
            }
            input => {
                let id = match &input {
                    Request::Status { id }
                    | Request::Finish { id, .. }
                    | Request::Cancel { id } => id,
                    _ => unreachable!(),
                };
                for entry in &mut slots.operations {
                    let Some(control) = entry else {
                        continue;
                    };
                    let mut slot = control.0 .0.lock();
                    if slot.owner.as_deref() != Some(owner) || slot.id != *id {
                        continue;
                    }
                    return match input {
                        Request::Status { .. } => {
                            if !slot.state.terminal() && !slot.cancelled {
                                slot.expires = Instant::now() + LEASE;
                                control.0 .1.notify_all();
                            }
                            Ok(json!(slot.state))
                        }
                        Request::Finish { wav, .. }
                            if slot.kind == Kind::Dictation
                                && !slot.cancelled
                                && !slot.state.terminal() =>
                        {
                            if slot.finish {
                                return Err(SpeechError::Busy);
                            }
                            slot.audio = Some(decode_wav(&wav).ok_or(SpeechError::Failed)?);
                            slot.finish = true;
                            control.0 .1.notify_all();
                            Ok(Value::Null)
                        }
                        Request::Cancel { .. } => {
                            let receipt = if matches!(slot.state, Operation::Prepared) {
                                json!(slot.state)
                            } else {
                                Value::Null
                            };
                            if slot.state.terminal() {
                                slot.forget();
                                control.0 .1.notify_all();
                                drop(slot);
                                entry.take();
                            } else {
                                slot.cancel(None);
                                control.0 .1.notify_all();
                            }
                            Ok(receipt)
                        }
                        _ => Err(SpeechError::Unavailable),
                    };
                }
                Err(SpeechError::NotOwned)
            }
        }
    }

    pub(crate) fn revoke(&self, owner: Option<&str>) {
        let mut slots = self.slots.lock();
        if slots
            .microphone
            .as_ref()
            .is_some_and(|lease| owner.is_none_or(|owner| lease.owner == owner))
        {
            slots.microphone = None;
        }
        #[cfg(target_os = "linux")]
        self.api_microphone.revoke(owner, None);
        #[cfg(target_os = "linux")]
        self.remote_microphone.revoke(owner, None);
        for entry in &mut slots.operations {
            let Some(control) = entry else {
                continue;
            };
            let mut slot = control.0 .0.lock();
            if owner.is_some_and(|owner| Some(owner) != slot.owner.as_deref()) {
                continue;
            }
            if slot.state.terminal() {
                slot.forget();
                control.0 .1.notify_all();
                drop(slot);
                entry.take();
            } else {
                slot.owner = None;
                slot.cancel(None);
                control.0 .1.notify_all();
            }
        }
    }

    fn begin(
        slots: &mut [Option<Control>; 2],
        owner: &str,
        kind: Kind,
        work: impl FnOnce(Control) -> Result<Operation, SpeechError> + Send + 'static,
    ) -> Result<Value, SpeechError> {
        let id = Uuid::new_v4().to_string();
        if let Some(previous) = slots[kind as usize].take() {
            previous.0 .0.lock().forget();
            previous.0 .1.notify_all();
        }
        let now = Instant::now();
        let seconds = if kind == Kind::Dictation { 150 } else { 7_200 };
        let control = Control(Arc::new((
            Mutex::new(Slot {
                owner: Some(owner.into()),
                id: id.clone(),
                kind,
                state: Operation::Starting,
                expires: now + LEASE,
                deadline: now + Duration::from_secs(seconds),
                finish: false,
                audio: None,
                #[cfg(target_os = "linux")]
                microphone_claimed: false,
                cancelled: false,
                reason: None,
            }),
            Condvar::new(),
        )));
        let monitor = control.clone();
        std::thread::spawn(move || monitor.monitor());
        let worker = control.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if worker.cancelled() {
                    Ok(Operation::Cancelled)
                } else {
                    work(worker.clone())
                }
            }))
            .unwrap_or(Err(SpeechError::Failed));
            let mut slot = worker.0 .0.lock();
            if slot.state.terminal() {
                return;
            }
            slot.state = if let Some(error) = slot.reason {
                Operation::Error { error }
            } else if slot.cancelled {
                Operation::Cancelled
            } else {
                result.unwrap_or_else(|error| Operation::Error { error })
            };
            slot.expires = Instant::now() + LEASE;
            worker.0 .1.notify_all();
        });
        slots[kind as usize] = Some(control);
        Ok(json!({ "id": id }))
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'f' | b'0'..=b'9' | b'-'))
}

pub(crate) fn microphone_id(value: &str) -> Option<Uuid> {
    let id = Uuid::try_parse(value).ok()?;
    (id.get_version() == Some(uuid::Version::Random)
        && id.get_variant() == uuid::Variant::RFC4122
        && id.hyphenated().encode_lower(&mut Uuid::encode_buffer()) == value)
        .then_some(id)
}

fn valid_plan_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn valid_locale(locale: &str) -> bool {
    let mut parts = locale.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    (2..=8).contains(&first.len())
        && first.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.enumerate().all(|(index, part)| {
            index < 5
                && (1..=8).contains(&part.len())
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
#[path = "device_speech_tests.rs"]
mod tests;
