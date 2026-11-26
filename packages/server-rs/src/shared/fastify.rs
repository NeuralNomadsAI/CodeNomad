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
            match serde_json::from_slice::<Value>(json_bytes) {
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
