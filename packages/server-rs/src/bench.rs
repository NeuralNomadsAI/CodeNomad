//! Switches reserved for the qualification bench: the positional launch, the injected native
//! endpoint, fixture-only features and traces. `serve` ignores the positional launch, fixture
//! endpoints and Missions feature gates; other explicit `CNRS_FIXTURE_*` switches (startup,
//! tracing, ingress, PATH and registry guards) still take effect when set in the environment.
use std::{env, net::SocketAddr, path::PathBuf, sync::LazyLock, time::Duration};

use axum::{body::Body, extract::Request, middleware::Next, response::Response};
use tokio_util::sync::CancellationToken;

use crate::{auth, host};

fn on(name: &str) -> bool {
    env::var(name).as_deref() == Ok("1")
}

/// `codenomad-rs <root> <identity.json> <port or 0> <opencode binary or "">` (bench and user
/// service): password `CNRS_SERVER_PASSWORD`, HTTPS from `CNRS_HTTPS_BIND`, `CNRS_HTTPS_NAME`,
/// `CNRS_TLS_KEY`/`CERT`/`CA` and `CNRS_TLS_SANS`, data beside the identity file.
pub fn positional(args: &[String]) -> Result<host::Launch, Box<dyn std::error::Error>> {
    let [root, identity, port, binary] = args else {
        return Err("usage: codenomad-rs <root> <identity.json> <port or 0> <opencode binary or \"\">".into());
    };
    let identity = PathBuf::from(identity);
    let data = identity.with_extension("data");
    let https = match env::var("CNRS_HTTPS_BIND").ok() {
        Some(bind) => {
            let bind: SocketAddr = bind.parse()?;
            Some(auth::tls::Settings {
                bind: host::Bind { ip: bind.ip(), port: bind.port(), fallback: false },
                name: env::var("CNRS_HTTPS_NAME")?,
                dir: data.join("tls"),
                files: ["CNRS_TLS_KEY", "CNRS_TLS_CERT", "CNRS_TLS_CA"].map(env::var_os),
                sans: env::var("CNRS_TLS_SANS").unwrap_or_default(),
            })
        }
        None => None,
    };
    let auth = auth::Settings {
        username: auth::DEFAULT_USERNAME.into(),
        password: Some(env::var("CNRS_SERVER_PASSWORD")?),
        file: None,
        cookie: auth::DEFAULT_COOKIE.into(),
        token: false,
        managed_local: false,
        skip: false,
        idle: Duration::from_secs(86400),
        absolute: Duration::from_secs(7 * 86400),
    };
    Ok(host::Launch {
        root: root.into(),
        identity: Some(identity),
        // `CLI_CONFIG` and `CLI_UNRESTRICTED_ROOT` as `serve` reads them; settings beside the data otherwise.
        settings: crate::settings::document::Location::resolve(
            &env::var("CLI_CONFIG").unwrap_or_else(|_| data.to_string_lossy().into_owned()),
        ),
        unrestricted: host::cli::switch("CLI_UNRESTRICTED_ROOT")?,
        data,
        binary: binary.into(),
        http: host::Bind { ip: [127, 0, 0, 1].into(), port: port.parse()?, fallback: false },
        https,
        auth,
        ui: match env::var_os("CNRS_FIXTURE_UI_DIR") {
            Some(dir) if native_endpoint_set() => host::ui::Source::Dir(dir.into(), "bundled"),
            _ => host::ui::Source::Absent,
        },
        serve: false,
    })
}

/// The fixture daemon (`CNRS_FIXTURE_URL`, `CNRS_FIXTURE_PASSWORD`), in place of the CLI lifecycle.
pub fn native_endpoint() -> Result<(String, String), env::VarError> {
    Ok((env::var("CNRS_FIXTURE_URL")?, env::var("CNRS_FIXTURE_PASSWORD")?))
}
pub fn native_endpoint_set() -> bool {
    env::var_os("CNRS_FIXTURE_URL").is_some()
}

pub fn releases_fixture() -> Option<reqwest::Url> {
    if crate::config::serve() || !native_endpoint_set() {
        return None;
    }
    let url: reqwest::Url = env::var("CNRS_FIXTURE_RELEASES").ok()?.parse().expect("Invalid release fixture URL");
    assert!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    );
    Some(url)
}

/// On a positional fixture launch every provider request is sent to a local recorder.
pub fn provider_fixture() -> Option<reqwest::Url> {
    if crate::config::serve() || !native_endpoint_set() {
        return None;
    }
    let raw = env::var_os("CNRS_FIXTURE_PROVIDERS")?;
    let url: reqwest::Url = raw.to_str().and_then(|v| v.parse().ok()).expect("Invalid provider fixture origin");
    assert!(
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "Invalid provider fixture origin"
    );
    Some(url)
}

/// Under the fixture daemon (tests and bench), the automation bridge registry must lie in the
/// fixture's private home: never the user's real `automation-bridges/`, which their plugins probe.
pub fn private_registry(dir: &std::path::Path) -> bool {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    !native_endpoint_set() || home.is_some_and(|home| inside(dir, &home))
}
fn inside(dir: &std::path::Path, home: &std::path::Path) -> bool {
    use std::path::Component::ParentDir;
    dir.is_absolute() && dir.starts_with(home) && !dir.components().any(|c| c == ParentDir)
}
#[cfg(test)]
#[test]
fn fixture_registry_stays_in_the_private_home() {
    let home = std::env::temp_dir().join("fixture-home");
    assert!(inside(&home.join("AppData/Local/CodeNomad/automation-bridges"), &home));
    assert!(!inside(&home.join("../real/AppData/Local/CodeNomad/automation-bridges"), &home));
    assert!(!inside(&std::env::temp_dir().join("real-user/AppData/Local"), &home));
    assert!(!inside(std::path::Path::new("relative/automation-bridges"), std::path::Path::new("relative")));
}
/// `CNRS_FIXTURE_PANIC=1`: panic at startup, to check the backtrace a desktop host logs.
pub fn panic_on_start() {
    if on("CNRS_FIXTURE_PANIC") {
        panic!("CNRS_FIXTURE_PANIC: bench-requested startup panic");
    }
}
/// `CNRS_FIXTURE_NO_USER_PATH=1`: an OpenCode installation leaves the account's PATH alone.
pub fn skip_user_path() -> bool {
    on("CNRS_FIXTURE_NO_USER_PATH")
}
pub fn ingress() -> bool {
    on("CNRS_FIXTURE_INGRESS")
}
pub fn missions_run() -> bool {
    !crate::config::serve() && on("CNRS_FIXTURE_MISSIONS_RUN")
}
pub fn missions_read() -> bool {
    !crate::config::serve() && on("CNRS_FIXTURE_MISSIONS_READ")
}
pub fn missions_calendar() -> bool {
    !crate::config::serve() && on("CNRS_FIXTURE_MISSIONS_CALENDAR")
}
pub fn family_trace() -> bool {
    on("CNRS_FIXTURE_FAMILY_TRACE")
}
#[cfg(test)]
pub fn provision_fixture() -> Option<std::ffi::OsString> {
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
    let raw_path = req.uri().path().to_owned();
    let sensitive_path = crate::auth::remote::is_no_store_account_path(&raw_path);
    let integrations = crate::integrations::is_integrations_path(&raw_path);
    let path = if sensitive_path { "<account-route>".to_owned() } else { sanitize_trace_path(&raw_path) };
    let keys = if sensitive_path || integrations {
        Vec::new()
    } else {
        req.uri()
            .query()
            .map(|q| q.split('&').map(|p| p.split('=').next().unwrap_or("").to_owned()).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let started = chrono::Utc::now().timestamp_millis();
    let response = next.run(req).await;
    let status = response.status();
    if status.as_u16() < 400 || status.as_u16() == 404 && path.ends_with("/session-favorites") {
        return response;
    }
    if integrations {
        route_trace(format_args!(
            "refusal {} {method} {path} at {started} took {}ms",
            status.as_u16(),
            chrono::Utc::now().timestamp_millis() - started
        ));
        return response;
    }
    let no_store = sensitive_path
        || response
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("no-store"));
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
    if no_store {
        line("<redacted>");
        return response;
    }
    if !small {
        line("<stream>");
        return response;
    }
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, 16 * 1024).await.unwrap_or_default();
    line(&String::from_utf8_lossy(&bytes));
    Response::from_parts(parts, Body::from(bytes))
}

fn sanitize_trace_path(path: &str) -> String {
    if !crate::integrations::is_integrations_path(path) {
        return path.to_owned();
    }
    let Some(rest) = path.strip_prefix("/api/workspaces/") else {
        return "<unmatched>".to_owned();
    };
    let mut parts = rest.split('/');
    let _ws = parts.next();
    let Some(seg) = parts.next() else { return "<unmatched>".to_owned() };
    if seg != "integrations" {
        return "<unmatched>".to_owned();
    }
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) => "/api/workspaces/:id/integrations".to_owned(),
        (Some(_), Some(action @ ("hosts" | "binding" | "install" | "install-host" | "attach" | "detach")), None) => {
            format!("/api/workspaces/:id/integrations/:integrationId/{action}")
        }
        _ => "<unmatched>".to_owned(),
    }
}

#[cfg(test)]
mod trace_tests {
    use super::sanitize_trace_path;

    #[test]
    fn integrations_trace_paths_redact_ids_and_encoded_segments() {
        assert_eq!(sanitize_trace_path("/api/workspaces/ws-secret/integrations"), "/api/workspaces/:id/integrations");
        assert_eq!(
            sanitize_trace_path("/api/workspaces/ws-secret/integrations/blender/attach"),
            "/api/workspaces/:id/integrations/:integrationId/attach"
        );
        assert_eq!(sanitize_trace_path("/api/workspaces/ws-secret/%69ntegrations/blender/attach"), "<unmatched>");
        assert_eq!(sanitize_trace_path("/%61pi/workspaces/ws-secret/integrations/blender/attach"), "<unmatched>");
        assert_eq!(sanitize_trace_path("/api/%77orkspaces/ws-secret/integrations"), "<unmatched>");
        assert_eq!(sanitize_trace_path("/api/workspaces/ws-secret/integrations;directory=/top/secret"), "<unmatched>");
        assert_eq!(
            sanitize_trace_path("/api/workspaces/ws-secret/integrations/blender/hosts;directory=/top/secret"),
            "<unmatched>"
        );
        assert_eq!(sanitize_trace_path("/api/workspaces/ws-secret/integrations/blender/other"), "<unmatched>");
        assert_eq!(sanitize_trace_path("/api/workspaces/ws-secret/files"), "/api/workspaces/ws-secret/files");
    }
}
