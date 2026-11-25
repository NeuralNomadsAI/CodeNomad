//! Streaming validation and deferred-media projection for history RPC payloads.
use crate::sessions::{media, user_files};
use axum::{
    Json,
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use serde_json::{Value, json};
pub(super) struct EnvelopeSlices<'a> {
    pub(super) output: Option<&'a str>,
    pub(super) tag: Option<&'a str>,
    pub(super) kind: Option<&'a str>,
}

/// Extracts top-level RPC envelope fields in O(1) memory (stripping an optional UTF-8 BOM and
/// strictly validating full JSON syntax) so an adversarial 20 MiB escaped unknown key never
/// allocates a Serde unescape buffer and malformed ignored fields are still rejected.
pub(super) fn parse_envelope(bytes: &[u8]) -> Option<EnvelopeSlices<'_>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    if !crate::sessions::media_stream::validate_json_syntax(text.as_bytes()) {
        return None;
    }
    let mut out = EnvelopeSlices { output: None, tag: None, kind: None };
    crate::sessions::media_stream::for_each_json_object_field(text, |k, v| match k {
        "output" => out.output = Some(v),
        "_tag" => out.tag = Some(v),
        "type" => out.kind = Some(v),
        _ => {}
    })?;
    Some(out)
}

pub(super) fn raw_str_eq(raw: Option<&str>, expected: &str) -> bool {
    raw.is_some_and(|text| {
        let text = text.trim();
        text.len() <= 128 && serde_json::from_str::<String>(text).ok().as_deref() == Some(expected)
    })
}

pub(super) fn blocked(reason: &str) -> Response {
    Json(json!({"status":"blocked","reason":reason})).into_response()
}

fn detach_or_slice(body: Bytes, raw_range: std::ops::Range<usize>) -> Bytes {
    if body.len() > raw_range.len().saturating_add(4096) {
        Bytes::copy_from_slice(&body[raw_range])
    } else {
        body.slice(raw_range)
    }
}

/// Validates and optionally defers a `window` RPC output in-place inside `body: Vec<u8>` without
/// building a `serde_json::Value` tree over `messages[*]` tool payloads or allocating a second
/// 24 MiB copy, so valid windows with millions of numeric samples never amplify memory or trip a
/// node cap.
fn process_window_payload(
    status: Status,
    mut body: Vec<u8>,
    id: &str,
    session: &str,
    reference: bool,
    defer: bool,
) -> Result<(Bytes, bool), Response> {
    use crate::sessions::media_stream;
    let mut refs_valid = true;
    let (raw_range, patches) = {
        let Some(envelope) = parse_envelope(&body) else { return Err(blocked("unavailable")) };
        let Some(raw_str) = envelope.output else { return Err(blocked("unavailable")) };
        let raw_bytes = raw_str.as_bytes();
        let offset = raw_bytes.as_ptr() as usize - body.as_ptr() as usize;
        let raw_range = offset..offset + raw_bytes.len();
        if !status.is_success() || !media_stream::validate_json_syntax(raw_bytes) {
            return Err(blocked("unavailable"));
        }
        let mut envelope_map = serde_json::Map::new();
        let mut messages_raw: Option<&str> = None;
        let mut envelope_ok = true;
        if media_stream::for_each_json_object_field(raw_str, |k, v| {
            if !envelope_ok {
                return;
            }
            if k == "\0" {
                envelope_ok = false;
            } else if k == "messages" {
                messages_raw = Some(v);
            } else if envelope_map.len() >= 32
                || v.len() > 8192
                || !media_stream::json_node_count_within(v.as_bytes(), 1024)
            {
                envelope_ok = false;
            } else if let Ok(val) = serde_json::from_str::<Value>(v) {
                envelope_map.insert(k.to_owned(), val);
            } else {
                envelope_ok = false;
            }
        })
        .is_none()
            || !envelope_ok
        {
            return Err(blocked("unavailable"));
        }
        if envelope_map.get("status").and_then(Value::as_str) != Some("window") {
            if messages_raw.is_some() {
                envelope_map.insert("messages".into(), Value::Null);
            }
            if !crate::sessions::contracts::valid(
                crate::sessions::contracts::get("window", true),
                &Value::Object(envelope_map),
            ) {
                return Err(blocked("unavailable"));
            }
            (raw_range, Vec::new())
        } else {
            let user_files_marker = envelope_map.remove("userFiles");
            if user_files_marker.as_ref().is_some_and(|v| v.as_str() != Some(user_files::REFERENCE)) {
                return Err(blocked("unavailable"));
            }
            if reference && user_files_marker.is_none() {
                refs_valid = false;
            }
            let Some(messages_str) = messages_raw else {
                return Err(blocked("unavailable"));
            };
            let can_defer = defer && media::valid_id(id) && media::valid_id(session);
            let (ws_enc, ses_enc) =
                if can_defer { (media::encode(id), media::encode(session)) } else { (String::new(), String::new()) };
            let raw_base = raw_str.as_ptr() as usize;
            let mut check_messages: Vec<Value> = Vec::new();
            let mut patches: Vec<(usize, usize, String)> = Vec::new();
            let mut messages_ok = true;
            let mut count = 0usize;
            if media_stream::for_each_json_array_item(messages_str, 201, |_, msg_str| {
                if !messages_ok {
                    return;
                }
                count += 1;
                if count > 200 {
                    messages_ok = false;
                    return;
                }
                let (mut id_tok, mut type_tok, mut time_tok, mut files_tok) = (None, None, None, None);
                if media_stream::for_each_json_object_field(msg_str, |k, v| match k {
                    "id" => id_tok = Some(v),
                    "type" => type_tok = Some(v),
                    "time" => time_tok = Some(v),
                    "files" => files_tok = Some(v),
                    _ => {}
                })
                .is_none()
                {
                    messages_ok = false;
                    return;
                }
                let (Some(id_tok), Some(type_tok), Some(time_tok)) = (id_tok, type_tok, time_tok) else {
                    messages_ok = false;
                    return;
                };
                if id_tok.len() > 2048 || type_tok.len() > 128 {
                    messages_ok = false;
                    return;
                }
                let (Ok(id_val), Ok(type_val)) =
                    (serde_json::from_str::<Value>(id_tok), serde_json::from_str::<Value>(type_tok))
                else {
                    messages_ok = false;
                    return;
                };
                let mut created_tok = None;
                if media_stream::for_each_json_object_field(time_tok, |k, v| {
                    if k == "created" {
                        created_tok = Some(v);
                    }
                })
                .is_none()
                {
                    messages_ok = false;
                    return;
                }
                let Some(created_tok) = created_tok.filter(|t| t.len() <= 64) else {
                    messages_ok = false;
                    return;
                };
                let Ok(created_val) = serde_json::from_str::<Value>(created_tok) else {
                    messages_ok = false;
                    return;
                };
                if reference
                    && type_val.as_str() == Some("user")
                    && let Some(files_tok) = files_tok
                    && !media_stream::valid_reference_files(files_tok, user_files::FILE_COUNT)
                {
                    // Defer rejecting invalid reference-v1 files until after `placement.current`
                    // (matching TS `session-navigation.ts:86-91` so `blocked/conflict` takes priority).
                    refs_valid = false;
                }
                check_messages.push(json!({"id": id_val, "type": type_val, "time": {"created": created_val}}));
                if can_defer && type_val.as_str() == Some("assistant") && msg_str.len() <= media::MESSAGE_LIMIT {
                    let msg_offset = msg_str.as_ptr() as usize - raw_base;
                    if let Some(item_patches) = media_stream::collect_item_patches(&ws_enc, &ses_enc, msg_str) {
                        for (start, end, replacement) in item_patches {
                            patches.push((msg_offset + start, msg_offset + end, replacement));
                        }
                    }
                }
            })
            .is_none()
                || !messages_ok
            {
                return Err(blocked("unavailable"));
            }
            envelope_map.insert("messages".into(), Value::Array(check_messages));
            if !crate::sessions::contracts::valid(
                crate::sessions::contracts::get("window", true),
                &Value::Object(envelope_map),
            ) {
                return Err(blocked("unavailable"));
            }
            (raw_range, patches)
        }
    };
    if !patches.is_empty() {
        let mut patches = patches;
        patches.sort_unstable_by_key(|(start, _, _)| *start);
        // Splice all deferred image URIs in-place inside `body` with ZERO second buffer
        // allocation: every deferred URI (`<= 4096` bytes) is strictly shorter than the `> 32 KiB`
        // data URI it replaces.
        let base = raw_range.start;
        let raw_end = raw_range.end;
        let mut read_pos = base;
        let mut write_pos = 0usize;
        for (rel_start, rel_end, replacement) in patches {
            let start = base + rel_start;
            let end = base + rel_end;
            let rep = replacement.as_bytes();
            if start < read_pos || end > raw_end || rep.len() > end - start {
                return Err(blocked("unavailable"));
            }
            let prefix_len = start - read_pos;
            if write_pos != read_pos && prefix_len > 0 {
                body.copy_within(read_pos..start, write_pos);
            }
            write_pos += prefix_len;
            body[write_pos..write_pos + rep.len()].copy_from_slice(rep);
            write_pos += rep.len();
            read_pos = end;
        }
        let tail_len = raw_end - read_pos;
        if write_pos != read_pos && tail_len > 0 {
            body.copy_within(read_pos..raw_end, write_pos);
        }
        write_pos += tail_len;
        if reference && write_pos > 24 * 1024 * 1024 {
            return Err(blocked("unsupported_storage"));
        }
        body.truncate(write_pos);
        body.shrink_to_fit();
        return Ok((body.into(), refs_valid));
    }
    let raw_len = raw_range.len();
    if reference && raw_len > 24 * 1024 * 1024 {
        return Err(blocked("unsupported_storage"));
    }
    if raw_range.start > 0 {
        body.copy_within(raw_range, 0);
    }
    body.truncate(raw_len);
    body.shrink_to_fit();
    Ok((body.into(), refs_valid))
}

fn valid_outline_payload(action: &str, raw: &str) -> bool {
    const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;
    fn present_non_null<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        T::deserialize(d).map(Some)
    }
    fn present_nullable<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        <Option<T> as serde::Deserialize<'de>>::deserialize(d).map(Some)
    }
    fn bounded_vec<'de, D, T, const MAX: usize>(d: D) -> Result<Option<Vec<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        struct V<T, const MAX: usize>(std::marker::PhantomData<T>);
        impl<'de, T: serde::Deserialize<'de>, const MAX: usize> serde::de::Visitor<'de> for V<T, MAX> {
            type Value = Vec<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "an array of at most {MAX} items")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX).min(1024));
                while let Some(item) = seq.next_element::<T>()? {
                    if items.len() >= MAX {
                        return Err(serde::de::Error::custom("array exceeds maximum length"));
                    }
                    items.push(item);
                }
                Ok(items)
            }
        }
        d.deserialize_seq(V::<T, MAX>(std::marker::PhantomData)).map(Some)
    }
    fn bounded_preview_entries<'de, D, T>(d: D) -> Result<Option<Vec<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        bounded_vec::<D, T, 12>(d)
    }
    fn bounded_outline_entries<'de, D, T>(d: D) -> Result<Option<Vec<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        bounded_vec::<D, T, 16_384>(d)
    }
    fn bounded_outline_checkpoints<'de, D, T>(d: D) -> Result<Option<Vec<T>>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::Deserialize<'de>,
    {
        bounded_vec::<D, T, 512>(d)
    }
    struct JsonNum(f64);
    impl<'de> serde::Deserialize<'de> for JsonNum {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> serde::de::Visitor<'de> for V {
                type Value = JsonNum;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str("a JSON number")
                }
                fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                    Ok(JsonNum(v as f64))
                }
                fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                    Ok(JsonNum(v as f64))
                }
                fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
                    Ok(JsonNum(v))
                }
            }
            d.deserialize_any(V)
        }
    }
    let valid_int = |n: &JsonNum, min: f64| n.0.is_finite() && n.0.fract() == 0.0 && n.0 >= min && n.0 <= MAX_SAFE_INT;
    let valid_blocked_reason = |r: &str| {
        matches!(r, "unavailable" | "maintenance_required" | "conflict" | "not_deletable" | "unsupported_storage")
    };
    let utf16_len = |s: &str| s.encode_utf16().count();

    if action == "outlinePreview" {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PreviewEntry {
            id: String,
            text: String,
            tools: String,
        }
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PreviewDoc {
            status: String,
            #[serde(default, deserialize_with = "present_non_null")]
            reason: Option<String>,
            #[serde(default, deserialize_with = "bounded_preview_entries")]
            entries: Option<Vec<PreviewEntry>>,
        }
        let Ok(doc) = serde_json::from_str::<PreviewDoc>(raw) else { return false };
        return match doc.status.as_str() {
            "blocked" => doc.entries.is_none() && doc.reason.as_deref().is_some_and(valid_blocked_reason),
            "previews" => {
                doc.reason.is_none()
                    && doc.entries.as_ref().is_some_and(|entries| {
                        entries.len() <= 12
                            && entries.iter().all(|e| {
                                let id_len = utf16_len(&e.id);
                                (1..=256).contains(&id_len) && utf16_len(&e.text) <= 4096 && utf16_len(&e.tools) <= 4096
                            })
                    })
            }
            _ => false,
        };
    }

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Omitted {
        reasoning: JsonNum,
        text: JsonNum,
        #[serde(rename = "continues")]
        _continues: bool,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Entry {
        id: String,
        seq: JsonNum,
        #[serde(rename = "type")]
        kind: String,
        tools: JsonNum,
        reasoning: JsonNum,
        #[serde(default, deserialize_with = "present_non_null")]
        text: Option<JsonNum>,
        #[serde(default, deserialize_with = "present_non_null")]
        #[serde(rename = "toolName")]
        tool_name: Option<String>,
        #[serde(default, deserialize_with = "present_non_null")]
        layout: Option<String>,
        #[serde(default, deserialize_with = "present_non_null")]
        omitted: Option<Omitted>,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Cursor {
        after: JsonNum,
        through: JsonNum,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Checkpoint {
        after: JsonNum,
        through: JsonNum,
        digest: String,
        #[serde(rename = "changed")]
        _changed: bool,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OutlineDoc {
        status: String,
        #[serde(default, deserialize_with = "present_non_null")]
        reason: Option<String>,
        #[serde(default, deserialize_with = "bounded_outline_entries")]
        entries: Option<Vec<Entry>>,
        #[serde(default, deserialize_with = "present_non_null")]
        total: Option<JsonNum>,
        #[serde(default, deserialize_with = "present_nullable")]
        cursor: Option<Option<Cursor>>,
        #[serde(default, deserialize_with = "bounded_outline_checkpoints")]
        checkpoints: Option<Vec<Checkpoint>>,
    }
    let Ok(doc) = serde_json::from_str::<OutlineDoc>(raw) else { return false };
    match doc.status.as_str() {
        "blocked" => {
            doc.entries.is_none()
                && doc.total.is_none()
                && doc.cursor.is_none()
                && doc.checkpoints.is_none()
                && doc.reason.as_deref().is_some_and(valid_blocked_reason)
        }
        "outline" => {
            if doc.reason.is_some() {
                return false;
            }
            let (Some(entries), Some(total), Some(cursor), Some(checkpoints)) =
                (&doc.entries, &doc.total, &doc.cursor, &doc.checkpoints)
            else {
                return false;
            };
            if entries.len() > 16_384 || checkpoints.len() > 512 || !valid_int(total, 0.0) {
                return false;
            }
            if let Some(c) = cursor
                && (!valid_int(&c.after, 0.0) || !valid_int(&c.through, 0.0))
            {
                return false;
            }
            let valid_layout = |s: &str| {
                let markers =
                    |p: &str, max: usize| p.len() <= max && p.bytes().all(|b| matches!(b, b'R' | b'T' | b'X'));
                s.split_once('-').map_or_else(|| markers(s, 1000), |(a, b)| markers(a, 500) && markers(b, 500))
            };
            entries.iter().all(|e| {
                let id_len = utf16_len(&e.id);
                (1..=256).contains(&id_len)
                    && valid_int(&e.seq, 0.0)
                    && matches!(
                        e.kind.as_str(),
                        "user"
                            | "assistant"
                            | "system"
                            | "synthetic"
                            | "skill"
                            | "shell"
                            | "compaction"
                            | "idle"
                            | "agent-switched"
                            | "model-switched"
                            | "location-switched"
                    )
                    && valid_int(&e.tools, 0.0)
                    && valid_int(&e.reasoning, 0.0)
                    && e.text.as_ref().is_none_or(|t| valid_int(t, 0.0))
                    && e.tool_name.as_deref().is_none_or(|n| utf16_len(n) <= 256)
                    && e.layout.as_deref().is_none_or(valid_layout)
                    && e.omitted.as_ref().is_none_or(|o| valid_int(&o.reasoning, 0.0) && valid_int(&o.text, 0.0))
                    && (e.omitted.is_some() == e.layout.as_deref().is_some_and(|l| l.contains('-')))
            }) && checkpoints.iter().all(|c| {
                valid_int(&c.after, -1.0)
                    && valid_int(&c.through, 0.0)
                    && c.digest.len() == 64
                    && c.digest.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            })
        }
        _ => false,
    }
}

pub(super) fn process_history_payload(
    status: Status,
    mut body: Vec<u8>,
    action: &str,
    id: &str,
    session: &str,
    reference: bool,
    defer: bool,
) -> Result<(Bytes, bool), Response> {
    body.shrink_to_fit();
    if action == "window" {
        return process_window_payload(status, body, id, session, reference, defer);
    }
    let body: Bytes = body.into();
    let Some(envelope) = parse_envelope(&body) else { return Err(blocked("unavailable")) };
    let Some(raw_str) = envelope.output else { return Err(blocked("unavailable")) };
    let raw_bytes = raw_str.as_bytes();
    let offset = raw_bytes.as_ptr() as usize - body.as_ptr() as usize;
    let raw_range = offset..offset + raw_bytes.len();
    // `outline` / `outlinePreview` deserialize directly into flat `#[serde(deny_unknown_fields)]`
    // structs (zero `BTreeMap`s) after O(1)-memory node and per-string length checks, keeping peak
    // RAM well below the 56 MiB History pool reservation even for adversarial 24 MiB payloads.
    const MAX_OUTLINE_NODES: usize = 400_000;
    const MAX_OUTLINE_STRING_BYTES: usize = 64 * 1024;
    if !status.is_success()
        || !crate::sessions::media_stream::json_bounds_within(raw_bytes, MAX_OUTLINE_NODES, MAX_OUTLINE_STRING_BYTES)
        || !valid_outline_payload(action, raw_str)
    {
        return Err(blocked("unavailable"));
    }
    Ok((detach_or_slice(body, raw_range), true))
}
