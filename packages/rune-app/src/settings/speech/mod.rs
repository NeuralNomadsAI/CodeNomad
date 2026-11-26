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
        SpeechPlaybackMode, SpeechSettings, SpeechTtsFormat, build_speech_patch, js_trim,
        normalize_speech_settings, read_speech_capabilities,
    },
};
use rune::{TextEdit, Waker};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Capabilities {
    Idle,
    Loading,
    Loaded(SpeechCapabilities),
    Unsupported,
    Error,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub(super) struct TextDraft {
    baseline: String,
    pub(super) edit: TextEdit,
}

impl TextDraft {
    fn sync(&mut self, value: &str) {
        if self.edit.text == self.baseline && self.baseline != value {
            self.baseline = value.to_owned();
            self.edit = TextEdit::new(value);
        }
    }

    fn reset(&mut self, value: &str) {
        self.baseline = value.to_owned();
        self.edit = TextEdit::new(value);
    }

    fn draft_value(&self) -> Option<String> {
        (self.edit.text != self.baseline).then(|| self.edit.text.clone())
    }
}

#[derive(Default)]
pub(super) struct Drafts {
    pub(super) separate_providers: Option<bool>,
    pub(super) playback_mode: Option<SpeechPlaybackMode>,
    pub(super) tts_format: Option<SpeechTtsFormat>,
    pub(super) tts_voice: TextDraft,
    pub(super) shared_api_key: TextEdit,
    pub(super) shared_clear_key: bool,
    pub(super) shared_base_url: TextDraft,
    pub(super) stt_model: TextDraft,
    pub(super) tts_model: TextDraft,
    pub(super) stt_api_key: TextEdit,
    pub(super) stt_clear_key: bool,
    pub(super) stt_base_url: TextDraft,
    pub(super) stt_model_dir: TextDraft,
    pub(super) tts_api_key: TextEdit,
    pub(super) tts_clear_key: bool,
    pub(super) tts_base_url: TextDraft,
    pub(super) tts_model_dir: TextDraft,
}

impl Drafts {
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
        self.shared_api_key = TextEdit::default();
        self.shared_clear_key = false;
        self.stt_api_key = TextEdit::default();
        self.stt_clear_key = false;
        self.tts_api_key = TextEdit::default();
        self.tts_clear_key = false;
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

    fn to_speech_draft(&self) -> SpeechDraft {
        let shared_typed = !js_trim(&self.shared_api_key.text).is_empty();
        let stt_typed = !js_trim(&self.stt_api_key.text).is_empty();
        let tts_typed = !js_trim(&self.tts_api_key.text).is_empty();
        SpeechDraft {
            separate_providers: self.separate_providers,
            shared_clear_key: self.shared_clear_key && !shared_typed,
            shared_api_key: self.shared_api_key.text.clone(),
            shared_base_url: self.shared_base_url.draft_value(),
            stt_model: self.stt_model.draft_value(),
            tts_model: self.tts_model.draft_value(),
            tts_voice: self.tts_voice.draft_value(),
            playback_mode: self.playback_mode,
            tts_format: self.tts_format,
            stt: SpeechDirectionDraft {
                clear_key: self.stt_clear_key && !stt_typed,
                api_key: self.stt_api_key.text.clone(),
                base_url: self.stt_base_url.draft_value(),
                model: self.stt_model_dir.draft_value(),
            },
            tts: SpeechDirectionDraft {
                clear_key: self.tts_clear_key && !tts_typed,
                api_key: self.tts_api_key.text.clone(),
                base_url: self.tts_base_url.draft_value(),
                model: self.tts_model_dir.draft_value(),
            },
        }
    }
}

type CapFlight = (u64, Sender<()>, Receiver<SpeechCapabilitiesOutcome>);

#[derive(Default)]
pub(super) struct Speech {
    owner: Option<String>,
    capabilities: Capabilities,
    cap_flight: Option<CapFlight>,
    cap_seen_epoch: Option<u64>,
    cap_reload_epoch: u64,
    seen_saved_generation: u64,
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
        self.cap_flight = None;
        if self.capabilities == Capabilities::Loading {
            self.capabilities = Capabilities::Idle;
        }
        self.cap_seen_epoch = None;
    }

    pub fn cancel_overlays(&mut self) -> bool {
        if self.open_picker.take().is_some() {
            return true;
        }
        self.info_open.take().is_some()
    }

    pub(super) fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    pub(super) fn loaded_capabilities(&self) -> Option<&SpeechCapabilities> {
        match &self.capabilities {
            Capabilities::Loaded(caps) => Some(caps),
            _ => None,
        }
    }

    pub(super) fn separate_supported(&self) -> bool {
        match &self.capabilities {
            Capabilities::Loaded(caps) => caps.supports_separate_providers,
            // When `/api/speech/capabilities` is unavailable (404/501) or loading, keep
            // `separateProviders` editable so `config.server.speech` stays fully configurable.
            Capabilities::Idle
            | Capabilities::Loading
            | Capabilities::Unsupported
            | Capabilities::Error => true,
        }
    }

    pub(super) fn capabilities_voice(&self) -> Option<&str> {
        self.loaded_capabilities()
            .map(|c| c.tts_voice.as_str())
            .filter(|v| !js_trim(v).is_empty())
    }

    pub(super) fn request_retry(&mut self, prefs: &mut Preferences) {
        prefs.speech.clear_error();
        prefs.refresh_speech_server();
        self.cap_reload_epoch = self.cap_reload_epoch.wrapping_add(1);
        self.cap_seen_epoch = None;
        if matches!(
            self.capabilities,
            Capabilities::Error | Capabilities::Unsupported
        ) {
            self.capabilities = Capabilities::Idle;
        }
    }

    pub(super) fn cancel_drafts(&mut self, prefs: &mut Preferences) {
        prefs.speech.clear_error();
        let saved = normalize_speech_settings(prefs.saved(Owner::Server));
        let voice = self.capabilities_voice().map(str::to_owned);
        self.drafts.reset(&saved, voice.as_deref());
    }

    pub(super) fn pending_patch(&self, saved: &SpeechSettings) -> Option<serde_json::Value> {
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
        let _ = prefs.start_speech_save(patch, &wake);
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
            self.drafts.reset(&saved, voice.as_deref());
            if self.capabilities != Capabilities::Unsupported {
                self.cap_reload_epoch = self.cap_reload_epoch.wrapping_add(1);
                self.cap_seen_epoch = None;
            }
            changed = true;
        } else {
            let voice = self.capabilities_voice().map(str::to_owned);
            self.drafts.sync_unedited(&saved, voice.as_deref());
        }

        if !active {
            if self.cap_flight.take().is_some() {
                if self.capabilities == Capabilities::Loading {
                    self.capabilities = Capabilities::Idle;
                }
                self.cap_seen_epoch = None;
                changed = true;
            }
            return changed;
        }

        let online = prefs.can_retry() && !prefs.is_transport_lost();
        if !online {
            if self.cap_flight.take().is_some() {
                if self.capabilities == Capabilities::Loading {
                    self.capabilities = Capabilities::Idle;
                }
                self.cap_seen_epoch = None;
                changed = true;
            }
            return changed;
        }

        let Some(backend) = prefs.backend.clone() else {
            return changed;
        };
        let epoch = backend
            .client
            .preferences_revision(Owner::Server)
            .wrapping_add(backend.client.drop_generation())
            .wrapping_add(self.cap_reload_epoch);

        if let Some(outcome) = self
            .cap_flight
            .as_ref()
            .and_then(|(_, _, inbox)| inbox.try_recv().ok())
        {
            let started_epoch = self.cap_flight.take().map(|(e, _, _)| e);
            if started_epoch == Some(epoch) {
                self.capabilities = match outcome {
                    SpeechCapabilitiesOutcome::Loaded(caps) => Capabilities::Loaded(*caps),
                    SpeechCapabilitiesOutcome::Unsupported => Capabilities::Unsupported,
                    SpeechCapabilitiesOutcome::Failed => Capabilities::Error,
                };
                let voice = self.capabilities_voice().map(str::to_owned);
                self.drafts.sync_unedited(&saved, voice.as_deref());
            } else {
                self.cap_seen_epoch = None;
                if self.capabilities == Capabilities::Loading {
                    self.capabilities = Capabilities::Idle;
                }
            }
            changed = true;
        }

        if self.cap_flight.is_none()
            && self.cap_seen_epoch != Some(epoch)
            && self.capabilities != Capabilities::Unsupported
        {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let wake = wake.clone();
            self.cap_seen_epoch = Some(epoch);
            if matches!(self.capabilities, Capabilities::Idle | Capabilities::Error) {
                self.capabilities = Capabilities::Loading;
            }
            self.cap_flight = Some((epoch, cancel, inbox));
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
