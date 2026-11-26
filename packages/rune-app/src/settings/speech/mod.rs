//! Preferences → Voice: prompt voice input toggle, playback settings, and API credentials.
mod shared;
mod view;

pub(super) use shared::{ServerContext, ServerEffects, Shared};

use super::preferences::{Owner, Preferences};
use crate::platform;
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::speech::{
        SpeechCapabilities, SpeechCapabilitiesOutcome, SpeechDirectionDraft, SpeechDraft,
        SpeechKeyWrite, SpeechPlaybackMode, SpeechSettings, SpeechTtsFormat, build_speech_patch,
        js_trim, normalize_speech_settings, read_speech_capabilities,
    },
};
use rune::{TextEdit, Waker};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Picker {
    PlaybackMode,
    TtsFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InfoTip {
    PromptVoiceInput,
    PlaybackMode,
    SharedApiKey,
    SharedBaseUrl,
    SttApiKey,
    SttBaseUrl,
    TtsApiKey,
    TtsBaseUrl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Direction {
    Shared,
    Stt,
    Tts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextField {
    TtsVoice,
    SharedBaseUrl,
    SttModel,
    TtsModel,
    SttBaseUrl,
    SttModelDir,
    TtsBaseUrl,
    TtsModelDir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CapState {
    Idle,
    Loading,
    Loaded,
    Unsupported,
}

impl Default for CapState {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub(super) struct TextDraft {
    baseline: String,
    edited: bool,
    /// Displayed URL captured when an API key was entered beside it (prevents SSE re-pairing).
    pinned: Option<String>,
    pub(super) edit: TextEdit,
}

impl TextDraft {
    fn sync(&mut self, value: &str) {
        if !self.edited
            && self.pinned.is_none()
            && self.edit.text == self.baseline
            && self.baseline != value
        {
            self.baseline = value.to_owned();
            self.edit = TextEdit::new(value);
        }
    }

    fn reset(&mut self, value: &str) {
        self.baseline = value.to_owned();
        self.edited = false;
        self.pinned = None;
        self.edit = TextEdit::new(value);
    }

    fn on_explicit_edit(&mut self) {
        self.edited = true;
        self.pinned = None;
    }

    fn pin_current(&mut self) {
        if self.pinned.is_none() {
            self.pinned = Some(self.edit.text.clone());
        }
    }

    fn unpin_if_unedited(&mut self) {
        if !self.edited && self.pinned.as_deref() == Some(self.edit.text.as_str()) {
            self.pinned = None;
        }
    }

    fn has_local_edit(&self) -> bool {
        self.edited || self.pinned.is_some() || self.edit.text != self.baseline
    }

    fn explicit_draft_value(&self) -> Option<String> {
        (self.edited || self.edit.text != self.baseline).then(|| self.edit.text.clone())
    }

    fn captured_url_for_key(&self) -> String {
        if self.edited || self.edit.text != self.baseline {
            self.edit.text.clone()
        } else {
            self.pinned
                .clone()
                .unwrap_or_else(|| self.edit.text.clone())
        }
    }
}

#[derive(Default)]
pub(super) struct KeyDraft {
    pub(super) edit: TextEdit,
    pub(super) clear_key: bool,
}

impl KeyDraft {
    fn reset(&mut self) {
        self.edit = TextEdit::default();
        self.clear_key = false;
    }

    fn has_local_edit(&self) -> bool {
        self.clear_key || !self.edit.text.is_empty()
    }
}

#[derive(Clone)]
struct SubmittedDirection {
    api_key: String,
    clear_key: bool,
    base_url: String,
    model: Option<String>,
}

#[derive(Clone, Default)]
struct SubmittedDraft {
    playback_mode: Option<SpeechPlaybackMode>,
    tts_format: Option<SpeechTtsFormat>,
    tts_voice: Option<String>,
    separate_providers: Option<bool>,
    shared_credentials: Option<SubmittedDirection>,
    stt_model: Option<String>,
    tts_model: Option<String>,
    stt: Option<SubmittedDirection>,
    tts: Option<SubmittedDirection>,
}

#[derive(Default)]
pub(super) struct Drafts {
    pub(super) separate_providers: Option<bool>,
    pub(super) playback_mode: Option<SpeechPlaybackMode>,
    pub(super) tts_format: Option<SpeechTtsFormat>,
    pub(super) tts_voice: TextDraft,
    pub(super) shared_key: KeyDraft,
    pub(super) shared_base_url: TextDraft,
    pub(super) stt_model: TextDraft,
    pub(super) tts_model: TextDraft,
    pub(super) stt_key: KeyDraft,
    pub(super) stt_base_url: TextDraft,
    pub(super) stt_model_dir: TextDraft,
    pub(super) tts_key: KeyDraft,
    pub(super) tts_base_url: TextDraft,
    pub(super) tts_model_dir: TextDraft,
}

impl Drafts {
    pub(super) fn on_key_change(&mut self, dir: Direction) {
        let (key, url) = match dir {
            Direction::Shared => (&mut self.shared_key, &mut self.shared_base_url),
            Direction::Stt => (&mut self.stt_key, &mut self.stt_base_url),
            Direction::Tts => (&mut self.tts_key, &mut self.tts_base_url),
        };
        // Any real text change cancels a pending clear marker; focus alone never runs on_change.
        key.clear_key = false;
        if !js_trim(&key.edit.text).is_empty() {
            url.pin_current();
        } else {
            url.unpin_if_unedited();
        }
    }

    pub(super) fn on_text_change(&mut self, field: TextField) {
        match field {
            TextField::TtsVoice => self.tts_voice.on_explicit_edit(),
            TextField::SharedBaseUrl => self.shared_base_url.on_explicit_edit(),
            TextField::SttModel => self.stt_model.on_explicit_edit(),
            TextField::TtsModel => self.tts_model.on_explicit_edit(),
            TextField::SttBaseUrl => self.stt_base_url.on_explicit_edit(),
            TextField::SttModelDir => self.stt_model_dir.on_explicit_edit(),
            TextField::TtsBaseUrl => self.tts_base_url.on_explicit_edit(),
            TextField::TtsModelDir => self.tts_model_dir.on_explicit_edit(),
        }
    }

    pub(super) fn has_any_local_draft(
        &self,
        saved: &SpeechSettings,
        capabilities_voice: Option<&str>,
    ) -> bool {
        let baseline_voice = capabilities_voice
            .map(js_trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(saved.tts_voice.as_str());
        self.separate_providers
            .is_some_and(|v| v != saved.separate_providers)
            || self.playback_mode.is_some_and(|v| v != saved.playback_mode)
            || self.tts_format.is_some_and(|v| v != saved.tts_format)
            || (self.tts_voice.has_local_edit()
                && js_trim(&self.tts_voice.edit.text) != baseline_voice)
            || self.shared_key.has_local_edit()
            || self.shared_base_url.has_local_edit()
            || self.stt_model.has_local_edit()
            || self.tts_model.has_local_edit()
            || self.stt_key.has_local_edit()
            || self.stt_base_url.has_local_edit()
            || self.stt_model_dir.has_local_edit()
            || self.tts_key.has_local_edit()
            || self.tts_base_url.has_local_edit()
            || self.tts_model_dir.has_local_edit()
    }

    fn sync_unedited(&mut self, saved: &SpeechSettings, capabilities_voice: Option<&str>) {
        let voice = capabilities_voice
            .map(js_trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(saved.tts_voice.as_str());
        self.tts_voice.sync(voice);
        self.shared_base_url
            .sync(saved.base_url.as_deref().unwrap_or(""));
        self.stt_model.sync(&saved.stt_model);
        self.tts_model.sync(&saved.tts_model);
        self.stt_base_url
            .sync(saved.stt.base_url.as_deref().unwrap_or(""));
        self.stt_model_dir.sync(&saved.stt.model);
        self.tts_base_url
            .sync(saved.tts.base_url.as_deref().unwrap_or(""));
        self.tts_model_dir.sync(&saved.tts.model);
    }

    fn reset(&mut self, saved: &SpeechSettings, capabilities_voice: Option<&str>) {
        self.separate_providers = None;
        self.playback_mode = None;
        self.tts_format = None;
        self.shared_key.reset();
        self.stt_key.reset();
        self.tts_key.reset();
        let voice = capabilities_voice
            .map(js_trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(saved.tts_voice.as_str());
        self.tts_voice.reset(voice);
        self.shared_base_url
            .reset(saved.base_url.as_deref().unwrap_or(""));
        self.stt_model.reset(&saved.stt_model);
        self.tts_model.reset(&saved.tts_model);
        self.stt_base_url
            .reset(saved.stt.base_url.as_deref().unwrap_or(""));
        self.stt_model_dir.reset(&saved.stt.model);
        self.tts_base_url
            .reset(saved.tts.base_url.as_deref().unwrap_or(""));
        self.tts_model_dir.reset(&saved.tts.model);
    }

    fn capture_submitted(&self, patch: &Value) -> SubmittedDraft {
        let Some(map) = patch.get("speech").and_then(Value::as_object) else {
            return SubmittedDraft::default();
        };
        SubmittedDraft {
            playback_mode: map
                .contains_key("playbackMode")
                .then_some(self.playback_mode)
                .flatten(),
            tts_format: map
                .contains_key("ttsFormat")
                .then_some(self.tts_format)
                .flatten(),
            tts_voice: map
                .contains_key("ttsVoice")
                .then(|| self.tts_voice.edit.text.clone()),
            separate_providers: map
                .contains_key("separateProviders")
                .then_some(self.separate_providers)
                .flatten(),
            shared_credentials: (map.contains_key("apiKey") || map.contains_key("baseUrl")).then(
                || SubmittedDirection {
                    api_key: self.shared_key.edit.text.clone(),
                    clear_key: self.shared_key.clear_key,
                    base_url: self.shared_base_url.edit.text.clone(),
                    model: None,
                },
            ),
            stt_model: map
                .contains_key("sttModel")
                .then(|| self.stt_model.edit.text.clone()),
            tts_model: map
                .contains_key("ttsModel")
                .then(|| self.tts_model.edit.text.clone()),
            stt: map.contains_key("stt").then(|| SubmittedDirection {
                api_key: self.stt_key.edit.text.clone(),
                clear_key: self.stt_key.clear_key,
                base_url: self.stt_base_url.edit.text.clone(),
                model: Some(self.stt_model_dir.edit.text.clone()),
            }),
            tts: map.contains_key("tts").then(|| SubmittedDirection {
                api_key: self.tts_key.edit.text.clone(),
                clear_key: self.tts_key.clear_key,
                base_url: self.tts_base_url.edit.text.clone(),
                model: Some(self.tts_model_dir.edit.text.clone()),
            }),
        }
    }

    /// Reset only the draft fields that were actually submitted in `submitted` and have not
    /// changed locally since clicking Save; leave untouched/hidden drafts intact.
    fn reconcile_confirmed_save(
        &mut self,
        submitted: &SubmittedDraft,
        saved: &SpeechSettings,
        capabilities_voice: Option<&str>,
    ) {
        let voice = capabilities_voice
            .map(js_trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(saved.tts_voice.as_str());
        if submitted.playback_mode.is_some() && self.playback_mode == submitted.playback_mode {
            self.playback_mode = None;
        }
        if submitted.tts_format.is_some() && self.tts_format == submitted.tts_format {
            self.tts_format = None;
        }
        if submitted.tts_voice.as_deref() == Some(self.tts_voice.edit.text.as_str()) {
            self.tts_voice.reset(voice);
        }
        if submitted.separate_providers.is_some()
            && self.separate_providers == submitted.separate_providers
        {
            self.separate_providers = None;
        }
        if let Some(sub) = &submitted.shared_credentials {
            if self.shared_key.edit.text == sub.api_key
                && self.shared_key.clear_key == sub.clear_key
            {
                self.shared_key.reset();
            }
            if self.shared_base_url.edit.text == sub.base_url {
                self.shared_base_url
                    .reset(saved.base_url.as_deref().unwrap_or(""));
            }
        }
        if submitted.stt_model.as_deref() == Some(self.stt_model.edit.text.as_str()) {
            self.stt_model.reset(&saved.stt_model);
        }
        if submitted.tts_model.as_deref() == Some(self.tts_model.edit.text.as_str()) {
            self.tts_model.reset(&saved.tts_model);
        }
        if let Some(sub) = &submitted.stt {
            if self.stt_key.edit.text == sub.api_key && self.stt_key.clear_key == sub.clear_key {
                self.stt_key.reset();
            }
            if self.stt_base_url.edit.text == sub.base_url {
                self.stt_base_url
                    .reset(saved.stt.base_url.as_deref().unwrap_or(""));
            }
            if sub.model.as_deref() == Some(self.stt_model_dir.edit.text.as_str()) {
                self.stt_model_dir.reset(&saved.stt.model);
            }
        }
        if let Some(sub) = &submitted.tts {
            if self.tts_key.edit.text == sub.api_key && self.tts_key.clear_key == sub.clear_key {
                self.tts_key.reset();
            }
            if self.tts_base_url.edit.text == sub.base_url {
                self.tts_base_url
                    .reset(saved.tts.base_url.as_deref().unwrap_or(""));
            }
            if sub.model.as_deref() == Some(self.tts_model_dir.edit.text.as_str()) {
                self.tts_model_dir.reset(&saved.tts.model);
            }
        }
        self.sync_unedited(saved, capabilities_voice);
    }

    fn key_write(key: &KeyDraft, url: &TextDraft) -> Option<SpeechKeyWrite> {
        (!js_trim(&key.edit.text).is_empty()).then(|| SpeechKeyWrite {
            api_key: key.edit.text.clone(),
            base_url: url.captured_url_for_key(),
        })
    }

    fn to_speech_draft(&self) -> SpeechDraft {
        let shared_key_write = Self::key_write(&self.shared_key, &self.shared_base_url);
        let stt_key_write = Self::key_write(&self.stt_key, &self.stt_base_url);
        let tts_key_write = Self::key_write(&self.tts_key, &self.tts_base_url);
        SpeechDraft {
            separate_providers: self.separate_providers,
            shared_clear_key: self.shared_key.clear_key && shared_key_write.is_none(),
            shared_key_write,
            shared_base_url: self.shared_base_url.explicit_draft_value(),
            stt_model: self.stt_model.explicit_draft_value(),
            tts_model: self.tts_model.explicit_draft_value(),
            tts_voice: self.tts_voice.explicit_draft_value(),
            playback_mode: self.playback_mode,
            tts_format: self.tts_format,
            stt: SpeechDirectionDraft {
                clear_key: self.stt_key.clear_key && stt_key_write.is_none(),
                key_write: stt_key_write,
                base_url: self.stt_base_url.explicit_draft_value(),
                model: self.stt_model_dir.explicit_draft_value(),
            },
            tts: SpeechDirectionDraft {
                clear_key: self.tts_key.clear_key && tts_key_write.is_none(),
                key_write: tts_key_write,
                base_url: self.tts_base_url.explicit_draft_value(),
                model: self.tts_model_dir.explicit_draft_value(),
            },
        }
    }
}

type CapKey = (u64, u64, u64);
type CapFlight = (CapKey, Sender<()>, Receiver<SpeechCapabilitiesOutcome>);

#[derive(Default)]
pub(super) struct Speech {
    owner: Option<String>,
    cap_state: CapState,
    cached_caps: Option<SpeechCapabilities>,
    cap_error: bool,
    cap_flight: Option<CapFlight>,
    cap_seen_key: Option<CapKey>,
    cap_drop_gen: Option<u64>,
    cap_reload_epoch: u64,
    seen_saved_generation: u64,
    submitted: Option<SubmittedDraft>,
    pub(super) credentials_open: bool,
    pub(super) open_picker: Option<Picker>,
    pub(super) info_open: Option<InfoTip>,
    pub(super) drafts: Drafts,
    wake: Option<Waker>,
}

impl Speech {
    pub fn close(&mut self) {
        self.open_picker = None;
        self.info_open = None;
        self.cancel_cap_flight();
        self.cap_seen_key = None;
    }

    pub fn cancel_overlays(&mut self) -> bool {
        if self.open_picker.take().is_some() {
            return true;
        }
        self.info_open.take().is_some()
    }

    fn cancel_cap_flight(&mut self) {
        if self.cap_flight.take().is_some() && self.cap_state == CapState::Loading {
            self.cap_state = if self.cached_caps.is_some() {
                CapState::Loaded
            } else {
                CapState::Idle
            };
        }
    }

    pub(super) fn cap_state(&self) -> CapState {
        self.cap_state
    }

    pub(super) fn cap_failed(&self) -> bool {
        self.cap_error
    }

    pub(super) fn loaded_capabilities(&self) -> Option<&SpeechCapabilities> {
        self.cached_caps.as_ref()
    }

    pub(super) fn separate_supported(&self) -> bool {
        // Keep `separateProviders` editable when capabilities are absent/unsupported (404/501)
        // so `config.server.speech` stays configurable; preserve last valid capabilities on error.
        self.cached_caps
            .as_ref()
            .is_none_or(|caps| caps.supports_separate_providers)
    }

    pub(super) fn capabilities_voice(&self) -> Option<&str> {
        self.loaded_capabilities()
            .map(|c| c.tts_voice.as_str())
            .filter(|v| !js_trim(v).is_empty())
    }

    pub(super) fn request_retry(&mut self, prefs: &mut Preferences) {
        prefs.speech.clear_error();
        prefs.refresh_speech_server();
        self.cap_error = false;
        self.cancel_cap_flight();
        self.cap_reload_epoch = self.cap_reload_epoch.wrapping_add(1);
        self.cap_seen_key = None;
        if self.cap_state == CapState::Unsupported {
            self.cap_state = CapState::Idle;
        }
    }

    pub(super) fn cancel_drafts(&mut self, prefs: &mut Preferences) {
        prefs.speech.clear_error();
        self.submitted = None;
        let saved = normalize_speech_settings(prefs.saved(Owner::Server));
        let voice = self.capabilities_voice().map(str::to_owned);
        self.drafts.reset(&saved, voice.as_deref());
    }

    pub(super) fn pending_patch(&self, saved: &SpeechSettings) -> Option<Value> {
        build_speech_patch(
            saved,
            &self.drafts.to_speech_draft(),
            self.separate_supported(),
            self.capabilities_voice(),
        )
    }

    pub(super) fn save(&mut self, prefs: &mut Preferences) {
        let saved = normalize_speech_settings(prefs.saved(Owner::Server));
        let Some(patch) = self.pending_patch(&saved) else {
            return;
        };
        let Some(wake) = self
            .wake
            .clone()
            .or_else(|| prefs.window_wake.clone())
            .or_else(|| prefs.main_wake.clone())
        else {
            return;
        };
        let submitted = self.drafts.capture_submitted(&patch);
        if prefs.start_speech_save(patch, &wake) {
            self.submitted = Some(submitted);
        }
    }

    pub fn poll(&mut self, prefs: &mut Preferences, wake: &Waker, active: bool) -> bool {
        self.wake = Some(wake.clone());
        prefs.show_speech(active);
        let mut changed = false;

        let owner = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .map(|b| b.client_id.as_str());
        if owner != self.owner.as_deref() {
            let open = self.credentials_open;
            *self = Self {
                owner: owner.map(str::to_owned),
                credentials_open: open,
                seen_saved_generation: prefs.speech.saved_generation(),
                wake: Some(wake.clone()),
                ..Self::default()
            };
            changed = true;
        }

        let writes_changed = prefs.poll_speech_writes();
        changed |= writes_changed;

        let saved = normalize_speech_settings(prefs.saved(Owner::Server));
        let saved_gen = prefs.speech.saved_generation();
        if saved_gen != self.seen_saved_generation {
            self.seen_saved_generation = saved_gen;
            let voice = self.capabilities_voice().map(str::to_owned);
            if let Some(submitted) = self.submitted.take() {
                self.drafts
                    .reconcile_confirmed_save(&submitted, &saved, voice.as_deref());
            } else {
                self.drafts.sync_unedited(&saved, voice.as_deref());
            }
            if self.cap_state != CapState::Unsupported {
                self.cap_reload_epoch = self.cap_reload_epoch.wrapping_add(1);
                self.cap_seen_key = None;
            }
            changed = true;
        } else {
            if !prefs.speech.saving() && prefs.speech.failed {
                self.submitted = None;
            }
            let voice = self.capabilities_voice().map(str::to_owned);
            self.drafts.sync_unedited(&saved, voice.as_deref());
        }

        if !active {
            if self.cap_flight.is_some() {
                self.cancel_cap_flight();
                self.cap_seen_key = None;
                changed = true;
            }
            return changed;
        }

        let online = prefs.can_retry() && !prefs.is_transport_lost();
        if !online {
            if self.cap_flight.is_some() {
                self.cancel_cap_flight();
                self.cap_seen_key = None;
                changed = true;
            }
            return changed;
        }

        let Some(backend) = prefs.backend.clone() else {
            return changed;
        };
        let drop_gen = backend.client.drop_generation();
        if self.cap_drop_gen != Some(drop_gen) {
            let reconnected = self.cap_drop_gen.is_some();
            self.cap_drop_gen = Some(drop_gen);
            if reconnected {
                // Transport reconnected: cancel any stale flight and allow rediscovering routes
                // that previously returned 404/501 in an earlier transport generation.
                self.cancel_cap_flight();
                self.cap_seen_key = None;
                if self.cap_state == CapState::Unsupported {
                    self.cap_state = CapState::Idle;
                }
                changed = true;
            }
        }

        let key: CapKey = (
            backend.client.preferences_revision(Owner::Server),
            drop_gen,
            self.cap_reload_epoch,
        );

        // Cancel an obsolete in-flight read immediately instead of waiting for it to finish.
        if self
            .cap_flight
            .as_ref()
            .is_some_and(|(started, _, _)| *started != key)
        {
            self.cancel_cap_flight();
            self.cap_seen_key = None;
            changed = true;
        }

        if let Some(outcome) = self
            .cap_flight
            .as_ref()
            .and_then(|(_, _, inbox)| inbox.try_recv().ok())
        {
            let started_key = self.cap_flight.take().map(|(k, _, _)| k);
            if started_key == Some(key) {
                match outcome {
                    SpeechCapabilitiesOutcome::Loaded(caps) => {
                        self.cached_caps = Some(*caps);
                        self.cap_state = CapState::Loaded;
                        self.cap_error = false;
                    }
                    SpeechCapabilitiesOutcome::Unsupported => {
                        self.cached_caps = None;
                        self.cap_state = CapState::Unsupported;
                        self.cap_error = false;
                    }
                    SpeechCapabilitiesOutcome::Failed => {
                        // Preserve the last valid capabilities snapshot alongside the error state.
                        self.cap_error = true;
                        self.cap_state = if self.cached_caps.is_some() {
                            CapState::Loaded
                        } else {
                            CapState::Idle
                        };
                    }
                }
                let voice = self.capabilities_voice().map(str::to_owned);
                self.drafts.sync_unedited(&saved, voice.as_deref());
            } else {
                self.cap_seen_key = None;
                if self.cap_state == CapState::Loading {
                    self.cap_state = if self.cached_caps.is_some() {
                        CapState::Loaded
                    } else {
                        CapState::Idle
                    };
                }
            }
            changed = true;
        }

        if self.cap_flight.is_none()
            && self.cap_seen_key != Some(key)
            && self.cap_state != CapState::Unsupported
        {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let wake = wake.clone();
            self.cap_seen_key = Some(key);
            if self.cached_caps.is_none() {
                self.cap_state = CapState::Loading;
            }
            self.cap_flight = Some((key, cancel, inbox));
            platform::spawn(async move {
                if let Some(outcome) =
                    platform::reads::cancellable(&cancelled, read_speech_capabilities(&backend))
                        .await
                    && out.send(outcome).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }

        changed
    }
}
