//! Insertion-ordered JSON with `JSON.stringify` output, UTF-16 measures, the
//! reference `contentDigest` and `missionPanelPage` (reference
//! `missions/content-digest.ts`, `missions/mission-panel-page.ts`). The crate's
//! `serde_json::Value` sorts keys; observation pages keep the reference's key
//! order so their text, digests and cursors match the TypeScript server.
use base64::Engine;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    U(u64),
    I(i64),
    F(f64),
    S(String),
    A(Vec<J>),
    O(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::O(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            J::S(s) => Some(s),
            _ => None,
        }
    }
    pub fn bool(&self) -> Option<bool> {
        match self {
            J::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn arr(&self) -> Option<&[J]> {
        match self {
            J::A(items) => Some(items),
            _ => None,
        }
    }
    pub fn obj(&self) -> Option<&[(String, J)]> {
        match self {
            J::O(entries) => Some(entries),
            _ => None,
        }
    }
    /// zod `z.number().int().nonnegative().safe()`.
    pub fn count(&self) -> Option<u64> {
        const SAFE: u64 = (1 << 53) - 1;
        match *self {
            J::U(n) if n <= SAFE => Some(n),
            J::I(n) if (0..=SAFE as i64).contains(&n) => Some(n as u64),
            J::F(f) if f.fract() == 0.0 && (0.0..=SAFE as f64).contains(&f) => Some(f as u64),
            _ => None,
        }
    }
    pub fn is_number(&self) -> bool {
        matches!(self, J::U(_) | J::I(_) | J::F(_))
    }
    pub fn s(text: impl Into<String>) -> J {
        J::S(text.into())
    }
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        write(self, &mut out);
        out
    }
}

/// An ordered object under construction.
pub fn obj(entries: Vec<(&str, J)>) -> J {
    J::O(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<J, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<J, E> {
                Ok(J::Bool(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<J, E> {
                Ok(J::U(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<J, E> {
                Ok(if v >= 0 { J::U(v as u64) } else { J::I(v) })
            }
            fn visit_f64<E>(self, v: f64) -> Result<J, E> {
                Ok(J::F(v))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<J, E> {
                Ok(J::S(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> Result<J, E> {
                Ok(J::S(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(J::A(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
                let mut entries: Vec<(String, J)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, J>()? {
                    // `JSON.parse`: a repeated key keeps its first position, last value.
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(entry) => entry.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                Ok(J::O(entries))
            }
        }
        deserializer.deserialize_any(V)
    }
}

pub fn parse(bytes: &[u8]) -> Option<J> {
    serde_json::from_slice(bytes).ok()
}

fn number(f: f64, out: &mut String) {
    if !f.is_finite() {
        out.push_str("null");
        return;
    }
    if f == 0.0 {
        out.push('0');
        return;
    }
    if f < 0.0 {
        out.push('-');
    }
    // Format from the shortest round-tripping decimal (`{:e}`), following ECMA-262 Number::toString.
    let sci = format!("{:e}", f.abs());
    let Some((mantissa, exp_str)) = sci.split_once('e') else {
        out.push_str(&sci);
        return;
    };
    let Ok(exp) = exp_str.parse::<i32>() else {
        out.push_str(&sci);
        return;
    };
    let digits: String = mantissa.chars().filter(|&c| c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let split = n as usize;
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        if exp >= 0 {
            out.push('+');
            out.push_str(&exp.to_string());
        } else {
            out.push_str(&exp.to_string());
        }
    }
}

pub fn escape(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write(value: &J, out: &mut String) {
    match value {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::U(n) => out.push_str(&n.to_string()),
        J::I(n) => out.push_str(&n.to_string()),
        J::F(f) => number(*f, out),
        J::S(s) => escape(s, out),
        J::A(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        J::O(entries) => {
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                escape(k, out);
                out.push(':');
                write(v, out);
            }
            out.push('}');
        }
    }
}

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Reference `contentDigest`: SHA-256 of the UTF-16LE code units, base64url.
pub fn content_digest(text: &str) -> String {
    let mut hash = Sha256::new();
    for unit in text.encode_utf16() {
        hash.update(unit.to_le_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash.finalize())
}

pub const PAGE_BYTES: usize = 64 * 1024;
pub const PAGE_ROWS: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub digest: String,
    pub index: u64,
    pub offset: u64,
}

fn high(unit: u16) -> bool {
    (0xD800..0xDC00).contains(&unit)
}

/// Reference `missionPanelPage` over one header (in its key order) and rows.
/// `Err` carries the refusal reason; `Err("budget")` is the reference's throw.
pub fn panel_page(header: &[(String, J)], values: &[J], cursor: Option<&Cursor>) -> Result<J, &'static str> {
    let texts: Vec<Vec<u16>> = values.iter().map(|v| v.stringify().encode_utf16().collect()).collect();
    let joined: Vec<String> = values.iter().map(J::stringify).collect();
    let digest = content_digest(&format!("[{}]", joined.join(",")));
    if cursor.is_some_and(|c| c.digest != digest) {
        return Err("changed");
    }
    let (mut index, mut offset) = cursor.map_or((0usize, 0usize), |c| (c.index as usize, c.offset as usize));
    let row_len = |i: usize| texts.get(i).map_or(0, Vec::len);
    if cursor.is_some_and(|c| c.index > texts.len() as u64 || c.offset > row_len(c.index as usize) as u64)
        || (index == texts.len() && offset != 0)
        || (offset > 0 && offset == row_len(index))
    {
        return Err("invalid-cursor");
    }
    let total = texts.len() as u64;
    let answer = |pieces: &[J], at: usize, from: usize| -> J {
        let mut entries = vec![("available".to_owned(), J::Bool(true)), ("version".to_owned(), J::U(1))];
        entries.extend(header.iter().cloned());
        let mut page = vec![
            ("digest".to_owned(), J::s(&digest)),
            ("total".to_owned(), J::U(total)),
            ("pieces".to_owned(), J::A(pieces.to_vec())),
        ];
        if at < texts.len() {
            page.push((
                "next".to_owned(),
                obj(vec![("digest", J::s(&digest)), ("index", J::U(at as u64)), ("offset", J::U(from as u64))]),
            ));
        }
        entries.push(("page".to_owned(), J::O(page)));
        J::O(entries)
    };
    let piece = |index: usize, offset: usize, text: &[u16]| {
        obj(vec![
            ("index", J::U(index as u64)),
            ("offset", J::U(offset as u64)),
            ("characters", J::U(texts[index].len() as u64)),
            ("text", J::S(String::from_utf16_lossy(text))),
        ])
    };
    let bytes = |value: &J| value.stringify().len();
    let mut pieces: Vec<J> = Vec::new();
    while index < texts.len() && pieces.len() < PAGE_ROWS {
        let text = &texts[index];
        let whole = piece(index, offset, &text[offset..]);
        let mut trial = pieces.clone();
        trial.push(whole.clone());
        if bytes(&answer(&trial, index + 1, 0)) <= PAGE_BYTES {
            pieces.push(whole);
            index += 1;
            offset = 0;
            continue;
        }
        if !pieces.is_empty() {
            break;
        }
        // One row wider than a transfer: the largest prefix that fits, measured
        // as `JSON.stringify` writes a cut surrogate pair (`\udXXX`, six bytes).
        let (mut low, mut high_end) = (offset, text.len());
        while low < high_end {
            let end = (low + high_end).div_ceil(2);
            let slice = &text[offset..end];
            let lone = slice.last().is_some_and(|u| high(*u));
            let shown = if lone { &slice[..slice.len() - 1] } else { slice };
            let size = bytes(&answer(&[piece(index, offset, shown)], index, end)) + if lone { 6 } else { 0 };
            if size <= PAGE_BYTES {
                low = end
            } else {
                high_end = end - 1
            }
        }
        if low < text.len() && low > 0 && high(text[low - 1]) {
            low -= 1;
        }
        if low <= offset {
            return Err("budget");
        }
        pieces.push(piece(index, offset, &text[offset..low]));
        offset = low;
        break;
    }
    let result = answer(&pieces, index, offset);
    if bytes(&result) > PAGE_BYTES {
        return Err("budget");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_hashes_utf16_code_units() {
        // Reference: createHash("sha256").update("[a]", "utf16le").digest("base64url").
        assert_eq!(content_digest("[a]"), "GywkoSn9bOJ0ENMPqrvY2U98kkVbjZWp1FTii8HQPuM");
        assert_eq!(content_digest("[\"é😀\"]"), "SuHkGvciKfDmEnj-POnAzZluiQePQZd0f-_3TFOyeYA");
    }

    #[test]
    fn stringify_matches_json_stringify() {
        let v = parse(br#"{"b":1,"a":[true,null,-2,1.5,1e21,1e-7,"\u0001\n\"\\"],"b":3}"#).unwrap();
        assert_eq!(v.stringify(), r#"{"b":3,"a":[true,null,-2,1.5,1e+21,1e-7,"\u0001\n\"\\"]}"#);
        let large_f64 = J::F(100_000_000_000_000_020_000.0);
        assert_eq!(large_f64.stringify(), "100000000000000020000");
        assert_eq!(J::F(1e20).stringify(), "100000000000000000000");
        assert_eq!(J::F(1e-6).stringify(), "0.000001");
        assert_eq!(J::F(-0.0).stringify(), "0");
    }

    fn header() -> Vec<(String, J)> {
        vec![("projectID".into(), J::s("p")), ("source".into(), J::s("activity"))]
    }

    #[test]
    fn page_splits_wide_rows_without_cutting_surrogate_pairs() {
        let row = J::S("😀".repeat(40_000));
        let rows = [row.clone()];
        let text = row.stringify();
        let mut cursor = None;
        let mut joined = String::new();
        let mut pages = 0;
        loop {
            let page = panel_page(&header(), &rows, cursor.as_ref()).unwrap();
            assert!(page.stringify().len() <= PAGE_BYTES);
            let p = page.get("page").unwrap();
            for piece in p.get("pieces").unwrap().arr().unwrap() {
                let t = piece.get("text").unwrap().str().unwrap();
                assert_eq!(piece.get("offset").unwrap().count().unwrap() as usize, utf16_len(&joined));
                joined.push_str(t);
            }
            pages += 1;
            match p.get("next") {
                Some(n) => {
                    cursor = Some(Cursor {
                        digest: n.get("digest").unwrap().str().unwrap().into(),
                        index: n.get("index").unwrap().count().unwrap(),
                        offset: n.get("offset").unwrap().count().unwrap(),
                    })
                }
                None => break,
            }
        }
        assert!(pages > 1);
        assert_eq!(joined, text);
        assert_eq!(content_digest(&format!("[{joined}]")), rows_digest(&rows));
    }

    fn rows_digest(rows: &[J]) -> String {
        content_digest(&format!("[{}]", rows.iter().map(J::stringify).collect::<Vec<_>>().join(",")))
    }

    #[test]
    fn page_refuses_changed_and_invalid_cursors() {
        let rows = [J::s("x")];
        let digest = rows_digest(&rows);
        let changed = Cursor { digest: "A".repeat(43), index: 0, offset: 0 };
        assert_eq!(panel_page(&header(), &rows, Some(&changed)), Err("changed"));
        for (index, offset) in [(2, 0), (1, 1), (0, 3), (0, 9)] {
            let bad = Cursor { digest: digest.clone(), index, offset };
            assert_eq!(panel_page(&header(), &rows, Some(&bad)), Err("invalid-cursor"), "{index}/{offset}");
        }
        let small = panel_page(&header(), &rows, None).unwrap();
        assert_eq!(
            small.stringify(),
            format!(r#"{{"available":true,"version":1,"projectID":"p","source":"activity","page":{{"digest":"{digest}","total":1,"pieces":[{{"index":0,"offset":0,"characters":3,"text":"\"x\""}}]}}}}"#)
        );
    }
}
