//! Bounded preview document rewriting and the reference's runtime bridge.
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;

const LIMIT: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy)]
pub enum Kind {
    Html,
    Css,
    Js,
}
pub fn kind(value: &str) -> Option<Kind> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    Some(match mime.as_str() {
        "text/html" | "application/xhtml+xml" => Kind::Html,
        "text/css" => Kind::Css,
        "application/ecmascript"
        | "application/javascript"
        | "application/x-ecmascript"
        | "application/x-javascript"
        | "text/ecmascript"
        | "text/javascript"
        | "text/javascript1.0"
        | "text/javascript1.1"
        | "text/javascript1.2"
        | "text/javascript1.3"
        | "text/javascript1.4"
        | "text/javascript1.5"
        | "text/jscript"
        | "text/livescript"
        | "text/x-ecmascript"
        | "text/x-javascript" => Kind::Js,
        _ => return None,
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Encoding {
    Utf8,
    Le,
    Be,
    Latin1,
}
impl Encoding {
    fn select(bytes: &[u8], mime: &str) -> Option<Self> {
        static CHARSET: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"(?i);\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))"#).unwrap());
        let charset =
            CHARSET.captures(mime).and_then(|c| c.get(1).or_else(|| c.get(2))).map(|m| m.as_str().to_ascii_lowercase());
        let named = match charset.as_deref() {
            Some("utf8" | "utf-8") => Some(Self::Utf8),
            Some("utf-16" | "utf-16le") => Some(Self::Le),
            Some("utf-16be") => Some(Self::Be),
            Some("windows-1252" | "iso-8859-1" | "latin1" | "us-ascii") => Some(Self::Latin1),
            None => None,
            _ => return None,
        };
        if bytes.starts_with(&[0, 0, 0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe, 0, 0]) {
            return None;
        }
        if bytes.starts_with(&[0xfe, 0xff]) {
            Some(Self::Be)
        } else if bytes.starts_with(&[0xff, 0xfe]) {
            Some(Self::Le)
        } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            Some(Self::Utf8)
        } else {
            Some(named.unwrap_or_else(|| if std::str::from_utf8(bytes).is_ok() { Self::Utf8 } else { Self::Latin1 }))
        }
    }
    fn decode(self, bytes: &[u8]) -> Option<String> {
        match self {
            Self::Utf8 => String::from_utf8(bytes.to_vec()).ok(),
            Self::Latin1 => Some(bytes.iter().map(|c| char::from(*c)).collect()),
            Self::Le | Self::Be => {
                if bytes.len() % 2 != 0 {
                    return None;
                }
                char::decode_utf16(bytes.chunks_exact(2).map(|b| {
                    if self == Self::Le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
                }))
                .collect::<Result<String, _>>()
                .ok()
            }
        }
    }
    fn encode(self, text: String) -> Option<Vec<u8>> {
        match self {
            Self::Utf8 => Some(text.into_bytes()),
            Self::Latin1 => text.chars().map(|c| u8::try_from(c as u32).ok()).collect(),
            Self::Le | Self::Be => Some(
                text.encode_utf16()
                    .flat_map(|c| if self == Self::Le { c.to_le_bytes() } else { c.to_be_bytes() })
                    .collect(),
            ),
        }
    }
}

#[derive(Clone)]
pub struct Budget {
    pub active: std::sync::Arc<tokio::sync::Semaphore>,
    pub total: std::sync::Arc<tokio::sync::Semaphore>,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            active: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
            total: std::sync::Arc::new(tokio::sync::Semaphore::new(36)),
        }
    }
}

pub const BYTES: usize = LIMIT;

/// A remote source has already rewritten the document. Both UUID prefixes have equal width.
pub(super) fn replace_prefix(mut bytes: Vec<u8>, mime: &str, from: &str, to: &str) -> Option<Vec<u8>> {
    let charset = Encoding::select(&bytes, mime)?;
    let wide = matches!(charset, Encoding::Be | Encoding::Le);
    let from = charset.encode(from.into())?;
    let to = charset.encode(to.into())?;
    if from.is_empty() || from.len() != to.len() {
        return None;
    }
    let find = memchr::memmem::Finder::new(&from);
    let mut offset = 0;
    while let Some(at) = find.find(&bytes[offset..]) {
        let at = offset + at;
        if wide && at % 2 == 1 {
            offset = at + 1;
            continue;
        }
        bytes[at..at + to.len()].copy_from_slice(&to);
        offset = at + to.len();
    }
    Some(bytes)
}
#[derive(Clone, Copy, Debug)]
pub struct TooLarge;

struct Rewrite<'a> {
    base: &'a str,
    left: usize,
}
impl Rewrite<'_> {
    fn grow(&mut self, added: usize) -> Result<(), TooLarge> {
        self.left = self.left.checked_sub(added).ok_or(TooLarge)?;
        Ok(())
    }
    fn module(&mut self, source: &str) -> Result<String, TooLarge> {
        static IMPORT: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?:^|[^A-Za-z0-9_$.])(?:import\s*(?:\(\s*)?|from\s*)$").unwrap());
        let bytes = source.as_bytes();
        let mut parts = String::new();
        let mut copied = 0;
        let mut i = 0;
        while i < bytes.len() {
            if bytes.get(i..i + 2) == Some(b"//") {
                let Some(next) = source[i + 2..].find('\n') else { break };
                i += 2 + next;
                continue;
            }
            if bytes.get(i..i + 2) == Some(b"/*") {
                let Some(next) = source[i + 2..].find("*/") else { break };
                i += 4 + next;
                continue;
            }
            let quote = bytes[i];
            if !matches!(quote, b'"' | b'\'' | b'`') {
                i += 1;
                continue;
            }
            let start = i;
            i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' => i += 2,
                    b if b == quote => break,
                    _ => i += 1,
                }
            }
            if quote != b'`'
                && bytes.get(start + 1) == Some(&b'/')
                && bytes.get(start + 2) != Some(&b'/')
                && IMPORT.is_match(&source[source.ceil_char_boundary(start.saturating_sub(640))..start])
            {
                self.grow(self.base.len())?;
                parts.push_str(&source[copied..start + 1]);
                parts.push_str(self.base);
                copied = start + 1;
            }
            i += 1;
        }
        parts.push_str(&source[copied..]);
        Ok(parts)
    }
    fn map(&mut self, text: &str) -> Result<String, TooLarge> {
        let Ok(value) = serde_json::from_str::<Value>(text) else { return Ok(text.to_owned()) };
        self.map_value(value).map(|value| value.to_string())
    }
    fn map_value(&mut self, v: Value) -> Result<Value, TooLarge> {
        Ok(match v {
            Value::String(s) if root(&s) => {
                self.grow(self.base.len())?;
                Value::String(format!("{}{}", self.base, s))
            }
            Value::Array(a) => Value::Array(a.into_iter().map(|v| self.map_value(v)).collect::<Result<_, _>>()?),
            Value::Object(o) => {
                Value::Object(o.into_iter().map(|(k, v)| self.map_value(v).map(|v| (k, v))).collect::<Result<_, _>>()?)
            }
            _ => v,
        })
    }
    fn css(&mut self, text: &str) -> Result<String, TooLarge> {
        static URL: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"(?i)url\((\s*)(?:"(/[^"')]+)"|'(/[^"')]+)'|(/[^"')]+))(\s*)\)"#).unwrap());
        replace(text, &URL, |c| {
            let (url, quote) = if let Some(s) = c.get(2) {
                (s.as_str(), "\"")
            } else if let Some(s) = c.get(3) {
                (s.as_str(), "'")
            } else {
                (&c[4], "")
            };
            if !root(url) {
                return Ok(c[0].to_owned());
            }
            self.grow(self.base.len())?;
            Ok(format!("url({}{quote}{}{url}{quote}{})", &c[1], self.base, &c[5]))
        })
    }
    fn html(&mut self, text: &str, origin: &str) -> Result<String, TooLarge> {
        static ATTR: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"(?i)\b(src|href|action|poster|data|srcset)=(?:"([^"]*)"|'([^']*)')"#).unwrap()
        });
        static SCRIPTS: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?is)(<script\b([^>]*)>)(.*?)(</script>)").unwrap());
        static HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head(?:\s[^>]*)?>").unwrap());
        static INLINE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"(?i)\btype\s*=\s*(?:"(module|importmap)"|'(module|importmap)')"#).unwrap());
        let text = replace(text, &ATTR, |c| {
            let (value, quote) = c.get(2).map_or_else(|| (&c[3], "'"), |s| (s.as_str(), "\""));
            let attr = &c[1];
            if attr.eq_ignore_ascii_case("srcset") {
                let parts = value
                    .split(',')
                    .map(|entry| {
                        let trimmed = entry.trim_start_matches(crate::shared::js_space);
                        if !root(trimmed) {
                            return Ok(entry.to_owned());
                        }
                        self.grow(self.base.len())?;
                        Ok(format!("{}{}{}", &entry[..entry.len() - trimmed.len()], self.base, trimmed))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(format!("srcset={quote}{}{quote}", parts.join(",")))
            } else if root(value) {
                self.grow(self.base.len())?;
                Ok(format!("{attr}={quote}{}{value}{quote}", self.base))
            } else {
                Ok(c[0].to_owned())
            }
        })?;
        let text = self.css(&text)?;
        let mut text = replace(&text, &SCRIPTS, |c| {
            let attr = INLINE.captures(&c[2]).and_then(|c| c.get(1).or_else(|| c.get(2)));
            let s = match attr.map(|a| a.as_str().to_ascii_lowercase()).as_deref() {
                Some("module") => self.module(&c[3])?,
                Some("importmap") => self.map(&c[3])?,
                _ => return Ok(c[0].to_owned()),
            };
            Ok(format!("{}{s}{}", &c[1], &c[4]))
        })?;
        let bridge = include_str!("runtime.html")
            .replace("__CN_PREVIEW_BASE__", self.base)
            .replace("__CN_PREVIEW_ORIGIN__", origin);
        self.grow(bridge.len())?;
        let insert =
            HEAD.find(&text).map(|m| m.end()).unwrap_or_else(|| if text.starts_with('\u{feff}') { 3 } else { 0 });
        text.insert_str(insert, &bridge);
        Ok(text)
    }
}
fn root(url: &str) -> bool {
    url.starts_with('/') && !url.starts_with("//")
}
fn replace(
    input: &str,
    matcher: &Regex,
    mut transform: impl FnMut(Captures<'_>) -> Result<String, TooLarge>,
) -> Result<String, TooLarge> {
    let mut out = String::with_capacity(input.len());
    let mut start = 0;
    for c in matcher.captures_iter(input) {
        let m = c.get(0).unwrap();
        out.push_str(&input[start..m.start()]);
        start = m.end();
        out.push_str(&transform(c)?);
    }
    out.push_str(&input[start..]);
    Ok(out)
}

pub fn body(kind: Kind, mime: &str, bytes: &[u8], base: &str, origin: &str) -> Option<Vec<u8>> {
    let encoding = Encoding::select(bytes, mime)?;
    let text = encoding.decode(bytes)?;
    let limit = if matches!(encoding, Encoding::Be | Encoding::Le) { LIMIT / 2 } else { LIMIT };
    let mut loader = Rewrite { base, left: limit.checked_sub(text.encode_utf16().count())? };
    let next = match kind {
        Kind::Html => loader.html(&text, origin),
        Kind::Css => loader.css(&text),
        Kind::Js => loader.module(&text),
    }
    .ok()?;
    let bytes = encoding.encode(next)?;
    (bytes.len() <= LIMIT).then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_root_relative_assets_are_rewritten() {
        let input = br#"<head><script type="module">import x from "/app.js"; const a="/as-is";</script></head>
            <img src="/img.jpg" srcset="/a.png 1x, //elsewhere/b.png 2x"><link href='/sheet.css'>"#;
        let rewritten =
            String::from_utf8(body(Kind::Html, "text/html", input, "/previews/token", "http://127.0.0.1:1").unwrap())
                .unwrap();
        for s in [
            r#"from "/previews/token/app.js""#,
            r#"const a="/as-is""#,
            r#"src="/previews/token/img.jpg""#,
            r#"srcset="/previews/token/a.png 1x, //elsewhere/b.png 2x""#,
            "href='/previews/token/sheet.css'",
            "codenomad-preview-location",
        ] {
            assert!(rewritten.contains(s), "{s}");
        }
    }
    #[test]
    fn charset_is_preserved_or_refused() {
        let input = b"p{background:url('/\xe9.png')}";
        let output = body(Kind::Css, "text/css", input, "/public", "").unwrap();
        assert_eq!(output, b"p{background:url('/public/\xe9.png')}");
        assert!(body(Kind::Css, "text/css; charset=utf-8", input, "/public", "").is_none());
        assert!(body(Kind::Css, "text/css; charset=utf-32", input, "/public", "").is_none());
    }
}
