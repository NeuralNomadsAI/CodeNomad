//! Streaming deferral for `GET /api/session/:id/message` JSON responses.
//!
//! Splits the top-level `"data": [...]` array one message at a time while chunks arrive so a
//! page with many large tool images (hundreds of MiB raw) is projected in bounded memory
//! without failing before image URIs are replaced by `/api/workspaces/.../session-media/...`.
//!
//! Intentional server-rs safety bounds: unlike the TypeScript proxy's unbounded `response.text()`,
//! Rust bounds a single raw message item (`ITEM_LIMIT`, 128 MiB) and the projected response buffer
//! (`OUTPUT_LIMIT`, 256 MiB, aligned with `ResponsePool::List`) to prevent OOM on malformed or
//! oversized upstream payloads.
use std::collections::BTreeMap;

use serde_json::value::RawValue;

use super::media;

/// Cap on the projected (or unprojected fallback) output buffer, aligned with `ResponsePool::List`.
pub(crate) const OUTPUT_LIMIT: usize = 256 * 1024 * 1024;
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

    pub(crate) fn retained_bytes(&self) -> usize {
        self.out.capacity().saturating_add(self.item.capacity())
    }

    fn push_out(&mut self, byte: u8) -> Result<(), ()> {
        let total = self.out.len().saturating_add(self.item.len());
        if total >= OUTPUT_LIMIT {
            return Err(());
        }
        if self.out.len() == self.out.capacity() && self.out.len() >= 1024 * 1024 {
            let step = (OUTPUT_LIMIT - total).min(4 * 1024 * 1024).max(1);
            self.out.reserve_exact(step);
        }
        self.out.push(byte);
        Ok(())
    }

    fn extend_out(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let total = self.out.len().saturating_add(self.item.len()).saturating_add(bytes.len());
        if total > OUTPUT_LIMIT {
            return Err(());
        }
        if self.out.len() + bytes.len() > self.out.capacity() && self.out.len() + bytes.len() >= 1024 * 1024 {
            self.out.reserve_exact(bytes.len());
        }
        self.out.extend_from_slice(bytes);
        Ok(())
    }

    fn push_item(&mut self, byte: u8) -> Result<(), ()> {
        let total = self.out.len().saturating_add(self.item.len());
        if self.item.len() >= ITEM_LIMIT || total >= OUTPUT_LIMIT {
            return Err(());
        }
        if self.item.len() == self.item.capacity() && self.item.len() >= 1024 * 1024 {
            let rem = (ITEM_LIMIT - self.item.len()).min(OUTPUT_LIMIT - total);
            self.item.reserve_exact(rem.min(4 * 1024 * 1024).max(1));
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
        self.out.shrink_to_fit();
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

const MAX_SCANNED_ITEMS: usize = 100_001;

/// Streams through up to `limit` elements of a JSON array slice with zero intermediate `Vec`
/// allocations, calling `visit(index, element_slice)` for each element.
fn for_each_json_array_item<'a>(raw: &'a str, limit: usize, mut visit: impl FnMut(usize, &'a str)) -> Option<()> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) != Some(&b'[') {
        return None;
    }
    i += 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) == Some(&b']') {
        return Some(());
    }
    let mut count = 0usize;
    loop {
        if count >= limit {
            return Some(());
        }
        let start = i;
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        while i < bytes.len() {
            let b = bytes[i];
            if in_string {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    in_string = false;
                }
            } else {
                match b {
                    b'"' => in_string = true,
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' if depth > 0 => depth -= 1,
                    b',' | b']' if depth == 0 => break,
                    _ => {}
                }
            }
            i += 1;
        }
        if i >= bytes.len() || in_string || depth != 0 {
            return None;
        }
        let slice = raw[start..i].trim();
        if slice.is_empty() {
            return None;
        }
        visit(count, slice);
        count += 1;
        if bytes[i] == b']' {
            return Some(());
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
    }
}

/// Projects a single message JSON item by streaming through up to `MAX_SCANNED_ITEMS` parts
/// and tool content items with zero intermediate array/node allocations, recording only the
/// byte ranges of replaced `"uri"` JSON string tokens and splicing them in one single pass.
pub(crate) fn project_item(workspace_enc: &str, session_enc: &str, mut raw: Vec<u8>) -> (Vec<u8>, bool) {
    if !may_contain_image_uri(&raw) {
        return (raw, false);
    }
    let patches = (|| -> Option<Vec<(usize, usize, String)>> {
        let base = raw.as_ptr() as usize;
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
        let id_enc = media::encode(&id_raw);
        let mut patches = Vec::new();
        for_each_json_array_item(content_raw.get(), MAX_SCANNED_ITEMS, |part_idx, part_raw| {
            if !may_contain_image_uri(part_raw.as_bytes()) {
                return;
            }
            let Ok(raw_part_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(part_raw) else {
                return;
            };
            if raw_part_fields.get("type").and_then(|v| parse_string(v)).as_deref() != Some("tool") {
                return;
            }
            let Some(state_raw) = raw_part_fields.get("state") else {
                return;
            };
            if !may_contain_image_uri(state_raw.get().as_bytes()) {
                return;
            }
            let Ok(raw_state_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(state_raw.get()) else {
                return;
            };
            let Some(items_raw) = raw_state_fields.get("content") else {
                return;
            };
            if !may_contain_image_uri(items_raw.get().as_bytes()) {
                return;
            }
            let _ = for_each_json_array_item(items_raw.get(), MAX_SCANNED_ITEMS, |item_idx, item_raw| {
                if item_raw.len() <= INLINE_THRESHOLD || !may_contain_image_uri(item_raw.as_bytes()) {
                    return;
                }
                let Ok(raw_file_fields) = serde_json::from_str::<BTreeMap<String, &RawValue>>(item_raw) else {
                    return;
                };
                let Some(file_type) = raw_file_fields.get("type").and_then(|v| parse_string(v)) else {
                    return;
                };
                let Some(mime) = raw_file_fields.get("mime").and_then(|v| parse_string(v)) else {
                    return;
                };
                let Some(uri_raw) = raw_file_fields.get("uri") else {
                    return;
                };
                if uri_raw.get().len() <= INLINE_THRESHOLD {
                    return;
                }
                let Some(uri) = parse_string(uri_raw) else {
                    return;
                };
                if let Some(reference) =
                    media::defer_uri(workspace_enc, session_enc, &id_enc, part_idx, item_idx, &file_type, &mime, &uri)
                    && let Ok(encoded) = serde_json::to_string(&reference)
                {
                    let start = uri_raw.get().as_ptr() as usize - base;
                    let end = start + uri_raw.get().len();
                    patches.push((start, end, encoded));
                }
            });
        })?;
        (!patches.is_empty()).then_some(patches)
    })();
    let Some(mut patches) = patches else {
        return (raw, false);
    };
    patches.sort_unstable_by_key(|(start, _, _)| *start);
    let mut cursor = 0usize;
    let mut fits_in_place = true;
    for (start, end, replacement) in &patches {
        if *start < cursor || *end > raw.len() {
            return (raw, false);
        }
        if replacement.len() > end - start {
            fits_in_place = false;
        }
        cursor = *end;
    }
    if fits_in_place {
        // Every deferred `/api/workspaces/.../session-media/...` URI is strictly shorter than the
        // `> 32 KiB` data URI it replaces, so splicing in-place avoids allocating a second `Vec`.
        let mut read_pos = 0usize;
        let mut write_pos = 0usize;
        for (start, end, replacement) in patches {
            let prefix_len = start - read_pos;
            if write_pos != read_pos && prefix_len > 0 {
                raw.copy_within(read_pos..start, write_pos);
            }
            write_pos += prefix_len;
            let rep = replacement.as_bytes();
            raw[write_pos..write_pos + rep.len()].copy_from_slice(rep);
            write_pos += rep.len();
            read_pos = end;
        }
        let tail_len = raw.len() - read_pos;
        if write_pos != read_pos && tail_len > 0 {
            raw.copy_within(read_pos.., write_pos);
        }
        write_pos += tail_len;
        raw.truncate(write_pos);
        raw.shrink_to_fit();
        return (raw, true);
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for (start, end, replacement) in patches {
        out.extend_from_slice(&raw[cursor..start]);
        out.extend_from_slice(replacement.as_bytes());
        cursor = end;
    }
    out.extend_from_slice(&raw[cursor..]);
    out.shrink_to_fit();
    (out, true)
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

        let escaped_slash = format!(
            "{{\"id\":\"msg_esc\",\"type\":\"assistant\",\"content\":[{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"data:image\\/png;base64,{}\"}}]}}}}]}}",
            "A".repeat(40 * 1024)
        );
        let (out, changed) = project_item("ws_1", "ses_1", escaped_slash.into_bytes());
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert!(
            parsed["content"][0]["state"]["content"][0]["uri"]
                .as_str()
                .unwrap()
                .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_esc/0/0/")
        );

        let escaped_unicode = format!(
            "{{\"id\":\"msg_uni\",\"type\":\"assistant\",\"content\":[{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"\\u0064ata:image/png;base64,{}\"}}]}}}}]}}",
            "A".repeat(40 * 1024)
        );
        let (out, changed) = project_item("ws_1", "ses_1", escaped_unicode.into_bytes());
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert!(
            parsed["content"][0]["state"]["content"][0]["uri"]
                .as_str()
                .unwrap()
                .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_uni/0/0/")
        );

        let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
        let mut big_parts = String::from("{\"id\":\"msg_huge\",\"type\":\"assistant\",\"content\":[");
        big_parts.push_str(&format!(
            "{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"{large}\"}}]}}}}",
        ));
        for _ in 0..100_005 {
            big_parts.push_str(",1");
        }
        big_parts.push_str("]}");
        let (out, changed) = project_item("ws_1", "ses_1", big_parts.into_bytes());
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        let parts = parsed["content"].as_array().unwrap();
        assert_eq!(parts.len(), 100_006);
        assert!(
            parts[0]["state"]["content"][0]["uri"]
                .as_str()
                .unwrap()
                .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_huge/0/0/")
        );
        assert_eq!(parts[100_005], 1);
    }
}
