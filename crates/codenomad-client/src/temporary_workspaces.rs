//! Bounded HTTP adapter for CodeNomad temporary workspace lifecycle routes.
use crate::{
    backend::{Backend, read_json_limited},
    history::valid_id,
};
use futures_lite::StreamExt;
use serde_json::{Value, json};
use std::fmt;

const MAX_TEMPORARY_FOLDERS: usize = 256;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_PATH_UTF16: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedTemporaryFolder {
    pub path: String,
    pub supports_cancel_and_abandon: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemporaryError {
    /// The server requires re-authentication (HTTP 401).
    Unauthorized,
    /// The server does not expose temporary workspace routes (404/501/503 without a temporary_* code).
    Unavailable,
    /// Structured temporary_* error code returned by the server.
    Code {
        code: String,
        message: Option<String>,
    },
    /// Any other HTTP, transport, or contract error.
    Other(String),
}

impl TemporaryError {
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Code { code, .. } => Some(code.as_str()),
            Self::Unauthorized | Self::Unavailable | Self::Other(_) => None,
        }
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable)
    }

    /// True only when the server explicitly confirmed the folder is no longer registered temporary.
    pub fn is_not_temporary(&self) -> bool {
        matches!(self.code(), Some("temporary_not_temporary"))
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self.code(), Some("temporary_not_found"))
    }

    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Code { message, .. } => message.as_deref(),
            Self::Other(message) => Some(message.as_str()),
            Self::Unauthorized | Self::Unavailable => None,
        }
    }
}

impl fmt::Display for TemporaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => f.write_str("authentication required"),
            Self::Unavailable => f.write_str("temporary workspaces unavailable"),
            Self::Code {
                code,
                message: Some(message),
            } => write!(f, "{code}: {message}"),
            Self::Code {
                code,
                message: None,
            } => f.write_str(code),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for TemporaryError {}

pub(crate) fn parse_folders(value: &Value) -> std::result::Result<Vec<String>, TemporaryError> {
    let raw = value
        .as_array()
        .ok_or_else(|| TemporaryError::Other("invalid temporary folders payload".into()))?;
    if raw.len() > MAX_TEMPORARY_FOLDERS {
        return Err(TemporaryError::Other(
            "too many temporary folders in payload".into(),
        ));
    }
    raw.iter()
        .map(|entry| {
            let path = entry
                .as_str()
                .filter(|path| {
                    crate::absolute_server_path(path)
                        && path.encode_utf16().nth(MAX_PATH_UTF16).is_none()
                })
                .ok_or_else(|| TemporaryError::Other("invalid temporary folder path".into()))?;
            Ok(path.to_owned())
        })
        .collect()
}

async fn parse_error(response: reqwest::Response) -> TemporaryError {
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return TemporaryError::Unauthorized;
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    let mut exceeded = false;
    while let Some(chunk) = chunks.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_ERROR_BYTES {
            exceeded = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    if !exceeded
        && let Ok(body) = serde_json::from_slice::<Value>(&bytes)
        && let Some(obj) = body.as_object()
    {
        let message = obj
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|msg| {
                !msg.is_empty()
                    && msg.encode_utf16().nth(512).is_none()
                    && !msg.chars().any(char::is_control)
            })
            .map(str::to_owned);
        if let Some(code) = obj
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|code| {
                code.starts_with("temporary_")
                    && code.len() <= 128
                    && !code.chars().any(char::is_control)
            })
        {
            return TemporaryError::Code {
                code: code.to_owned(),
                message,
            };
        }
        if matches!(status.as_u16(), 404 | 501 | 503) {
            return TemporaryError::Unavailable;
        }
        if let Some(message) = message {
            return TemporaryError::Other(message);
        }
    } else if matches!(status.as_u16(), 404 | 501 | 503) {
        return TemporaryError::Unavailable;
    }
    TemporaryError::Other(format!("HTTP {}", status.as_u16()))
}

impl Backend {
    pub async fn temporary_folders(&self) -> std::result::Result<Vec<String>, TemporaryError> {
        let response = self
            .client
            .get(format!("{}api/workspaces/temporary", self.base))
            .send()
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        let data = read_json_limited(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        parse_folders(&data["folders"])
    }

    pub async fn create_temporary_folder(
        &self,
    ) -> std::result::Result<CreatedTemporaryFolder, TemporaryError> {
        let response = self
            .client
            .post(format!("{}api/workspaces/temporary", self.base))
            .send()
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        let data = read_json_limited(response, MAX_RESPONSE_BYTES)
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        let path = data["path"]
            .as_str()
            .filter(|path| {
                crate::absolute_server_path(path)
                    && path.encode_utf16().nth(MAX_PATH_UTF16).is_none()
            })
            .ok_or_else(|| TemporaryError::Other("invalid temporary folder path".into()))?;
        Ok(CreatedTemporaryFolder {
            path: path.to_owned(),
            supports_cancel_and_abandon: data["supportsCancelAndAbandon"]
                .as_bool()
                .unwrap_or(false),
        })
    }

    pub async fn abandon_temporary_folder(
        &self,
        path: &str,
        request_id: Option<&str>,
    ) -> std::result::Result<(), TemporaryError> {
        if !crate::absolute_server_path(path) || path.encode_utf16().nth(MAX_PATH_UTF16).is_some() {
            return Err(TemporaryError::Other(
                "invalid temporary folder path".into(),
            ));
        }
        let mut payload = json!({ "path": path });
        if let Some(raw) = request_id {
            if raw.chars().any(char::is_control) {
                return Err(TemporaryError::Other("invalid requestId".into()));
            }
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.encode_utf16().nth(128).is_some() {
                return Err(TemporaryError::Other("invalid requestId".into()));
            }
            payload["requestId"] = Value::String(trimmed.to_owned());
        }
        let response = self
            .client
            .post(format!("{}api/workspaces/temporary/abandon", self.base))
            .json(&payload)
            .send()
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        Ok(())
    }

    pub async fn keep_temporary_workspace(
        &self,
        id: &str,
    ) -> std::result::Result<(), TemporaryError> {
        if !valid_id(id) {
            return Err(TemporaryError::Other("invalid workspace id".into()));
        }
        let response = self
            .client
            .post(format!("{}api/workspaces/{id}/keep", self.base))
            .send()
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        Ok(())
    }

    pub async fn discard_temporary_workspace(
        &self,
        id: &str,
        only_if_empty: bool,
    ) -> std::result::Result<(), TemporaryError> {
        if !valid_id(id) {
            return Err(TemporaryError::Other("invalid workspace id".into()));
        }
        let response = self
            .client
            .post(format!("{}api/workspaces/{id}/discard", self.base))
            .json(&json!({ "onlyIfEmpty": only_if_empty }))
            .send()
            .await
            .map_err(|err| TemporaryError::Other(err.to_string()))?;
        if !response.status().is_success() {
            return Err(parse_error(response).await);
        }
        Ok(())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::http::Http;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    struct MockReply {
        status: &'static str,
        body: String,
    }

    type RecordedRequests = Arc<Mutex<Vec<(String, String)>>>;

    fn spawn_server(
        replies: Vec<MockReply>,
    ) -> (Backend, RecordedRequests, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_clone = seen.clone();
        let handle = thread::spawn(move || {
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let header_end;
                loop {
                    let n = stream.read(&mut tmp).unwrap();
                    if n == 0 {
                        header_end = buf.len();
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = pos + 4;
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                let content_len = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while buf.len() < header_end + content_len {
                    let n = stream.read(&mut tmp).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let request_line = head.lines().next().unwrap_or("").to_owned();
                let body = String::from_utf8_lossy(&buf[header_end..header_end + content_len])
                    .into_owned();
                seen_clone.lock().unwrap().push((request_line, body));
                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    reply.body.len(),
                    reply.body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let backend = Backend {
            client: Http::new().unwrap(),
            base: format!("http://{addr}/"),
            workspace: String::new(),
            session: String::new(),
            client_id: "test".into(),
            session_directory: None,
            fresh_mode: false,
        };
        (backend, seen, handle)
    }

    #[test]
    fn temporary_workspace_endpoints_round_trip_and_classify_errors() {
        let (backend, seen, handle) = spawn_server(vec![
            MockReply {
                status: "200 OK",
                body: r#"{"folders":["/tmp/cn-temp-1","D:\\Temp\\cn-temp-2"]}"#.into(),
            },
            MockReply {
                status: "201 Created",
                body: r#"{"path":"/tmp/cn-temp-3","supportsCancelAndAbandon":true}"#.into(),
            },
            MockReply {
                status: "204 No Content",
                body: String::new(),
            },
            MockReply {
                status: "204 No Content",
                body: String::new(),
            },
            MockReply {
                status: "204 No Content",
                body: String::new(),
            },
            MockReply {
                status: "409 Conflict",
                body:
                    r#"{"error":"temporary_running","message":"A conversation is still running"}"#
                        .into(),
            },
            MockReply {
                status: "404 Not Found",
                body: r#"{"error":"temporary_not_found"}"#.into(),
            },
            MockReply {
                status: "409 Conflict",
                body: r#"{"error":"temporary_not_temporary"}"#.into(),
            },
            MockReply {
                status: "401 Unauthorized",
                body: r#"{"error":"Authentication required"}"#.into(),
            },
            MockReply {
                status: "404 Not Found",
                body: r#"{"error":"Not Found"}"#.into(),
            },
            MockReply {
                status: "501 Not Implemented",
                body: String::new(),
            },
            MockReply {
                status: "503 Service Unavailable",
                body: String::new(),
            },
        ]);

        let folders = block_on(backend.temporary_folders()).unwrap();
        assert_eq!(folders, vec!["/tmp/cn-temp-1", r"D:\Temp\cn-temp-2"]);

        let created = block_on(backend.create_temporary_folder()).unwrap();
        assert_eq!(
            created,
            CreatedTemporaryFolder {
                path: "/tmp/cn-temp-3".into(),
                supports_cancel_and_abandon: true,
            }
        );

        block_on(backend.abandon_temporary_folder("/tmp/cn-temp-3", Some("req-1"))).unwrap();
        block_on(backend.keep_temporary_workspace("ws-1")).unwrap();
        block_on(backend.discard_temporary_workspace("ws-1", true)).unwrap();

        let running = block_on(backend.discard_temporary_workspace("ws-1", false)).unwrap_err();
        assert_eq!(running.code(), Some("temporary_running"));
        assert!(!running.is_unavailable());
        assert!(!running.is_not_temporary());

        let not_found = block_on(backend.keep_temporary_workspace("ws-2")).unwrap_err();
        assert_eq!(not_found.code(), Some("temporary_not_found"));
        assert!(not_found.is_not_found());
        assert!(!not_found.is_not_temporary());
        assert!(!not_found.is_unavailable());

        let not_temp = block_on(backend.keep_temporary_workspace("ws-2")).unwrap_err();
        assert_eq!(not_temp.code(), Some("temporary_not_temporary"));
        assert!(not_temp.is_not_temporary());
        assert!(!not_temp.is_not_found());

        let unauth = block_on(backend.discard_temporary_workspace("ws-2", false)).unwrap_err();
        assert!(unauth.is_unauthorized());
        assert!(!unauth.is_unavailable());

        // Invalid requestId must be rejected before dispatch instead of silently omitted.
        let invalid_empty =
            block_on(backend.abandon_temporary_folder("/tmp/cn-temp-3", Some("   "))).unwrap_err();
        assert!(!invalid_empty.is_unavailable());
        let invalid_ctrl =
            block_on(backend.abandon_temporary_folder("/tmp/cn-temp-3", Some("\treq-1\n")))
                .unwrap_err();
        assert!(!invalid_ctrl.is_unavailable());
        let long_id = "x".repeat(129);
        let invalid_long =
            block_on(backend.abandon_temporary_folder("/tmp/cn-temp-3", Some(&long_id)))
                .unwrap_err();
        assert!(!invalid_long.is_unavailable());

        let unavail_404 = block_on(backend.create_temporary_folder()).unwrap_err();
        assert!(unavail_404.is_unavailable());
        let unavail_501 = block_on(backend.create_temporary_folder()).unwrap_err();
        assert!(unavail_501.is_unavailable());
        let unavail_503 = block_on(backend.temporary_folders()).unwrap_err();
        assert!(unavail_503.is_unavailable());

        handle.join().unwrap();
        let requests = seen.lock().unwrap();
        assert_eq!(requests[0].0, "GET /api/workspaces/temporary HTTP/1.1");
        assert_eq!(requests[1].0, "POST /api/workspaces/temporary HTTP/1.1");
        assert_eq!(
            requests[2].0,
            "POST /api/workspaces/temporary/abandon HTTP/1.1"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&requests[2].1).unwrap(),
            json!({"path": "/tmp/cn-temp-3", "requestId": "req-1"})
        );
        assert_eq!(requests[3].0, "POST /api/workspaces/ws-1/keep HTTP/1.1");
        assert_eq!(requests[4].0, "POST /api/workspaces/ws-1/discard HTTP/1.1");
        assert_eq!(
            serde_json::from_str::<Value>(&requests[4].1).unwrap(),
            json!({"onlyIfEmpty": true})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&requests[5].1).unwrap(),
            json!({"onlyIfEmpty": false})
        );
    }
}
