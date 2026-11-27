//! OpenAI-compatible HTTP provider for STT (`POST /audio/transcriptions`) and
//! streaming TTS (`POST /audio/speech`), with manual multipart encoding and zero credential logging.
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

use axum::http::HeaderValue;
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use regex::Regex;
use reqwest::{Client, Url, header};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::config::{DEFAULT_BASE_URL, NormalizedSpeechSettings, js_trim};

const MAX_TRANSCRIPTION_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

pub(super) struct TranscribeInput {
    pub audio: Vec<u8>,
    pub mime_type: String,
    pub filename: Option<String>,
    pub language: Option<String>,
    pub prompt: Option<String>,
}

pub(super) struct SynthesizeInput {
    pub text: String,
    pub format: Option<&'static str>,
}

pub(super) struct SynthesizeStream {
    pub response: reqwest::Response,
    pub mime_type: HeaderValue,
}

#[derive(Debug)]
pub(super) enum ProviderError {
    NotConfigured,
    Cancelled,
    Upstream,
}

static SPEECH_CLIENT: OnceLock<Client> = OnceLock::new();
static SPEECH_LOOPBACK_CLIENT: OnceLock<Client> = OnceLock::new();
static FORMAT_REJECTION_RE: OnceLock<Regex> = OnceLock::new();

fn is_loopback_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    trimmed.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn same_origin_redirect_policy() -> reqwest::redirect::Policy {
    // Only follow same-origin redirects (scheme + host + port) so Authorization
    // is never sent in cleartext on HTTPS -> HTTP downgrades or to foreign origins.
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() < 10
            && attempt
                .previous()
                .first()
                .is_some_and(|origin| origin.origin().is_tuple() && origin.origin() == attempt.url().origin())
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

fn http_client(url: &Url) -> Result<&'static Client, ProviderError> {
    let loopback = is_loopback_url(url);
    let slot = if loopback { &SPEECH_LOOPBACK_CLIENT } else { &SPEECH_CLIENT };
    if let Some(client) = slot.get() {
        return Ok(client);
    }
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(300))
        .redirect(same_origin_redirect_policy());
    if loopback {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| ProviderError::Upstream)?;
    Ok(slot.get_or_init(|| client))
}

fn format_rejection_regex() -> &'static Regex {
    FORMAT_REJECTION_RE.get_or_init(|| Regex::new(r"(?i)response[ _-]format|verbose_json").unwrap())
}

pub(super) fn decode_audio_base64(raw: &str) -> Result<Vec<u8>, ()> {
    // Accept both standard (+/) and URL-safe (-_) Base64 alphabets like Node's Buffer.from(..., "base64").
    let mut normalized = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_whitespace() {
            continue;
        }
        normalized.push(match ch {
            '-' => '+',
            '_' => '/',
            other => other,
        });
    }
    if normalized.is_empty() {
        return Err(());
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let bytes = engine.decode(normalized).map_err(|_| ())?;
    if bytes.is_empty() {
        return Err(());
    }
    Ok(bytes)
}

fn endpoint_url(base_url: Option<&str>, path: &str) -> Result<Url, ProviderError> {
    let raw = base_url.unwrap_or(DEFAULT_BASE_URL);
    let with_slash = if raw.ends_with('/') { raw.to_owned() } else { format!("{raw}/") };
    let base = Url::parse(&with_slash).map_err(|_| ProviderError::Upstream)?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err(ProviderError::Upstream);
    }
    base.join(path).map_err(|_| ProviderError::Upstream)
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    let normalized = mime_type.to_ascii_lowercase();
    if normalized.contains("webm") {
        "webm"
    } else if normalized.contains("ogg") {
        "ogg"
    } else if normalized.contains("wav") {
        "wav"
    } else if normalized.contains("mpeg") || normalized.contains("mp3") {
        "mp3"
    } else if normalized.contains("mp4") || normalized.contains("aac") {
        "m4a"
    } else {
        "webm"
    }
}

fn mime_type_for_format(format: &str) -> HeaderValue {
    match format {
        "wav" => HeaderValue::from_static("audio/wav"),
        "opus" => HeaderValue::from_static("audio/ogg; codecs=\"opus\""),
        "aac" => HeaderValue::from_static("audio/aac"),
        _ => HeaderValue::from_static("audio/mpeg"),
    }
}

fn sanitize_header_filename(raw: &str) -> String {
    raw.chars()
        .filter(|&c| c != '\r' && c != '\n' && c != '\0')
        .map(|c| if c == '"' || c == '\\' { '_' } else { c })
        .collect()
}

fn build_multipart_body(
    boundary: &str,
    model: &str,
    language: Option<&str>,
    prompt: Option<&str>,
    filename: &str,
    mime_type: &str,
    audio: &[u8],
    verbose_json: bool,
) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    let push_field = |buf: &mut Vec<u8>, name: &str, value: &str| {
        buf.extend_from_slice(b"--");
        buf.extend_from_slice(boundary.as_bytes());
        buf.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"");
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(b"\"\r\n\r\n");
        buf.extend_from_slice(value.as_bytes());
        buf.extend_from_slice(b"\r\n");
    };
    push_field(&mut body, "model", model);
    if let Some(lang) = language.filter(|s| !s.is_empty()) {
        push_field(&mut body, "language", lang);
    }
    if let Some(p) = prompt.filter(|s| !s.is_empty()) {
        push_field(&mut body, "prompt", p);
    }
    if verbose_json {
        push_field(&mut body, "response_format", "verbose_json");
    }
    body.extend_from_slice(b"--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"");
    body.extend_from_slice(sanitize_header_filename(filename).as_bytes());
    body.extend_from_slice(b"\"\r\nContent-Type: ");
    body.extend_from_slice(mime_type.as_bytes());
    body.extend_from_slice(b"\r\n\r\n");
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"--\r\n");
    body
}

async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, ProviderError> {
    let mut out = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            chunk = response.chunk() => chunk.map_err(|_| ProviderError::Upstream)?,
        };
        let Some(chunk) = next else {
            return Ok(out);
        };
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(ProviderError::Upstream);
        }
        out.extend_from_slice(&chunk);
    }
}

fn is_response_format_rejection(status: u16, body: &[u8]) -> bool {
    if status != 400 && status != 422 {
        return false;
    }
    if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
        let err_obj = parsed.get("error").and_then(Value::as_object);
        let param = err_obj.and_then(|o| o.get("param")).or_else(|| parsed.get("param")).and_then(Value::as_str);
        if param == Some("response_format") {
            return true;
        }
        let message = err_obj.and_then(|o| o.get("message")).or_else(|| parsed.get("message")).and_then(Value::as_str);
        if let Some(msg) = message {
            return format_rejection_regex().is_match(msg);
        }
    }
    std::str::from_utf8(body).is_ok_and(|text| format_rejection_regex().is_match(text))
}

async fn send_transcription(
    url: &Url,
    api_key: &str,
    settings: &NormalizedSpeechSettings,
    input: &TranscribeInput,
    filename: &str,
    verbose_json: bool,
    cancel: &CancellationToken,
) -> Result<(u16, Vec<u8>), ProviderError> {
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let boundary = format!("----CodeNomadSpeech{}", Uuid::new_v4().simple());
    let payload = build_multipart_body(
        &boundary,
        &settings.stt_model,
        input.language.as_deref(),
        input.prompt.as_deref(),
        filename,
        &input.mime_type,
        &input.audio,
        verbose_json,
    );
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let request = http_client(url)?
        .post(url.clone())
        .bearer_auth(api_key)
        .header(header::CONTENT_TYPE, content_type)
        .body(payload);
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
        sent = request.send() => sent.map_err(|_| ProviderError::Upstream)?,
    };
    let status = response.status().as_u16();
    let limit = if (200..300).contains(&status) { MAX_TRANSCRIPTION_RESPONSE_BYTES } else { MAX_ERROR_BODY_BYTES };
    let bytes = read_bounded(response, limit, cancel).await?;
    Ok((status, bytes))
}

pub(super) async fn transcribe(
    settings: &NormalizedSpeechSettings,
    input: TranscribeInput,
    cancel: &CancellationToken,
) -> Result<Value, ProviderError> {
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let api_key = settings.api_key.as_deref().ok_or(ProviderError::NotConfigured)?;
    let url = endpoint_url(settings.base_url.as_deref(), "audio/transcriptions")?;
    let started_at = Instant::now();
    let extension = extension_for_mime(&input.mime_type);
    let filename = input
        .filename
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("prompt-input.{extension}"));

    let (status, bytes) = send_transcription(&url, api_key, settings, &input, &filename, true, cancel).await?;
    let (status, bytes) = if !(200..300).contains(&status) && is_response_format_rejection(status, &bytes) {
        send_transcription(&url, api_key, settings, &input, &filename, false, cancel).await?
    } else {
        (status, bytes)
    };
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    if !(200..300).contains(&status) {
        return Err(ProviderError::Upstream);
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| ProviderError::Upstream)?;

    let text = parsed.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
    let language = parsed.get("language").and_then(Value::as_str).map(str::to_owned).or(input.language);
    let duration_ms = match parsed.get("duration").and_then(Value::as_f64).filter(|d| d.is_finite()) {
        Some(seconds) => (seconds * 1000.0).round() as i64,
        None => started_at.elapsed().as_millis() as i64,
    };
    let segments = parsed.get("segments").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|seg| {
                let text = seg.get("text").and_then(Value::as_str)?;
                let start_ms =
                    (seg.get("start").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0).round().max(0.0) as u64;
                let end_ms = (seg.get("end").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0).round().max(0.0) as u64;
                Some(json!({ "startMs": start_ms, "endMs": end_ms, "text": text }))
            })
            .collect::<Vec<_>>()
    });

    let mut out = Map::new();
    out.insert("text".into(), json!(text));
    if let Some(lang) = language {
        out.insert("language".into(), json!(lang));
    }
    out.insert("durationMs".into(), json!(duration_ms));
    if let Some(segs) = segments {
        out.insert("segments".into(), Value::Array(segs));
    }
    Ok(Value::Object(out))
}

pub(super) async fn synthesize_stream(
    settings: &NormalizedSpeechSettings,
    input: SynthesizeInput,
    cancel: &CancellationToken,
) -> Result<SynthesizeStream, ProviderError> {
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let api_key = settings.api_key.as_deref().ok_or(ProviderError::NotConfigured)?;
    let format = input.format.unwrap_or(settings.tts_format);
    let url = endpoint_url(settings.base_url.as_deref(), "audio/speech")?;
    let payload = json!({
        "model": settings.tts_model,
        "voice": settings.tts_voice,
        "input": input.text,
        "response_format": format,
    });
    let request = http_client(&url)?.post(url).bearer_auth(api_key).json(&payload);
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
        sent = request.send() => sent.map_err(|_| ProviderError::Upstream)?,
    };
    if cancel.is_cancelled() {
        drop(response);
        return Err(ProviderError::Cancelled);
    }
    let status = response.status();
    if !status.is_success() || matches!(status, reqwest::StatusCode::NO_CONTENT | reqwest::StatusCode::RESET_CONTENT) {
        drop(response);
        return Err(ProviderError::Upstream);
    }
    let mime_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.bytes().any(|b| b < 0x20 || b == 0x7f))
        .and_then(|s| HeaderValue::from_str(s).ok())
        .unwrap_or_else(|| mime_type_for_format(format));
    Ok(SynthesizeStream { response, mime_type })
}
