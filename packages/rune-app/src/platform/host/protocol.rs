//! The existing desktop stdout/stdin protocol, with bounded passive readers.
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub(super) const MAX_LINE: usize = 1024 * 1024;
pub(super) const SHUTDOWN: &[u8] = b"codenomad:shutdown\n";
pub(super) const RENEW_PREFIX: &str = "CODENOMAD_MANAGED_SESSION:";
pub(super) const OPENCODE_SERVICE_START: &str = "opencode.service.start";
pub(super) enum Line {
    Token(String),
    Ready(String),
    ManagedSession {
        id: String,
        session: Option<String>,
    },
    Native {
        response: String,
        expires: Instant,
        deadline: u64,
    },
    NativeServiceStart {
        id: String,
        params: Value,
        expires: Instant,
        deadline: u64,
    },
    Shutdown(bool),
    Diagnostic,
}
pub(super) fn native_ok(id: &str, result: Value) -> String {
    format!(
        "CODENOMAD_NATIVE_RESPONSE:{}\n",
        json!({"v":1,"id":id,"ok":true,"result":result})
    )
}
pub(super) fn native_error(id: &str, message: &str) -> String {
    format!(
        "CODENOMAD_NATIVE_RESPONSE:{}\n",
        json!({"v":1,"id":id,"ok":false,"error":{"code":"native_error","message":message}})
    )
}
pub(super) fn renew_command(id: &str) -> String {
    format!("codenomad:renew-session {id}\n")
}
fn valid_request_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}
fn valid_session_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub(super) fn classify(line: &str) -> Line {
    if let Some(token) = line.strip_prefix("CODENOMAD_BOOTSTRAP_TOKEN:") {
        return Line::Token(token.trim().into());
    }
    if let Some(raw) = line.strip_prefix(RENEW_PREFIX) {
        if let Some((id, value)) = raw.split_once(' ')
            && valid_request_id(id)
        {
            if value == "-" {
                return Line::ManagedSession {
                    id: id.to_owned(),
                    session: None,
                };
            }
            if valid_session_token(value) {
                return Line::ManagedSession {
                    id: id.to_owned(),
                    session: Some(value.to_owned()),
                };
            }
        }
        return Line::Diagnostic;
    }
    if let Some(raw) = line.strip_prefix("CODENOMAD_NATIVE_REQUEST:") {
        let Ok(request) = serde_json::from_str::<Value>(raw) else {
            return Line::Diagnostic;
        };
        let Some(id) = request["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
        else {
            return Line::Diagnostic;
        };
        let Some(method) = request["method"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
        else {
            return Line::Diagnostic;
        };
        let Some(deadline) = request["deadline"].as_u64() else {
            return Line::Diagnostic;
        };
        if request["v"] != 1 {
            return Line::Diagnostic;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(u64::MAX);
        let expires = Instant::now()
            .checked_add(Duration::from_millis(deadline.saturating_sub(now)))
            .unwrap_or_else(Instant::now);
        if method == OPENCODE_SERVICE_START && now < deadline {
            return Line::NativeServiceStart {
                id: id.to_owned(),
                params: request.get("params").cloned().unwrap_or(Value::Null),
                expires,
                deadline,
            };
        }
        // Unsupported capabilities are refused without reflecting their params or text.
        let message = if now >= deadline {
            "Native request expired before execution"
        } else {
            "Native capability is not implemented by this Rune host"
        };
        let response = native_error(id, message);
        return Line::Native {
            response,
            expires,
            deadline,
        };
    }
    if line == "CODENOMAD_SHUTDOWN_STATUS:complete" {
        return Line::Shutdown(true);
    }
    if line == "CODENOMAD_SHUTDOWN_STATUS:incomplete" {
        return Line::Shutdown(false);
    }
    // The reference accepts whitespace between these stdout words and around ':'.
    if let Some((label, url)) = line.split_once(':') {
        if label.split_whitespace().eq(["Local", "Connection", "URL"]) {
            let url = url.trim();
            if loopback_url(url) {
                return Line::Ready(url.into());
            }
        }
    }
    Line::Diagnostic
}
pub(super) fn fenced_response(response: String, expires: Instant, deadline: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX);
    if Instant::now() < expires && now < deadline {
        return response;
    }
    // Match native_request::dispatch's expired error after queueing, including ok responses.
    let raw = response
        .trim()
        .strip_prefix("CODENOMAD_NATIVE_RESPONSE:")
        .unwrap();
    let value: Value = serde_json::from_str(raw).unwrap();
    let id = value["id"].as_str().unwrap_or_default();
    native_error(id, "Native request expired before execution")
}
pub(super) fn loopback_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}
/// Drain a whole oversized line without retaining its tail as another command.
pub(super) fn pump(
    mut reader: impl BufRead,
    mut consume: impl FnMut(Option<&str>),
) -> io::Result<()> {
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let mut total = 0usize;
        let mut oversized = false;
        let mut ended = false;
        loop {
            let chunk = reader.fill_buf()?;
            if chunk.is_empty() {
                break;
            }
            let take = chunk
                .iter()
                .position(|b| *b == b'\n')
                .map_or(chunk.len(), |i| i + 1);
            ended = chunk.get(take - 1) == Some(&b'\n');
            total = total.saturating_add(take);
            if !oversized && total <= MAX_LINE {
                bytes.extend_from_slice(&chunk[..take]);
            } else {
                oversized = true;
                bytes.clear();
            }
            reader.consume(take);
            if ended {
                break;
            }
        }
        if total == 0 || !ended {
            return Ok(());
        }
        if oversized {
            consume(None)
        } else {
            let line = String::from_utf8_lossy(&bytes);
            consume(Some(line.trim_end_matches('\n').trim_end_matches('\r')));
        }
    }
}
