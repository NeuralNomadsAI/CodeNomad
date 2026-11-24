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

fn encode(id: &str) -> String {
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

fn valid_id(id: &str) -> bool {
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

fn renderable(file: &Value) -> Option<(&str, &str)> {
    let mime = file["mime"].as_str()?;
    let uri = file["uri"].as_str()?;
    let (kind, subtype) = mime.split_once('/')?;
    if file["type"] != "file"
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

pub(crate) fn wants_deferred(headers: &axum::http::HeaderMap) -> bool {
    headers.get_all("x-codenomad-media").iter().eq(["deferred"])
}

pub(crate) fn defer(workspace: &str, session: &str, messages: &mut Value) -> bool {
    if !valid_id(workspace) || !valid_id(session) {
        return false;
    }
    let (workspace, session) = (encode(workspace), encode(session));
    let mut changed = false;
    for message in messages.as_array_mut().into_iter().flatten().filter(|message| message["type"] == "assistant") {
        let Some(id) = message["id"].as_str().filter(|id| valid_id(id)).map(encode) else { continue };
        let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else { continue };
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
                    format!("/api/workspaces/{workspace}/session-media/{session}/{id}/{part}/{index}/{digest}");
                if reference.len() <= 4096 {
                    file["uri"] = reference.into();
                    changed = true;
                }
            }
        }
    }
    changed
}

pub(super) async fn route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    OriginalUri(uri): OriginalUri,
) -> Result<Response, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid media reference");
    let reference = uri.query().is_none().then(|| parse(uri.path())).flatten().ok_or_else(invalid)?;
    let missing = || error(Status::NOT_FOUND, "Media not found");
    let unavailable = || error(Status::BAD_GATEWAY, "Media unavailable");
    let request = async {
        let r = &reference;
        if app.workspace(&r.workspace).is_err() {
            return Err(missing());
        }
        let placement = Placement::capture_with_media(&app, &r.workspace, &r.session, false, true, false)
            .await
            .map_err(|failure| if failure.0 == Status::FORBIDDEN { failure } else { unavailable() })?;
        if !placement.operation_current(&app, &r.workspace) {
            return Err(unavailable());
        }
        if !placement.live(&app, &r.workspace) {
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
        let response = app
            .native
            .client
            .get(url)
            .basic_auth("opencode", Some(&placement.endpoint.password))
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        if !placement.operation_current(&app, &r.workspace) {
            return Err(unavailable());
        }
        if !placement.live(&app, &r.workspace) {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        let envelope = crate::opencode::read_json(response, MESSAGE_LIMIT).await.map_err(|_| unavailable())?;
        let newest = placement
            .latest(&app, &r.workspace, &r.session)
            .await
            .map_err(|failure| if failure.0 == Status::CONFLICT { failure } else { unavailable() })?;
        let message = envelope.get("data").filter(|message| message.is_object()).ok_or_else(unavailable)?;
        if message["id"] != r.message
            || message["type"] != "assistant"
            || newest["revert"]["messageID"].as_str().is_some_and(|boundary| r.message.as_str() >= boundary)
        {
            return Err(missing());
        }
        let part = &message["content"][r.part];
        if part["type"] != "tool" {
            return Err(missing());
        }
        let (mime, uri) = renderable(&part["state"]["content"][r.index]).ok_or_else(missing)?;
        if user_files::digest(uri.as_bytes()) != r.digest {
            return Err(missing());
        }
        let prefix = format!("data:{mime};base64,");
        let payload = uri.strip_prefix(&prefix).ok_or_else(missing)?;
        if payload.len() % 4 != 0 {
            return Err(missing());
        }
        let bytes = STANDARD.decode(payload).map_err(|_| missing())?;
        if raster(&bytes) != Some(mime) {
            return Err(missing());
        }
        principal.live()?;
        if !placement.operation_current(&app, &r.workspace) {
            return Err(unavailable());
        }
        if !placement.live(&app, &r.workspace) {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        Ok((
            [
                (header::CONTENT_TYPE, HeaderValue::from_str(mime).map_err(|_| missing())?),
                (header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable")),
                (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
                (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox")),
            ],
            bytes,
        )
            .into_response())
    };
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(30), request) => result.unwrap_or_else(|_| Err(unavailable())),
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
}
