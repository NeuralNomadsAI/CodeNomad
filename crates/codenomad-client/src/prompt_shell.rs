use crate::backend::Backend;
use serde_json::json;

pub const MAX_SHELL_COMMAND_BYTES: usize = 128 * 1024;
const PRE_DISPATCH_HEADER: &str = "x-codenomad-before-dispatch";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellError {
    Rejected,
    Unconfirmed,
    PreDispatchAuthenticationRequired,
    UnconfirmedAuthenticationRequired,
}

fn classify_status(status: u16, pre_dispatch: bool, native: bool) -> Result<(), ShellError> {
    if status == 204 {
        Ok(())
    } else if status == 401 {
        if native {
            if pre_dispatch {
                Err(ShellError::PreDispatchAuthenticationRequired)
            } else {
                Err(ShellError::UnconfirmedAuthenticationRequired)
            }
        } else if pre_dispatch {
            Err(ShellError::Rejected)
        } else {
            Err(ShellError::Unconfirmed)
        }
    } else if status == 408 {
        Err(ShellError::Unconfirmed)
    } else if (400..500).contains(&status) || (status == 501 && pre_dispatch) {
        Err(ShellError::Rejected)
    } else {
        Err(ShellError::Unconfirmed)
    }
}

impl Backend {
    pub async fn prompt_shell(&self, id: &str, command: &str) -> Result<(), ShellError> {
        if !crate::history::valid_id(&self.workspace)
            || !crate::history::valid_id(&self.session)
            || !crate::history::valid_id(id)
            || command.trim().is_empty()
            || command.len() > MAX_SHELL_COMMAND_BYTES
        {
            return Err(ShellError::Rejected);
        }
        let body = json!({ "id": id, "command": command });
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut request = self
                .client
                .post(format!(
                    "{}workspaces/{}/instance/api/session/{}/shell",
                    self.base, self.workspace, self.session
                ))
                .timeout(crate::http::REQUEST_TIMEOUT)
                .json(&body);
            if let Some(directory) = &self.session_directory {
                request = request.query(&[("directory", directory.as_str())]);
            }
            let response = request.send().await.map_err(|error| {
                if error.is_connect() || error.is_builder() {
                    ShellError::Rejected
                } else {
                    ShellError::Unconfirmed
                }
            })?;
            let pre_dispatch = response
                .headers()
                .get(PRE_DISPATCH_HEADER)
                .and_then(|value| value.to_str().ok())
                == Some("1");
            classify_status(response.status().as_u16(), pre_dispatch, true)
        }
        #[cfg(target_arch = "wasm32")]
        {
            use wasm_bindgen::JsCast;
            use wasm_bindgen_futures::JsFuture;
            use web_sys::{
                AbortController, Headers, Request, RequestCredentials, RequestInit, Response,
            };

            struct AbortOnDrop(AbortController);
            impl Drop for AbortOnDrop {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }

            let mut url = reqwest::Url::parse(&format!(
                "{}workspaces/{}/instance/api/session/{}/shell",
                self.base, self.workspace, self.session
            ))
            .map_err(|_| ShellError::Rejected)?;
            if let Some(directory) = &self.session_directory {
                url.query_pairs_mut()
                    .append_pair("directory", directory.as_str());
            }
            let window = web_sys::window().ok_or(ShellError::Rejected)?;
            let controller = AbortController::new().map_err(|_| ShellError::Rejected)?;
            let headers = Headers::new().map_err(|_| ShellError::Rejected)?;
            headers
                .set("Content-Type", "application/json")
                .map_err(|_| ShellError::Rejected)?;
            let serialized = serde_json::to_string(&body).map_err(|_| ShellError::Rejected)?;
            let init = RequestInit::new();
            init.set_method("POST");
            init.set_credentials(RequestCredentials::SameOrigin);
            init.set_headers(&headers);
            init.set_body(&serialized.into());
            init.set_signal(Some(&controller.signal()));
            // Refuse redirects before the browser can forward a shell POST outside the session.
            js_sys::Reflect::set(&init, &"redirect".into(), &"error".into())
                .map_err(|_| ShellError::Rejected)?;
            let request = Request::new_with_str_and_init(url.as_str(), &init)
                .map_err(|_| ShellError::Rejected)?;
            let _abort = AbortOnDrop(controller);
            let response: Response = crate::runtime::timeout(
                crate::http::REQUEST_TIMEOUT,
                JsFuture::from(window.fetch_with_request(&request)),
            )
            .await
            .ok_or(ShellError::Unconfirmed)?
            .and_then(JsCast::dyn_into)
            .map_err(|_| ShellError::Unconfirmed)?;
            let pre_dispatch = response
                .headers()
                .get(PRE_DISPATCH_HEADER)
                .ok()
                .flatten()
                .as_deref()
                == Some("1");
            classify_status(response.status(), pre_dispatch, false)
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
        handler: impl Fn(String, String) -> (u16, Vec<(&'static str, &'static str)>, String)
        + Send
        + Sync
        + 'static,
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
                    let (status, extra_headers, resp_body) = handler(target, body);
                    let mut extra = String::new();
                    for (k, v) in extra_headers {
                        extra.push_str(&format!("{k}: {v}\r\n"));
                    }
                    let raw = format!(
                        "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
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
            let code = Arc::new(std::sync::atomic::AtomicU16::new(204));
            let pre_dispatch = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let status_code = code.clone();
            let marked = pre_dispatch.clone();
            let (base, server) = spawn_server(move |path, body| {
                let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
                seen.lock().unwrap().push((path, parsed));
                let headers = if marked.load(std::sync::atomic::Ordering::SeqCst) {
                    vec![("x-codenomad-before-dispatch", "1")]
                } else {
                    vec![]
                };
                (
                    status_code.load(std::sync::atomic::Ordering::SeqCst),
                    headers,
                    String::new(),
                )
            })
            .await;

            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_1".into();
            backend.session_directory = Some("/repo/wt".into());

            // Pre-send validation refuses without HTTP.
            assert_eq!(
                backend.prompt_shell("msg_1", "   ").await,
                Err(ShellError::Rejected)
            );
            assert_eq!(
                backend.prompt_shell("../bad", "ls").await,
                Err(ShellError::Rejected)
            );
            assert_eq!(
                backend
                    .prompt_shell("msg_1", &"x".repeat(MAX_SHELL_COMMAND_BYTES + 1))
                    .await,
                Err(ShellError::Rejected)
            );
            assert!(captured.lock().unwrap().is_empty());

            // 204 success with directory query and exact JSON payload including attempt id.
            assert_eq!(backend.prompt_shell("msg_1", "git status").await, Ok(()));
            {
                let requests = captured.lock().unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(
                    requests[0].0,
                    "/workspaces/ws-1/instance/api/session/ses_1/shell?directory=%2Frepo%2Fwt"
                );
                assert_eq!(
                    requests[0].1,
                    json!({ "id": "msg_1", "command": "git status" })
                );
            }

            // Unexpected 200 (e.g. login page) must NOT confirm a 204-only shell endpoint.
            code.store(200, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_200", "echo 200").await,
                Err(ShellError::Unconfirmed)
            );

            // HTTP status classification, including pre-dispatch vs unmarked 401 and 408 timeout.
            code.store(400, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_400", "echo 400").await,
                Err(ShellError::Rejected)
            );
            code.store(408, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_408", "echo 408").await,
                Err(ShellError::Unconfirmed)
            );
            // Bare 501 stays unconfirmed without pre-dispatch proof; marked 501 is rejected.
            code.store(501, std::sync::atomic::Ordering::SeqCst);
            pre_dispatch.store(false, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_501", "echo 501").await,
                Err(ShellError::Unconfirmed)
            );
            pre_dispatch.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_501p", "echo 501-pre").await,
                Err(ShellError::Rejected)
            );
            pre_dispatch.store(false, std::sync::atomic::Ordering::SeqCst);
            code.store(401, std::sync::atomic::Ordering::SeqCst);
            pre_dispatch.store(false, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_401u", "echo 401-unmarked").await,
                Err(ShellError::UnconfirmedAuthenticationRequired)
            );
            pre_dispatch.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_401p", "echo 401-pre").await,
                Err(ShellError::PreDispatchAuthenticationRequired)
            );
            pre_dispatch.store(false, std::sync::atomic::Ordering::SeqCst);
            code.store(500, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_500", "echo 500").await,
                Err(ShellError::Unconfirmed)
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
                backend.prompt_shell("msg_off", "echo offline").await,
                Err(ShellError::Rejected)
            );
        });
    }

    #[test]
    fn decodes_shell_history_rows_for_running_and_completed_commands() {
        let running = crate::history::decode_message(&json!({
            "id": "msg_shell_1",
            "type": "shell",
            "shellID": "sh_1",
            "command": "git status",
            "status": "running",
            "time": { "created": 1 }
        }))
        .unwrap();
        assert_eq!(running.role, "shell");
        assert!(!running.completed);
        assert_eq!(running.body, "git status");

        let exited = crate::history::decode_message(&json!({
            "id": "msg_shell_2",
            "type": "shell",
            "shellID": "sh_2",
            "command": "echo hi",
            "status": "exited",
            "exit": 0,
            "output": { "output": "hi\n", "cursor": 3, "size": 3, "truncated": false },
            "time": { "created": 2, "completed": 3 }
        }))
        .unwrap();
        assert!(exited.completed);
        assert_eq!(exited.body, "$ echo hi\nhi\n");

        let empty_out = crate::history::decode_message(&json!({
            "id": "msg_shell_3",
            "type": "shell",
            "shellID": "sh_3",
            "command": "true",
            "status": "exited",
            "exit": 0,
            "output": { "output": "", "cursor": 0, "size": 0, "truncated": false },
            "time": { "created": 4 }
        }))
        .unwrap();
        assert!(empty_out.completed);
        assert_eq!(empty_out.body, "true");

        // Huge command + output stays strictly within 32 KiB per row, including "$ " and "\n".
        let huge_cmd = "c".repeat(40 * 1024);
        let capped = crate::history::decode_message(&json!({
            "id": "msg_huge_cmd",
            "type": "shell",
            "shellID": "sh_huge_cmd",
            "command": huge_cmd,
            "status": "exited",
            "exit": 0,
            "output": { "output": "tail", "cursor": 4, "size": 4, "truncated": false },
            "time": { "created": 5, "completed": 6 }
        }))
        .unwrap();
        assert!(capped.body.len() <= 32 * 1024);

        // Many 1 MiB shell outputs stay bounded so the resident history check never rejects the page.
        let large = "a".repeat(1024 * 1024);
        let rows: Vec<_> = (0..10)
            .map(|i| {
                Arc::new(
                    crate::history::decode_message(&json!({
                        "id": format!("msg_big_{i}"),
                        "type": "shell",
                        "shellID": format!("sh_big_{i}"),
                        "command": "cat big.log",
                        "status": "exited",
                        "exit": 0,
                        "output": { "output": large, "cursor": large.len(), "size": large.len(), "truncated": true },
                        "time": { "created": 10 + i, "completed": 11 + i }
                    }))
                    .unwrap(),
                )
            })
            .collect();
        assert!(crate::history::check(&rows).is_ok());
    }

    #[test]
    fn stale_epoch_shell_auth_expiry_settles_attempt_without_closing_newer_epoch() {
        run(async {
            use crate::transport::{Command, Event, PromptOutcome};
            use std::sync::atomic::{AtomicUsize, Ordering};
            use tokio::sync::Notify;

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let sse_hits = Arc::new(AtomicUsize::new(0));
            let release_shell = Arc::new(Notify::new());
            let release_sse1 = Arc::new(Notify::new());
            let shell_started = Arc::new(Notify::new());
            let sse2_opened = Arc::new(Notify::new());

            let shell_hits = Arc::new(AtomicUsize::new(0));
            let server = tokio::spawn({
                let sse_hits = sse_hits.clone();
                let shell_hits = shell_hits.clone();
                let release_shell = release_shell.clone();
                let release_sse1 = release_sse1.clone();
                let shell_started = shell_started.clone();
                let sse2_opened = sse2_opened.clone();
                async move {
                    while let Ok((mut socket, _)) = listener.accept().await {
                        let sse_hits = sse_hits.clone();
                        let shell_hits = shell_hits.clone();
                        let release_shell = release_shell.clone();
                        let release_sse1 = release_sse1.clone();
                        let shell_started = shell_started.clone();
                        let sse2_opened = sse2_opened.clone();
                        tokio::spawn(async move {
                            let mut buf = Vec::new();
                            let mut chunk = [0u8; 4096];
                            let header_end = loop {
                                let n = socket.read(&mut chunk).await.unwrap_or(0);
                                if n == 0 {
                                    return;
                                }
                                buf.extend_from_slice(&chunk[..n]);
                                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                    break pos + 4;
                                }
                            };
                            let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
                            let path = head
                                .lines()
                                .next()
                                .and_then(|line| line.split_whitespace().nth(1))
                                .unwrap_or_default()
                                .to_owned();
                            let content_len: usize = head
                                .lines()
                                .find_map(|line| {
                                    let (k, v) = line.split_once(':')?;
                                    k.eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            while buf.len() < header_end + content_len {
                                let n = socket.read(&mut chunk).await.unwrap_or(0);
                                if n == 0 {
                                    break;
                                }
                                buf.extend_from_slice(&chunk[..n]);
                            }

                            if path.starts_with("/api/events") {
                                let hit = sse_hits.fetch_add(1, Ordering::SeqCst) + 1;
                                let _ = socket
                                    .write_all(
                                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\ndata: {\"type\":\"server.connected\"}\n\n",
                                    )
                                    .await;
                                if hit == 1 {
                                    release_sse1.notified().await;
                                    let _ = socket.shutdown().await;
                                } else {
                                    sse2_opened.notify_one();
                                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                                }
                            } else if path.contains("/shell") {
                                let hit = shell_hits.fetch_add(1, Ordering::SeqCst) + 1;
                                if hit == 1 {
                                    shell_started.notify_one();
                                    release_shell.notified().await;
                                    let _ = socket
                                        .write_all(
                                            b"HTTP/1.1 401 Unauthorized\r\nx-codenomad-before-dispatch: 1\r\nContent-Length: 0\r\n\r\n",
                                        )
                                        .await;
                                } else {
                                    let _ = socket
                                        .write_all(
                                            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n",
                                        )
                                        .await;
                                }
                            } else if path.starts_with("/api/auth/status") {
                                let body = r#"{"authenticated":false}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            } else {
                                let body = r#"{"status":"window","messages":[],"running":false,"latest":true}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            }
                        });
                    }
                }
            });

            let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_1".into();
            let (ev_tx, ev_rx) = crate::bounded(64);
            let (cmd_tx, cmd_rx) = crate::bounded(16);
            let wake: crate::Wake = Arc::new(|| {});
            let runner = tokio::spawn(crate::recovery::run(backend, ev_tx, cmd_rx, wake));

            // Wait for epoch 1 SSE stream to open.
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while let Ok(ev) = ev_rx.recv().await {
                    if matches!(ev, Event::AgentHint(true)) {
                        return;
                    }
                }
                panic!("event channel closed before epoch 1 opened");
            })
            .await
            .expect("epoch 1 opened");

            // Dispatch shell command on epoch 1 and wait until server holds the POST.
            cmd_tx
                .send(Command::Shell {
                    attempt: "msg_stale_auth".into(),
                    command: "sleep 1".into(),
                })
                .await
                .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), shell_started.notified())
                .await
                .expect("shell POST reached server");

            // Force epoch 1 SSE to drop and reconnect as epoch 2.
            release_sse1.notify_one();
            tokio::time::timeout(std::time::Duration::from_secs(5), sse2_opened.notified())
                .await
                .expect("epoch 2 opened");
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while let Ok(ev) = ev_rx.recv().await {
                    if matches!(ev, Event::AgentHint(true)) {
                        return;
                    }
                }
                panic!("event channel closed before epoch 2 opened");
            })
            .await
            .expect("epoch 2 AgentHint");

            // Release the stale epoch-1 shell POST with pre-dispatch 401 + auth/status=false.
            release_shell.notify_one();

            // Must receive exact PromptAcknowledged(Rejected) and NEVER AuthenticationRequired,
            // AND a subsequent epoch-2 shell command must succeed on the surviving transport.
            let mut saw_stale_ack = false;
            let mut saw_epoch2_ack = false;
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while let Ok(event) = ev_rx.recv().await {
                    match event {
                        Event::AuthenticationRequired(_) => {
                            panic!("stale-epoch shell 401 must not expire the newer epoch");
                        }
                        Event::PromptAcknowledged { attempted, outcome }
                            if attempted == "msg_stale_auth" =>
                        {
                            assert!(matches!(outcome, PromptOutcome::Rejected));
                            saw_stale_ack = true;
                            cmd_tx
                                .send(Command::Shell {
                                    attempt: "msg_epoch2_ok".into(),
                                    command: "echo alive".into(),
                                })
                                .await
                                .unwrap();
                        }
                        Event::PromptAcknowledged { attempted, outcome }
                            if attempted == "msg_epoch2_ok" =>
                        {
                            assert!(
                                matches!(outcome, PromptOutcome::Confirmed(ref id) if id == "msg_epoch2_ok")
                            );
                            saw_epoch2_ack = true;
                            break;
                        }
                        _ => {}
                    }
                }
            })
            .await
            .expect("received stale-epoch and epoch-2 shell acknowledgements");
            assert!(saw_stale_ack);
            assert!(saw_epoch2_ack);
            assert!(
                !runner.is_finished(),
                "transport loop must stay alive on epoch 2 after stale-epoch shell 401"
            );

            let _ = cmd_tx.send(Command::Close).await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), runner).await;
            server.abort();
        });
    }

    #[test]
    fn before_dispatch_header_contract_rejects_legacy_name_and_non_one_values() {
        run(async {
            let header = Arc::new(Mutex::new(Option::<(&'static str, &'static str)>::None));
            let code = Arc::new(std::sync::atomic::AtomicU16::new(401));
            let active_header = header.clone();
            let status_code = code.clone();
            let (base, server) = spawn_server(move |_path, _body| {
                let headers = active_header.lock().unwrap().into_iter().collect();
                (
                    status_code.load(std::sync::atomic::Ordering::SeqCst),
                    headers,
                    String::new(),
                )
            })
            .await;

            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_1".into();

            // Canonical header name + value "1" proves pre-dispatch refusal.
            *header.lock().unwrap() = Some(("x-codenomad-before-dispatch", "1"));
            code.store(401, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_ok_401", "echo ok").await,
                Err(ShellError::PreDispatchAuthenticationRequired)
            );
            code.store(501, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_ok_501", "echo ok").await,
                Err(ShellError::Rejected)
            );

            // Legacy wrong header name must NOT be accepted as pre-dispatch proof.
            *header.lock().unwrap() = Some(("x-codenomad-pre-dispatch", "1"));
            code.store(401, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_old_401", "echo old").await,
                Err(ShellError::UnconfirmedAuthenticationRequired)
            );
            code.store(501, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_old_501", "echo old").await,
                Err(ShellError::Unconfirmed)
            );

            // Canonical header with a value other than "1" must NOT be accepted.
            *header.lock().unwrap() = Some(("x-codenomad-before-dispatch", "0"));
            code.store(401, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_zero_401", "echo zero").await,
                Err(ShellError::UnconfirmedAuthenticationRequired)
            );
            code.store(501, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                backend.prompt_shell("msg_hdr_zero_501", "echo zero").await,
                Err(ShellError::Unconfirmed)
            );

            server.abort();
        });
    }
}
