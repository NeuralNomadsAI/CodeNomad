//! Host speech settings (`config.server.speech`) normalization, patch construction, and capabilities.
use crate::backend::{Backend, read_json};
use serde_json::{Map, Value, json};

pub const DEFAULT_PROVIDER: &str = "openai-compatible";
pub const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_TTS_VOICE: &str = "alloy";

/// ECMAScript `String.prototype.trim()` whitespace (excludes U+0085 NEL, includes U+FEFF BOM).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechPlaybackMode {
    Streaming,
    Buffered,
}

impl SpeechPlaybackMode {
    pub const ALL: [Self; 2] = [Self::Streaming, Self::Buffered];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Buffered => "buffered",
        }
    }

    pub fn label_key(self) -> &'static str {
        match self {
            Self::Streaming => "settings.speech.playbackMode.streaming",
            Self::Buffered => "settings.speech.playbackMode.buffered",
        }
    }

    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw? {
            "streaming" => Some(Self::Streaming),
            "buffered" => Some(Self::Buffered),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechTtsFormat {
    Mp3,
    Wav,
    Opus,
    Aac,
}

impl SpeechTtsFormat {
    pub const ALL: [Self; 4] = [Self::Mp3, Self::Wav, Self::Opus, Self::Aac];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Opus => "opus",
            Self::Aac => "aac",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Mp3 => "MP3",
            Self::Wav => "WAV",
            Self::Opus => "Opus",
            Self::Aac => "AAC",
        }
    }

    pub fn parse(raw: Option<&str>) -> Option<Self> {
        match raw? {
            "mp3" => Some(Self::Mp3),
            "wav" => Some(Self::Wav),
            "opus" => Some(Self::Opus),
            "aac" => Some(Self::Aac),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechDirectionConfig {
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechSettings {
    pub provider: String,
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub playback_mode: SpeechPlaybackMode,
    pub tts_format: SpeechTtsFormat,
    pub separate_providers: bool,
    pub stt: SpeechDirectionConfig,
    pub tts: SpeechDirectionConfig,
}

impl Default for SpeechSettings {
    fn default() -> Self {
        Self {
            provider: DEFAULT_PROVIDER.to_owned(),
            has_api_key: false,
            base_url: None,
            stt_model: DEFAULT_STT_MODEL.to_owned(),
            tts_model: DEFAULT_TTS_MODEL.to_owned(),
            tts_voice: DEFAULT_TTS_VOICE.to_owned(),
            playback_mode: SpeechPlaybackMode::Streaming,
            tts_format: SpeechTtsFormat::Mp3,
            separate_providers: false,
            stt: SpeechDirectionConfig {
                has_api_key: false,
                base_url: None,
                model: DEFAULT_STT_MODEL.to_owned(),
            },
            tts: SpeechDirectionConfig {
                has_api_key: false,
                base_url: None,
                model: DEFAULT_TTS_MODEL.to_owned(),
            },
        }
    }
}

/// An explicit API key entry paired with the endpoint displayed beside it at entry time,
/// preventing concurrent server refreshes from re-pairing the typed key with another URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechKeyWrite {
    pub api_key: String,
    pub base_url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechDirectionDraft {
    pub clear_key: bool,
    pub key_write: Option<SpeechKeyWrite>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechDraft {
    pub separate_providers: Option<bool>,
    pub shared_clear_key: bool,
    pub shared_key_write: Option<SpeechKeyWrite>,
    pub shared_base_url: Option<String>,
    pub stt_model: Option<String>,
    pub tts_model: Option<String>,
    pub tts_voice: Option<String>,
    pub playback_mode: Option<SpeechPlaybackMode>,
    pub tts_format: Option<SpeechTtsFormat>,
    pub stt: SpeechDirectionDraft,
    pub tts: SpeechDirectionDraft,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeechCapabilities {
    pub available: bool,
    pub configured: bool,
    pub provider: String,
    pub supports_stt: bool,
    pub supports_tts: bool,
    pub supports_streaming_tts: bool,
    pub base_url: Option<String>,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_formats: Vec<String>,
    pub streaming_tts_formats: Vec<String>,
    pub supports_separate_providers: bool,
    pub separate_providers: bool,
    pub stt_configured: bool,
    pub tts_configured: bool,
    pub stt_base_url: Option<String>,
    pub tts_base_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpeechCapabilitiesOutcome {
    Loaded(Box<SpeechCapabilities>),
    Unsupported,
    Failed,
}

fn non_empty_trimmed(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let trimmed = js_trim(raw);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn has_stored_key(map: &Map<String, Value>) -> bool {
    map.get("hasApiKey").and_then(Value::as_bool) == Some(true)
        || non_empty_trimmed(map.get("apiKey")).is_some()
}

/// Normalize `config.server.speech` matching Solid `normalizeSpeechSettings`.
/// Plaintext API keys are never retained on the returned model.
pub fn normalize_speech_settings(server_doc: Option<&Value>) -> SpeechSettings {
    let Some(speech) = server_doc
        .and_then(|doc| doc.get("speech"))
        .and_then(Value::as_object)
    else {
        return SpeechSettings::default();
    };
    let stt_model =
        non_empty_trimmed(speech.get("sttModel")).unwrap_or_else(|| DEFAULT_STT_MODEL.to_owned());
    let tts_model =
        non_empty_trimmed(speech.get("ttsModel")).unwrap_or_else(|| DEFAULT_TTS_MODEL.to_owned());
    let provider = match speech.get("provider").and_then(Value::as_str) {
        Some(DEFAULT_PROVIDER) => DEFAULT_PROVIDER.to_owned(),
        _ => DEFAULT_PROVIDER.to_owned(),
    };
    let direction = |key: &str, fallback_model: &str| -> SpeechDirectionConfig {
        let map = speech.get(key).and_then(Value::as_object);
        SpeechDirectionConfig {
            has_api_key: map.is_some_and(has_stored_key),
            base_url: map.and_then(|m| non_empty_trimmed(m.get("baseUrl"))),
            model: map
                .and_then(|m| non_empty_trimmed(m.get("model")))
                .unwrap_or_else(|| fallback_model.to_owned()),
        }
    };
    let stt = direction("stt", &stt_model);
    let tts = direction("tts", &tts_model);
    SpeechSettings {
        provider,
        has_api_key: has_stored_key(speech),
        base_url: non_empty_trimmed(speech.get("baseUrl")),
        stt_model,
        tts_model,
        tts_voice: non_empty_trimmed(speech.get("ttsVoice"))
            .unwrap_or_else(|| DEFAULT_TTS_VOICE.to_owned()),
        playback_mode: SpeechPlaybackMode::parse(
            speech.get("playbackMode").and_then(Value::as_str),
        )
        .unwrap_or(SpeechPlaybackMode::Streaming),
        tts_format: SpeechTtsFormat::parse(speech.get("ttsFormat").and_then(Value::as_str))
            .unwrap_or(SpeechTtsFormat::Mp3),
        separate_providers: speech.get("separateProviders").and_then(Value::as_bool) == Some(true),
        stt,
        tts,
    }
}

/// Exact port of `packages/ui/src/lib/speech-dir-save.ts` + explicit endpoint pairing on key write.
pub fn build_dir_save(
    clear_key: bool,
    draft_api_key: &str,
    draft_base_url: &str,
    draft_model: &str,
    stored_base_url: Option<&str>,
    shared_model: &str,
) -> Map<String, Value> {
    let mut out = Map::new();
    if clear_key {
        out.insert("apiKey".into(), Value::Null);
        out.insert("baseUrl".into(), Value::Null);
        out.insert("model".into(), Value::Null);
        return out;
    }
    let new_key = js_trim(draft_api_key);
    let trimmed_url = js_trim(draft_base_url);
    let base_url_changed = trimmed_url != stored_base_url.unwrap_or("");
    let trimmed_model = js_trim(draft_model);
    let model_matches_shared = trimmed_model == js_trim(shared_model);
    let model_value = if model_matches_shared || trimmed_model.is_empty() {
        Value::Null
    } else {
        json!(trimmed_model)
    };
    let url_value = if trimmed_url.is_empty() {
        Value::Null
    } else {
        json!(trimmed_url)
    };
    if base_url_changed {
        out.insert(
            "apiKey".into(),
            if new_key.is_empty() {
                Value::Null
            } else {
                json!(new_key)
            },
        );
        out.insert("baseUrl".into(), url_value);
        out.insert("model".into(), model_value);
    } else {
        if !new_key.is_empty() {
            out.insert("apiKey".into(), json!(new_key));
            // An explicit credential write always carries the endpoint shown beside it.
            out.insert("baseUrl".into(), url_value);
        }
        out.insert("model".into(), model_value);
    }
    out
}

/// Build the minimal `PATCH /api/storage/config/server` body (`{ "speech": { ... } }`),
/// preserving untouched sibling keys and enforcing credential/endpoint pairing.
pub fn build_speech_patch(
    saved: &SpeechSettings,
    draft: &SpeechDraft,
    separate_supported: bool,
    capabilities_voice: Option<&str>,
) -> Option<Value> {
    let mut speech = Map::new();

    if let Some(mode) = draft.playback_mode
        && mode != saved.playback_mode
    {
        speech.insert("playbackMode".into(), json!(mode.as_str()));
    }
    if let Some(format) = draft.tts_format
        && format != saved.tts_format
    {
        speech.insert("ttsFormat".into(), json!(format.as_str()));
    }
    let baseline_voice = capabilities_voice
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(saved.tts_voice.as_str());
    if let Some(voice) = draft.tts_voice.as_deref() {
        let trimmed = js_trim(voice);
        if trimmed != baseline_voice {
            speech.insert(
                "ttsVoice".into(),
                if trimmed.is_empty() {
                    Value::Null
                } else {
                    json!(trimmed)
                },
            );
        }
    }

    let effective_separate =
        separate_supported && draft.separate_providers.unwrap_or(saved.separate_providers);
    if separate_supported && effective_separate != saved.separate_providers {
        speech.insert("separateProviders".into(), json!(effective_separate));
    }

    let shared_key_write = draft
        .shared_key_write
        .as_ref()
        .filter(|kw| !js_trim(&kw.api_key).is_empty());
    let shared_new_key = shared_key_write.map_or("", |kw| js_trim(&kw.api_key));
    let shared_url = js_trim(
        draft
            .shared_base_url
            .as_deref()
            .or_else(|| shared_key_write.map(|kw| kw.base_url.as_str()))
            .unwrap_or(saved.base_url.as_deref().unwrap_or("")),
    );
    let shared_url_changed = shared_url != saved.base_url.as_deref().unwrap_or("");
    if draft.shared_clear_key || shared_url_changed || !shared_new_key.is_empty() {
        speech.insert(
            "apiKey".into(),
            if draft.shared_clear_key || shared_new_key.is_empty() {
                Value::Null
            } else {
                json!(shared_new_key)
            },
        );
        speech.insert(
            "baseUrl".into(),
            if shared_url.is_empty() {
                Value::Null
            } else {
                json!(shared_url)
            },
        );
    }

    let mut effective_stt_model = saved.stt_model.as_str();
    if let Some(model) = draft.stt_model.as_deref() {
        let trimmed = js_trim(model);
        if trimmed != saved.stt_model {
            speech.insert(
                "sttModel".into(),
                if trimmed.is_empty() {
                    Value::Null
                } else {
                    json!(trimmed)
                },
            );
            effective_stt_model = trimmed;
        }
    }

    let mut effective_tts_model = saved.tts_model.as_str();
    if let Some(model) = draft.tts_model.as_deref() {
        let trimmed = js_trim(model);
        if trimmed != saved.tts_model {
            speech.insert(
                "ttsModel".into(),
                if trimmed.is_empty() {
                    Value::Null
                } else {
                    json!(trimmed)
                },
            );
            effective_tts_model = trimmed;
        }
    }

    if effective_separate {
        let dirs = [
            ("stt", &draft.stt, &saved.stt, effective_stt_model),
            ("tts", &draft.tts, &saved.tts, effective_tts_model),
        ];
        for (name, dir_draft, dir_saved, shared_model) in dirs {
            let dir_key_write = dir_draft
                .key_write
                .as_ref()
                .filter(|kw| !js_trim(&kw.api_key).is_empty());
            let new_key = dir_key_write.map_or("", |kw| js_trim(&kw.api_key));
            let url = js_trim(
                dir_draft
                    .base_url
                    .as_deref()
                    .or_else(|| dir_key_write.map(|kw| kw.base_url.as_str()))
                    .unwrap_or(dir_saved.base_url.as_deref().unwrap_or("")),
            );
            let model = js_trim(
                dir_draft
                    .model
                    .as_deref()
                    .unwrap_or(dir_saved.model.as_str()),
            );
            let url_changed = url != dir_saved.base_url.as_deref().unwrap_or("");
            let model_changed = model != dir_saved.model;
            if dir_draft.clear_key || !new_key.is_empty() || url_changed || model_changed {
                let dir_patch = build_dir_save(
                    dir_draft.clear_key,
                    new_key,
                    url,
                    model,
                    dir_saved.base_url.as_deref(),
                    shared_model,
                );
                if !dir_patch.is_empty() {
                    speech.insert(name.into(), Value::Object(dir_patch));
                }
            }
        }
    }

    (!speech.is_empty()).then(|| json!({ "speech": Value::Object(speech) }))
}

/// Checks whether a fresh authoritative server config snapshot confirms every field in a
/// previously submitted `speech` patch. Returns `false` if the patch included any non-null
/// `apiKey` write, because `hasApiKey: true` cannot prove which secret value is stored.
pub fn speech_patch_confirmed(patch: &Value, snapshot: &Value) -> bool {
    let Some(speech) = patch.get("speech").and_then(Value::as_object) else {
        return false;
    };
    let saved = normalize_speech_settings(Some(snapshot));
    for (key, value) in speech {
        let ok = match key.as_str() {
            "playbackMode" => value.as_str() == Some(saved.playback_mode.as_str()),
            "ttsFormat" => value.as_str() == Some(saved.tts_format.as_str()),
            "ttsVoice" => {
                let expected = value
                    .as_str()
                    .map(js_trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(DEFAULT_TTS_VOICE);
                saved.tts_voice == expected
            }
            "separateProviders" => value.as_bool() == Some(saved.separate_providers),
            "baseUrl" => {
                let expected = value.as_str().map(js_trim).filter(|v| !v.is_empty());
                saved.base_url.as_deref() == expected
            }
            "sttModel" => {
                let expected = value
                    .as_str()
                    .map(js_trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(DEFAULT_STT_MODEL);
                saved.stt_model == expected
            }
            "ttsModel" => {
                let expected = value
                    .as_str()
                    .map(js_trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(DEFAULT_TTS_MODEL);
                saved.tts_model == expected
            }
            "apiKey" => value.is_null() && !saved.has_api_key,
            "stt" => dir_patch_confirmed(value, &saved.stt, &saved.stt_model),
            "tts" => dir_patch_confirmed(value, &saved.tts, &saved.tts_model),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

fn dir_patch_confirmed(patch: &Value, saved: &SpeechDirectionConfig, shared_model: &str) -> bool {
    let Some(map) = patch.as_object() else {
        return false;
    };
    for (key, value) in map {
        let ok = match key.as_str() {
            "apiKey" => value.is_null() && !saved.has_api_key,
            "baseUrl" => {
                let expected = value.as_str().map(js_trim).filter(|v| !v.is_empty());
                saved.base_url.as_deref() == expected
            }
            "model" => {
                let expected = value
                    .as_str()
                    .map(js_trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or(shared_model);
                saved.model == expected
            }
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

pub fn parse_speech_capabilities(value: &Value) -> Option<SpeechCapabilities> {
    let map = value.as_object()?;
    let available = map.get("available").and_then(Value::as_bool)?;
    let configured = map.get("configured").and_then(Value::as_bool)?;
    let provider = map
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let supports_stt = map
        .get("supportsStt")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let supports_tts = map
        .get("supportsTts")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let supports_streaming_tts = map
        .get("supportsStreamingTts")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let string_list = |key: &str| -> Vec<String> {
        map.get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let supports_separate_providers = map.contains_key("separateProviders");
    let separate_providers = map
        .get("separateProviders")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stt_configured = map
        .get("sttConfigured")
        .and_then(Value::as_bool)
        .unwrap_or(configured);
    let tts_configured = map
        .get("ttsConfigured")
        .and_then(Value::as_bool)
        .unwrap_or(configured);
    Some(SpeechCapabilities {
        available,
        configured,
        provider,
        supports_stt,
        supports_tts,
        supports_streaming_tts,
        base_url: non_empty_trimmed(map.get("baseUrl")),
        stt_model: map
            .get("sttModel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        tts_model: map
            .get("ttsModel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        tts_voice: map
            .get("ttsVoice")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        tts_formats: string_list("ttsFormats"),
        streaming_tts_formats: string_list("streamingTtsFormats"),
        supports_separate_providers,
        separate_providers,
        stt_configured,
        tts_configured,
        stt_base_url: non_empty_trimmed(map.get("sttBaseUrl")),
        tts_base_url: non_empty_trimmed(map.get("ttsBaseUrl")),
    })
}

/// Extract host (including optional port) from an HTTP(S) base URL for display, without leaking paths/userinfo.
pub fn url_display_host(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(js_trim(raw)).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// Lazy host read of `GET /api/speech/capabilities`.
/// `404` and `501` degrade cleanly to `Unsupported` so `config.server.speech` remains editable.
pub async fn read_speech_capabilities(backend: &Backend) -> SpeechCapabilitiesOutcome {
    let request = backend
        .client
        .get(format!("{}api/speech/capabilities", backend.base))
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let Ok(response) = request.send().await else {
        return SpeechCapabilitiesOutcome::Failed;
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::NOT_IMPLEMENTED {
        return SpeechCapabilitiesOutcome::Unsupported;
    }
    if !status.is_success() {
        return SpeechCapabilitiesOutcome::Failed;
    }
    let Ok(value) = read_json(response).await else {
        return SpeechCapabilitiesOutcome::Failed;
    };
    parse_speech_capabilities(&value).map_or(SpeechCapabilitiesOutcome::Failed, |caps| {
        SpeechCapabilitiesOutcome::Loaded(Box::new(caps))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_uses_solid_defaults_and_derives_has_api_key_without_storing_secret() {
        let empty = normalize_speech_settings(None);
        assert_eq!(empty.provider, DEFAULT_PROVIDER);
        assert_eq!(empty.stt_model, DEFAULT_STT_MODEL);
        assert_eq!(empty.tts_model, DEFAULT_TTS_MODEL);
        assert_eq!(empty.tts_voice, DEFAULT_TTS_VOICE);
        assert_eq!(empty.playback_mode, SpeechPlaybackMode::Streaming);
        assert_eq!(empty.tts_format, SpeechTtsFormat::Mp3);
        assert!(!empty.has_api_key);
        assert!(!empty.separate_providers);
        assert_eq!(empty.stt.model, DEFAULT_STT_MODEL);
        assert_eq!(empty.tts.model, DEFAULT_TTS_MODEL);

        let doc = json!({
            "logLevel": "INFO",
            "speech": {
                "hasApiKey": true,
                "baseUrl": "  https://api.example.com/v1  ",
                "sttModel": "whisper-1",
                "ttsVoice": "nova",
                "playbackMode": "buffered",
                "ttsFormat": "opus",
                "separateProviders": true,
                "stt": { "apiKey": "sk-raw", "baseUrl": "https://stt.example/v1" },
                "tts": { "hasApiKey": false, "model": "tts-hd" }
            }
        });
        let parsed = normalize_speech_settings(Some(&doc));
        assert!(parsed.has_api_key);
        assert_eq!(
            parsed.base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert_eq!(parsed.stt_model, "whisper-1");
        assert_eq!(parsed.tts_voice, "nova");
        assert_eq!(parsed.playback_mode, SpeechPlaybackMode::Buffered);
        assert_eq!(parsed.tts_format, SpeechTtsFormat::Opus);
        assert!(parsed.separate_providers);
        assert!(parsed.stt.has_api_key);
        assert_eq!(
            parsed.stt.base_url.as_deref(),
            Some("https://stt.example/v1")
        );
        assert_eq!(parsed.stt.model, "whisper-1");
        assert!(!parsed.tts.has_api_key);
        assert_eq!(parsed.tts.model, "tts-hd");
    }

    #[test]
    fn build_speech_patch_preserves_siblings_omits_unchanged_key_and_pairs_url_changes() {
        let saved = normalize_speech_settings(Some(&json!({
            "speech": {
                "hasApiKey": true,
                "baseUrl": "https://old.example/v1",
                "sttModel": "whisper-1",
                "ttsModel": "tts-1",
                "ttsVoice": "alloy",
                "playbackMode": "streaming",
                "ttsFormat": "mp3",
                "separateProviders": true,
                "stt": { "hasApiKey": true, "baseUrl": "https://stt-old.example/v1", "model": "whisper-large" },
                "tts": { "hasApiKey": true, "baseUrl": "https://tts-old.example/v1", "model": "tts-1" }
            }
        })));

        // Editing playback only never sends apiKey or baseUrl.
        let playback_only = SpeechDraft {
            playback_mode: Some(SpeechPlaybackMode::Buffered),
            tts_format: Some(SpeechTtsFormat::Wav),
            tts_voice: Some("  echo ".into()),
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved, &playback_only, true, None),
            Some(json!({
                "speech": {
                    "playbackMode": "buffered",
                    "ttsFormat": "wav",
                    "ttsVoice": "echo"
                }
            }))
        );

        // Changing shared baseUrl without a new key clears apiKey: null.
        let changed_url = SpeechDraft {
            shared_base_url: Some("https://new.example/v1".into()),
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved, &changed_url, true, None),
            Some(json!({
                "speech": {
                    "apiKey": null,
                    "baseUrl": "https://new.example/v1"
                }
            }))
        );

        // Explicit clear_key sends apiKey: null while keeping baseUrl value.
        let cleared = SpeechDraft {
            shared_clear_key: true,
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved, &cleared, true, None),
            Some(json!({
                "speech": {
                    "apiKey": null,
                    "baseUrl": "https://old.example/v1"
                }
            }))
        );

        // Directional STT key clear emits all nulls; TTS URL change without key emits apiKey: null.
        let dir_edit = SpeechDraft {
            stt: SpeechDirectionDraft {
                clear_key: true,
                ..SpeechDirectionDraft::default()
            },
            tts: SpeechDirectionDraft {
                base_url: Some("https://tts-new.example/v1".into()),
                ..SpeechDirectionDraft::default()
            },
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved, &dir_edit, true, None),
            Some(json!({
                "speech": {
                    "stt": { "apiKey": null, "baseUrl": null, "model": null },
                    "tts": { "apiKey": null, "baseUrl": "https://tts-new.example/v1", "model": null }
                }
            }))
        );

        // Directional explicit key write always carries its captured baseUrl, even if saved changed.
        let dir_key = SpeechDraft {
            stt: SpeechDirectionDraft {
                key_write: Some(SpeechKeyWrite {
                    api_key: "  sk-stt-new ".into(),
                    base_url: "https://stt-old.example/v1".into(),
                }),
                ..SpeechDirectionDraft::default()
            },
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved, &dir_key, true, None),
            Some(json!({
                "speech": {
                    "stt": {
                        "apiKey": "sk-stt-new",
                        "baseUrl": "https://stt-old.example/v1",
                        "model": "whisper-large"
                    }
                }
            }))
        );

        // Concurrent server URL change to B cannot re-pair a key typed against A (shared, STT, TTS).
        let saved_rotated = normalize_speech_settings(Some(&json!({
            "speech": {
                "hasApiKey": true,
                "baseUrl": "https://b.example/v1",
                "sttModel": "whisper-1",
                "ttsModel": "tts-1",
                "separateProviders": true,
                "stt": { "hasApiKey": true, "baseUrl": "https://stt-b.example/v1", "model": "whisper-1" },
                "tts": { "hasApiKey": true, "baseUrl": "https://tts-b.example/v1", "model": "tts-1" }
            }
        })));
        let pinned_keys = SpeechDraft {
            shared_key_write: Some(SpeechKeyWrite {
                api_key: "sk-for-a".into(),
                base_url: "https://a.example/v1".into(),
            }),
            stt: SpeechDirectionDraft {
                key_write: Some(SpeechKeyWrite {
                    api_key: "sk-stt-a".into(),
                    base_url: "https://stt-a.example/v1".into(),
                }),
                ..SpeechDirectionDraft::default()
            },
            tts: SpeechDirectionDraft {
                key_write: Some(SpeechKeyWrite {
                    api_key: "sk-tts-a".into(),
                    base_url: "https://tts-a.example/v1".into(),
                }),
                // Explicit URL edit overrides the earlier captured URL.
                base_url: Some("https://tts-c.example/v1".into()),
                ..SpeechDirectionDraft::default()
            },
            ..SpeechDraft::default()
        };
        assert_eq!(
            build_speech_patch(&saved_rotated, &pinned_keys, true, None),
            Some(json!({
                "speech": {
                    "apiKey": "sk-for-a",
                    "baseUrl": "https://a.example/v1",
                    "stt": {
                        "apiKey": "sk-stt-a",
                        "baseUrl": "https://stt-a.example/v1",
                        "model": null
                    },
                    "tts": {
                        "apiKey": "sk-tts-a",
                        "baseUrl": "https://tts-c.example/v1",
                        "model": null
                    }
                }
            }))
        );
    }

    #[test]
    fn speech_patch_confirmed_verifies_public_fields_and_null_clears_but_never_secret_writes() {
        let snapshot = json!({
            "speech": {
                "hasApiKey": true,
                "baseUrl": "https://a.example/v1",
                "sttModel": "whisper-1",
                "playbackMode": "buffered",
                "ttsFormat": "wav",
                "ttsVoice": "nova",
                "separateProviders": true,
                "stt": { "hasApiKey": false, "baseUrl": null, "model": "whisper-1" },
                "tts": { "hasApiKey": true, "baseUrl": "https://tts.example/v1", "model": "tts-hd" }
            }
        });
        assert!(speech_patch_confirmed(
            &json!({"speech": {"playbackMode": "buffered", "ttsFormat": "wav", "ttsVoice": "nova"}}),
            &snapshot
        ));
        assert!(speech_patch_confirmed(
            &json!({"speech": {"stt": {"apiKey": null, "baseUrl": null, "model": null}}}),
            &snapshot
        ));
        assert!(!speech_patch_confirmed(
            &json!({"speech": {"apiKey": "sk-new", "baseUrl": "https://a.example/v1"}}),
            &snapshot
        ));
        assert!(!speech_patch_confirmed(
            &json!({"speech": {"tts": {"apiKey": "sk-tts", "baseUrl": "https://tts.example/v1", "model": "tts-hd"}}}),
            &snapshot
        ));
        assert!(!speech_patch_confirmed(
            &json!({"speech": {"playbackMode": "streaming"}}),
            &snapshot
        ));
    }

    #[test]
    fn parse_capabilities_tracks_separate_providers_and_configured_fallbacks() {
        let legacy = parse_speech_capabilities(&json!({
            "available": true,
            "configured": true,
            "provider": "openai-compatible",
            "supportsStt": true,
            "supportsTts": true,
            "supportsStreamingTts": false,
            "sttModel": "whisper-1",
            "ttsModel": "tts-1",
            "ttsVoice": "alloy",
            "ttsFormats": ["mp3"],
            "streamingTtsFormats": []
        }))
        .unwrap();
        assert!(!legacy.supports_separate_providers);
        assert!(legacy.stt_configured);
        assert!(legacy.tts_configured);
        assert!(!legacy.supports_streaming_tts);

        let modern = parse_speech_capabilities(&json!({
            "available": true,
            "configured": false,
            "provider": "openai-compatible",
            "supportsStt": true,
            "supportsTts": true,
            "supportsStreamingTts": true,
            "separateProviders": true,
            "sttConfigured": true,
            "ttsConfigured": false,
            "ttsBaseUrl": "https://tts.example.org:8443/v1"
        }))
        .unwrap();
        assert!(modern.supports_separate_providers);
        assert!(modern.separate_providers);
        assert!(modern.stt_configured);
        assert!(!modern.tts_configured);
        assert_eq!(
            url_display_host(modern.tts_base_url.as_deref().unwrap()).as_deref(),
            Some("tts.example.org:8443")
        );
    }
}
