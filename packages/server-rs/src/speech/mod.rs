//! `/api/speech/*` routes matching `packages/server/src/server/routes/speech.ts`.
mod config;
mod provider;
#[cfg(test)]
mod tests;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode as Status, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::{
    Error, Shared,
    auth::{Principal, tls},
    error,
    opencode::proxy_body,
    shared::{CancelWrite, fastify},
};

use config::{
    LIVE_VOICE_NOTICE_VERSION, capabilities_json, js_trim, parse_live_voice_engine, parse_tts_format,
    parse_voice_engine, read_desktop_engine, resolve_stt_settings, resolve_tts_settings, write_desktop_consent,
    write_desktop_engine,
};
use provider::{ProviderError, SynthesizeInput, TranscribeInput, decode_audio_base64};

const TRANSCRIPTION_BODY_LIMIT: usize = 1024 * 1024;
const SYNTHESIZE_BODY_LIMIT: usize = 1024 * 1024;
const CONTROL_BODY_LIMIT: usize = 1024 * 1024;
const NOT_CONFIGURED_MESSAGE: &str = "Speech provider is not configured. Add an API key in Speech settings.";

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/api/speech/capabilities", get(capabilities))
        .route(
            "/api/speech/conversation/engine",
            get(get_engine).patch(patch_engine).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/speech/conversation/consent", put(put_consent).layer(DefaultBodyLimit::disable()))
        .route("/api/speech/transcribe", post(transcribe).layer(DefaultBodyLimit::disable()))
        .route("/api/speech/synthesize/stream", post(synthesize_stream).layer(DefaultBodyLimit::disable()))
}

async fn read_fastify_json(request: Request, limit: usize, principal: &Principal) -> Result<Value, Error> {
    let (head, body) = request.into_parts();
    let declared =
        head.headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|len| len > limit) {
        tokio::select! {
            biased;
            _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
            _ = proxy_body::read(body, limit, declared) => {}
        }
        principal.live()?;
        return Err(proxy_body::too_large());
    }
    let bytes = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Err(crate::auth::unauthorized()),
        res = proxy_body::read(body, limit, declared) => res?,
    };
    principal.live()?;
    match fastify::body(&head.headers, &bytes)? {
        None => Ok(json!({})),
        Some(fastify::Body::Json(value)) => Ok(value),
        Some(fastify::Body::Text(text)) => Ok(Value::String(text)),
    }
}

async fn capabilities(
    State(app): State<Shared>,
    channel: Option<Extension<tls::Channel>>,
) -> Result<Json<Value>, Error> {
    let is_local = channel.is_none();
    let payload = capabilities_json(&app.settings, is_local)
        .map_err(|_| error(Status::SERVICE_UNAVAILABLE, "Speech capabilities unavailable"))?;
    Ok(Json(payload))
}

async fn get_engine(State(app): State<Shared>, channel: Option<Extension<tls::Channel>>) -> Result<Response, Error> {
    if channel.is_some() {
        return Ok(Status::NOT_FOUND.into_response());
    }
    match read_desktop_engine(&app.settings) {
        Ok(Some(engine)) => Ok(Json(json!({ "engine": engine })).into_response()),
        Ok(None) => Ok(Status::NOT_FOUND.into_response()),
        Err(_) => Err(error(Status::SERVICE_UNAVAILABLE, "Conversation engine unavailable")),
    }
}

async fn patch_engine(
    State(app): State<Shared>,
    channel: Option<Extension<tls::Channel>>,
    request: Request,
) -> Result<Response, Error> {
    if channel.is_some() {
        return Ok(Status::NOT_FOUND.into_response());
    }
    let principal = request.extensions().get::<Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let value = read_fastify_json(request, CONTROL_BODY_LIMIT, &principal).await?;
    let engine = value
        .as_object()
        .filter(|obj| obj.len() == 1)
        .and_then(|obj| obj.get("engine"))
        .and_then(Value::as_str)
        .and_then(parse_voice_engine)
        .ok_or_else(|| error(Status::BAD_REQUEST, "Invalid conversation engine"))?;
    principal.live()?;
    match write_desktop_engine(&app.settings, engine) {
        Ok(Some(saved)) => Ok(Json(json!({ "engine": saved })).into_response()),
        Ok(None) => Ok(Status::NOT_FOUND.into_response()),
        Err(_) => Err(error(Status::SERVICE_UNAVAILABLE, "Conversation engine could not be saved")),
    }
}

async fn put_consent(
    State(app): State<Shared>,
    channel: Option<Extension<tls::Channel>>,
    request: Request,
) -> Result<Response, Error> {
    if channel.is_some() {
        return Ok(Status::NOT_FOUND.into_response());
    }
    let principal = request.extensions().get::<Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let value = read_fastify_json(request, CONTROL_BODY_LIMIT, &principal).await?;
    let invalid = || error(Status::BAD_REQUEST, "Invalid voice notice");
    let obj = value.as_object().filter(|o| o.len() == 2).ok_or_else(invalid)?;
    let engine = obj.get("engine").and_then(Value::as_str).and_then(parse_live_voice_engine).ok_or_else(invalid)?;
    let version_ok = obj.get("version").and_then(Value::as_f64).is_some_and(|v| v == LIVE_VOICE_NOTICE_VERSION as f64);
    if !version_ok {
        return Err(invalid());
    }
    principal.live()?;
    match write_desktop_consent(&app.settings, engine) {
        Ok(Some(_)) => Ok(Status::NO_CONTENT.into_response()),
        Ok(None) => Ok(Status::NOT_FOUND.into_response()),
        Err(_) => Err(error(Status::SERVICE_UNAVAILABLE, "Voice consent could not be saved")),
    }
}

struct RawTranscribeInput {
    audio_b64: String,
    mime_type: String,
    filename: Option<String>,
    language: Option<String>,
    prompt: Option<String>,
}

fn parse_transcribe_input(value: &Value) -> Result<RawTranscribeInput, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Failed to transcribe audio");
    let obj = value.as_object().ok_or_else(invalid)?;
    let audio_b64 = obj.get("audioBase64").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(invalid)?;
    let mime_type = obj
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.bytes().any(|b| b < 0x20 || b == 0x7f))
        .ok_or_else(invalid)?;
    let opt_str = |key: &str| -> Result<Option<String>, Error> {
        match obj.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(invalid()),
        }
    };
    let filename = opt_str("filename")?;
    let language = opt_str("language")?;
    let prompt = opt_str("prompt")?;
    Ok(RawTranscribeInput {
        audio_b64: audio_b64.to_owned(),
        mime_type: mime_type.to_owned(),
        filename,
        language,
        prompt,
    })
}

fn parse_synthesize_input(value: &Value) -> Result<SynthesizeInput, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Failed to stream synthesized audio");
    let obj = value.as_object().ok_or_else(invalid)?;
    let text = obj
        .get("text")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)?;
    let format = match obj.get("format") {
        None => None,
        Some(Value::String(s)) => Some(parse_tts_format(s).ok_or_else(invalid)?),
        Some(_) => return Err(invalid()),
    };
    Ok(SynthesizeInput { text, format })
}

fn map_provider_error(err: ProviderError, fallback: &str) -> Error {
    match err {
        ProviderError::NotConfigured => error(Status::SERVICE_UNAVAILABLE, NOT_CONFIGURED_MESSAGE),
        ProviderError::Cancelled => crate::auth::unauthorized(),
        ProviderError::Upstream => error(Status::BAD_GATEWAY, fallback),
    }
}

async fn transcribe(State(app): State<Shared>, request: Request) -> Result<Json<Value>, Error> {
    let principal = request.extensions().get::<Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let value = read_fastify_json(request, TRANSCRIPTION_BODY_LIMIT, &principal).await?;
    let raw = parse_transcribe_input(&value)?;
    principal.live()?;
    let settings =
        resolve_stt_settings(&app.settings).map_err(|_| error(Status::BAD_REQUEST, "Failed to transcribe audio"))?;
    if settings.api_key.is_none() {
        return Err(error(Status::SERVICE_UNAVAILABLE, NOT_CONFIGURED_MESSAGE));
    }
    let audio =
        decode_audio_base64(&raw.audio_b64).map_err(|_| error(Status::BAD_REQUEST, "Failed to transcribe audio"))?;
    let input = TranscribeInput {
        audio,
        mime_type: raw.mime_type,
        filename: raw.filename,
        language: raw.language,
        prompt: raw.prompt,
    };
    let result = provider::transcribe(&settings, input, &principal.0)
        .await
        .map_err(|err| map_provider_error(err, "Failed to transcribe audio"))?;
    principal.live()?;
    Ok(Json(result))
}

async fn synthesize_stream(State(app): State<Shared>, request: Request) -> Result<Response, Error> {
    let principal = request.extensions().get::<Principal>().cloned().ok_or_else(crate::auth::unauthorized)?;
    let value = read_fastify_json(request, SYNTHESIZE_BODY_LIMIT, &principal).await?;
    let input = parse_synthesize_input(&value)?;
    principal.live()?;
    let settings = resolve_tts_settings(&app.settings)
        .map_err(|_| error(Status::BAD_REQUEST, "Failed to stream synthesized audio"))?;
    let stream_res = provider::synthesize_stream(&settings, input, &principal.0)
        .await
        .map_err(|err| map_provider_error(err, "Failed to stream synthesized audio"))?;
    principal.live()?;

    let cancel = principal.0.clone();
    let mut upstream = stream_res.response.bytes_stream();
    let body = Body::from_stream(async_stream::stream! {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    drop(upstream);
                    yield Err(axum::Error::new(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "speech synthesis stream aborted",
                    )));
                    return;
                }
                chunk = upstream.next() => match chunk {
                    Some(Ok(bytes)) => yield Ok(bytes),
                    Some(Err(err)) => {
                        yield Err(axum::Error::new(err));
                        return;
                    }
                    None => return,
                }
            }
        }
    });

    Response::builder()
        .status(Status::OK)
        .header(header::CONTENT_TYPE, stream_res.mime_type)
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .extension(CancelWrite::token(principal.0))
        .body(body)
        .map_err(|_| error(Status::BAD_GATEWAY, "Failed to stream synthesized audio"))
}
