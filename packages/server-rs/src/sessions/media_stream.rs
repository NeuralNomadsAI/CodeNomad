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
use super::media;

/// Cap on the projected (or unprojected fallback) output buffer, aligned with `ResponsePool::List`.
pub(crate) const OUTPUT_LIMIT: usize = 256 * 1024 * 1024;
/// Cap on a single raw message item before projection.
const ITEM_LIMIT: usize = 128 * 1024 * 1024;
const INLINE_THRESHOLD: usize = 32 * 1024;
const RESERVE_STEP: usize = crate::shared::RESPONSE_CHUNK;
const MAX_SYNTAX_DEPTH: usize = 1024;

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

#[derive(Clone, Copy)]
enum Esc {
    None,
    Slash,
    Hex(u8),
}

#[derive(Clone, Copy)]
enum NumState {
    Sign,
    Zero,
    Int,
    DotStart,
    Frac,
    ExpSign,
    ExpStart,
    Exp,
}

#[derive(Clone, Copy)]
enum SyntaxState {
    ExpectValue,
    AfterValue,
    ObjKeyOrEnd,
    ObjKey,
    ObjColon,
    ArrValueOrEnd,
    String { in_key: bool, esc: Esc },
    Number(NumState),
    Keyword(&'static [u8], usize),
    Invalid,
}

/// Streaming RFC 8259 JSON syntax validator with bounded stack (`<= 1 KiB`) so `finish()`
/// restores the unmodified upstream bytes whenever the full document is not valid JSON
/// (matching TS `proxy.ts:91` `JSON.parse` fallback).
struct JsonSyntax {
    state: SyntaxState,
    stack: Vec<u8>,
}

impl JsonSyntax {
    fn new() -> Self {
        Self { state: SyntaxState::ExpectValue, stack: Vec::new() }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if matches!(self.state, SyntaxState::Invalid) {
                return;
            }
            self.step(b);
        }
    }

    fn step(&mut self, b: u8) {
        let current = b;
        loop {
            match self.state {
                SyntaxState::Invalid => return,
                SyntaxState::String { in_key, esc } => {
                    match esc {
                        Esc::None => match current {
                            b'"' => {
                                self.state = if in_key { SyntaxState::ObjColon } else { SyntaxState::AfterValue };
                            }
                            b'\\' => self.state = SyntaxState::String { in_key, esc: Esc::Slash },
                            0x00..=0x1F => self.state = SyntaxState::Invalid,
                            _ => {}
                        },
                        Esc::Slash => match current {
                            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                                self.state = SyntaxState::String { in_key, esc: Esc::None };
                            }
                            b'u' => self.state = SyntaxState::String { in_key, esc: Esc::Hex(4) },
                            _ => self.state = SyntaxState::Invalid,
                        },
                        Esc::Hex(rem) => {
                            if current.is_ascii_hexdigit() {
                                self.state = SyntaxState::String {
                                    in_key,
                                    esc: if rem <= 1 { Esc::None } else { Esc::Hex(rem - 1) },
                                };
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                    }
                    return;
                }
                SyntaxState::Keyword(expected, idx) => {
                    if current == expected[idx] {
                        if idx + 1 == expected.len() {
                            self.state = SyntaxState::AfterValue;
                        } else {
                            self.state = SyntaxState::Keyword(expected, idx + 1);
                        }
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::Number(num) => {
                    match num {
                        NumState::Sign => match current {
                            b'0' => self.state = SyntaxState::Number(NumState::Zero),
                            b'1'..=b'9' => self.state = SyntaxState::Number(NumState::Int),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Zero => match current {
                            b'.' => self.state = SyntaxState::Number(NumState::DotStart),
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            b'0'..=b'9' => self.state = SyntaxState::Invalid,
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::Int => match current {
                            b'0'..=b'9' => {}
                            b'.' => self.state = SyntaxState::Number(NumState::DotStart),
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::DotStart => match current {
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Frac),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Frac => match current {
                            b'0'..=b'9' => {}
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::ExpSign => match current {
                            b'+' | b'-' => self.state = SyntaxState::Number(NumState::ExpStart),
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Exp),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::ExpStart => match current {
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Exp),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Exp => match current {
                            b'0'..=b'9' => {}
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                    }
                    return;
                }
                SyntaxState::ExpectValue | SyntaxState::ArrValueOrEnd => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if matches!(self.state, SyntaxState::ArrValueOrEnd) && current == b']' {
                        if self.stack.pop() == Some(b'[') {
                            self.state = SyntaxState::AfterValue;
                        } else {
                            self.state = SyntaxState::Invalid;
                        }
                        return;
                    }
                    match current {
                        b'{' => {
                            if self.stack.len() >= MAX_SYNTAX_DEPTH {
                                self.state = SyntaxState::Invalid;
                            } else {
                                self.stack.push(b'{');
                                self.state = SyntaxState::ObjKeyOrEnd;
                            }
                        }
                        b'[' => {
                            if self.stack.len() >= MAX_SYNTAX_DEPTH {
                                self.state = SyntaxState::Invalid;
                            } else {
                                self.stack.push(b'[');
                                self.state = SyntaxState::ArrValueOrEnd;
                            }
                        }
                        b'"' => self.state = SyntaxState::String { in_key: false, esc: Esc::None },
                        b'-' => self.state = SyntaxState::Number(NumState::Sign),
                        b'0' => self.state = SyntaxState::Number(NumState::Zero),
                        b'1'..=b'9' => self.state = SyntaxState::Number(NumState::Int),
                        b't' => self.state = SyntaxState::Keyword(b"rue", 0),
                        b'f' => self.state = SyntaxState::Keyword(b"alse", 0),
                        b'n' => self.state = SyntaxState::Keyword(b"ull", 0),
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
                SyntaxState::ObjKeyOrEnd => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    match current {
                        b'}' => {
                            if self.stack.pop() == Some(b'{') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        b'"' => self.state = SyntaxState::String { in_key: true, esc: Esc::None },
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
                SyntaxState::ObjKey => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if current == b'"' {
                        self.state = SyntaxState::String { in_key: true, esc: Esc::None };
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::ObjColon => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if current == b':' {
                        self.state = SyntaxState::ExpectValue;
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::AfterValue => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    match current {
                        b',' => match self.stack.last().copied() {
                            Some(b'{') => self.state = SyntaxState::ObjKey,
                            Some(b'[') => self.state = SyntaxState::ExpectValue,
                            _ => self.state = SyntaxState::Invalid,
                        },
                        b'}' => {
                            if self.stack.pop() == Some(b'{') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        b']' => {
                            if self.stack.pop() == Some(b'[') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
            }
            #[allow(unreachable_code)]
            {
                current = b;
            }
        }
    }

    fn is_valid_eof(&self) -> bool {
        self.stack.is_empty()
            && matches!(
                self.state,
                SyntaxState::AfterValue
                    | SyntaxState::Number(NumState::Zero | NumState::Int | NumState::Frac | NumState::Exp)
            )
    }
}

pub(crate) struct UndoPatch {
    range: std::ops::Range<usize>,
    original: Box<[u8]>,
}

pub(crate) struct MessageListStream {
    state: State,
    syntax: JsonSyntax,
    key_buf: Vec<u8>,
    segments: std::collections::VecDeque<axum::body::Bytes>,
    segments_bytes: usize,
    undo: Vec<(usize, Vec<UndoPatch>)>,
    undo_bytes: usize,
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
            key_buf: Vec::new(),
            segments: std::collections::VecDeque::new(),
            segments_bytes: 0,
            undo: Vec::new(),
            undo_bytes: 0,
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
    }

    fn total_len(&self) -> usize {
        self.segments_bytes
            .saturating_add(self.undo_bytes)
            .saturating_add(self.out.len())
            .saturating_add(self.item.len())
    }

    fn push_out(&mut self, byte: u8) -> Result<(), ()> {
        let total = self.total_len();
        if total >= OUTPUT_LIMIT {
            return Err(());
        }
        if self.out.len() == self.out.capacity() && self.out.len() >= RESERVE_STEP {
            let step = (OUTPUT_LIMIT - total).min(RESERVE_STEP).max(1);
            self.out.reserve_exact(step);
        }
        self.out.push(byte);
        Ok(())
    }

    fn extend_out(&mut self, bytes: &[u8]) -> Result<(), ()> {
        let total = self.total_len().saturating_add(bytes.len());
        if total > OUTPUT_LIMIT {
            return Err(());
        }
        if self.out.len() + bytes.len() > self.out.capacity() && self.out.len() + bytes.len() >= RESERVE_STEP {
            self.out.reserve_exact(bytes.len());
        }
        self.out.extend_from_slice(bytes);
        Ok(())
    }

    fn push_item(&mut self, byte: u8) -> Result<(), ()> {
        let total = self.total_len();
        if self.item.len() >= ITEM_LIMIT || total >= OUTPUT_LIMIT {
            return Err(());
        }
        if self.item.len() == self.item.capacity() && self.item.len() >= RESERVE_STEP {
            let rem = (ITEM_LIMIT - self.item.len()).min(OUTPUT_LIMIT - total);
            self.item.reserve_exact(rem.min(RESERVE_STEP).max(1));
        }
        self.item.push(byte);
        Ok(())
    }

    fn push_segment(&mut self, mut bytes: Vec<u8>) -> Result<Option<usize>, ()> {
        if self.total_len().saturating_add(bytes.len()) > OUTPUT_LIMIT {
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
            return Ok(Some(self.segments.len() - 1));
        }
        Ok(None)
    }

    /// Consumes bytes from `chunk` starting at `*pos`. Returns `Ok(Some(item))` whenever a
    /// `> 32 KiB` message item finishes so the caller can project it off the async executor
    /// and call `commit_item` before resuming the same chunk.
    pub(crate) fn feed(&mut self, chunk: &[u8], pos: &mut usize) -> Result<Option<PendingItem>, ()> {
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

    pub(crate) fn commit_item(
        &mut self,
        projected: Vec<u8>,
        undo_patches: Vec<UndoPatch>,
        delimiter: u8,
    ) -> Result<(), ()> {
        let undo_len: usize = undo_patches.iter().map(|p| p.original.len()).sum();
        if self.total_len().saturating_add(projected.len()).saturating_add(undo_len) > OUTPUT_LIMIT {
            return Err(());
        }
        let changed = !undo_patches.is_empty();
        self.changed |= changed;
        let seg_idx = self.push_segment(projected)?;
        if changed && let Some(idx) = seg_idx {
            self.undo_bytes += undo_len;
            self.undo.push((idx, undo_patches));
        }
        self.push_out(delimiter)?;
        self.state = if delimiter == b',' { State::DataArrayNext } else { State::Passthrough };
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<(std::collections::VecDeque<axum::body::Bytes>, usize, bool), ()> {
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
            return Ok((self.segments, self.segments_bytes, self.changed));
        }
        // Invalid JSON anywhere in the document: restore all deferred URIs verbatim to match
        // TS `proxy.ts:91` (`try { JSON.parse(text) } catch { return reply.send(text) }`).
        for (idx, patches) in self.undo {
            if let Some(seg) = self.segments.get_mut(idx) {
                let delta: isize =
                    patches.iter().map(|p| p.original.len() as isize - (p.range.end - p.range.start) as isize).sum();
                let restored_len = (seg.len() as isize + delta) as usize;
                let mut restored = Vec::with_capacity(restored_len);
                let mut cursor = 0usize;
                for patch in patches {
                    restored.extend_from_slice(&seg[cursor..patch.range.start]);
                    restored.extend_from_slice(&patch.original);
                    cursor = patch.range.end;
                }
                restored.extend_from_slice(&seg[cursor..]);
                self.segments_bytes = self.segments_bytes - seg.len() + restored.len();
                *seg = axum::body::Bytes::from(restored);
            }
        }
        Ok((self.segments, self.segments_bytes, false))
    }
}

fn may_contain_image_uri(haystack: &[u8]) -> bool {
    const NEEDLE: &[u8] = b"data:image";
    if haystack.len() < NEEDLE.len() {
        return false;
    }
    haystack.windows(NEEDLE.len()).any(|w| w.eq_ignore_ascii_case(NEEDLE)) || haystack.windows(2).any(|w| w == b"\\u")
}

fn parse_string(raw: &str) -> Option<String> {
    serde_json::from_str::<String>(raw).ok()
}

/// Streams through a JSON object's top-level `"key": value` entries with zero intermediate
/// `BTreeMap` or `String` allocations. Only short keys (`<= 64` bytes, matching the target
/// field names) are decoded and forwarded to `visit`. Duplicate keys naturally follow last-wins
/// order matching JS `JSON.parse`.
fn for_each_json_object_field<'a>(raw: &'a str, mut visit: impl FnMut(&str, &'a str)) -> Option<()> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if bytes.get(i) == Some(&b'}') {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        return (i == bytes.len()).then_some(());
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let key_start = i;
        let key_end = skip_json_value(bytes, key_start)?;
        let key_tok = &raw[key_start..key_end];
        i = key_end;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let val_start = i;
        let val_end = skip_json_value(bytes, val_start)?;
        let val_tok = &raw[val_start..val_end];
        if key_tok.len() <= 16 && !key_tok.as_bytes().contains(&b'\\') {
            visit(&key_tok[1..key_tok.len() - 1], val_tok);
        } else if key_tok.len() <= 64
            && let Some(decoded) = parse_string(key_tok)
        {
            visit(&decoded, val_tok);
        }
        i = val_end;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
            }
            Some(&b'}') => {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                return (i == bytes.len()).then_some(());
            }
            _ => return None,
        }
    }
}

/// Advances past one complete JSON value starting at `start` (string, object, array, number,
/// boolean, or null) and returns its exclusive end byte offset.
fn skip_json_value(bytes: &[u8], start: usize) -> Option<usize> {
    let first = *bytes.get(start)?;
    match first {
        b'"' => {
            let mut i = start + 1;
            let mut escaped = false;
            while i < bytes.len() {
                let b = bytes[i];
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    return Some(i + 1);
                }
                i += 1;
            }
            None
        }
        b'{' | b'[' => {
            let mut i = start + 1;
            let mut depth = 1usize;
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
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some(i + 1);
                            }
                        }
                        _ => {}
                    }
                }
                i += 1;
            }
            None
        }
        _ => {
            let mut i = start;
            while i < bytes.len() && !matches!(bytes[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                i += 1;
            }
            (i > start).then_some(i)
        }
    }
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
/// and tool content items with zero intermediate array/map allocations, recording only the
/// byte ranges of replaced `"uri"` JSON string tokens and splicing them in one single pass.
/// Returns the projected bytes and the `UndoPatch` list needed to restore the original bytes if
/// a subsequent chunk renders the full document invalid JSON.
pub(crate) fn project_item(workspace_enc: &str, session_enc: &str, mut raw: Vec<u8>) -> (Vec<u8>, Vec<UndoPatch>) {
    if !may_contain_image_uri(&raw) {
        return (raw, Vec::new());
    }
    let patches = (|| -> Option<Vec<(usize, usize, String)>> {
        let text = std::str::from_utf8(&raw).ok()?;
        let base = raw.as_ptr() as usize;
        let (mut msg_type, mut msg_id, mut content_raw) = (None, None, None);
        for_each_json_object_field(text, |k, v| match k {
            "type" => msg_type = Some(v),
            "id" => msg_id = Some(v),
            "content" => content_raw = Some(v),
            _ => {}
        })?;
        if parse_string(msg_type?)?.as_str() != "assistant" {
            return None;
        }
        let id_raw = parse_string(msg_id?)?;
        if !media::valid_id(&id_raw) {
            return None;
        }
        let content_raw = content_raw?;
        if !may_contain_image_uri(content_raw.as_bytes()) {
            return None;
        }
        let id_enc = media::encode(&id_raw);
        let mut patches = Vec::new();
        for_each_json_array_item(content_raw, MAX_SCANNED_ITEMS, |part_idx, part_raw| {
            if !may_contain_image_uri(part_raw.as_bytes()) {
                return;
            }
            let (mut part_type, mut state_raw) = (None, None);
            if for_each_json_object_field(part_raw, |k, v| match k {
                "type" => part_type = Some(v),
                "state" => state_raw = Some(v),
                _ => {}
            })
            .is_none()
            {
                return;
            }
            if part_type.and_then(parse_string).as_deref() != Some("tool") {
                return;
            }
            let Some(state_raw) = state_raw else {
                return;
            };
            if !may_contain_image_uri(state_raw.as_bytes()) {
                return;
            }
            let mut items_raw = None;
            if for_each_json_object_field(state_raw, |k, v| {
                if k == "content" {
                    items_raw = Some(v);
                }
            })
            .is_none()
            {
                return;
            }
            let Some(items_raw) = items_raw else {
                return;
            };
            if !may_contain_image_uri(items_raw.as_bytes()) {
                return;
            }
            let _ = for_each_json_array_item(items_raw, MAX_SCANNED_ITEMS, |item_idx, item_raw| {
                if item_raw.len() <= INLINE_THRESHOLD || !may_contain_image_uri(item_raw.as_bytes()) {
                    return;
                }
                let (mut file_type, mut mime, mut uri_raw) = (None, None, None);
                if for_each_json_object_field(item_raw, |k, v| match k {
                    "type" => file_type = Some(v),
                    "mime" => mime = Some(v),
                    "uri" => uri_raw = Some(v),
                    _ => {}
                })
                .is_none()
                {
                    return;
                }
                let Some(file_type) = file_type.and_then(parse_string) else {
                    return;
                };
                let Some(mime) = mime.and_then(parse_string) else {
                    return;
                };
                let Some(uri_raw) = uri_raw else {
                    return;
                };
                if uri_raw.len() <= INLINE_THRESHOLD {
                    return;
                }
                let Some(uri) = parse_string(uri_raw) else {
                    return;
                };
                if let Some(reference) =
                    media::defer_uri(workspace_enc, session_enc, &id_enc, part_idx, item_idx, &file_type, &mime, &uri)
                    && let Ok(encoded) = serde_json::to_string(&reference)
                {
                    let start = uri_raw.as_ptr() as usize - base;
                    let end = start + uri_raw.len();
                    patches.push((start, end, encoded));
                }
            });
        })?;
        (!patches.is_empty()).then_some(patches)
    })();
    let Some(mut patches) = patches else {
        return (raw, Vec::new());
    };
    patches.sort_unstable_by_key(|(start, _, _)| *start);
    let mut cursor = 0usize;
    let mut fits_in_place = true;
    for (start, end, replacement) in &patches {
        if *start < cursor || *end > raw.len() {
            return (raw, Vec::new());
        }
        if replacement.len() > end - start {
            fits_in_place = false;
        }
        cursor = *end;
    }
    let mut undo = Vec::with_capacity(patches.len());
    if fits_in_place {
        // Every deferred `/api/workspaces/.../session-media/...` URI is strictly shorter than the
        // `> 32 KiB` data URI it replaces, so splicing in-place avoids allocating a second `Vec`.
        let mut read_pos = 0usize;
        let mut write_pos = 0usize;
        for (start, end, replacement) in patches {
            let original: Box<[u8]> = raw[start..end].into();
            let prefix_len = start - read_pos;
            if write_pos != read_pos && prefix_len > 0 {
                raw.copy_within(read_pos..start, write_pos);
            }
            write_pos += prefix_len;
            let rep = replacement.as_bytes();
            let new_start = write_pos;
            raw[write_pos..write_pos + rep.len()].copy_from_slice(rep);
            write_pos += rep.len();
            undo.push(UndoPatch { range: new_start..write_pos, original });
            read_pos = end;
        }
        let tail_len = raw.len() - read_pos;
        if write_pos != read_pos && tail_len > 0 {
            raw.copy_within(read_pos.., write_pos);
        }
        write_pos += tail_len;
        raw.truncate(write_pos);
        raw.shrink_to_fit();
        return (raw, undo);
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for (start, end, replacement) in patches {
        out.extend_from_slice(&raw[cursor..start]);
        let new_start = out.len();
        out.extend_from_slice(replacement.as_bytes());
        let new_end = out.len();
        undo.push(UndoPatch { range: new_start..new_end, original: raw[start..end].into() });
        cursor = end;
    }
    out.extend_from_slice(&raw[cursor..]);
    out.shrink_to_fit();
    (out, undo)
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
                let (out, undo) = project_item(ws, ses, pending.bytes);
                stream.commit_item(out, undo, pending.delimiter).unwrap();
            }
        }
        let (segments, total, changed) = stream.finish().unwrap();
        let mut flat = Vec::with_capacity(total);
        for seg in segments {
            flat.extend_from_slice(&seg);
        }
        assert_eq!(flat.len(), total);
        (axum::body::Bytes::from(flat), changed)
    }

    #[test]
    fn preserves_non_object_invalid_and_small_json_byte_for_byte() {
        for raw in
            [b"".as_slice(), b"[]", b"{}", b"null", b"not json", b"{\"data\":[]}", b"{\"other\":[1],\"data\":null}"]
        {
            for chunk in [1, 7, 1024] {
                let (out, changed) = run_stream("ws_1", "ses_1", raw, chunk);
                assert!(!changed);
                assert_eq!(out.as_ref(), raw);
            }
        }
    }

    #[test]
    fn restores_original_bytes_when_document_tail_is_invalid_json() {
        let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
        let valid_prefix = json!({
            "data": [
                {"id": "msg_big", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]}
            ]
        })
        .to_string();
        let trailing_garbage = format!("{valid_prefix} trailing");
        let truncated = valid_prefix[..valid_prefix.len() - 1].to_owned();
        let bad_tail = format!("{},\"tail\": [1,]}}", &valid_prefix[..valid_prefix.len() - 1]);
        for bad in [&trailing_garbage, &truncated, &bad_tail] {
            for chunk in [97, 4096, bad.len()] {
                let (out, changed) = run_stream("ws_1", "ses_1", bad.as_bytes(), chunk);
                assert!(!changed, "invalid JSON must not report changed");
                assert_eq!(out.as_ref(), bad.as_bytes());
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
        let (out, undo) = project_item("ws_1", "ses_1", dense.clone().into_bytes());
        assert!(undo.is_empty());
        assert_eq!(out, dense.as_bytes());

        let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
        let with_nums = json!({
            "id": "msg_mix",
            "type": "assistant",
            "extra": [1, 2, 3, 4, 5],
            "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]
        });
        let (out, undo) = project_item("ws_1", "ses_1", with_nums.to_string().into_bytes());
        assert!(!undo.is_empty());
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
        let (out, undo) = project_item("ws_1", "ses_1", escaped_slash.into_bytes());
        assert!(!undo.is_empty());
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
        let (out, undo) = project_item("ws_1", "ses_1", escaped_unicode.into_bytes());
        assert!(!undo.is_empty());
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
        let (out, undo) = project_item("ws_1", "ses_1", big_parts.into_bytes());
        assert!(!undo.is_empty());
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
