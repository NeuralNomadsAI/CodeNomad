use super::*;
use reqwest::RequestBuilder;

pub(super) fn build_stream_client() -> Result<Client, OpenStreamError> {
    build_stream_client_with_read_timeout(Duration::from_millis(STREAM_READ_TIMEOUT_MS))
}

fn build_stream_client_with_read_timeout(
    read_timeout: Duration,
) -> Result<Client, OpenStreamError> {
    Client::builder()
        .connect_timeout(Duration::from_millis(STREAM_CONNECT_TIMEOUT_MS))
        .read_timeout(read_timeout)
        .tcp_keepalive(Duration::from_millis(STREAM_TCP_KEEPALIVE_MS))
        .build()
        .map_err(|error: reqwest::Error| OpenStreamError {
            kind: OpenStreamErrorKind::Transport,
            message: error.to_string(),
            status_code: None,
        })
}

pub(super) fn open_stream(
    app: &AppHandle,
    client: &Client,
    config: &DesktopEventStreamConfig,
) -> Result<Response, OpenStreamError> {
    let url = format!(
        "{}?clientId={}&connectionId={}",
        config.events_url, config.client_id, config.connection_id
    );

    let request = attach_session_cookie(
        client.get(&url).header("Accept", "text/event-stream"),
        app,
        config,
    );

    let response =
        tauri::async_runtime::block_on(async { request.send().await }).map_err(|error| {
            OpenStreamError {
                kind: OpenStreamErrorKind::Transport,
                message: error.to_string(),
                status_code: None,
            }
        })?;

    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let kind = if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        OpenStreamErrorKind::Unauthorized
    } else {
        OpenStreamErrorKind::Http
    };

    Err(OpenStreamError {
        kind,
        message: format!("desktop event stream unavailable ({status})"),
        status_code: Some(status.as_u16()),
    })
}

fn resolve_session_cookie(app: &AppHandle, config: &DesktopEventStreamConfig) -> Option<String> {
    read_session_cookie_from_webview(app, &config.base_url, &config.cookie_name)
        .or_else(|| config.session_cookie.clone())
        .filter(|value| !value.is_empty())
}

pub(super) fn attach_session_cookie(
    request: RequestBuilder,
    app: &AppHandle,
    config: &DesktopEventStreamConfig,
) -> RequestBuilder {
    attach_session_cookie_value(
        request,
        &config.cookie_name,
        resolve_session_cookie(app, config).as_deref(),
    )
}

fn attach_session_cookie_value(
    request: RequestBuilder,
    cookie_name: &str,
    session_cookie: Option<&str>,
) -> RequestBuilder {
    let Some(session_cookie) = session_cookie.filter(|value| !value.is_empty()) else {
        return request;
    };

    request.header(
        "Cookie",
        format!(
            "{}={}",
            cookie_name,
            encode_cookie_header_value(session_cookie)
        ),
    )
}

fn encode_cookie_header_value(value: &str) -> String {
    let mut encoded = String::new();

    for byte in value.bytes() {
        if is_cookie_header_value_byte(byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

fn is_cookie_header_value_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'..=b'+' | b'-'..=b':' | b'<'..=b'[' | b']'..=b'~'
    )
}

fn read_session_cookie_from_webview(
    app: &AppHandle,
    base_url: &str,
    cookie_name: &str,
) -> Option<String> {
    let url = Url::parse(base_url).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    let windows = app.webview_windows();
    let window = windows.get("main")?;
    let cookies = window.cookies().ok()?;
    cookies
        .into_iter()
        .filter(|cookie: &tauri::webview::cookie::Cookie<'static>| cookie.name() == cookie_name)
        .filter(|cookie: &tauri::webview::cookie::Cookie<'static>| {
            let Some(domain) = cookie.domain() else {
                return true;
            };

            let normalized_domain = domain.trim_start_matches('.').to_ascii_lowercase();
            host == normalized_domain || host.ends_with(&format!(".{}", normalized_domain))
        })
        .filter(|cookie: &tauri::webview::cookie::Cookie<'static>| {
            let Some(cookie_path) = cookie.path() else {
                return true;
            };

            path.starts_with(cookie_path)
        })
        .map(|cookie: tauri::webview::cookie::Cookie<'static>| cookie.value().to_string())
        .next()
}

pub(super) fn read_sse(
    mut response: Response,
    tx: SyncSender<ReaderMessage>,
    stop: Arc<AtomicBool>,
    generation_atomic: Arc<AtomicU64>,
    generation: u64,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) {
    let mut buffer = [0_u8; SSE_READ_BUFFER_BYTES];
    let mut decoder = SseDecoder::new(MAX_SSE_LINE_BYTES, MAX_SSE_FRAME_BYTES);

    tauri::async_runtime::block_on(async move {
        loop {
            if stop.load(Ordering::SeqCst) || !generation_matches(&generation_atomic, generation) {
                let _ = tx.send(ReaderMessage::End(Some("stopped".to_string())));
                return;
            }

            let next_chunk = tokio::select! {
                _ = &mut cancel => {
                    let _ = tx.send(ReaderMessage::End(Some("stopped".to_string())));
                    return;
                }
                chunk = response.chunk() => chunk,
            };

            match next_chunk {
                Ok(None) => {
                    decoder.discard_frame();
                    let _ = tx.send(ReaderMessage::End(Some("stream closed".to_string())));
                    return;
                }
                Ok(Some(chunk)) => {
                    if tx.send(ReaderMessage::Activity).is_err() {
                        return; // consumer dropped - stop reading
                    }
                    for bytes in chunk.chunks(buffer.len()) {
                        buffer[..bytes.len()].copy_from_slice(bytes);
                        if let Err(error) = decoder.push(&buffer[..bytes.len()], &tx) {
                            let _ = tx.send(ReaderMessage::End(Some(error)));
                            return;
                        }
                    }
                }
                Err(error) => {
                    decoder.discard_frame();
                    let _ = tx.send(ReaderMessage::End(Some(error.to_string())));
                    return;
                }
            }
        }
    });
}

struct SseDecoder {
    line: Vec<u8>,
    event_name: Option<String>,
    data_lines: Vec<String>,
    frame_bytes: usize,
    max_line_bytes: usize,
    max_frame_bytes: usize,
    skip_lf: bool,
}

impl SseDecoder {
    fn new(max_line_bytes: usize, max_frame_bytes: usize) -> Self {
        Self {
            line: Vec::with_capacity(max_line_bytes.min(SSE_READ_BUFFER_BYTES)),
            event_name: None,
            data_lines: Vec::new(),
            frame_bytes: 0,
            max_line_bytes,
            max_frame_bytes,
            skip_lf: false,
        }
    }

    fn push(&mut self, bytes: &[u8], tx: &SyncSender<ReaderMessage>) -> Result<(), String> {
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }

            match byte {
                b'\r' => {
                    self.finish_line(tx)?;
                    self.skip_lf = true;
                }
                b'\n' => self.finish_line(tx)?,
                _ => {
                    checked_sse_size(self.line.len(), 1, self.max_line_bytes, "SSE line")?;
                    self.line.push(byte);
                }
            }
        }

        Ok(())
    }

    fn discard_frame(&mut self) {
        self.line.clear();
        self.event_name = None;
        self.data_lines.clear();
        self.frame_bytes = 0;
        self.skip_lf = false;
    }

    fn finish_line(&mut self, tx: &SyncSender<ReaderMessage>) -> Result<(), String> {
        if self.line.is_empty() {
            return self.flush_frame(tx);
        }

        let line_bytes = self
            .line
            .len()
            .checked_add(1)
            .ok_or_else(|| "SSE frame size overflow".to_string())?;
        self.frame_bytes = checked_sse_size(
            self.frame_bytes,
            line_bytes,
            self.max_frame_bytes,
            "SSE frame",
        )?;

        let line = std::str::from_utf8(&self.line)
            .map_err(|error| format!("invalid UTF-8 in SSE stream: {error}"))?;
        handle_sse_line(line, &mut self.event_name, &mut self.data_lines);
        self.line.clear();
        Ok(())
    }

    fn flush_frame(&mut self, tx: &SyncSender<ReaderMessage>) -> Result<(), String> {
        flush_sse_frame(tx, &self.event_name, &self.data_lines)
            .map_err(|_| "desktop event consumer dropped".to_string())?;
        self.event_name = None;
        self.data_lines.clear();
        self.frame_bytes = 0;
        Ok(())
    }
}

fn checked_sse_size(
    current: usize,
    additional: usize,
    maximum: usize,
    label: &str,
) -> Result<usize, String> {
    let next = current
        .checked_add(additional)
        .ok_or_else(|| format!("{label} size overflow"))?;
    if next > maximum {
        return Err(format!("{label} exceeded {maximum} bytes"));
    }
    Ok(next)
}

fn handle_sse_line(
    trimmed: &str,
    event_name: &mut Option<String>,
    data_lines: &mut Vec<String>,
) -> bool {
    if trimmed.is_empty() {
        return true;
    }

    if trimmed.starts_with(':') {
        return false;
    }

    if let Some(name) = trimmed.strip_prefix("event:") {
        *event_name = Some(name.strip_prefix(' ').unwrap_or(name).to_string());
        return false;
    }

    if let Some(data) = trimmed.strip_prefix("data:") {
        data_lines.push(data.strip_prefix(' ').unwrap_or(data).to_string());
    }

    false
}

fn flush_sse_frame(
    tx: &SyncSender<ReaderMessage>,
    event_name: &Option<String>,
    lines: &[String],
) -> Result<(), ()> {
    let Some(payload) = parse_sse_payload(lines) else {
        return Ok(());
    };

    if event_name.as_deref() == Some("codenomad.client.ping") {
        tx.send(ReaderMessage::Ping(payload)).map_err(|_| ())
    } else {
        tx.send(ReaderMessage::Event(payload)).map_err(|_| ())
    }
}

fn parse_sse_payload(lines: &[String]) -> Option<Value> {
    if lines.is_empty() {
        return None;
    }

    let payload = lines.join("\n").trim().to_string();
    if payload.is_empty() {
        return None;
    }

    serde_json::from_str::<Value>(&payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn decode_single_event(input: &[u8]) -> Value {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut decoder = SseDecoder::new(256, 1024);
        decoder.push(input, &tx).expect("stream should decode");
        decoder.discard_frame();

        match rx.recv().expect("event should be emitted") {
            ReaderMessage::Event(payload) => payload,
            _ => panic!("expected event frame"),
        }
    }

    #[test]
    fn decodes_lf_crlf_and_cr_only_streams() {
        for input in [
            &b"data: {\"ending\":\"lf\"}\n\n"[..],
            &b"data: {\"ending\":\"crlf\"}\r\n\r\n"[..],
            &b"data: {\"ending\":\"cr\"}\r\r"[..],
        ] {
            assert!(decode_single_event(input).get("ending").is_some());
        }
    }

    #[test]
    fn rejects_oversized_line_when_peer_withholds_lf() {
        let (tx, _rx) = mpsc::sync_channel(1);
        let mut decoder = SseDecoder::new(8, 64);

        let error = decoder
            .push(b"data: 123", &tx)
            .expect_err("ninth byte must exceed the line limit");

        assert_eq!(error, "SSE line exceeded 8 bytes");
    }

    #[test]
    fn rejects_oversized_frame_across_bounded_lines() {
        let (tx, _rx) = mpsc::sync_channel(1);
        let mut decoder = SseDecoder::new(16, 15);

        let error = decoder
            .push(b"data: a\ndata: b\n", &tx)
            .expect_err("second line must exceed the frame limit");

        assert_eq!(error, "SSE frame exceeded 15 bytes");
    }

    #[test]
    fn server_maximum_wire_frame_fits_and_next_byte_is_rejected_without_allocation() {
        let maximum_server_event_bytes = SERVER_MAX_EVENT_CHARACTERS
            .checked_mul(MAX_UTF8_BYTES_PER_CHARACTER)
            .and_then(|bytes| bytes.checked_add(MAX_WORKSPACE_EVENT_ENVELOPE_BYTES))
            .expect("configured SSE line limit should fit usize");

        assert_eq!(maximum_server_event_bytes, MAX_SSE_LINE_BYTES);
        assert_eq!(
            checked_sse_size(
                0,
                maximum_server_event_bytes,
                MAX_SSE_LINE_BYTES,
                "SSE line"
            ),
            Ok(MAX_SSE_LINE_BYTES)
        );
        assert_eq!(
            checked_sse_size(MAX_SSE_LINE_BYTES, 1, MAX_SSE_LINE_BYTES, "SSE line"),
            Err(format!("SSE line exceeded {MAX_SSE_LINE_BYTES} bytes"))
        );
        assert!(MAX_SSE_LINE_BYTES + 1 <= MAX_SSE_FRAME_BYTES);
        assert_eq!(
            checked_sse_size(0, MAX_SSE_FRAME_BYTES, MAX_SSE_FRAME_BYTES, "SSE frame"),
            Ok(MAX_SSE_FRAME_BYTES)
        );
        assert_eq!(
            checked_sse_size(MAX_SSE_FRAME_BYTES, 1, MAX_SSE_FRAME_BYTES, "SSE frame"),
            Err(format!("SSE frame exceeded {MAX_SSE_FRAME_BYTES} bytes"))
        );
    }

    #[test]
    fn discards_unterminated_frame_at_eof() {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut decoder = SseDecoder::new(256, 1024);
        decoder
            .push(b"data: {\"incomplete\":true}\n", &tx)
            .expect("line should decode");

        decoder.discard_frame();

        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    }

    #[test]
    fn read_timeout_ends_a_live_but_silent_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener should have an address");
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("client should connect");
            let mut request = [0_u8; 1024];
            socket.read(&mut request).expect("request should arrive");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                .expect("headers should send");
            socket.flush().expect("headers should flush");
            release_rx.recv().expect("test should release server");
        });
        let client = build_stream_client_with_read_timeout(Duration::from_millis(20))
            .expect("client should build");
        let mut response = tauri::async_runtime::block_on(async {
            client.get(format!("http://{address}/events")).send().await
        })
        .expect("response headers should arrive");

        let error = tauri::async_runtime::block_on(async { response.chunk().await })
            .expect_err("silent body should time out");

        assert!(error.is_timeout(), "unexpected error: {error}");
        release_tx.send(()).expect("server should release");
        server.join().expect("server should stop");
    }

    #[test]
    fn cancellation_ends_a_silent_reader_promptly() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener should have an address");
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("client should connect");
            let mut request = [0_u8; 1024];
            socket.read(&mut request).expect("request should arrive");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                .expect("headers should send");
            socket.flush().expect("headers should flush");
            release_rx.recv().expect("test should release server");
        });
        let client = build_stream_client_with_read_timeout(Duration::from_secs(5))
            .expect("client should build");
        let response = tauri::async_runtime::block_on(async {
            client.get(format!("http://{address}/events")).send().await
        })
        .expect("response headers should arrive");
        let (tx, rx) = mpsc::sync_channel(READER_CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let generation = Arc::new(AtomicU64::new(1));
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let started_at = Instant::now();
        let reader = thread::spawn(move || {
            read_sse(response, tx, stop, generation, 1, cancel_rx);
        });

        cancel_tx.send(()).expect("reader should be running");
        reader.join().expect("reader should stop");

        assert!(started_at.elapsed() < Duration::from_secs(1));
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(1)),
            Ok(ReaderMessage::End(Some(reason))) if reason == "stopped"
        ));
        release_tx.send(()).expect("server should release");
        server.join().expect("server should stop");
    }

    #[test]
    fn named_ping_event_is_routed_to_ping_channel() {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut event_name = None;
        let mut data_lines = Vec::new();

        assert!(!handle_sse_line(
            "event: codenomad.client.ping",
            &mut event_name,
            &mut data_lines
        ));
        assert!(!handle_sse_line(
            r#"data: {"ts":123}"#,
            &mut event_name,
            &mut data_lines
        ));
        assert!(handle_sse_line("", &mut event_name, &mut data_lines));

        flush_sse_frame(&tx, &event_name, &data_lines).expect("ping frame should flush");

        match rx.recv().expect("ping frame should be emitted") {
            ReaderMessage::Ping(payload) => {
                assert_eq!(payload.get("ts").and_then(Value::as_u64), Some(123));
            }
            _ => panic!("expected ping frame"),
        }
    }

    #[test]
    fn session_cookie_is_attached_to_requests() {
        let request = attach_session_cookie_value(
            Client::new().post("http://localhost/api/client-connections/pong"),
            "codenomad_session",
            Some("cookie-value"),
        )
        .build()
        .expect("request should build");

        assert_eq!(
            request
                .headers()
                .get("Cookie")
                .and_then(|value| value.to_str().ok()),
            Some("codenomad_session=cookie-value")
        );
    }

    #[test]
    fn session_cookie_value_is_encoded_before_header_attachment() {
        let request = attach_session_cookie_value(
            Client::new().post("http://localhost/api/client-connections/pong"),
            "codenomad_session",
            Some("safe;\r\nInjected=bad value"),
        )
        .build()
        .expect("request should build");

        assert_eq!(
            request
                .headers()
                .get("Cookie")
                .and_then(|value| value.to_str().ok()),
            Some("codenomad_session=safe%3B%0D%0AInjected=bad%20value")
        );
    }
}
