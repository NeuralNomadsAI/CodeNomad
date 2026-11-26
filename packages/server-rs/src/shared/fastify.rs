//! Fastify 5 behaviour the reference routes inherit: its error body and its default
//! body parsers (JSON through secure-json-parse, plain text) ahead of a route schema.
use axum::{
    Json,
    http::{HeaderMap, StatusCode as Status, header},
};
use serde_json::{Value, json};

use crate::Error;

pub enum Body {
    Json(Value),
    Text(String),
}

pub fn error(status: Status, code: &str, message: &str) -> Error {
    let reason = status.canonical_reason().unwrap_or_default();
    (status, Json(json!({"statusCode": status.as_u16(), "code": code, "error": reason, "message": message})))
}

/// `None`: no content type and an empty body.
pub fn body(headers: &HeaderMap, bytes: &[u8]) -> Result<Option<Body>, Error> {
    let media = || error(Status::UNSUPPORTED_MEDIA_TYPE, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type");
    let Some(kind) = headers.get(header::CONTENT_TYPE) else {
        return if bytes.is_empty() { Ok(None) } else { Err(media()) };
    };
    let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match essence.as_str() {
        "application/json" if bytes.is_empty() => Err(error(
            Status::BAD_REQUEST,
            "FST_ERR_CTP_EMPTY_JSON_BODY",
            "Body cannot be empty when content-type is set to 'application/json'",
        )),
        "application/json" => {
            let json_bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
            let parsed = serde_json::from_slice::<Value>(json_bytes).or_else(|err| {
                // JS `JSON.parse` / Fastify accepts unpaired UTF-16 surrogate escapes (`\uD800`..`\uDFFF`),
                // letting route schemas and business validators handle them (e.g. `422 invalid-spec`).
                replace_lone_surrogates(json_bytes)
                    .ok_or(err)
                    .and_then(|rewritten| serde_json::from_slice::<Value>(&rewritten))
            });
            match parsed {
                Ok(v) if !poisoned(&v) => Ok(Some(Body::Json(v))),
                _ => Err(error(
                    Status::BAD_REQUEST,
                    "FST_ERR_CTP_INVALID_JSON_BODY",
                    "Body is not valid JSON but content-type is set to 'application/json'",
                )),
            }
        }
        "text/plain" => Ok(Some(Body::Text(String::from_utf8_lossy(bytes).into_owned()))),
        _ => Err(media()),
    }
}

/// secure-json-parse refuses `__proto__` and `constructor.prototype` keys.
fn poisoned(v: &Value) -> bool {
    match v {
        Value::Object(m) => {
            m.iter().any(|(k, x)| k == "__proto__" || k == "constructor" && x.get("prototype").is_some() || poisoned(x))
        }
        Value::Array(a) => a.iter().any(poisoned),
        _ => false,
    }
}

fn parse_hex4(bytes: &[u8]) -> Option<u16> {
    if bytes.len() != 4 {
        return None;
    }
    let mut val = 0u16;
    for &b in bytes {
        let d = match b {
            b'0'..=b'9' => (b - b'0') as u16,
            b'a'..=b'f' => (b - b'a' + 10) as u16,
            b'A'..=b'F' => (b - b'A' + 10) as u16,
            _ => return None,
        };
        val = (val << 4) | d;
    }
    Some(val)
}

/// Rewrites unpaired `\uD800`..`\uDFFF` escapes inside JSON strings to `\uFFFD` so valid JS JSON
/// containing lone surrogates parses through `serde_json` and reaches route/business validation.
fn replace_lone_surrogates(bytes: &[u8]) -> Option<Vec<u8>> {
    if std::str::from_utf8(bytes).is_err() {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut changed = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !in_string {
            if b == b'"' {
                in_string = true;
            }
            out.push(b);
            i += 1;
            continue;
        }
        if b == b'"' {
            in_string = false;
            out.push(b);
            i += 1;
            continue;
        }
        if b == b'\\' {
            if i + 5 < bytes.len()
                && bytes[i + 1] == b'u'
                && let Some(u1) = parse_hex4(&bytes[i + 2..i + 6])
            {
                if (0xD800..=0xDBFF).contains(&u1) {
                    if i + 11 < bytes.len()
                        && bytes[i + 6] == b'\\'
                        && bytes[i + 7] == b'u'
                        && let Some(u2) = parse_hex4(&bytes[i + 8..i + 12])
                        && (0xDC00..=0xDFFF).contains(&u2)
                    {
                        out.extend_from_slice(&bytes[i..i + 12]);
                        i += 12;
                        continue;
                    }
                    out.extend_from_slice(b"\\uFFFD");
                    changed = true;
                    i += 6;
                    continue;
                }
                if (0xDC00..=0xDFFF).contains(&u1) {
                    out.extend_from_slice(b"\\uFFFD");
                    changed = true;
                    i += 6;
                    continue;
                }
                out.extend_from_slice(&bytes[i..i + 6]);
                i += 6;
                continue;
            }
            if i + 1 < bytes.len() {
                out.extend_from_slice(&bytes[i..i + 2]);
                i += 2;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    changed.then_some(out)
}
