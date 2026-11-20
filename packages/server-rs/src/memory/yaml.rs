//! Entry frontmatter as `yaml` 2.9.1 writes and reads it (`stringify(header)`,
//! `parseDocument(…, { uniqueKeys: true })`), for the values an entry header can hold:
//! single-line strings at the root mapping's value position.
//!
//! Encoding is exact (`stringifyString`, `plainString`, `quotedString`,
//! `foldFlowLines`, with lengths in UTF-16 units as in JS). Decoding accepts block
//! mappings of `key: scalar` lines (plain, single- or double-quoted, folded over
//! indented continuation lines), full-line and trailing comments and blank lines.
//! Other YAML spellings (flow collections, block scalars, tags, anchors, explicit
//! keys) are refused as `malformed`: the reference may read them, this port does not.

use super::model::{Code, Entry, MemoryError, Result, fail};

const LINE_WIDTH: usize = 80;
const MIN_CONTENT: usize = 20;

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn from16(v: &[u16]) -> String {
    String::from_utf16_lossy(v)
}

/// Core-schema tags that would resolve a plain scalar to a non-string.
pub fn resolves_non_string(s: &str) -> bool {
    use std::sync::LazyLock;
    static TAGS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        [
            r"^(?:~|[Nn]ull|NULL)?$",
            r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$",
            r"^0o[0-7]+$",
            r"^[-+]?[0-9]+$",
            r"^0x[0-9a-fA-F]+$",
            r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).unwrap())
        .collect()
    });
    TAGS.iter().any(|t| t.is_match(s))
}

/// `foldFlowLines(text, indent, mode, { indentAtStart, lineWidth: 80, minContentWidth: 20 })`.
fn fold(text: &[u16], indent: &str, quoted: bool, indent_at_start: usize) -> Vec<u16> {
    let ind = indent.len();
    let end_step = (1 + MIN_CONTENT).max(1 + LINE_WIDTH - ind);
    if text.len() <= end_step {
        return text.to_vec();
    }
    let mut folds: Vec<usize> = Vec::new();
    let mut escaped: std::collections::HashSet<i64> = Default::default();
    let mut end: i64 = (LINE_WIDTH - ind) as i64;
    if indent_at_start > LINE_WIDTH - 2usize.max(MIN_CONTENT) {
        folds.push(0);
    } else {
        end = (LINE_WIDTH - indent_at_start) as i64;
    }
    let (sp, nl, tab, bs) = (b' ' as u16, b'\n' as u16, b'\t' as u16, b'\\' as u16);
    let at = |i: i64| -> Option<u16> { if i >= 0 { text.get(i as usize).copied() } else { None } };
    let mut split: Option<i64> = None;
    let mut prev: Option<u16> = None;
    let (mut esc_start, mut esc_end): (i64, i64) = (-1, -1);
    let mut i: i64 = -1;
    loop {
        i += 1;
        // `for (let ch; (ch = text[(i += 1)]);)`: `ch` may become undefined below.
        let mut ch: Option<u16> = at(i);
        if ch.is_none() {
            break;
        }
        if quoted && ch == Some(bs) {
            esc_start = i;
            i += match at(i + 1) {
                Some(c) if c == b'x' as u16 => 3,
                Some(c) if c == b'u' as u16 => 5,
                Some(c) if c == b'U' as u16 => 9,
                _ => 1,
            };
            esc_end = i;
        }
        if ch == Some(nl) {
            end = i + ind as i64 + end_step as i64;
            split = None;
        } else {
            if ch == Some(sp) && prev.is_some_and(|p| p != sp && p != nl && p != tab) {
                let next = at(i + 1);
                if next.is_some_and(|n| n != sp && n != nl && n != tab) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(s) = split.filter(|s| *s != 0) {
                    folds.push(s as usize);
                    end = s + end_step as i64;
                    split = None;
                } else if quoted {
                    while prev == Some(sp) || prev == Some(tab) {
                        prev = ch;
                        i += 1;
                        ch = at(i);
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped.contains(&j) || j < 1 {
                        return text.to_vec();
                    }
                    folds.push(j as usize);
                    escaped.insert(j);
                    end = j + end_step as i64;
                    split = None;
                }
            }
        }
        prev = ch;
    }
    if folds.is_empty() {
        return text.to_vec();
    }
    let indent16 = utf16(indent);
    let mut res: Vec<u16> = text[..folds[0].min(text.len())].to_vec();
    for (k, &f) in folds.iter().enumerate() {
        let stop = folds.get(k + 1).copied().filter(|n| *n != 0).unwrap_or(text.len());
        if f == 0 {
            res = vec![nl];
            res.extend(&indent16);
            res.extend(&text[..stop]);
        } else {
            if quoted && escaped.contains(&(f as i64)) {
                res.push(text[f]);
                res.push(bs);
            }
            res.push(nl);
            res.extend(&indent16);
            res.extend(&text[f + 1..stop]);
        }
    }
    res
}

/// `JSON.stringify(value)` as UTF-16.
fn json16(value: &str) -> Vec<u16> {
    utf16(&serde_json::to_string(value).expect("string"))
}

fn double_quoted(value: &str, indent_at_start: usize) -> Vec<u16> {
    // No newline can occur in a header value: only the `\u` rewrites apply.
    let json = json16(value);
    let mut out: Vec<u16> = Vec::with_capacity(json.len());
    let mut i = 0;
    while i < json.len() {
        if json[i] == b'\\' as u16 && json.get(i + 1) == Some(&(b'u' as u16)) {
            let code = from16(&json[i + 2..i + 6]);
            let short = match code.as_str() {
                "0000" => Some("\\0".to_owned()),
                "0007" => Some("\\a".to_owned()),
                "000b" => Some("\\v".to_owned()),
                "001b" => Some("\\e".to_owned()),
                "0085" => Some("\\N".to_owned()),
                "00a0" => Some("\\_".to_owned()),
                "2028" => Some("\\L".to_owned()),
                "2029" => Some("\\P".to_owned()),
                c if c.starts_with("00") => Some(format!("\\x{}", &c[2..])),
                _ => None,
            };
            match short {
                Some(s) => out.extend(utf16(&s)),
                None => out.extend(&json[i..i + 6]),
            }
            i += 6;
        } else if json[i] == b'\\' as u16 {
            out.extend(&json[i..i + 2]);
            i += 2;
        } else {
            out.push(json[i]);
            i += 1;
        }
    }
    fold(&out, "  ", true, indent_at_start)
}

fn single_quoted(value: &str, indent_at_start: usize) -> Vec<u16> {
    let quoted = format!("'{}'", value.replace('\'', "''"));
    fold(&utf16(&quoted), "  ", false, indent_at_start)
}

fn quoted_string(value: &str, indent_at_start: usize) -> Vec<u16> {
    let (double, single) = (value.contains('"'), value.contains('\''));
    if double && !single { single_quoted(value, indent_at_start) } else { double_quoted(value, indent_at_start) }
}

/// `stringifyString` for a single-line value of a root mapping pair.
fn scalar(value: &str, indent_at_start: usize) -> Vec<u16> {
    use std::sync::LazyLock;
    static FORCE_DOUBLE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\x{9f}]").unwrap());
    static NOT_PLAIN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#)
            .unwrap()
    });
    if FORCE_DOUBLE.is_match(value) {
        return double_quoted(value, indent_at_start);
    }
    if NOT_PLAIN.is_match(value) || resolves_non_string(value) {
        return quoted_string(value, indent_at_start);
    }
    fold(&utf16(value), "  ", false, indent_at_start)
}

/// `stringify(header)` with zod's output key order.
pub fn encode_header(e: &Entry) -> String {
    let mut out = String::new();
    for (key, value) in [
        ("title", &e.title),
        ("type", &e.kind),
        ("id", &e.id),
        ("createdAt", &e.created_at),
        ("updatedAt", &e.updated_at),
        ("sessionId", &e.session_id),
    ] {
        out.push_str(key);
        out.push(':');
        let rendered = from16(&scalar(value, key.len() + 2));
        if !rendered.is_empty() && !rendered.starts_with('\n') {
            out.push(' ');
        }
        out.push_str(&rendered);
        out.push('\n');
    }
    out
}

fn malformed() -> MemoryError {
    fail(Code::Malformed, "Invalid memory entry")
}

/// One logical value: the first line's text after `key:` plus its continuation lines.
fn decode_value(first: &str, rest: &[&str]) -> Result<String> {
    let first = first.trim_start_matches([' ', '\t']);
    let mut lines: Vec<&str> = vec![first];
    lines.extend(rest.iter().map(|l| l.trim_start_matches([' ', '\t'])));
    let joined_head = first.chars().next();
    match joined_head {
        Some('"') => double_value(&lines),
        Some('\'') => single_value(&lines),
        _ => plain_value(&lines),
    }
}

fn trailing_ok(tail: &str) -> bool {
    let t = tail.trim_end_matches([' ', '\t']);
    t.is_empty() || (tail.starts_with([' ', '\t']) && t.trim_start_matches([' ', '\t']).starts_with('#'))
}

fn plain_value(lines: &[&str]) -> Result<String> {
    let mut parts: Vec<String> = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        // ` #` starts a comment; it ends the scalar and no continuation may follow.
        let mut text = raw.to_string();
        let mut commented = false;
        if let Some(pos) = find_comment(&text) {
            text.truncate(pos);
            commented = true;
        }
        let text = text.trim_end_matches([' ', '\t']).to_owned();
        if index == 0 && text.is_empty() && !commented && lines.len() == 1 {
            return Err(malformed());
        }
        let first = text.chars().next();
        if index == 0 && first.is_some_and(|c| ",[]{}#&*!|>'\"%@`".contains(c)) {
            return Err(malformed());
        }
        if (index == 0 && (text == "-" || text == "?" || text.starts_with("- ") || text.starts_with("? ")))
            || (text.contains(": ") || text.ends_with(':') || text.contains(":\t"))
            || index > 0 && text.starts_with('#')
        {
            return Err(malformed());
        }
        if !text.is_empty() {
            parts.push(text);
        } else if index > 0 {
            return Err(malformed());
        }
        if commented && index + 1 < lines.len() {
            return Err(malformed());
        }
    }
    let value = parts.join(" ");
    if value.is_empty() || resolves_non_string(&value) { Err(malformed()) } else { Ok(value) }
}

fn find_comment(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    (1..bytes.len()).find(|&i| bytes[i] == b'#' && matches!(bytes[i - 1], b' ' | b'\t'))
}

fn single_value(lines: &[&str]) -> Result<String> {
    let joined = lines.join("\n");
    let body = &joined[1..];
    let mut out = String::new();
    let mut chars = body.char_indices().peekable();
    let mut end = None;
    while let Some((i, c)) = chars.next() {
        if c == '\'' {
            if chars.peek().map(|(_, n)| *n) == Some('\'') {
                out.push('\'');
                chars.next();
                continue;
            }
            end = Some(i + 1);
            break;
        }
        if c == '\n' {
            while out.ends_with([' ', '\t']) {
                out.pop();
            }
            out.push(' ');
            continue;
        }
        out.push(c);
    }
    end.filter(|end| trailing_ok(&body[*end..]) && !body[*end..].contains('\n')).ok_or_else(malformed)?;
    Ok(out)
}

fn double_value(lines: &[&str]) -> Result<String> {
    let joined = lines.join("\n");
    let body: Vec<char> = joined[1..].chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut closed = None;
    while i < body.len() {
        let c = body[i];
        match c {
            '"' => {
                closed = Some(i + 1);
                break;
            }
            '\n' => {
                while out.ends_with([' ', '\t']) {
                    out.pop();
                }
                out.push(' ');
                i += 1;
            }
            '\\' => {
                let next = *body.get(i + 1).ok_or_else(malformed)?;
                let hex = |n: usize| -> Result<char> {
                    let digits: String = body.get(i + 2..i + 2 + n).ok_or_else(malformed)?.iter().collect();
                    let value = u32::from_str_radix(&digits, 16).map_err(|_| malformed())?;
                    if !digits.chars().all(|d| d.is_ascii_hexdigit()) {
                        return Err(malformed());
                    }
                    char::from_u32(value).ok_or_else(malformed)
                };
                let (decoded, width) = match next {
                    '0' => ('\0', 2),
                    'a' => ('\u{7}', 2),
                    'b' => ('\u{8}', 2),
                    't' | '\t' => ('\t', 2),
                    'n' => ('\n', 2),
                    'v' => ('\u{b}', 2),
                    'f' => ('\u{c}', 2),
                    'r' => ('\r', 2),
                    'e' => ('\u{1b}', 2),
                    ' ' => (' ', 2),
                    '"' => ('"', 2),
                    '/' => ('/', 2),
                    '\\' => ('\\', 2),
                    'N' => ('\u{85}', 2),
                    '_' => ('\u{a0}', 2),
                    'L' => ('\u{2028}', 2),
                    'P' => ('\u{2029}', 2),
                    'x' => (hex(2)?, 4),
                    'u' => (hex(4)?, 6),
                    'U' => (hex(8)?, 10),
                    '\n' => {
                        // An escaped line break joins without a space.
                        i += 2;
                        continue;
                    }
                    _ => return Err(malformed()),
                };
                out.push(decoded);
                i += width;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    let end = closed.ok_or_else(malformed)?;
    let tail: String = body[end..].iter().collect();
    if !trailing_ok(&tail) || tail.contains('\n') { Err(malformed()) } else { Ok(out) }
}

/// `parseDocument` + `toJS` + the exact key set check for the header block.
pub fn decode_header(text: &str) -> Result<Vec<(String, String)>> {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.iter().any(|l| l.contains('\r')) {
        return Err(malformed());
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            index += 1;
            continue;
        }
        if line.starts_with([' ', '\t']) {
            return Err(malformed());
        }
        let colon = line.find(':').ok_or_else(malformed)?;
        let key = &line[..colon];
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(malformed());
        }
        let after = &line[colon + 1..];
        if !after.is_empty() && !after.starts_with([' ', '\t']) {
            return Err(malformed());
        }
        let mut stop = index + 1;
        while stop < lines.len() && lines[stop].starts_with([' ', '\t']) && !lines[stop].trim().is_empty() {
            stop += 1;
        }
        let first = after;
        let rest = &lines[index + 1..stop];
        // A value on the following indented lines only.
        let (first, rest) = if first.trim_matches([' ', '\t']).is_empty() && !rest.is_empty() {
            (rest[0], &rest[1..])
        } else {
            (first, rest)
        };
        let value = decode_value(first, rest)?;
        if pairs.iter().any(|(k, _)| k == key) {
            return Err(malformed());
        }
        pairs.push((key.to_owned(), value));
        index = stop;
    }
    Ok(pairs)
}

/// `decodeMemoryEntry`: `---` header, `---`, then the literal body.
pub fn decode_entry(file: &str) -> Result<Entry> {
    let invalid = malformed;
    let rest = file.strip_prefix("---").ok_or_else(invalid)?;
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')).ok_or_else(invalid)?;
    // Lazy `([\s\S]*?)\r?\n---\r?\n`: the first delimiter line after the opening one.
    let mut search = 0;
    let (header, body) = loop {
        let found = rest[search..].find("\n---").ok_or_else(invalid)? + search;
        let after = &rest[found + 4..];
        let body = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n'));
        if let Some(body) = body {
            let header = rest[..found].strip_suffix('\r').unwrap_or(&rest[..found]);
            break (header, body);
        }
        search = found + 1;
    };
    let pairs = decode_header(header)?;
    let mut keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    if keys != ["createdAt", "id", "sessionId", "title", "type", "updatedAt"] {
        return Err(invalid());
    }
    let get = |k: &str| pairs.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let entry = Entry {
        id: get("id"),
        title: get("title"),
        kind: get("type"),
        text: body.to_owned(),
        created_at: get("createdAt"),
        updated_at: get("updatedAt"),
        session_id: get("sessionId"),
    };
    super::model::validate(&entry, Code::Malformed).map_err(|_| invalid())?;
    Ok(entry)
}

/// `encodeMemoryEntry`.
pub fn encode_entry(e: &Entry) -> Result<String> {
    super::model::validate(e, Code::Invalid)?;
    Ok(format!("---\n{}---\n{}", encode_header(e), e.text))
}
