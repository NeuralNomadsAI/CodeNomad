//! Streaming deferral for `GET /api/session/:id/message` JSON responses.
//!
//! Splits the top-level `"data": [...]` array one message at a time while chunks arrive so a
//! page with many large tool images (hundreds of MiB raw) is projected in bounded memory
//! without failing before image URIs are replaced by `/api/workspaces/.../session-media/...`.
//!
//! Intentional server-rs safety bounds: unlike the TypeScript proxy's unbounded `response.text()`,
//! Rust bounds a single raw message item (`ITEM_LIMIT`, 72 MiB) and the projected response buffer
//! (`OUTPUT_LIMIT`, 160 MiB, paired with `ResponsePool::List` 256 MiB via Banker's admission
//! `3 * 32 + 160 = 256 MiB`) to prevent OOM on malformed or oversized upstream payloads.
use super::media;

/// Cap on the projected (or unprojected fallback) output buffer. Chosen via Banker's admission
/// rule alongside `ResponsePool::List` (256 MiB), `DEFER_SLOTS` (4), and `FAIR_LIST_SHARE`
/// (32 MiB): `160 MiB + 3 * 32 MiB = 256 MiB`, so the single `LARGE_DEFER_SLOT` holder can
/// always finish without ever deadlocking against up to 3 concurrent waiting streams.
pub(crate) const OUTPUT_LIMIT: usize = 160 * 1024 * 1024;
/// Cap on a single raw message item before projection (`2 * 72 MiB + 8 MiB URI <= 160 MiB`).
const ITEM_LIMIT: usize = 72 * 1024 * 1024;
/// Cap on kept original image URIs for invalid-JSON rollback so valid pages with hundreds of MiB
/// of deferrable images still project down to a few KiB instead of hitting `OUTPUT_LIMIT`.
const UNDO_LIMIT: usize = 48 * 1024 * 1024;
const INLINE_THRESHOLD: usize = 32 * 1024;
const RESERVE_STEP: usize = crate::shared::RESPONSE_CHUNK;

mod scan;
mod syntax;
#[cfg(test)]
mod tests;
mod validate;

pub(crate) use scan::{ExtractedToolMedia, extract_tool_media, may_contain_image_uri, project_item};
pub(super) use scan::{collect_item_patches, for_each_json_array_item, for_each_json_object_field};
use syntax::JsonSyntax;
pub(super) use syntax::validate_json_syntax;
pub(crate) use validate::{extract_session_record, json_bounds_within, json_node_count_within, valid_reference_files};

#[derive(Debug)]
enum State {
    Start,
    ObjExpectKey,
    ObjKey { escaped: bool },
    ObjAfterKey { is_data: bool },
    ObjAfterValue,
    SkipValue { depth: usize, in_string: bool, escaped: bool },
    DataValueStart,
    DataArrayStart,
    DataArrayNext,
    DataItem { depth: usize, in_string: bool, escaped: bool },
    Passthrough,
}

pub(crate) struct UndoPatch {
    range: std::ops::Range<usize>,
    original: Box<[u8]>,
}

pub(crate) struct MessageListStream {
    state: State,
    syntax: JsonSyntax,
    bom_buf: [u8; 3],
    bom_len: u8,
    bom_done: bool,
    had_bom: bool,
    key_buf: Vec<u8>,
    segments: std::collections::VecDeque<axum::body::Bytes>,
    segments_bytes: usize,
    undo: Vec<(usize, Vec<UndoPatch>)>,
    undo_bytes: usize,
    undo_overflow: bool,
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
            syntax: JsonSyntax::new(),
            bom_buf: [0; 3],
            bom_len: 0,
            bom_done: false,
            had_bom: false,
            key_buf: Vec::new(),
            segments: std::collections::VecDeque::new(),
            segments_bytes: 0,
            undo: Vec::new(),
            undo_bytes: 0,
            undo_overflow: false,
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
        self.segments_bytes
            .saturating_add(self.undo_bytes)
            .saturating_add(self.out.capacity())
            .saturating_add(self.item.capacity())
            .saturating_add(self.segments.capacity().saturating_mul(std::mem::size_of::<(axum::body::Bytes, usize)>()))
            .saturating_add(self.undo.capacity().saturating_mul(std::mem::size_of::<(usize, Vec<UndoPatch>)>()))
    }

    pub(crate) fn needs_blocking_finish(&self) -> bool {
        self.retained_bytes() > INLINE_THRESHOLD
    }

    pub(crate) fn evict_undo_if_needed(&mut self, incoming_peak: usize) {
        if !self.undo.is_empty() && self.retained_bytes().saturating_add(incoming_peak) > OUTPUT_LIMIT {
            self.undo.clear();
            self.undo.shrink_to_fit();
            self.undo_bytes = 0;
            self.undo_overflow = true;
        }
    }

    fn push_out(&mut self, byte: u8) -> Result<(), ()> {
        if self.out.len() == self.out.capacity() {
            self.evict_undo_if_needed(1);
            let avail = OUTPUT_LIMIT.saturating_sub(self.retained_bytes());
            if avail == 0 {
                return Err(());
            }
            let step = self.out.capacity().max(64).min(RESERVE_STEP).min(avail);
            self.out.reserve_exact(step);
        }
        self.out.push(byte);
        if self.retained_bytes() > OUTPUT_LIMIT {
            return Err(());
        }
        Ok(())
    }

    fn extend_out(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let slack = self.out.capacity().saturating_sub(self.out.len());
        if bytes.len() > slack {
            let extra = bytes.len() - slack;
            self.evict_undo_if_needed(extra);
            let avail = OUTPUT_LIMIT.saturating_sub(self.retained_bytes());
            if extra > avail {
                return Err(());
            }
            // `Vec::reserve_exact` reserves relative to `len`, not `capacity`, so add `slack`
            // so the resulting capacity grows by `step <= avail` without triggering Vec doubling.
            let step = self.out.capacity().max(64).min(RESERVE_STEP).max(extra).min(avail);
            self.out.reserve_exact(slack.saturating_add(step));
        }
        self.out.extend_from_slice(bytes);
        if self.retained_bytes() > OUTPUT_LIMIT {
            return Err(());
        }
        Ok(())
    }

    fn push_item(&mut self, byte: u8) -> Result<(), ()> {
        if self.item.len() >= ITEM_LIMIT {
            return Err(());
        }
        if self.item.len() == self.item.capacity() {
            self.evict_undo_if_needed(1);
            let avail = OUTPUT_LIMIT.saturating_sub(self.retained_bytes());
            if avail == 0 {
                return Err(());
            }
            let rem = (ITEM_LIMIT - self.item.len()).min(avail);
            let step = self.item.capacity().max(64).min(RESERVE_STEP).min(rem);
            self.item.reserve_exact(step);
        }
        self.item.push(byte);
        if self.retained_bytes() > OUTPUT_LIMIT {
            return Err(());
        }
        Ok(())
    }

    fn push_segment(&mut self, mut bytes: Vec<u8>) -> Result<Option<usize>, ()> {
        self.evict_undo_if_needed(bytes.len());
        let after_flush = self
            .segments_bytes
            .saturating_add(self.undo_bytes)
            .saturating_add(self.out.len())
            .saturating_add(self.item.capacity())
            .saturating_add(bytes.len());
        if after_flush > OUTPUT_LIMIT {
            return Err(());
        }
        if !bytes.is_empty() {
            if !self.out.is_empty() {
                let mut prefix = std::mem::take(&mut self.out);
                prefix.shrink_to_fit();
                self.segments_bytes += prefix.len();
                self.segments.push_back(axum::body::Bytes::from(prefix));
            }
            bytes.shrink_to_fit();
            self.segments_bytes += bytes.len();
            self.segments.push_back(axum::body::Bytes::from(bytes));
            if self.retained_bytes() > OUTPUT_LIMIT {
                return Err(());
            }
            return Ok(Some(self.segments.len() - 1));
        }
        Ok(None)
    }

    /// Consumes bytes from `chunk` starting at `*pos`. Returns `Ok(Some(item))` whenever a
    /// `> 32 KiB` message item finishes so the caller can project it off the async executor
    /// and call `commit_item` before resuming the same chunk.
    pub(crate) fn feed(&mut self, chunk: &[u8], pos: &mut usize) -> Result<Option<PendingItem>, ()> {
        const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
        if !self.bom_done {
            while *pos < chunk.len() && !self.bom_done {
                let b = chunk[*pos];
                let idx = self.bom_len as usize;
                if b == BOM[idx] {
                    self.bom_buf[idx] = b;
                    self.bom_len += 1;
                    *pos += 1;
                    if self.bom_len == 3 {
                        self.bom_len = 0;
                        self.bom_done = true;
                        self.had_bom = true;
                    }
                } else {
                    self.bom_done = true;
                    if self.bom_len > 0 {
                        let prefix = self.bom_buf;
                        let len = self.bom_len as usize;
                        self.bom_len = 0;
                        let mut p = 0;
                        let _ = self.feed_inner(&prefix[..len], &mut p)?;
                        self.syntax.feed(&prefix[..p]);
                    }
                }
            }
            if !self.bom_done || *pos >= chunk.len() {
                return Ok(None);
            }
        }
        let start = *pos;
        let result = self.feed_inner(chunk, pos);
        self.syntax.feed(&chunk[start..*pos]);
        result
    }

    fn feed_inner(&mut self, chunk: &[u8], pos: &mut usize) -> Result<Option<PendingItem>, ()> {
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
                State::ObjAfterValue => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    self.state = if b == b',' { State::ObjExpectKey } else { State::Passthrough };
                }
                State::DataValueStart => {
                    self.push_out(b)?;
                    *pos += 1;
                    if b.is_ascii_whitespace() {
                        continue;
                    }
                    self.state = if b == b'[' {
                        State::DataArrayStart
                    } else if b == b'"' {
                        State::SkipValue { depth: 0, in_string: true, escaped: false }
                    } else if b == b'{' {
                        State::SkipValue { depth: 1, in_string: false, escaped: false }
                    } else if b == b',' {
                        State::ObjExpectKey
                    } else if b == b'}' {
                        State::Passthrough
                    } else {
                        State::SkipValue { depth: 0, in_string: false, escaped: false }
                    };
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
                        self.state = State::ObjAfterValue;
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
                        self.state = State::ObjAfterValue;
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
                        self.state = if b == b',' { State::DataArrayNext } else { State::ObjAfterValue };
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

    pub(crate) fn commit_item(
        &mut self,
        projected: Vec<u8>,
        undo_patches: Vec<UndoPatch>,
        delimiter: u8,
    ) -> Result<(), ()> {
        let undo_len: usize = undo_patches.iter().map(|p| p.original.len()).sum();
        let changed = !undo_patches.is_empty();
        // Drop the rollback log once kept original URIs would exceed `UNDO_LIMIT` or push past
        // `OUTPUT_LIMIT`, so valid pages with hundreds of MiB of deferrable images still succeed
        // while oversized invalid JSON fails closed in `finish()`.
        if changed
            && (self.undo_overflow
                || self.undo_bytes.saturating_add(undo_len) > UNDO_LIMIT
                || self.retained_bytes().saturating_add(projected.len()).saturating_add(undo_len) > OUTPUT_LIMIT)
        {
            self.undo.clear();
            self.undo.shrink_to_fit();
            self.undo_bytes = 0;
            self.undo_overflow = true;
        }
        if self.retained_bytes().saturating_add(projected.len()) > OUTPUT_LIMIT {
            self.evict_undo_if_needed(projected.len());
            if self.retained_bytes().saturating_add(projected.len()) > OUTPUT_LIMIT {
                return Err(());
            }
        }
        self.changed |= changed;
        if (!changed || self.undo_overflow) && projected.len() <= 4096 {
            // Coalesce small non-rollback items directly into `self.out` to avoid per-item deque growth.
            self.extend_out(&projected)?;
        } else {
            let seg_idx = self.push_segment(projected)?;
            if changed
                && !self.undo_overflow
                && let Some(idx) = seg_idx
            {
                self.undo_bytes += undo_len;
                self.undo.push((idx, undo_patches));
            }
        }
        self.push_out(delimiter)?;
        self.state = if delimiter == b',' { State::DataArrayNext } else { State::ObjAfterValue };
        Ok(())
    }

    /// Returns `(chunks_with_backing_release, payload_len, total_backing_len, changed)`.
    pub(crate) fn finish(
        mut self,
    ) -> Result<(std::collections::VecDeque<(axum::body::Bytes, usize)>, usize, usize, bool), ()> {
        if self.bom_len > 0 {
            let prefix = self.bom_buf;
            let len = self.bom_len as usize;
            self.bom_len = 0;
            self.bom_done = true;
            let mut p = 0;
            let _ = self.feed_inner(&prefix[..len], &mut p)?;
            self.syntax.feed(&prefix[..p]);
        }
        if !self.item.is_empty() {
            let item = std::mem::take(&mut self.item);
            self.push_segment(item)?;
        }
        if !self.out.is_empty() {
            let mut tail = std::mem::take(&mut self.out);
            tail.shrink_to_fit();
            self.segments_bytes += tail.len();
            self.segments.push_back(axum::body::Bytes::from(tail));
        }
        if self.syntax.is_valid_eof() {
            drop(self.undo);
            let chunks = self.segments.into_iter().map(|seg| {
                let len = seg.len();
                (seg, len)
            });
            return Ok((chunks.collect(), self.segments_bytes, self.segments_bytes, self.changed || self.had_bom));
        }
        if self.undo_overflow {
            // Never emit partially rewritten invalid JSON when rollback originals were evicted.
            return Err(());
        }
        // Invalid JSON anywhere in the document: restore all deferred URIs verbatim with ZERO
        // extra heap copies using `Bytes::slice`, attributing each patched segment's full backing
        // size (`seg.len()`) ONLY to its final slice so `permit_body_chunks` holds permits until
        // the backing allocation is actually dropped (matching TS `proxy.ts:91`).
        let mut by_idx: std::collections::HashMap<usize, Vec<UndoPatch>> = self.undo.into_iter().collect();
        let mut restored = std::collections::VecDeque::with_capacity(self.segments.len() + by_idx.len() * 2);
        let mut payload_len = 0usize;
        let mut backing_len = 0usize;
        for (idx, seg) in self.segments.into_iter().enumerate() {
            if let Some(patches) = by_idx.remove(&idx) {
                let seg_backing = seg.len();
                let mut last_seg_slice_pos: Option<usize> = None;
                let mut cursor = 0usize;
                for patch in patches {
                    if patch.range.start > cursor {
                        let prefix = seg.slice(cursor..patch.range.start);
                        payload_len += prefix.len();
                        last_seg_slice_pos = Some(restored.len());
                        restored.push_back((prefix, 0));
                    }
                    let orig = axum::body::Bytes::from(patch.original);
                    let orig_len = orig.len();
                    payload_len += orig_len;
                    backing_len += orig_len;
                    restored.push_back((orig, orig_len));
                    cursor = patch.range.end;
                }
                if cursor < seg.len() {
                    let suffix = seg.slice(cursor..);
                    payload_len += suffix.len();
                    last_seg_slice_pos = Some(restored.len());
                    restored.push_back((suffix, 0));
                }
                if let Some(pos) = last_seg_slice_pos {
                    restored[pos].1 = seg_backing;
                    backing_len += seg_backing;
                }
            } else {
                let len = seg.len();
                payload_len += len;
                backing_len += len;
                restored.push_back((seg, len));
            }
        }
        Ok((restored, payload_len, backing_len, self.had_bom))
    }
}
