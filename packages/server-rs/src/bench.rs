//! Switches reserved for the qualification bench: the injected native endpoint,
//! fixture-only features and traces. Production never sets them.
use std::{env, ffi::OsString, sync::LazyLock};

use axum::{body::Body, extract::Request, middleware::Next, response::Response};
use tokio_util::sync::CancellationToken;

fn on(name: &str) -> bool {
    env::var(name).as_deref() == Ok("1")
}

/// The fixture daemon (`CNRS_FIXTURE_URL`, `CNRS_FIXTURE_PASSWORD`), in place of the CLI lifecycle.
pub fn native_endpoint() -> Result<(String, String), env::VarError> {
    Ok((env::var("CNRS_FIXTURE_URL")?, env::var("CNRS_FIXTURE_PASSWORD")?))
}
pub fn native_endpoint_set() -> bool {
    env::var_os("CNRS_FIXTURE_URL").is_some()
}
pub fn ingress() -> bool {
    on("CNRS_FIXTURE_INGRESS")
}
pub fn missions_run() -> bool {
    on("CNRS_FIXTURE_MISSIONS_RUN")
}
pub fn missions_read() -> bool {
    on("CNRS_FIXTURE_MISSIONS_READ")
}
pub fn missions_calendar() -> bool {
    on("CNRS_FIXTURE_MISSIONS_CALENDAR")
}
pub fn missions_registry() -> Option<OsString> {
    env::var_os("CNRS_FIXTURE_MISSIONS_REGISTRY")
}
pub fn family_trace() -> bool {
    on("CNRS_FIXTURE_FAMILY_TRACE")
}
#[cfg(test)]
pub fn provision_fixture() -> Option<OsString> {
    env::var_os("CNRS_PROVISION_FIXTURE")
}

/// `CNRS_FIXTURE_STDIN_STOP=1`: a `shutdown` line on stdin stops the server gracefully.
pub fn stop_on_stdin(stop: CancellationToken) {
    if !on("CNRS_FIXTURE_STDIN_STOP") {
        return;
    }
    std::thread::spawn(move || {
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).is_ok() && line.trim() == "shutdown" {
            stop.cancel();
        }
    });
}

static ROUTE_TRACE: LazyLock<bool> = LazyLock::new(|| on("CNRS_FIXTURE_ROUTE_TRACE"));

/// Timing lines (`CNRS_FIXTURE_ROUTE_TRACE=1`); no paths or payloads.
pub fn route_trace(line: std::fmt::Arguments) {
    if *ROUTE_TRACE {
        println!("route-trace {line}");
    }
}

/// `<label> <elapsed>ms at <epoch ms>`.
pub fn trace_elapsed(label: &str, started: std::time::Instant) {
    route_trace(format_args!(
        "{label} {}ms at {}",
        started.elapsed().as_millis(),
        chrono::Utc::now().timestamp_millis()
    ))
}

/// Refused requests on the HTTPS listener: method, path, query parameter names and the
/// short error body. No query values, headers or request bodies are logged.
pub async fn refusal_trace(req: Request, next: Next) -> Response {
    if !*ROUTE_TRACE {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let keys = req
        .uri()
        .query()
        .map(|q| q.split('&').map(|p| p.split('=').next().unwrap_or("").to_owned()).collect::<Vec<_>>())
        .unwrap_or_default();
    let started = chrono::Utc::now().timestamp_millis();
    let response = next.run(req).await;
    let status = response.status();
    if status.as_u16() < 400 || status.as_u16() == 404 && path.ends_with("/session-favorites") {
        return response;
    }
    let small = response
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok()?.parse::<usize>().ok())
        .is_some_and(|n| n <= 16 * 1024);
    let took = || chrono::Utc::now().timestamp_millis() - started;
    let line = |body: &str| {
        route_trace(format_args!(
            "refusal {} {method} {path} keys={keys:?} at {started} took {}ms body={body}",
            status.as_u16(),
            took()
        ))
    };
    if !small {
        line("<stream>");
        return response;
    }
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, 16 * 1024).await.unwrap_or_default();
    line(&String::from_utf8_lossy(&bytes));
    Response::from_parts(parts, Body::from(bytes))
}
