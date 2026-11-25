//! Byte-oriented JSON scanning, bounded image-URI parsing, and in-place tool-media projection.
use super::{INLINE_THRESHOLD, UndoPatch, media, syntax::JsonSyntax};

pub(super) fn parse_short_string(raw: &str, max_raw: usize) -> Option<String> {
    (raw.len() <= max_raw).then(|| serde_json::from_str::<String>(raw).ok()).flatten()
}

pub(crate) fn may_contain_image_uri(haystack: &[u8]) -> bool {
    const NEEDLE: &[u8] = b"data:image";
    if haystack.len() < NEEDLE.len() {
        return false;
    }
    if haystack.windows(NEEDLE.len()).any(|w| w.eq_ignore_ascii_case(NEEDLE)) {
        return true;
    }
    // Only return true for `\u`-escaped text if a JSON string literal actually begins with
    // ASCII case-insensitive `data:image`, avoiding false positives on ordinary Unicode text.
    if !haystack.windows(2).any(|w| w == b"\\u") {
        return false;
    }
    let mut i = 0usize;
    while let Some(rel) = memchr::memchr(b'"', &haystack[i..]) {
        let mut p = i + rel + 1;
        let mut matched = 0usize;
        while matched < NEEDLE.len() && p < haystack.len() {
            let ch = if haystack[p] == b'\\' && haystack.get(p + 1) == Some(&b'u') {
                let Some(code) = parse_hex4(haystack, p + 2) else { break };
                if code > 0x7f {
                    break;
                }
                p += 6;
                code as u8
            } else if haystack[p] == b'\\' && haystack.get(p + 1) == Some(&b'/') {
                p += 2;
                b'/'
            } else {
                let b = haystack[p];
                p += 1;
                b
            };
            if !ch.eq_ignore_ascii_case(&NEEDLE[matched]) {
                break;
            }
            matched += 1;
        }
        if matched == NEEDLE.len() {
            return true;
        }
        i = i + rel + 1;
    }
    false
}

pub(super) fn parse_string(raw: &str) -> Option<String> {
    serde_json::from_str::<String>(raw).ok()
}

fn hex_val(b: u8) -> Option<u16> {
    match b {
        b'0'..=b'9' => Some((b - b'0') as u16),
        b'a'..=b'f' => Some((b - b'a' + 10) as u16),
        b'A'..=b'F' => Some((b - b'A' + 10) as u16),
        _ => None,
    }
}

fn parse_hex4(bytes: &[u8], i: usize) -> Option<u16> {
    let b = bytes.get(i..i + 4)?;
    Some((hex_val(b[0])? << 12) | (hex_val(b[1])? << 8) | (hex_val(b[2])? << 4) | hex_val(b[3])?)
}

/// Decodes a JSON string token directly into a single `String` capped at `max_utf16` UTF-16 code
/// units (and rejects non-`data:image/` prefixes within the first 11 characters), preventing a
/// 120 MiB escaped non-deferrable URI from allocating a 240+ MiB `serde_json` scratch + result pair.
pub(super) fn parse_bounded_image_uri(raw: &str, max_utf16: usize) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return None;
    }
    let inner = &raw[1..raw.len() - 1];
    if !inner.as_bytes().contains(&b'\\') {
        if !inner.get(..11).is_some_and(|p| p.eq_ignore_ascii_case("data:image/")) {
            return None;
        }
        if inner.len() > max_utf16 && inner.encode_utf16().nth(max_utf16).is_some() {
            return None;
        }
        return Some(inner.to_owned());
    }
    let mut out = String::with_capacity(inner.len().min(256));
    let mut utf16 = 0usize;
    let mut prefix_checked = false;
    let mut i = 0usize;
    let ib = inner.as_bytes();
    while i < ib.len() {
        let b = ib[i];
        if b == b'\\' {
            i += 1;
            let esc = *ib.get(i)?;
            i += 1;
            let ch = match esc {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\x08',
                b'f' => '\x0C',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => {
                    let u1 = parse_hex4(ib, i)?;
                    i += 4;
                    if (0xD800..=0xDBFF).contains(&u1) {
                        if ib.get(i..i + 2) != Some(b"\\u") {
                            return None;
                        }
                        i += 2;
                        let u2 = parse_hex4(ib, i)?;
                        i += 4;
                        if !(0xDC00..=0xDFFF).contains(&u2) {
                            return None;
                        }
                        let cp = 0x10000 + (((u1 as u32 - 0xD800) << 10) | (u2 as u32 - 0xDC00));
                        char::from_u32(cp)?
                    } else if (0xDC00..=0xDFFF).contains(&u1) {
                        return None;
                    } else {
                        char::from_u32(u1 as u32)?
                    }
                }
                _ => return None,
            };
            utf16 += ch.len_utf16();
            if utf16 > max_utf16 {
                return None;
            }
            out.push(ch);
        } else if b < 0x20 {
            return None;
        } else {
            let start = i;
            while i < ib.len() && ib[i] != b'\\' && ib[i] >= 0x20 {
                i += 1;
            }
            let chunk = &inner[start..i];
            let chunk_utf16 = if chunk.is_ascii() { chunk.len() } else { chunk.encode_utf16().count() };
            utf16 += chunk_utf16;
            if utf16 > max_utf16 {
                return None;
            }
            out.push_str(chunk);
        }
        if !prefix_checked && out.len() >= 11 {
            if !out.get(..11).is_some_and(|p| p.eq_ignore_ascii_case("data:image/")) {
                return None;
            }
            prefix_checked = true;
            let reserve = (ib.len() - i).min(max_utf16.saturating_sub(out.len()));
            out.reserve(reserve);
        }
    }
    if !prefix_checked {
        return None;
    }
    Some(out)
}

/// Streams through a JSON object's top-level `"key": value` entries with zero intermediate
/// `BTreeMap` or `String` allocations. Only short keys (`<= 64` bytes, matching the target
/// field names) are decoded and forwarded to `visit`. Duplicate keys naturally follow last-wins
/// order matching JS `JSON.parse`.
pub(crate) fn for_each_json_object_field<'a>(raw: &'a str, mut visit: impl FnMut(&str, &'a str)) -> Option<()> {
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
        } else if key_tok.len() <= 256
            && let Some(decoded) = parse_string(key_tok)
        {
            visit(&decoded, val_tok);
        } else {
            // Surface oversized keys (>256 raw bytes, well above any schema key even when fully
            // `\uXXXX`-escaped) via a NUL sentinel so strict-schema validators reject them.
            visit("\0", val_tok);
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
pub(crate) fn for_each_json_array_item<'a>(
    raw: &'a str,
    limit: usize,
    mut visit: impl FnMut(usize, &'a str),
) -> Option<()> {
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

/// Collects byte ranges `(start, end, json_encoded_replacement)` relative to `text` for every
/// deferrable `> 32 KiB` tool image URI in a single message JSON object, with zero `Value` tree
/// allocation and bounded string decoding (`<= 2 KiB` for metadata fields, `<= 8 MiB` for URIs).
pub(crate) fn collect_item_patches(
    workspace_enc: &str,
    session_enc: &str,
    text: &str,
) -> Option<Vec<(usize, usize, String)>> {
    if !may_contain_image_uri(text.as_bytes()) {
        return None;
    }
    let base = text.as_ptr() as usize;
    let (mut msg_type, mut msg_id, mut content_raw) = (None, None, None);
    for_each_json_object_field(text, |k, v| match k {
        "type" => msg_type = Some(v),
        "id" => msg_id = Some(v),
        "content" => content_raw = Some(v),
        _ => {}
    })?;
    if parse_short_string(msg_type?, 128)?.as_str() != "assistant" {
        return None;
    }
    let id_raw = parse_short_string(msg_id?, 2048)?;
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
        if part_type.and_then(|v| parse_short_string(v, 128)).as_deref() != Some("tool") {
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
            let Some(file_type) = file_type.and_then(|v| parse_short_string(v, 128)) else {
                return;
            };
            let Some(mime) = mime.and_then(|v| parse_short_string(v, 1024)) else {
                return;
            };
            let Some(uri_raw) = uri_raw else {
                return;
            };
            if uri_raw.len() <= INLINE_THRESHOLD {
                return;
            }
            let Some(uri) = parse_bounded_image_uri(uri_raw, media::URI_LIMIT) else {
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
}

/// Projects a single message JSON item by streaming through up to `MAX_SCANNED_ITEMS` parts
/// and tool content items with zero intermediate array/map allocations, recording only the
/// byte ranges of replaced `"uri"` JSON string tokens and splicing them in one single pass.
/// Returns the projected bytes and the `UndoPatch` list needed to restore the original bytes if
/// a subsequent chunk renders the full document invalid JSON.
pub(crate) fn project_item(workspace_enc: &str, session_enc: &str, mut raw: Vec<u8>) -> (Vec<u8>, Vec<UndoPatch>) {
    if raw.len() > media::MESSAGE_LIMIT || !may_contain_image_uri(&raw) {
        return (raw, Vec::new());
    }
    let patches =
        std::str::from_utf8(&raw).ok().and_then(|text| collect_item_patches(workspace_enc, session_enc, text));
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

pub(crate) struct ExtractedToolMedia {
    pub(crate) id: Option<String>,
    pub(crate) msg_type: Option<String>,
    pub(crate) part_type: Option<String>,
    pub(crate) file_type: Option<String>,
    pub(crate) mime: Option<String>,
    pub(crate) uri: Option<String>,
}

/// Validates full RFC 8259 JSON syntax and extracts only the target tool image fields at
/// `(part_index, item_index)` with O(1) extra memory (no `serde_json::Value` tree allocation),
/// preventing dense numeric arrays in ignored fields from multiplying a 16 MiB body into 180+ MiB.
/// Returns `Err(())` when the JSON is malformed or `data` is missing/`null` (`502 Media unavailable`),
/// `Ok(None)` when `data` is not an object (`404 Media not found`), and `Ok(Some(_))` otherwise.
pub(crate) fn extract_tool_media(
    raw: &[u8],
    part_index: usize,
    item_index: usize,
) -> Result<Option<ExtractedToolMedia>, ()> {
    let raw = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let mut syntax = JsonSyntax::new();
    syntax.feed(raw);
    if !syntax.is_valid_eof() {
        return Err(());
    }
    let mut data_raw: Option<&str> = None;
    for_each_json_object_field(text, |k, v| {
        if k == "data" {
            data_raw = Some(v);
        }
    })
    .ok_or(())?;
    let data_raw = data_raw.map(str::trim).ok_or(())?;
    if data_raw == "null" {
        return Err(());
    }
    if !data_raw.starts_with('{') {
        return Ok(None);
    }
    let (mut id_raw, mut type_raw, mut content_raw) = (None, None, None);
    for_each_json_object_field(data_raw, |k, v| match k {
        "id" => id_raw = Some(v),
        "type" => type_raw = Some(v),
        "content" => content_raw = Some(v),
        _ => {}
    })
    .ok_or(())?;
    let id = id_raw.and_then(|v| parse_short_string(v, 2048));
    let msg_type = type_raw.and_then(|v| parse_short_string(v, 128));
    let mut part_raw = None;
    if let Some(content) = content_raw {
        let _ = for_each_json_array_item(content, part_index.saturating_add(1), |idx, elem| {
            if idx == part_index {
                part_raw = Some(elem);
            }
        });
    }
    let mut part_type = None;
    let mut state_raw = None;
    if let Some(part) = part_raw {
        let _ = for_each_json_object_field(part, |k, v| match k {
            "type" => part_type = Some(v),
            "state" => state_raw = Some(v),
            _ => {}
        });
    }
    let mut items_raw = None;
    if let Some(state) = state_raw {
        let _ = for_each_json_object_field(state, |k, v| {
            if k == "content" {
                items_raw = Some(v);
            }
        });
    }
    let mut item_raw = None;
    if let Some(items) = items_raw {
        let _ = for_each_json_array_item(items, item_index.saturating_add(1), |idx, elem| {
            if idx == item_index {
                item_raw = Some(elem);
            }
        });
    }
    let (mut file_type, mut mime, mut uri) = (None, None, None);
    if let Some(item) = item_raw {
        let _ = for_each_json_object_field(item, |k, v| match k {
            "type" => file_type = Some(v),
            "mime" => mime = Some(v),
            "uri" => uri = Some(v),
            _ => {}
        });
    }
    Ok(Some(ExtractedToolMedia {
        id,
        msg_type,
        part_type: part_type.and_then(|v| parse_short_string(v, 128)),
        file_type: file_type.and_then(|v| parse_short_string(v, 128)),
        mime: mime.and_then(|v| parse_short_string(v, 1024)),
        uri: uri.and_then(|v| parse_bounded_image_uri(v, media::URI_LIMIT)),
    }))
}
