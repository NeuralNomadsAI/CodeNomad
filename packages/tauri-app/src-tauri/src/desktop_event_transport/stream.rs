use super::*;
use reqwest::blocking::RequestBuilder;

pub(super) fn build_stream_client() -> Result<Client, OpenStreamError> {
    Client::builder()
        .connect_timeout(Duration::from_millis(STREAM_CONNECT_TIMEOUT_MS))
        .tcp_keepalive(Duration::from_millis(STREAM_TCP_KEEPALIVE_MS))
        // Note: reqwest's blocking client doesn't expose a per-read timeout.
        // The global `.timeout()` would kill the entire SSE stream, so we
        // rely on:
        //   1. tcp_keepalive to detect dead connections (OS will RST after
        //      several unacked probes, typically ~2 min).
        //   2. Consumer-side stall detection (STREAM_STALL_TIMEOUT_MS).
        //   3. Reader thread breaking on channel send error (consumer dropped).
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

    let response = request.send().map_err(|error| OpenStreamError {
        kind: OpenStreamErrorKind::Transport,
        message: error.to_string(),
        status_code: None,
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

    request.header("Cookie", format!("{}={}", cookie_name, session_cookie))
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
    response: Response,
    tx: SyncSender<ReaderMessage>,
    stop: Arc<AtomicBool>,
    generation_atomic: Arc<AtomicU64>,
    generation: u64,
) {
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        if stop.load(Ordering::SeqCst) || !generation_matches(&generation_atomic, generation) {
            let _ = tx.send(ReaderMessage::End(Some("stopped".to_string())));
            return;
        }

        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = flush_sse_frame(&tx, &event_name, &data_lines);
                let _ = tx.send(ReaderMessage::End(Some("stream closed".to_string())));
                return;
            }
            Ok(_) => {
                if tx.send(ReaderMessage::Activity).is_err() {
                    return; // consumer dropped — stop reading
                }
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if handle_sse_line(trimmed, &mut event_name, &mut data_lines) {
                    if flush_sse_frame(&tx, &event_name, &data_lines).is_err() {
                        return;
                    }
                    event_name = None;
                    data_lines.clear();
                    continue;
                }
            }
            Err(error) => {
                let _ = flush_sse_frame(&tx, &event_name, &data_lines);
                let _ = tx.send(ReaderMessage::End(Some(error.to_string())));
                return;
            }
        }
    }
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
}
