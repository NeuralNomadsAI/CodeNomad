//! Deferred passive tool images, pinned to raw data URI and native content position.
use axum::{
    Extension,
    extract::{OriginalUri, State},
    http::{HeaderValue, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::time::Duration;

use super::{history::Placement, user_files};
use crate::{Error, Shared, auth::Principal, error};

const URI_LIMIT: usize = 8 * 1024 * 1024;
const MESSAGE_LIMIT: usize = 16 * 1024 * 1024;
const INLINE_LIMIT: usize = 32 * 1024;

pub(super) fn encode(id: &str) -> String {
    let mut encoded = String::new();
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.encode_utf16().nth(256).is_none() && !id.bytes().any(|byte| byte.is_ascii_control())
}

struct Reference<'a> {
    workspace: String,
    session: String,
    message: String,
    part: usize,
    index: usize,
    digest: &'a str,
}

fn parse(path: &str) -> Option<Reference<'_>> {
    if path.len() > 4096 {
        return None;
    }
    let segments: [&str; 7] = path.strip_prefix("/api/workspaces/")?.split('/').collect::<Vec<_>>().try_into().ok()?;
    let [workspace, "session-media", session, message, part, index, digest] = segments else { return None };
    let decode_id = |segment: &str| {
        let id = percent_encoding::percent_decode_str(segment).decode_utf8().ok()?;
        (valid_id(&id) && encode(&id) == segment).then(|| id.into_owned())
    };
    let number = |segment: &str| {
        segment.parse::<usize>().ok().filter(|&number| number <= 100_000 && number.to_string() == segment)
    };
    user_files::valid_digest(digest).then_some(())?;
    Some(Reference {
        workspace: decode_id(workspace)?,
        session: decode_id(session)?,
        message: decode_id(message)?,
        part: number(part)?,
        index: number(index)?,
        digest,
    })
}

fn renderable_parts<'a>(file_type: &str, mime: &'a str, uri: &'a str) -> Option<(&'a str, &'a str)> {
    let (kind, subtype) = mime.split_once('/')?;
    if file_type != "file"
        || !kind.eq_ignore_ascii_case("image")
        || mime.len() > 128
        || subtype.is_empty()
        || !subtype.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
        || uri.len() > URI_LIMIT && uri.encode_utf16().nth(URI_LIMIT).is_some()
    {
        return None;
    }
    let prefix = format!("data:{mime};base64,");
    uri.get(..prefix.len()).is_some_and(|start| start.eq_ignore_ascii_case(&prefix)).then_some((mime, uri))
}

fn renderable(file: &Value) -> Option<(&str, &str)> {
    renderable_parts(file["type"].as_str()?, file["mime"].as_str()?, file["uri"].as_str()?)
}

pub(super) fn defer_uri(
    workspace_enc: &str,
    session_enc: &str,
    message_enc: &str,
    part: usize,
    index: usize,
    file_type: &str,
    mime: &str,
    uri: &str,
) -> Option<String> {
    let (_, uri) =
        renderable_parts(file_type, mime, uri).filter(|(_, uri)| uri.encode_utf16().nth(INLINE_LIMIT).is_some())?;
    let digest = user_files::digest(uri.as_bytes());
    let reference =
        format!("/api/workspaces/{workspace_enc}/session-media/{session_enc}/{message_enc}/{part}/{index}/{digest}");
    (reference.len() <= 4096).then_some(reference)
}

pub(crate) fn wants_deferred(headers: &axum::http::HeaderMap) -> bool {
    headers.get_all("x-codenomad-media").iter().eq(["deferred"])
}

pub(super) fn defer_message(workspace_enc: &str, session_enc: &str, message: &mut Value) -> bool {
    if message["type"] != "assistant" {
        return false;
    }
    let Some(id) = message["id"].as_str().filter(|id| valid_id(id)).map(encode) else { return false };
    let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else { return false };
    let mut changed = false;
    for (part, tool) in parts.iter_mut().take(100_001).enumerate() {
        if tool["type"] != "tool" {
            continue;
        }
        let Some(content) =
            tool.get_mut("state").and_then(|state| state.get_mut("content")).and_then(Value::as_array_mut)
        else {
            continue;
        };
        for (index, file) in content.iter_mut().take(100_001).enumerate() {
            let Some((_, uri)) = renderable(file).filter(|(_, uri)| uri.encode_utf16().nth(INLINE_LIMIT).is_some())
            else {
                continue;
            };
            let digest = user_files::digest(uri.as_bytes());
            let reference =
                format!("/api/workspaces/{workspace_enc}/session-media/{session_enc}/{id}/{part}/{index}/{digest}");
            if reference.len() <= 4096 {
                file["uri"] = reference.into();
                changed = true;
            }
        }
    }
    changed
}

pub(crate) fn defer(workspace: &str, session: &str, messages: &mut Value) -> bool {
    if !valid_id(workspace) || !valid_id(session) {
        return false;
    }
    let (workspace, session) = (encode(workspace), encode(session));
    let mut changed = false;
    for message in messages.as_array_mut().into_iter().flatten() {
        changed |= defer_message(&workspace, &session, message);
    }
    changed
}

fn parse_message_envelope(raw: &[u8]) -> Result<Value, Error> {
    let unavailable = || error(Status::BAD_GATEWAY, "Media unavailable");
    serde_json::from_slice(raw).map_err(|_| unavailable())
}

fn extract_media_from_envelope(
    message_id: &str,
    part_index: usize,
    item_index: usize,
    digest: &str,
    revert_boundary: Option<&str>,
    envelope: &Value,
) -> Result<(&'static str, Vec<u8>), Error> {
    let missing = || error(Status::NOT_FOUND, "Media not found");
    let unavailable = || error(Status::BAD_GATEWAY, "Media unavailable");
    let data = envelope.get("data").filter(|value| !value.is_null()).ok_or_else(unavailable)?;
    let message = data.as_object().map(|_| data).ok_or_else(missing)?;
    if message["id"] != message_id
        || message["type"] != "assistant"
        || revert_boundary.is_some_and(|boundary| message_id.encode_utf16().cmp(boundary.encode_utf16()).is_ge())
    {
        return Err(missing());
    }
    let part = &message["content"][part_index];
    if part["type"] != "tool" {
        return Err(missing());
    }
    let (mime, uri) = renderable(&part["state"]["content"][item_index]).ok_or_else(missing)?;
    if user_files::digest(uri.as_bytes()) != digest {
        return Err(missing());
    }
    let prefix = format!("data:{mime};base64,");
    let payload = uri.strip_prefix(&prefix).ok_or_else(missing)?;
    if payload.len() % 4 != 0 {
        return Err(missing());
    }
    let bytes = STANDARD.decode(payload).map_err(|_| missing())?;
    let mime = raster(&bytes).filter(|&detected| detected == mime).ok_or_else(missing)?;
    Ok((mime, bytes))
}

#[cfg(test)]
fn extract_media(
    message_id: &str,
    part_index: usize,
    item_index: usize,
    digest: &str,
    revert_boundary: Option<&str>,
    raw: &[u8],
) -> Result<(&'static str, Vec<u8>), Error> {
    let envelope = parse_message_envelope(raw)?;
    extract_media_from_envelope(message_id, part_index, item_index, digest, revert_boundary, &envelope)
}

pub(super) async fn route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    OriginalUri(uri): OriginalUri,
) -> Result<Response, Error> {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    principal.live()?;
    let invalid = || error(Status::BAD_REQUEST, "Invalid media reference");
    let reference = uri.query().is_none().then(|| parse(uri.path())).flatten().ok_or_else(invalid)?;
    let missing = || error(Status::NOT_FOUND, "Media not found");
    let unavailable = || error(Status::BAD_GATEWAY, "Media unavailable");
    // Verify workspace existence before arming the close watcher so a missing
    // workspace returns 404 (TS `session-media.ts:45-46`).
    let initial_workspace = app.workspace(&reference.workspace).map_err(|_| missing())?;
    let request = async {
        let r = &reference;
        // Acquire the concurrency slot before ownership/native reads so waiting
        // requests neither spawn Git probes nor hold open native responses.
        let slot = SLOTS.acquire().await.map_err(|_| unavailable())?;
        if app.workspace(&r.workspace).ok().as_ref().map(|w| w.id) != Some(initial_workspace.id) {
            return Ok(crate::shared::abort_response());
        }
        let placement = match Placement::capture_for_media(&app, &r.workspace, &r.session).await {
            Ok(placement) => placement,
            Err((Status::GONE, _)) => return Ok(crate::shared::abort_response()),
            Err(failure) if failure.0 == Status::FORBIDDEN => return Err(failure),
            Err(_) if app.workspace(&r.workspace).ok().as_ref().map(|w| w.id) != Some(initial_workspace.id) => {
                return Ok(crate::shared::abort_response());
            }
            Err(_) => return Err(unavailable()),
        };
        if !placement.operation_current(&app, &r.workspace).await {
            return Ok(crate::shared::abort_response());
        }
        if !placement.live(&app, &r.workspace).await {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        let mut url = placement.endpoint.url.clone();
        if matches!(r.message.as_str(), "." | "..") {
            return Err(unavailable());
        }
        url.path_segments_mut()
            .map_err(|_| unavailable())?
            .clear()
            .extend(["api", "session", &r.session, "message", &r.message]);
        let after_capture = async {
            let response = match app
                .native
                .client
                .get(url)
                .basic_auth("opencode", Some(&placement.endpoint.password))
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) if !placement.operation_current(&app, &r.workspace).await => {
                    return Ok(crate::shared::abort_response());
                }
                Err(_) => return Err(unavailable()),
            };
            if !placement.operation_current(&app, &r.workspace).await {
                return Ok(crate::shared::abort_response());
            }
            if !response.status().is_success() {
                return Err(unavailable());
            }
            if !placement.live(&app, &r.workspace).await {
                return Err(error(Status::CONFLICT, "Session location changed"));
            }
            let raw = match crate::opencode::read_bytes(response, MESSAGE_LIMIT).await {
                Ok(raw) => raw,
                Err(_) if !placement.operation_current(&app, &r.workspace).await => {
                    return Ok(crate::shared::abort_response());
                }
                Err(_) => return Err(unavailable()),
            };
            if !placement.operation_current(&app, &r.workspace).await {
                return Ok(crate::shared::abort_response());
            }
            // Matches TS `session-media.ts:61-76`: parse and validate the message envelope
            // before issuing the final `session.get` so malformed JSON fails with 502 immediately.
            let raw_len = raw.len();
            let (envelope, slot) = if raw_len > INLINE_LIMIT {
                let (parsed, slot) = tokio::task::spawn_blocking(move || (parse_message_envelope(&raw), slot))
                    .await
                    .map_err(|_| unavailable())?;
                match parsed {
                    Ok(envelope) => (envelope, slot),
                    Err(_) if !placement.operation_current(&app, &r.workspace).await => {
                        return Ok(crate::shared::abort_response());
                    }
                    Err(failure) => return Err(failure),
                }
            } else {
                (parse_message_envelope(&raw)?, slot)
            };
            if !placement.operation_current(&app, &r.workspace).await {
                return Ok(crate::shared::abort_response());
            }
            // Decode and verify the attachment before the final `session.get` so no
            // `spawn_blocking` yield occurs between the last `revert` check and sending bytes.
            let (decoded, slot) = if raw_len > INLINE_LIMIT {
                let (message_id, part, index, digest) = (r.message.clone(), r.part, r.index, r.digest.to_owned());
                tokio::task::spawn_blocking(move || {
                    let decoded = extract_media_from_envelope(&message_id, part, index, &digest, None, &envelope);
                    (decoded, slot)
                })
                .await
                .map_err(|_| unavailable())?
            } else {
                (extract_media_from_envelope(&r.message, r.part, r.index, r.digest, None, &envelope), slot)
            };
            // Reserve response-stream memory BEFORE the final `session.get` so no blocking
            // wait occurs after the last native revert/placement revalidation.
            let mem = crate::shared::reserve_response_memory(
                crate::shared::ResponsePool::Media,
                raw_len.min(6 * 1024 * 1024),
            )
            .await
            .map_err(|_| unavailable())?;
            if !placement.operation_current(&app, &r.workspace).await {
                return Ok(crate::shared::abort_response());
            }
            // 3 native GETs: session1, message, session2; check only `latest.revert` so a
            // cancelled staged undo still serves the visible image.
            let newest = match placement.latest(&app, &r.workspace, &r.session).await {
                Ok(newest) => newest,
                Err(_) if !placement.operation_current(&app, &r.workspace).await => {
                    return Ok(crate::shared::abort_response());
                }
                Err(failure) if failure.0 == Status::CONFLICT => return Err(failure),
                Err(_) => return Err(unavailable()),
            };
            let revert = newest["revert"]["messageID"].as_str();
            if revert.is_some_and(|boundary| r.message.encode_utf16().cmp(boundary.encode_utf16()).is_ge()) {
                return Err(missing());
            }
            let (mime, mut bytes) = decoded?;
            bytes.shrink_to_fit();
            drop(slot);
            principal.live()?;
            let abort = crate::shared::stream_abort(
                app.clone(),
                r.workspace.clone(),
                initial_workspace.clone(),
                placement.endpoint.clone(),
                principal.0.clone(),
            );
            let length = HeaderValue::from(bytes.len());
            let mut response = (
                [
                    (header::CONTENT_TYPE, HeaderValue::from_str(mime).map_err(|_| missing())?),
                    (header::CONTENT_LENGTH, length),
                    (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable")),
                    (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
                    (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox")),
                ],
                crate::shared::permit_body(bytes.into(), Some(mem), abort),
            )
                .into_response();
            let write_abort = crate::shared::stream_abort(
                app.clone(),
                r.workspace.clone(),
                initial_workspace.clone(),
                placement.endpoint.clone(),
                principal.0.clone(),
            );
            response.extensions_mut().insert(crate::shared::CancelWrite::new(write_abort));
            Ok(response)
        };
        tokio::select! {
            biased;
            _ = app.native.wait_retired(&placement.endpoint) => Ok(crate::shared::abort_response()),
            result = after_capture => result,
        }
    };
    let closed = async {
        loop {
            let notified = app.workspace_closed.notified();
            if app.workspace(&reference.workspace).ok().as_ref().map(|w| w.id) != Some(initial_workspace.id) {
                return;
            }
            notified.await;
        }
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        _ = closed => Ok(crate::shared::abort_response()),
        result = tokio::time::timeout(Duration::from_secs(30), request) => {
            result.unwrap_or_else(|_| Ok(crate::shared::abort_response()))
        }
    }
}

fn raster(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset, signature: &[u8]| bytes.get(offset..).is_some_and(|rest| rest.starts_with(signature));
    if at(0, b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if at(0, b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if bytes.len() >= 26 && at(0, b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 22 && at(0, b"\0\0\x01\0") && (bytes[4] != 0 || bytes[5] != 0) {
        Some("image/x-icon")
    } else if bytes.len() >= 16 && at(4, b"ftyp") {
        let size = u32::from_be_bytes(bytes[..4].try_into().ok()?) as usize;
        ((16..=bytes.len()).contains(&size)
            && size % 4 == 0
            && (std::iter::once(8).chain((16..size).step_by(4)))
                .any(|offset| at(offset, b"avif") || at(offset, b"avis")))
        .then_some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use serde_json::json;

    #[test]
    fn deferred_header_requires_single_exact_opt_in() {
        let mut headers = HeaderMap::new();
        assert!(!wants_deferred(&headers));
        headers.insert("x-codenomad-media", HeaderValue::from_static("deferred"));
        assert!(wants_deferred(&headers));
        headers.append("x-codenomad-media", HeaderValue::from_static("deferred"));
        assert!(!wants_deferred(&headers));
        headers.insert("x-codenomad-media", HeaderValue::from_static("inline"));
        assert!(!wants_deferred(&headers));
    }

    #[test]
    fn media_reference_parser_enforces_canonical_segments() {
        let sha = "a".repeat(64);
        let ok = format!("/api/workspaces/ws%201/session-media/ses_1/msg_1/0/2/{sha}");
        let parsed = parse(&ok).unwrap();
        assert_eq!(
            (parsed.workspace.as_str(), parsed.session.as_str(), parsed.message.as_str()),
            ("ws 1", "ses_1", "msg_1")
        );
        assert_eq!((parsed.part, parsed.index, parsed.digest), (0, 2, sha.as_str()));
        for bad in [
            format!("/api/workspaces/ws%201/session-media/ses_1/msg_1/01/2/{sha}"),
            format!("/api/workspaces/ws%201/session-media/ses_1/msg_1/100001/2/{sha}"),
            format!("/api/workspaces/ws%201/session-media/ses_1/msg_1/0/2/{}", "A".repeat(64)),
            format!("/api/workspaces/ws%2f1/session-media/ses_1/msg_1/0/2/{sha}"),
            format!("/api/workspaces/ws%001/session-media/ses_1/msg_1/0/2/{sha}"),
            format!("/api/workspaces/{}/session-media/ses_1/msg_1/0/2/{sha}", "x".repeat(257)),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn defer_rewrites_only_large_renderable_tool_images() {
        let small = format!("data:image/png;base64,{}", "A".repeat(16));
        let large = format!("data:image/png;base64,{}", "A".repeat(INLINE_LIMIT));
        let non_image = format!("data:application/pdf;base64,{}", "A".repeat(INLINE_LIMIT));
        let mut messages = json!([{
            "id": "msg_1",
            "type": "assistant",
            "content": [{
                "type": "tool",
                "state": {
                    "content": [
                        {"type": "file", "mime": "image/png", "uri": small},
                        {"type": "file", "mime": "image/png", "uri": large},
                        {"type": "file", "mime": "application/pdf", "uri": non_image}
                    ]
                }
            }]
        }]);
        assert!(defer("ws_1", "ses_1", &mut messages));
        let content = messages[0]["content"][0]["state"]["content"].as_array().unwrap();
        assert_eq!(content[0]["uri"].as_str().unwrap(), small);
        assert_eq!(
            content[1]["uri"].as_str().unwrap(),
            format!("/api/workspaces/ws_1/session-media/ses_1/msg_1/0/1/{}", user_files::digest(large.as_bytes()))
        );
        assert_eq!(content[2]["uri"].as_str().unwrap(), non_image);
    }

    #[test]
    fn raster_signatures_match_declared_image_types() {
        assert_eq!(raster(b"\x89PNG\r\n\x1a\nxxxx"), Some("image/png"));
        assert_eq!(raster(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(raster(b"GIF89a"), Some("image/gif"));
        assert_eq!(raster(b"RIFF1234WEBP"), Some("image/webp"));
        assert_eq!(
            raster(&[b'B', b'M', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            Some("image/bmp")
        );
        assert_eq!(raster(&[0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Some("image/x-icon"));
        assert_eq!(raster(b"\0\0\0\x14ftypavif\0\0\0\0mif1"), Some("image/avif"));
        assert_eq!(raster(b"\0\0\0\x18ftypmif1\0\0\0\0msf1avis"), Some("image/avif"));
        assert_eq!(raster(b"\0\0\0\x0cftypavif\0\0\0\0"), None);
        assert_eq!(raster(b"\0\0\0\x20ftypavif\0\0\0\0mif1"), None);
        assert_eq!(raster(b"\0\0\0\x15ftypavif\0\0\0\0mif1a"), None);
        assert_eq!(raster(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None);
        assert_eq!(raster(b""), None);
    }

    #[test]
    fn inline_limit_counts_utf16_code_units() {
        let prefix = "data:image/png;base64,";
        let at_limit = format!("{prefix}{}", "A".repeat(INLINE_LIMIT - prefix.len()));
        let over_limit = format!("{prefix}{}", "A".repeat(INLINE_LIMIT - prefix.len() + 1));
        let mut messages = json!([{
            "id": "msg_1",
            "type": "assistant",
            "content": [{
                "type": "tool",
                "state": {
                    "content": [
                        {"type": "file", "mime": "image/png", "uri": at_limit},
                        {"type": "file", "mime": "image/png", "uri": over_limit}
                    ]
                }
            }]
        }]);
        assert!(defer("ws_1", "ses_1", &mut messages));
        let content = messages[0]["content"][0]["state"]["content"].as_array().unwrap();
        assert_eq!(content[0]["uri"].as_str().unwrap(), at_limit);
        assert!(content[1]["uri"].as_str().unwrap().starts_with("/api/workspaces/ws_1/session-media/"));
    }

    #[test]
    fn extract_media_matches_ts_exact_lowercase_mime_and_prefix() {
        let png = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 0];
        let uri = format!("data:image/png;base64,{}", STANDARD.encode(png));
        let digest = user_files::digest(uri.as_bytes());
        let raw = serde_json::to_vec(&json!({
            "data": {
                "id": "msg_1",
                "type": "assistant",
                "content": [{
                    "type": "tool",
                    "state": { "content": [{ "type": "file", "mime": "image/png", "uri": uri }] }
                }]
            }
        }))
        .unwrap();
        let (mime, bytes) = extract_media("msg_1", 0, 0, &digest, None, &raw).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, png);
        assert_eq!(extract_media("msg_1", 0, 0, &digest, Some("msg_1"), &raw).unwrap_err().0, Status::NOT_FOUND);
        assert!(extract_media("msg_1", 0, 0, &digest, Some("msg_2"), &raw).is_ok());

        let upper_uri = format!("DATA:IMAGE/PNG;BASE64,{}", STANDARD.encode(png));
        let upper_digest = user_files::digest(upper_uri.as_bytes());
        let upper_raw = serde_json::to_vec(&json!({
            "data": {
                "id": "msg_1",
                "type": "assistant",
                "content": [{
                    "type": "tool",
                    "state": { "content": [{ "type": "file", "mime": "IMAGE/PNG", "uri": upper_uri }] }
                }]
            }
        }))
        .unwrap();
        assert_eq!(extract_media("msg_1", 0, 0, &upper_digest, None, &upper_raw).unwrap_err().0, Status::NOT_FOUND);
    }

    #[test]
    fn revert_boundary_uses_utf16_code_unit_order() {
        let png = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 0];
        let uri = format!("data:image/png;base64,{}", STANDARD.encode(png));
        let digest = user_files::digest(uri.as_bytes());
        let make = |id: &str| {
            serde_json::to_vec(&json!({
                "data": {
                    "id": id,
                    "type": "assistant",
                    "content": [{
                        "type": "tool",
                        "state": { "content": [{ "type": "file", "mime": "image/png", "uri": uri }] }
                    }]
                }
            }))
            .unwrap()
        };
        // U+10000 encodes as [0xD800, 0xDC00] in UTF-16, which sorts before U+E000 [0xE000],
        // even though U+10000 > U+E000 in UTF-8 / Unicode scalar order.
        let astral = "\u{10000}";
        let pua = "\u{E000}";
        assert!(extract_media(astral, 0, 0, &digest, Some(pua), &make(astral)).is_ok());
        assert_eq!(extract_media(pua, 0, 0, &digest, Some(astral), &make(pua)).unwrap_err().0, Status::NOT_FOUND);
    }

    #[tokio::test]
    async fn abort_response_drops_tcp_connection_without_sending_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .route("/abort", axum::routing::get(|| async { crate::shared::abort_response() }))
            .route("/ok", axum::routing::get(|| async { "ok" }));
        let shutdown = tokio_util::sync::CancellationToken::new();
        let server = tokio::spawn(crate::shared::serve_local(listener, router, shutdown.clone(), || {}));

        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /abort HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out).await;
        assert!(out.is_empty(), "aborted response must send 0 bytes, got {:?}", String::from_utf8_lossy(&out));

        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(b"GET /ok HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        assert!(String::from_utf8_lossy(&out).starts_with("HTTP/1.1 200 OK"));

        shutdown.cancel();
        server.await.unwrap().unwrap();
    }
}
