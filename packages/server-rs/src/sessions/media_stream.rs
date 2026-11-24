//! Streaming deferral for `GET /api/session/:id/message` JSON responses.
//!
//! Splits the top-level `"data": [...]` array one message at a time while chunks arrive so a
//! page with many large tool images (hundreds of MiB raw) is projected in bounded memory
//! without failing before image URIs are replaced by `/api/workspaces/.../session-media/...`.
use std::collections::BTreeMap;

use serde_json::value::{RawValue, to_raw_value};

use super::media;

/// Cap on the projected (or unprojected fallback) output buffer.
pub(crate) const OUTPUT_LIMIT: usize = 128 * 1024 * 1024;
/// Cap on a single raw message item before projection.
const ITEM_LIMIT: usize = 128 * 1024 * 1024;
const INLINE_THRESHOLD: usize = 32 * 1024;

#[derive(Debug)]
enum State {
    Start,
    ObjExpectKey,
    ObjKey { escaped: bool },
    ObjAfterKey { is_data: bool },
    SkipValue { depth: usize, in_string: bool, escaped: bool },
    DataValueStart,
    DataArrayStart,
    DataArrayNext,
    DataItem { depth: usize, in_string: bool, escaped: bool },
    Passthrough,
}

pub(crate) struct MessageListStream {
    state: State,
    key_buf: Vec<u8>,
    out: Vec<u8>,
    item: Vec<u8>,
    changed: bool,
    workspace_enc: Option<String>,
    session_enc: Option<String>,
}

/// Completed large item ready to be projected (potentially on a blocking thread).
pub(crate) struct PendingItem {
    pub(crate) bytes: Vec<u8>,
    pub(crate) delimiter: u8,
}

impl MessageListStream {
    pub(crate) fn new(workspace: &str, session: &str) -> Self {
        let (workspace_enc, session_enc) = if media::valid_id(workspace) && media::valid_id(session) {
            (Some(media::encode(workspace)), Some(media::encode(session)))
        } else {
            (None, None)
        };
        let state = if workspace_enc.is_some() { State::Start } else { State::Passthrough };
        Self {
            state,
            key_buf: Vec::new(),
            out: Vec::new(),
            item: Vec::new(),
            changed: false,
            workspace_enc,
            session_enc,
        }
    }

    pub(crate) fn ids(&self) -> Option<(&str, &str)> {
        Some((self.workspace_enc.as_deref()?, self.session_enc.as_deref()?))
    }

    fn push_out(&mut self, byte: u8) -> Result<(), ()> {
        if self.out.len() >= OUTPUT_LIMIT {
            return Err(());
        }
        self.out.push(byte);
        Ok(())
    }

    fn extend_out(&mut self, bytes: &[u8]) -> Result<(), ()> {
        if self.out.len().saturating_add(bytes.len()) > OUTPUT_LIMIT {
            return Err(());
        }
        self.out.extend_from_slice(bytes);
        Ok(())
    }

    fn push_item(&mut self, byte: u8) -> Result<(), ()> {
        if self.item.len() >= ITEM_LIMIT {
            return Err(());
        }
        self.item.push(byte);
        Ok(())
    }

    /// Consumes bytes from `chunk` starting at `*pos`. Returns `Ok(Some(item))` whenever a
    /// `> 32 KiB` message item finishes so the caller can project it off the async executor
    /// and call `commit_item` before resuming the same chunk.
    pub(crate) fn feed(&mut self, chunk: &[u8], pos: &mut usize) -> Result<Option<PendingItem>, ()> {
        while *pos < chunk.len() {
            let b = chunk[*pos];
            match self.state {
                State::Passthrough => {
                    let rest = &chunk[*pos..];
                    self.extend_out(rest)?;
                    *pos = chunk.len();
                    return Ok(None);
                }
                State::Start => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    self.state = if b == b'{' { State::ObjExpectKey } else { State::Passthrough };
                }
                State::ObjExpectKey => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    if b == b'"' {
                        self.key_buf.clear();
                        self.key_buf.push(b'"');
                        self.state = State::ObjKey { escaped: false };
                    } else {
                        self.state = State::Passthrough;
                    }
                }
                State::ObjKey { escaped } => {
                    self.push_out(b)?;
                    *pos += 1;
                    if self.key_buf.len() < 64 {
                        self.key_buf.push(b);
                    }
                    if escaped {
                        self.state = State::ObjKey { escaped: false };
                    } else if b == b'\\' {
                        self.state = State::ObjKey { escaped: true };
                    } else if b == b'"' {
                        let is_data = self.key_buf.len() < 64
                            && serde_json::from_slice::<String>(&self.key_buf).ok().as_deref() == Some("data");
                        self.state = State::ObjAfterKey { is_data };
                    }
                }
                State::ObjAfterKey { is_data } => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    if b == b':' {
                        self.state = if is_data {
                            State::DataValueStart
                        } else {
                            State::SkipValue { depth: 0, in_string: false, escaped: false }
                        };
                    } else {
                        self.state = State::Passthrough;
                    }
                }
                State::SkipValue { depth, in_string, escaped } => {
                    self.push_out(b)?;
                    *pos += 1;
                    if in_string {
                        let next = if escaped {
                            (false, true)
                        } else if b == b'\\' {
                            (true, true)
                        } else if b == b'"' {
                            (false, false)
                        } else {
                            (false, true)
                        };
                        self.state = State::SkipValue { depth, in_string: next.1, escaped: next.0 };
                    } else if b == b'"' {
                        self.state = State::SkipValue { depth, in_string: true, escaped: false };
                    } else if b == b'{' || b == b'[' {
                        self.state = State::SkipValue { depth: depth + 1, in_string: false, escaped: false };
                    } else if (b == b'}' || b == b']') && depth > 0 {
                        self.state = State::SkipValue { depth: depth - 1, in_string: false, escaped: false };
                    } else if depth == 0 && b == b',' {
                        self.state = State::ObjExpectKey;
                    } else if depth == 0 && b == b'}' {
                        self.state = State::Passthrough;
                    }
                }
                State::DataValueStart => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    self.state = if b == b'[' { State::DataArrayStart } else { State::Passthrough };
                }
                State::DataArrayStart => {
                    if b.is_ascii_whitespace() {
                        self.push_out(b)?;
                        *pos += 1;
                        continue;
                    }
                    if b == b']' {
                        self.push_out(b)?;
                        *pos += 1;
                        self.state = State::Passthrough;
                    } else {
                        self.item.clear();
                        self.state = State::DataItem { depth: 0, in_string: false, escaped: false };
                    }
                }
                State::DataArrayNext => {
                    if b.is_ascii_whitespace() {
                        self.push_out(b)?;
                        *pos += 1;
                        continue;
                    }
                    if b == b']' {
                        self.push_out(b)?;
                        *pos += 1;
                        self.state = State::Passthrough;
                    } else {
                        self.item.clear();
                        self.state = State::DataItem { depth: 0, in_string: false, escaped: false };
                    }
                }
                State::DataItem { depth, in_string, escaped } => {
                    if !in_string && depth == 0 && (b == b',' || b == b']') {
                        *pos += 1;
                        if self.item.len() > INLINE_THRESHOLD {
                            let bytes = std::mem::take(&mut self.item);
                            return Ok(Some(PendingItem { bytes, delimiter: b }));
                        }
                        let bytes = std::mem::take(&mut self.item);
                        self.extend_out(&bytes)?;
                        self.push_out(b)?;
                        self.state = if b == b',' { State::DataArrayNext } else { State::Passthrough };
                    } else {
                        self.push_item(b)?;
                        *pos += 1;
                        if in_string {
                            let next = if escaped {
                                (false, true)
                            } else if b == b'\\' {
                                (true, true)
                            } else if b == b'"' {
                                (false, false)
                            } else {
                                (false, true)
                            };
                            self.state = State::DataItem { depth, in_string: next.1, escaped: next.0 };
                        } else if b == b'"' {
                            self.state = State::DataItem { depth, in_string: true, escaped: false };
                        } else if b == b'{' || b == b'[' {
                            self.state = State::DataItem { depth: depth + 1, in_string: false, escaped: false };
                        } else if (b == b'}' || b == b']') && depth > 0 {
                            self.state = State::DataItem { depth: depth - 1, in_string: false, escaped: false };
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    pub(crate) fn commit_item(&mut self, projected: Vec<u8>, changed: bool, delimiter: u8) -> Result<(), ()> {
        self.changed |= changed;
        self.extend_out(&projected)?;
        self.push_out(delimiter)?;
        self.state = if delimiter == b',' { State::DataArrayNext } else { State::Passthrough };
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<(axum::body::Bytes, bool), ()> {
        if !self.item.is_empty() {
            let item = std::mem::take(&mut self.item);
            self.extend_out(&item)?;
        }
        Ok((axum::body::Bytes::from(self.out), self.changed))
    }
}

fn may_contain_image_uri(haystack: &[u8]) -> bool {
    const NEEDLE: &[u8] = b"data:image";
    if haystack.len() < NEEDLE.len() {
        return false;
    }
    haystack.windows(NEEDLE.len()).any(|w| w.eq_ignore_ascii_case(NEEDLE)) || haystack.windows(2).any(|w| w == b"\\u")
}

fn parse_string(raw: &RawValue) -> Option<String> {
    serde_json::from_str::<String>(raw.get()).ok()
}

enum RawRef<'a> {
    Borrowed(&'a RawValue),
    Owned(Box<RawValue>),
}

impl serde::Serialize for RawRef<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Borrowed(raw) => raw.serialize(serializer),
            Self::Owned(raw) => raw.serialize(serializer),
        }
    }
}

/// Projects a single message JSON item by borrowing `&RawValue` slices directly from `raw`
/// (zero-copy for untouched or nested subtrees) and only allocating the short replacement URI
/// strings and modified containers, keeping peak memory near 1x the raw message size.
pub(crate) fn project_item(workspace_enc: &str, session_enc: &str, raw: Vec<u8>) -> (Vec<u8>, bool) {
    if !may_contain_image_uri(&raw) {
        return (raw, false);
    }
    let projected = (|| -> Option<Vec<u8>> {
        let raw_fields = serde_json::from_slice::<BTreeMap<String, &RawValue>>(&raw).ok()?;
        if parse_string(raw_fields.get("type")?)?.as_str() != "assistant" {
            return None;
        }
        let id_raw = parse_string(raw_fields.get("id")?)?;
        if !media::valid_id(&id_raw) {
            return None;
        }
        let content_raw = raw_fields.get("content")?;
        if !may_contain_image_uri(content_raw.get().as_bytes()) {
            return None;
        }
        let raw_parts = serde_json::from_str::<Vec<&RawValue>>(content_raw.get()).ok()?;
        let id_enc = media::encode(&id_raw);
        let mut parts: Vec<RawRef<'_>> = raw_parts.into_iter().map(RawRef::Borrowed).collect();
        let mut changed = false;
        for (part_idx, part_ref) in parts.iter_mut().take(100_001).enumerate() {
            let RawRef::Borrowed(part_raw) = *part_ref else {
                continue;
            };
            if !may_contain_image_uri(part_raw.get().as_bytes()) {
                continue;
            }
            let Ok(raw_part_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(part_raw.get()) else {
                continue;
            };
            if raw_part_fields.get("type").and_then(|v| parse_string(v)).as_deref() != Some("tool") {
                continue;
            }
            let Some(state_raw) = raw_part_fields.get("state") else {
                continue;
            };
            if !may_contain_image_uri(state_raw.get().as_bytes()) {
                continue;
            }
            let Ok(raw_state_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(state_raw.get()) else {
                continue;
            };
            let Some(items_raw) = raw_state_fields.get("content") else {
                continue;
            };
            if !may_contain_image_uri(items_raw.get().as_bytes()) {
                continue;
            }
            let Ok(raw_items) = serde_json::from_str::<Vec<&RawValue>>(items_raw.get()) else {
                continue;
            };
            let mut items: Vec<RawRef<'_>> = raw_items.into_iter().map(RawRef::Borrowed).collect();
            let mut part_changed = false;
            for (item_idx, item_ref) in items.iter_mut().take(100_001).enumerate() {
                let RawRef::Borrowed(item_raw) = *item_ref else {
                    continue;
                };
                if item_raw.get().len() <= INLINE_THRESHOLD || !may_contain_image_uri(item_raw.get().as_bytes()) {
                    continue;
                }
                let Ok(raw_file_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(item_raw.get()) else {
                    continue;
                };
                let Some(file_type) = raw_file_fields.get("type").and_then(|v| parse_string(v)) else {
                    continue;
                };
                let Some(mime) = raw_file_fields.get("mime").and_then(|v| parse_string(v)) else {
                    continue;
                };
                let Some(uri_raw) = raw_file_fields.get("uri") else {
                    continue;
                };
                if uri_raw.get().len() <= INLINE_THRESHOLD {
                    continue;
                }
                let Some(uri) = parse_string(uri_raw) else {
                    continue;
                };
                if let Some(reference) =
                    media::defer_uri(workspace_enc, session_enc, &id_enc, part_idx, item_idx, &file_type, &mime, &uri)
                    && let Ok(encoded_uri) = to_raw_value(&reference)
                {
                    drop(uri);
                    let mut file_fields: BTreeMap<String, RawRef<'_>> =
                        raw_file_fields.into_iter().map(|(k, v)| (k, RawRef::Borrowed(v))).collect();
                    file_fields.insert("uri".into(), RawRef::Owned(encoded_uri));
                    if let Ok(encoded_file) = to_raw_value(&file_fields) {
                        *item_ref = RawRef::Owned(encoded_file);
                        part_changed = true;
                    }
                }
            }
            if part_changed && let Ok(encoded_items) = to_raw_value(&items) {
                let mut state_fields: BTreeMap<String, RawRef<'_>> =
                    raw_state_fields.into_iter().map(|(k, v)| (k, RawRef::Borrowed(v))).collect();
                state_fields.insert("content".into(), RawRef::Owned(encoded_items));
                if let Ok(encoded_state) = to_raw_value(&state_fields) {
                    let mut part_fields: BTreeMap<String, RawRef<'_>> =
                        raw_part_fields.into_iter().map(|(k, v)| (k, RawRef::Borrowed(v))).collect();
                    part_fields.insert("state".into(), RawRef::Owned(encoded_state));
                    if let Ok(encoded_part) = to_raw_value(&part_fields) {
                        *part_ref = RawRef::Owned(encoded_part);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            return None;
        }
        let encoded_parts = to_raw_value(&parts).ok()?;
        let mut fields: BTreeMap<String, RawRef<'_>> =
            raw_fields.into_iter().map(|(k, v)| (k, RawRef::Borrowed(v))).collect();
        fields.insert("content".into(), RawRef::Owned(encoded_parts));
        serde_json::to_vec(&fields).ok()
    })();
    match projected {
        Some(serialized) => (serialized, true),
        None => (raw, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn run_stream(workspace: &str, session: &str, input: &[u8], chunk_size: usize) -> (axum::body::Bytes, bool) {
        let mut stream = MessageListStream::new(workspace, session);
        for chunk in input.chunks(chunk_size) {
            let mut pos = 0;
            while let Some(pending) = stream.feed(chunk, &mut pos).unwrap() {
                let (ws, ses) = stream.ids().unwrap();
                let (out, changed) = project_item(ws, ses, pending.bytes);
                stream.commit_item(out, changed, pending.delimiter).unwrap();
            }
        }
        stream.finish().unwrap()
    }

    #[test]
    fn preserves_non_object_invalid_and_small_json_byte_for_byte() {
        for raw in [b"[]".as_slice(), b"{}", b"null", b"not json", b"{\"data\":[]}", b"{\"other\":[1],\"data\":null}"] {
            for chunk in [1, 7, 1024] {
                let (out, changed) = run_stream("ws_1", "ses_1", raw, chunk);
                assert!(!changed);
                assert_eq!(out.as_ref(), raw);
            }
        }
    }

    #[test]
    fn projects_large_tool_images_across_arbitrary_chunk_boundaries_and_other_keys() {
        let small = format!("data:image/png;base64,{}", "A".repeat(16));
        let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
        let payload = json!({
            "meta": {"nested": [1, {"data": "ignored \"quoted\""}]},
            "data": [
                {"id": "msg_small", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": small}]}}]},
                {"id": "msg_big", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]}
            ],
            "next": "cursor_1"
        });
        let raw = payload.to_string();
        for chunk in [13, 4096, raw.len()] {
            let (out, changed) = run_stream("ws 1", "ses_1", raw.as_bytes(), chunk);
            assert!(changed);
            let parsed: Value = serde_json::from_slice(&out).unwrap();
            assert_eq!(parsed["meta"], payload["meta"]);
            assert_eq!(parsed["next"], "cursor_1");
            assert_eq!(parsed["data"][0]["content"][0]["state"]["content"][0]["uri"], small);
            let uri = parsed["data"][1]["content"][0]["state"]["content"][0]["uri"].as_str().unwrap();
            assert!(uri.starts_with("/api/workspaces/ws%201/session-media/ses_1/msg_big/0/0/"), "{uri}");
        }
    }

    #[test]
    fn skips_dense_numeric_items_and_preserves_unknown_fields_without_value_tree() {
        let dense = format!("{{\"id\":\"msg_n\",\"type\":\"assistant\",\"nums\":[{}]}}", vec!["1"; 20_000].join(","));
        let (out, changed) = project_item("ws_1", "ses_1", dense.clone().into_bytes());
        assert!(!changed);
        assert_eq!(out, dense.as_bytes());

        let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
        let with_nums = json!({
            "id": "msg_mix",
            "type": "assistant",
            "extra": [1, 2, 3, 4, 5],
            "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]
        });
        let (out, changed) = project_item("ws_1", "ses_1", with_nums.to_string().into_bytes());
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["extra"], json!([1, 2, 3, 4, 5]));
        assert!(
            parsed["content"][0]["state"]["content"][0]["uri"]
                .as_str()
                .unwrap()
                .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_mix/0/0/")
        );
    }
}
