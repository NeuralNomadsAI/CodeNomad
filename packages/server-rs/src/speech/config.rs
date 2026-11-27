//! Speech configuration resolution, voice-conversation capability projection,
//! and per-profile desktop voice engine/consent YAML stores.
use std::{
    env,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde_json::{Map, Value, json};

use crate::settings::{
    Kind, Settings,
    document::{self, Doc},
    profile,
};

pub(super) const DEFAULT_PROVIDER: &str = "openai-compatible";
pub(super) const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub(super) const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub(super) const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub(super) const DEFAULT_TTS_VOICE: &str = "alloy";
pub(super) const DEFAULT_TTS_FORMAT: &str = "mp3";
pub(super) const LIVE_VOICE_NOTICE_VERSION: u64 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct NormalizedSpeechSettings {
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_format: &'static str,
}

#[derive(Debug)]
pub(super) struct InvalidSpeechConfig;

#[derive(Debug)]
pub(super) enum DesktopStoreError {
    Unavailable,
    Io,
}

static VOICE_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn voice_store_lock() -> &'static Mutex<()> {
    VOICE_STORE_LOCK.get_or_init(|| Mutex::new(()))
}

/// ECMAScript `String.prototype.trim()` whitespace (excludes U+0085 NEL, includes U+FEFF BOM).
pub(super) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    value.map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn env_non_empty(settings: &Settings, key: &str) -> Option<String> {
    #[cfg(test)]
    if let Some((api_key, base_url)) = settings.speech_env_for_test() {
        return match key {
            "OPENAI_API_KEY" => api_key.filter(|s| !s.is_empty()),
            "OPENAI_BASE_URL" => base_url.filter(|s| !s.is_empty()),
            _ => None,
        };
    }
    let _ = settings;
    env::var(key).ok().filter(|s| !s.is_empty())
}

pub(super) fn parse_tts_format(raw: &str) -> Option<&'static str> {
    match raw {
        "mp3" => Some("mp3"),
        "wav" => Some("wav"),
        "opus" => Some("opus"),
        "aac" => Some("aac"),
        _ => None,
    }
}

pub(super) fn parse_voice_engine(raw: &str) -> Option<&'static str> {
    match raw {
        "classic" => Some("classic"),
        "gemini-live" => Some("gemini-live"),
        "openai-realtime" => Some("openai-realtime"),
        _ => None,
    }
}

pub(super) fn parse_live_voice_engine(raw: &str) -> Option<&'static str> {
    match raw {
        "gemini-live" => Some("gemini-live"),
        "openai-realtime" => Some("openai-realtime"),
        _ => None,
    }
}

struct ParsedDirection {
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
}

struct ParsedSpeech {
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    stt_model: Option<String>,
    tts_model: Option<String>,
    tts_voice: Option<String>,
    tts_format: Option<&'static str>,
    separate_providers: bool,
    stt: ParsedDirection,
    tts: ParsedDirection,
}

fn opt_string(map: &Map<String, Value>, key: &str) -> Result<Option<String>, InvalidSpeechConfig> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(InvalidSpeechConfig),
    }
}

fn nullish_string(map: &Map<String, Value>, key: &str) -> Result<Option<String>, InvalidSpeechConfig> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(InvalidSpeechConfig),
    }
}

fn parse_direction(map: &Map<String, Value>, key: &str) -> Result<ParsedDirection, InvalidSpeechConfig> {
    match map.get(key) {
        None => Ok(ParsedDirection { api_key: None, base_url: None, model: None }),
        Some(Value::Object(obj)) => Ok(ParsedDirection {
            api_key: nullish_string(obj, "apiKey")?,
            base_url: nullish_string(obj, "baseUrl")?,
            model: nullish_string(obj, "model")?,
        }),
        Some(_) => Err(InvalidSpeechConfig),
    }
}

fn parse_server_speech(server: &Doc) -> Result<ParsedSpeech, InvalidSpeechConfig> {
    let empty = Map::new();
    let speech = match server.get("speech") {
        None => &empty,
        Some(Value::Object(obj)) => obj,
        Some(_) => return Err(InvalidSpeechConfig),
    };
    let tts_format = match speech.get("ttsFormat") {
        None => None,
        Some(Value::String(s)) => Some(parse_tts_format(s).ok_or(InvalidSpeechConfig)?),
        Some(_) => return Err(InvalidSpeechConfig),
    };
    let separate_providers = match speech.get("separateProviders") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(InvalidSpeechConfig),
    };
    Ok(ParsedSpeech {
        provider: opt_string(speech, "provider")?,
        api_key: opt_string(speech, "apiKey")?,
        base_url: opt_string(speech, "baseUrl")?,
        stt_model: opt_string(speech, "sttModel")?,
        tts_model: opt_string(speech, "ttsModel")?,
        tts_voice: opt_string(speech, "ttsVoice")?,
        tts_format,
        separate_providers,
        stt: parse_direction(speech, "stt")?,
        tts: parse_direction(speech, "tts")?,
    })
}

fn canonical_base_url(raw: &str) -> Option<reqwest::Url> {
    let with_slash = if raw.ends_with('/') { raw.to_owned() } else { format!("{raw}/") };
    let url = reqwest::Url::parse(&with_slash).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

fn env_api_key_for_base_url(settings: &Settings, yaml_base_url: Option<&str>) -> Option<String> {
    let env_key = env_non_empty(settings, "OPENAI_API_KEY")?;
    let Some(yaml_url) = yaml_base_url else {
        return Some(env_key);
    };
    // Allow OPENAI_API_KEY with an explicit YAML baseUrl only when it resolves to the
    // exact host-configured OPENAI_BASE_URL (or OpenAI's default URL when unset), so a
    // remote-patched foreign baseUrl can never exfiltrate the host environment key.
    let candidate = canonical_base_url(yaml_url)?;
    let env_base = env_non_empty(settings, "OPENAI_BASE_URL");
    let trusted = canonical_base_url(env_base.as_deref().unwrap_or(DEFAULT_BASE_URL))?;
    (candidate == trusted).then_some(env_key)
}

fn resolve_shared(settings: &Settings, speech: &ParsedSpeech) -> NormalizedSpeechSettings {
    let shared_base_url = non_empty_trimmed(speech.base_url.as_deref());
    let env_api_key = env_api_key_for_base_url(settings, shared_base_url.as_deref());
    NormalizedSpeechSettings {
        provider: non_empty_trimmed(speech.provider.as_deref()).unwrap_or_else(|| DEFAULT_PROVIDER.into()),
        api_key: non_empty_trimmed(speech.api_key.as_deref()).or(env_api_key),
        base_url: shared_base_url.or_else(|| env_non_empty(settings, "OPENAI_BASE_URL")),
        stt_model: non_empty_trimmed(speech.stt_model.as_deref()).unwrap_or_else(|| DEFAULT_STT_MODEL.into()),
        tts_model: non_empty_trimmed(speech.tts_model.as_deref()).unwrap_or_else(|| DEFAULT_TTS_MODEL.into()),
        tts_voice: non_empty_trimmed(speech.tts_voice.as_deref()).unwrap_or_else(|| DEFAULT_TTS_VOICE.into()),
        tts_format: speech.tts_format.unwrap_or(DEFAULT_TTS_FORMAT),
    }
}

fn resolve_directional(
    settings: &Settings,
    speech: &ParsedSpeech,
    dir: &ParsedDirection,
    is_stt: bool,
) -> NormalizedSpeechSettings {
    if !speech.separate_providers {
        return resolve_shared(settings, speech);
    }
    let shared_base_url = non_empty_trimmed(speech.base_url.as_deref());
    let raw_dir_base_url = non_empty_trimmed(dir.base_url.as_deref());
    let dir_api_key = non_empty_trimmed(dir.api_key.as_deref());
    let dir_base_url = if dir_api_key.is_some() {
        raw_dir_base_url
    } else {
        raw_dir_base_url.filter(|u| shared_base_url.as_deref() != Some(u.as_str()))
    };
    let has_complete = dir_api_key.is_some() && dir_base_url.is_some();
    let has_none = dir_api_key.is_none() && dir_base_url.is_none();
    let api_key = if has_complete {
        dir_api_key
    } else if has_none {
        let env_api_key = env_api_key_for_base_url(settings, shared_base_url.as_deref());
        non_empty_trimmed(speech.api_key.as_deref()).or(env_api_key)
    } else {
        None
    };
    let base_url = if has_complete || has_none {
        dir_base_url.or(shared_base_url).or_else(|| env_non_empty(settings, "OPENAI_BASE_URL"))
    } else {
        dir_base_url
    };
    let dir_model = non_empty_trimmed(dir.model.as_deref());
    let (stt_model, tts_model) = if is_stt {
        (
            dir_model
                .or_else(|| non_empty_trimmed(speech.stt_model.as_deref()))
                .unwrap_or_else(|| DEFAULT_STT_MODEL.into()),
            non_empty_trimmed(speech.tts_model.as_deref()).unwrap_or_else(|| DEFAULT_TTS_MODEL.into()),
        )
    } else {
        (
            non_empty_trimmed(speech.stt_model.as_deref()).unwrap_or_else(|| DEFAULT_STT_MODEL.into()),
            dir_model
                .or_else(|| non_empty_trimmed(speech.tts_model.as_deref()))
                .unwrap_or_else(|| DEFAULT_TTS_MODEL.into()),
        )
    };
    NormalizedSpeechSettings {
        provider: non_empty_trimmed(speech.provider.as_deref()).unwrap_or_else(|| DEFAULT_PROVIDER.into()),
        api_key,
        base_url,
        stt_model,
        tts_model,
        tts_voice: non_empty_trimmed(speech.tts_voice.as_deref()).unwrap_or_else(|| DEFAULT_TTS_VOICE.into()),
        tts_format: speech.tts_format.unwrap_or(DEFAULT_TTS_FORMAT),
    }
}

pub(super) fn resolve_stt_settings(settings: &Settings) -> Result<NormalizedSpeechSettings, InvalidSpeechConfig> {
    let server = settings.owner(Kind::Config, "server");
    let speech = parse_server_speech(&server)?;
    Ok(resolve_directional(settings, &speech, &speech.stt, true))
}

pub(super) fn resolve_tts_settings(settings: &Settings) -> Result<NormalizedSpeechSettings, InvalidSpeechConfig> {
    let server = settings.owner(Kind::Config, "server");
    let speech = parse_server_speech(&server)?;
    Ok(resolve_directional(settings, &speech, &speech.tts, false))
}

fn has_desktop_identity(settings: &Settings) -> bool {
    #[cfg(test)]
    if let Some((ref identity, _)) = settings.desktop_voice_env_for_test() {
        return identity.as_deref().is_some_and(|s| !s.is_empty());
    }
    let _ = settings;
    env::var_os("CODENOMAD_PROFILE_CONFIG_IDENTITY").is_some_and(|v| !v.is_empty())
}

fn desktop_voice_dir(settings: &Settings) -> Result<Option<PathBuf>, DesktopStoreError> {
    if !has_desktop_identity(settings) {
        return Ok(None);
    }
    #[cfg(test)]
    if let Some((ref identity, ref channel)) = settings.desktop_voice_env_for_test() {
        let scope = profile::scope_for_test(&settings.location.config, channel, identity.as_deref())
            .ok_or(DesktopStoreError::Unavailable)?;
        return Ok(Some(settings.location.base.join("voice").join(scope.key)));
    }
    let scope = profile::scope(&settings.location.config).ok_or(DesktopStoreError::Unavailable)?;
    Ok(Some(settings.location.base.join("voice").join(scope.key)))
}

pub(super) fn read_desktop_engine(settings: &Settings) -> Result<Option<&'static str>, DesktopStoreError> {
    let Some(dir) = desktop_voice_dir(settings)? else {
        return Ok(None);
    };
    let _lock = voice_store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let doc = document::read(&dir.join("engine.yaml")).map_err(|_| DesktopStoreError::Io)?;
    let selection = match doc.get("selection") {
        None => return Ok(Some("classic")),
        Some(Value::Object(obj)) => obj,
        Some(_) => return Err(DesktopStoreError::Io),
    };
    match selection.get("engine") {
        None => Ok(Some("classic")),
        Some(Value::String(s)) => parse_voice_engine(s).map(Some).ok_or(DesktopStoreError::Io),
        Some(_) => Err(DesktopStoreError::Io),
    }
}

pub(super) fn write_desktop_engine(
    settings: &Settings,
    engine: &'static str,
) -> Result<Option<&'static str>, DesktopStoreError> {
    let Some(dir) = desktop_voice_dir(settings)? else {
        return Ok(None);
    };
    let _lock = voice_store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = Doc::new();
    doc.insert("selection".into(), json!({ "engine": engine }));
    document::write(&dir.join("engine.yaml"), &doc).map_err(|_| DesktopStoreError::Io)?;
    Ok(Some(engine))
}

pub(super) fn read_desktop_consent(settings: &Settings, engine: &str) -> Result<Option<u64>, DesktopStoreError> {
    let Some(dir) = desktop_voice_dir(settings)? else {
        return Ok(None);
    };
    let _lock = voice_store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let Ok(doc) = document::read(&dir.join(format!("consent-{engine}.yaml"))) else {
        return Ok(None);
    };
    let version = doc.get("notice").and_then(Value::as_object).and_then(|o| o.get("version")).and_then(Value::as_f64);
    Ok((version == Some(LIVE_VOICE_NOTICE_VERSION as f64)).then_some(LIVE_VOICE_NOTICE_VERSION))
}

pub(super) fn write_desktop_consent(settings: &Settings, engine: &str) -> Result<Option<u64>, DesktopStoreError> {
    let Some(dir) = desktop_voice_dir(settings)? else {
        return Ok(None);
    };
    let _lock = voice_store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut doc = Doc::new();
    doc.insert("notice".into(), json!({ "version": LIVE_VOICE_NOTICE_VERSION }));
    document::write(&dir.join(format!("consent-{engine}.yaml")), &doc).map_err(|_| DesktopStoreError::Io)?;
    Ok(Some(LIVE_VOICE_NOTICE_VERSION))
}

pub(super) fn capabilities_json(settings: &Settings, is_local: bool) -> Result<Value, ()> {
    let server = settings.owner(Kind::Config, "server");
    let speech = parse_server_speech(&server).map_err(|_| ())?;
    let separate = speech.separate_providers;
    let stt = resolve_directional(settings, &speech, &speech.stt, true);
    let tts = resolve_directional(settings, &speech, &speech.tts, false);
    let stt_configured = stt.api_key.is_some();
    let tts_configured = tts.api_key.is_some();
    let configured = if separate { stt_configured && tts_configured } else { stt_configured || tts_configured };
    let shared_base_url = if separate {
        None
    } else {
        non_empty_trimmed(speech.base_url.as_deref()).or_else(|| env_non_empty(settings, "OPENAI_BASE_URL"))
    };
    let desktop_engine = is_local && has_desktop_identity(settings);

    let mut out = Map::new();
    out.insert("available".into(), json!(true));
    out.insert("configured".into(), json!(configured));
    out.insert("provider".into(), json!(stt.provider));
    out.insert("supportsStt".into(), json!(true));
    out.insert("supportsTts".into(), json!(true));
    out.insert("supportsStreamingTts".into(), json!(true));
    if let Some(url) = shared_base_url {
        out.insert("baseUrl".into(), json!(url));
    }
    out.insert("sttModel".into(), json!(stt.stt_model));
    out.insert("ttsModel".into(), json!(tts.tts_model));
    out.insert("ttsVoice".into(), json!(tts.tts_voice));
    out.insert("ttsFormats".into(), json!(["mp3", "wav", "opus", "aac"]));
    out.insert("streamingTtsFormats".into(), json!(["mp3", "wav", "opus", "aac"]));
    out.insert("separateProviders".into(), json!(separate));
    out.insert("sttConfigured".into(), json!(stt_configured));
    out.insert("ttsConfigured".into(), json!(tts_configured));
    out.insert("desktopVoiceConversationEngine".into(), json!(desktop_engine));
    if separate {
        if let Some(url) = stt.base_url {
            out.insert("sttBaseUrl".into(), json!(url));
        }
        if let Some(url) = tts.base_url {
            out.insert("ttsBaseUrl".into(), json!(url));
        }
    }
    // Omit `voiceConversation` while the live voice WebSocket `/api/speech/conversation/live`
    // is not served here: the UI treats absence as unsupported instead of attempting a doomed upgrade.
    if desktop_engine {
        let mut consent = Map::new();
        for engine in ["gemini-live", "openai-realtime"] {
            if let Some(version) = read_desktop_consent(settings, engine).map_err(|_| ())? {
                consent.insert(engine.into(), json!(version));
            }
        }
        out.insert("desktopLiveVoiceConsent".into(), Value::Object(consent));
    }
    Ok(Value::Object(out))
}
