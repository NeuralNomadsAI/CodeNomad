//! Strict RFC 8259 JSON parser preserving exact UTF-16 code units (`Vec<u16>`) for strings.
//! Used only as a fallback when `serde_json` fails on an `application/json` body so valid JS JSON
//! containing unpaired UTF-16 surrogate escapes (`\uD800`..`\uDFFF`) reaches schema/business
//! validation without ever substituting `\uD800` for `\u{FFFD}`.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone)]
pub(super) enum JsVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<JsVal>),
    Obj(Vec<(Vec<u16>, JsVal)>),
}

impl JsVal {
    pub(super) fn as_object(&self) -> Option<&[(Vec<u16>, JsVal)]> {
        match self {
            Self::Obj(m) => Some(m),
            _ => None,
        }
    }

    pub(super) fn get_ascii(&self, key: &str) -> Option<&JsVal> {
        let target: Vec<u16> = key.encode_utf16().collect();
        self.as_object()?.iter().rev().find(|(k, _)| *k == target).map(|(_, v)| v)
    }

    pub(super) fn as_u16_str(&self) -> Option<&[u16]> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    pub(super) fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub(super) fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// Converts the final JS object (after last-key-wins deduplication) into a lossless UTF-8
    /// `serde_json::Value` when no retained key or value contains an unpaired UTF-16 surrogate.
    pub(super) fn to_utf8_json(&self) -> Option<Value> {
        match self {
            Self::Null => Some(Value::Null),
            Self::Bool(b) => Some(Value::Bool(*b)),
            Self::Num(n) => {
                if n.is_finite() && n.fract() == 0.0 && (*n >= i64::MIN as f64) && (*n <= i64::MAX as f64) {
                    Some(Value::Number(Number::from(*n as i64)))
                } else {
                    Number::from_f64(*n).map(Value::Number)
                }
            }
            Self::Str(units) => String::from_utf16(units).ok().map(Value::String),
            Self::Arr(items) => items.iter().map(Self::to_utf8_json).collect::<Option<Vec<_>>>().map(Value::Array),
            Self::Obj(entries) => {
                // Keep only the final value for each key in O(N) (matching JS `JSON.parse`), so a
                // shadowed lone surrogate (`{"pluginId":"\uD800","pluginId":"id"}`) resolves to `"id"`.
                let mut index_by_key: HashMap<&[u16], usize> = HashMap::with_capacity(entries.len());
                let mut dedup: Vec<(&[u16], &JsVal)> = Vec::with_capacity(entries.len());
                for (k, v) in entries {
                    if let Some(&idx) = index_by_key.get(k.as_slice()) {
                        dedup[idx].1 = v;
                    } else {
                        let idx = dedup.len();
                        index_by_key.insert(k.as_slice(), idx);
                        dedup.push((k.as_slice(), v));
                    }
                }
                let mut map = Map::with_capacity(dedup.len());
                for (k, v) in dedup {
                    let key = String::from_utf16(k).ok()?;
                    let val = v.to_utf8_json()?;
                    map.insert(key, val);
                }
                Some(Value::Object(map))
            }
        }
    }
}

/// Parses strict RFC 8259 JSON (matching Fastify `secure-json-parse`: UTF-8 input, optional BOM,
/// no comments, no trailing commas, `__proto__` and `constructor.prototype` refused), retaining
/// exact UTF-16 code units in strings (including lone surrogates) in a single O(N) pass.
pub(super) fn parse_strict_json(raw: &[u8]) -> Option<JsVal> {
    let bytes = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
    let text = std::str::from_utf8(bytes).ok()?;
    let mut p = Parser { text, bytes: text.as_bytes(), pos: 0, depth: 0 };
    p.skip_ws();
    let val = p.value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() || poisoned(&val) {
        return None;
    }
    Some(val)
}

fn poisoned(v: &JsVal) -> bool {
    match v {
        JsVal::Obj(entries) => entries.iter().any(|(k, x)| {
            eq_ascii(k, "__proto__")
                || (eq_ascii(k, "constructor") && x.get_ascii("prototype").is_some())
                || poisoned(x)
        }),
        JsVal::Arr(items) => items.iter().any(poisoned),
        _ => false,
    }
}

pub(super) fn js_trim_u16(units: &[u16]) -> &[u16] {
    let is_js_ws = |u: u16| {
        matches!(
            u,
            0x0009..=0x000D
                | 0x0020
                | 0x00A0
                | 0x1680
                | 0x2000..=0x200A
                | 0x2028
                | 0x2029
                | 0x202F
                | 0x205F
                | 0x3000
                | 0xFEFF
        )
    };
    let start = units.iter().position(|&u| !is_js_ws(u)).unwrap_or(units.len());
    let end = units.iter().rposition(|&u| !is_js_ws(u)).map_or(start, |i| i + 1);
    &units[start..end]
}

pub(super) fn eq_ascii(units: &[u16], ascii: &str) -> bool {
    units.len() == ascii.len() && units.iter().zip(ascii.bytes()).all(|(&u, b)| u == u16::from(b))
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn value(&mut self) -> Option<JsVal> {
        self.skip_ws();
        match self.peek()? {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => self.string().map(JsVal::Str),
            b't' => self.literal(b"true").map(|()| JsVal::Bool(true)),
            b'f' => self.literal(b"false").map(|()| JsVal::Bool(false)),
            b'n' => self.literal(b"null").map(|()| JsVal::Null),
            b'-' | b'0'..=b'9' => self.number().map(JsVal::Num),
            _ => None,
        }
    }

    fn literal(&mut self, expected: &[u8]) -> Option<()> {
        if self.bytes.get(self.pos..self.pos + expected.len()) == Some(expected) {
            self.pos += expected.len();
            Some(())
        } else {
            None
        }
    }

    fn object(&mut self) -> Option<JsVal> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        self.pos += 1; // '{'
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.depth -= 1;
            return Some(JsVal::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return None;
            }
            self.pos += 1;
            let val = self.value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b'}' => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Some(JsVal::Obj(entries));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<JsVal> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        self.pos += 1; // '['
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.depth -= 1;
            return Some(JsVal::Arr(items));
        }
        loop {
            let item = self.value()?;
            items.push(item);
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b']' => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Some(JsVal::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.pos += 1;
        let mut out = Vec::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'"' {
                self.pos += 1;
                return Some(out);
            }
            if b < 0x20 {
                return None;
            }
            if b == b'\\' {
                self.pos += 1;
                let esc = *self.bytes.get(self.pos)?;
                self.pos += 1;
                match esc {
                    b'"' => out.push(u16::from(b'"')),
                    b'\\' => out.push(u16::from(b'\\')),
                    b'/' => out.push(u16::from(b'/')),
                    b'b' => out.push(0x0008),
                    b'f' => out.push(0x000C),
                    b'n' => out.push(0x000A),
                    b'r' => out.push(0x000D),
                    b't' => out.push(0x0009),
                    b'u' => {
                        let hex = self.bytes.get(self.pos..self.pos + 4)?;
                        let mut u = 0u16;
                        for &h in hex {
                            let d = match h {
                                b'0'..=b'9' => (h - b'0') as u16,
                                b'a'..=b'f' => (h - b'a' + 10) as u16,
                                b'A'..=b'F' => (h - b'A' + 10) as u16,
                                _ => return None,
                            };
                            u = (u << 4) | d;
                        }
                        self.pos += 4;
                        out.push(u);
                    }
                    _ => return None,
                }
                continue;
            }
            if b < 0x80 {
                out.push(u16::from(b));
                self.pos += 1;
                continue;
            }
            // `self.text` was validated as UTF-8 once up front; slicing at `self.pos` is O(1).
            let ch = self.text[self.pos..].chars().next()?;
            let mut buf = [0u16; 2];
            out.extend_from_slice(ch.encode_utf16(&mut buf));
            self.pos += ch.len_utf8();
        }
        None
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek()? {
            b'0' => self.pos += 1,
            b'1'..=b'9' => {
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return None;
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !self.peek().is_some_and(|b| b.is_ascii_digit()) {
                return None;
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let s = &self.text[start..self.pos];
        let n: f64 = s.parse().ok()?;
        n.is_finite().then_some(n)
    }
}
