/// Maximum UTF-16 code units per reader page, matching Solid `READER_PAGE_SIZE`.
pub const READER_PAGE_SIZE: usize = 9_000;
const MAX_SYNTHETIC_FENCE_LENGTH: usize = 32;
const MAX_LANGUAGE_LENGTH: usize = 48;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkdownPage {
    /// Exact contiguous source excerpt. Copy and literal views must use this, never `markdown_text`.
    pub source_text: String,
    /// Display-only Markdown; `None` means render `source_text` literally in a code surface.
    pub markdown_text: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Fence {
    marker: u8,
    length: usize,
    language: String,
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn page_count(characters: u64, page_size: usize) -> usize {
    let page_size = page_size.max(1) as u64;
    characters.div_ceil(page_size).max(1) as usize
}

/// Converts a UTF-16 code-unit offset to a UTF-8 byte boundary without splitting a surrogate pair.
fn source_boundary(text: &str, utf16_offset: usize) -> usize {
    let mut units = 0usize;
    for (byte_idx, ch) in text.char_indices() {
        if units >= utf16_offset {
            return byte_idx;
        }
        let next_units = units + ch.len_utf16();
        if next_units > utf16_offset {
            // Landed on the low surrogate of a 2-unit UTF-16 char: step back to the char start.
            return byte_idx;
        }
        units = next_units;
    }
    text.len()
}

/// Whether `text` (a loaded prefix of a body with `characters` total UTF-16 units) covers `page`
/// exactly as the whole text would, matching `missionBodyCovers`.
pub fn body_covers(text: &str, characters: u64, page: usize, page_size: usize) -> bool {
    let loaded = utf16_len(text) as u64;
    if loaded >= characters {
        return true;
    }
    let Some(end_units) = page.checked_add(1).and_then(|p| p.checked_mul(page_size)) else {
        return false;
    };
    if (end_units as u64) >= loaded {
        return false;
    }
    let byte_start = source_boundary(text, end_units);
    text[byte_start..].contains('\n')
}

/// Prefix length in UTF-16 code units to load for `page`, matching `missionBodyNeed`.
pub fn body_need(
    loaded_utf16: Option<u64>,
    characters: u64,
    covers: bool,
    page: usize,
    page_size: usize,
) -> u64 {
    let end = (page as u64)
        .saturating_add(1)
        .saturating_mul(page_size as u64);
    match loaded_utf16 {
        None => end.saturating_add(1),
        Some(loaded) if covers => loaded.min(characters),
        Some(loaded) => end.saturating_add(1).max(loaded.saturating_add(1)),
    }
}

fn fence_run(bytes: &[u8], start: usize, end: usize) -> Option<(u8, usize, usize)> {
    let mut cursor = start;
    while cursor < end && bytes[cursor] == b' ' && cursor - start < 4 {
        cursor += 1;
    }
    if cursor - start > 3 || cursor >= end {
        return None;
    }
    let marker = bytes[cursor];
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let marker_start = cursor;
    while cursor < end && bytes[cursor] == marker {
        cursor += 1;
    }
    let length = cursor - marker_start;
    (length >= 3).then_some((marker, length, cursor))
}

fn closes_fence(bytes: &[u8], start: usize, end: usize, fence: &Fence) -> bool {
    let Some((marker, length, info_start)) = fence_run(bytes, start, end) else {
        return false;
    };
    if marker != fence.marker || length < fence.length {
        return false;
    }
    bytes[info_start..end]
        .iter()
        .all(|&b| matches!(b, b' ' | b'\t' | b'\r'))
}

fn opens_fence(text: &str, start: usize, end: usize) -> Option<Fence> {
    let bytes = text.as_bytes();
    let (marker, length, info_start) = fence_run(bytes, start, end)?;
    if marker == b'`' && bytes[info_start..end].contains(&b'`') {
        return None;
    }
    let mut language_start = info_start;
    while language_start < end && matches!(bytes[language_start], b' ' | b'\t') {
        language_start += 1;
    }
    let mut language_end = language_start;
    while language_end < end && !matches!(bytes[language_end], b' ' | b'\t' | b'\r') {
        language_end += 1;
    }
    let token = if language_end - language_start <= MAX_LANGUAGE_LENGTH {
        &text[language_start..language_end]
    } else {
        ""
    };
    let language = if !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'.' | b'-'))
    {
        token.to_owned()
    } else {
        String::new()
    };
    Some(Fence {
        marker,
        length,
        language,
    })
}

/// Zero-based bounded excerpt matching TS `missionMarkdownPage`.
pub fn markdown_page(text: &str, page: usize, page_size: usize) -> Option<MarkdownPage> {
    if page_size == 0 || page_size > READER_PAGE_SIZE {
        return None;
    }
    let start_units = page.checked_mul(page_size)?;
    let end_units = page.checked_add(1)?.checked_mul(page_size)?;
    let start = source_boundary(text, start_units);
    let end = source_boundary(text, end_units);
    let source_text = text[start..end].to_owned();
    if source_text.is_empty() {
        return Some(MarkdownPage {
            source_text: String::new(),
            markdown_text: Some(String::new()),
        });
    }

    let bytes = text.as_bytes();
    let mut active: Option<Fence> = None;
    let mut initial: Option<Fence> = None;
    let mut final_fence: Option<Fence> = None;
    let mut interrupted = false;
    let mut line_start = 0usize;

    while line_start < end {
        let newline = text[line_start..].find('\n').map(|rel| line_start + rel);
        let next_line = newline.map_or(text.len(), |pos| pos + 1);
        let line_end = newline.unwrap_or(text.len());
        let before = active.clone();
        let closing = before
            .as_ref()
            .is_some_and(|fence| closes_fence(bytes, line_start, line_end, fence));
        let opening = if before.is_none() {
            opens_fence(text, line_start, line_end)
        } else {
            None
        };
        let after = if closing {
            None
        } else {
            opening.clone().or_else(|| before.clone())
        };

        if start >= line_start && start < next_line {
            initial = if start == line_start || start < line_end {
                before.clone()
            } else {
                after.clone()
            };
            if start > line_start && start < line_end && (opening.is_some() || closing) {
                interrupted = true;
            }
            if let Some(ref fence) = before
                && start > line_start
                && closes_fence(bytes, start, end.min(line_end), fence)
            {
                interrupted = true;
            }
        }
        if end > line_start && end <= next_line {
            final_fence = if end < line_end {
                before.clone()
            } else {
                after.clone()
            };
            if end < line_end && (opening.is_some() || closing) {
                interrupted = true;
            }
            if let Some(ref fence) = before
                && end < line_end
                && let Some((marker, length, _)) = fence_run(bytes, line_start, line_end)
                && marker == fence.marker
                && length >= fence.length
            {
                interrupted = true;
            }
        }
        active = after;
        line_start = next_line;
    }

    if interrupted
        || initial
            .as_ref()
            .is_some_and(|f| f.length > MAX_SYNTHETIC_FENCE_LENGTH)
        || final_fence
            .as_ref()
            .is_some_and(|f| f.length > MAX_SYNTHETIC_FENCE_LENGTH)
    {
        return Some(MarkdownPage {
            source_text,
            markdown_text: None,
        });
    }

    let mut markdown = String::with_capacity(source_text.len() + 128);
    if let Some(fence) = initial {
        for _ in 0..fence.length {
            markdown.push(fence.marker as char);
        }
        markdown.push_str(&fence.language);
        markdown.push('\n');
    }
    markdown.push_str(&source_text);
    if let Some(fence) = final_fence {
        if !source_text.ends_with('\n') {
            markdown.push('\n');
        }
        for _ in 0..fence.length {
            markdown.push(fence.marker as char);
        }
        markdown.push('\n');
    }
    Some(MarkdownPage {
        source_text,
        markdown_text: Some(markdown),
    })
}
