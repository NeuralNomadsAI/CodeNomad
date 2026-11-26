use crate::{backend::Backend, prompt::PromptError};
use serde_json::json;

pub const MAX_SHELL_COMMAND_BYTES: usize = 128 * 1024;

impl Backend {
    pub async fn prompt_shell(&self, command: &str) -> Result<(), PromptError> {
        if !crate::history::valid_id(&self.workspace)
            || !crate::history::valid_id(&self.session)
            || command.trim().is_empty()
            || command.len() > MAX_SHELL_COMMAND_BYTES
        {
            return Err(PromptError::Rejected);
        }
        let mut request = self
            .client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/shell",
                self.base, self.workspace, self.session
            ))
            .json(&json!({ "command": command }));
        if let Some(directory) = &self.session_directory {
            request = request.query(&[("directory", directory.as_str())]);
        }
        let response = request.send().await.map_err(|error| {
            #[cfg(not(target_arch = "wasm32"))]
            if error.is_connect() || error.is_builder() {
                return PromptError::Rejected;
            }
            #[cfg(target_arch = "wasm32")]
            if error.is_builder() {
                return PromptError::Rejected;
            }
            PromptError::Unconfirmed
        })?;
        if cfg!(not(target_arch = "wasm32"))
            && response.status() == reqwest::StatusCode::UNAUTHORIZED
        {
            Err(PromptError::AuthenticationRequired)
        } else if response.status().is_success() {
            Ok(())
        } else if response.status().is_client_error()
            || response.status() == reqwest::StatusCode::NOT_IMPLEMENTED
        {
            Err(PromptError::Rejected)
        } else {
            Err(PromptError::Unconfirmed)
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn spawn_server(
        handler: impl Fn(String, String) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let mut header_end = None;
                    let mut content_len = 0usize;
                    while let Ok(n) = socket.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if header_end.is_none()
                            && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
                        {
                            header_end = Some(pos + 4);
                            let head = String::from_utf8_lossy(&buf[..pos]);
                            for line in head.lines() {
                                if let Some((k, v)) = line.split_once(':')
                                    && k.eq_ignore_ascii_case("content-length")
                                {
                                    content_len = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                        if let Some(end) = header_end
                            && buf.len() >= end + content_len
                        {
                            break;
                        }
                    }
                    let head_end = header_end.unwrap_or(buf.len());
                    let head = String::from_utf8_lossy(&buf[..head_end]);
                    let first = head.lines().next().unwrap_or_default();
                    let target = first
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned();
                    let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
                    let (status, resp_body) = handler(target, body);
                    let raw = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = socket.write_all(raw.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (format!("http://{addr}/"), handle)
    }

    #[test]
    fn posts_session_shell_with_directory_and_classifies_outcomes() {
        run(async {
            let captured = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
            let seen = captured.clone();
            let code = Arc::new(std::sync::atomic::AtomicU16::new(200));
            let status_code = code.clone();
            let (base, server) = spawn_server(move |path, body| {
                let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
                seen.lock().unwrap().push((path, parsed));
                (
                    status_code.load(std::sync::atomic::Ordering::SeqCst),
                    "{}".into(),
                )
            })
            .await;

            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_1".into();
            backend.session_directory = Some("/repo/wt".into());

            // Pre-send validation refuses without HTTP.
            assert_eq!(
                backend.prompt_shell("   ").await,
                Err(PromptError::Rejected)
            );
            assert_eq!(
                backend
                    .prompt_shell(&"x".repeat(MAX_SHELL_COMMAND_BYTES + 1))
                    .await,
                Err(PromptError::Rejected)
            );
            assert!(captured.lock().unwrap().is_empty());

            // Success with directory query and exact JSON payload.
            assert_eq!(backend.prompt_shell("git status").await, Ok(()));
            {
                let requests = captured.lock().unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(
                    requests[0].0,
                    "/workspaces/ws-1/instance/api/session/ses_1/shell?directory=%2Frepo%2Fwt"
                );
                assert_eq!(requests[0].1, json!({ "command": "git status" }));
            }

            // HTTP status classification.
            code.store(400, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("echo 400").await,
                Err(PromptError::Rejected)
            );
            code.store(501, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("echo 501").await,
                Err(PromptError::Rejected)
            );
            code.store(401, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("echo 401").await,
                Err(PromptError::AuthenticationRequired)
            );
            code.store(500, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("echo 500").await,
                Err(PromptError::Unconfirmed)
            );
            server.abort();
        });
    }

    #[test]
    fn connect_failure_is_rejected_before_dispatch() {
        run(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            drop(listener);
            let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_1".into();
            assert_eq!(
                backend.prompt_shell("echo offline").await,
                Err(PromptError::Rejected)
            );
        });
    }
}
