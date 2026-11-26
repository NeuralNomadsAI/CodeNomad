//! The selected OpenCode executable (`settings/binaries.ts`), its `--version` and `service --help` probes
//! (`spawn.ts`) and the update status (`opencode-update/service.ts` `getStatus`) with the npm release and
//! the running daemon's admission and capabilities.
use std::{cmp::Ordering, time::Duration};

use axum::{
    Json,
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{
    admission::{self, MINIMUM_VERSION, Refusal},
    daemon, install, launch,
};
use crate::{Shared, shared::fastify};

const RECOMMENDED_VERSION: &str = "2.3.2";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// One bounded `execFile`: exit status, spawn or timeout error (`missing` for ENOENT) and output.
struct Run {
    status: Option<i32>,
    error: Option<String>,
    missing: bool,
    stdout: String,
    stderr: String,
}
async fn run(binary: &str, args: &[&str]) -> Run {
    let failed = |error: String, missing| Run {
        status: None,
        error: Some(error),
        missing,
        stdout: "".into(),
        stderr: "".into(),
    };
    let spec = match launch::spec(binary, args) {
        Ok(spec) => spec,
        Err(e) => return failed(e, false),
    };
    match daemon::execute(&spec, None, PROBE_TIMEOUT).await {
        Ok(out) => Run { status: Some(0), error: None, missing: false, stdout: out.stdout, stderr: out.stderr },
        Err(e) if e.code.is_some() => {
            Run { status: e.code, error: None, missing: false, stdout: e.output.stdout, stderr: e.output.stderr }
        }
        Err(e) => {
            // Node's message, without the `code X: ` prefix the lifecycle logs carry.
            let missing = e.detail.starts_with("code ENOENT");
            let message =
                e.detail.split_once(": ").filter(|(code, _)| code.starts_with("code ")).map_or(&*e.detail, |(_, m)| m);
            failed(message.into(), missing)
        }
    }
}

/// `parseBinaryVersion`: the first reported line, without `opencode ` or `v` prefixes.
struct Probe {
    valid: bool,
    version: Option<String>,
    error: Option<String>,
    missing: bool,
}
fn parse_version(run: &Run) -> Probe {
    let failed = |error: String, missing| Probe { valid: false, version: None, error: Some(error), missing };
    if let Some(error) = &run.error {
        return failed(error.clone(), run.missing);
    }
    let line = |text: &str| text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_owned);
    if run.status != Some(0) {
        let code = run.status.map_or("null".into(), |c| c.to_string());
        let detail =
            Some(run.stderr.trim()).filter(|s| !s.is_empty()).or(Some(run.stdout.trim()).filter(|s| !s.is_empty()));
        return failed(
            detail.map_or(format!("Exited with code {code}"), |d| format!("Exited with code {code}: {d}")),
            false,
        );
    }
    static PREFIX: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^opencode2?\s+").unwrap());
    static V: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^v([0-9]+\.)").unwrap());
    let version = line(&run.stdout).or_else(|| line(&run.stderr)).map(|reported| {
        let version = PREFIX.replace(&reported, "").into_owned();
        V.replace(&version, "$1").into_owned()
    });
    Probe { valid: true, version, error: None, missing: false }
}

/// `isOpenCodeServiceHelp`: the `service` namespace listing `start`, `status` and `get`.
fn service_help(stdout: &str, stderr: &str) -> bool {
    let output = daemon::help_output(stdout, stderr);
    let lines: Vec<&str> = output.lines().collect();
    let words = |l: &str| l.split_whitespace().map(str::to_ascii_lowercase).collect::<Vec<_>>();
    let namespace = |l: &&str| matches!(words(l).as_slice(), [cli, service, ..] if (cli == "opencode" || cli == "opencode2") && service == "service");
    let header = |l: &&str| l.trim().eq_ignore_ascii_case("SUBCOMMANDS") || l.trim().eq_ignore_ascii_case("Commands:");
    let Some(start) = lines.iter().position(header) else { return false };
    let section: Vec<&str> = lines[start + 1..].iter().copied().take_while(|l| !header(l)).collect();
    let listed = |command: &str| {
        section.iter().any(|l| {
            let words = words(l);
            let rest = match words.as_slice() {
                [cli, service, rest @ ..] if (cli == "opencode" || cli == "opencode2") && service == "service" => rest,
                rest => rest,
            };
            rest.first().is_some_and(|w| w == command)
        })
    };
    lines.iter().any(namespace) && ["start", "status", "get"].iter().all(|c| listed(c))
}

/// `probeOpenCodeBinary`: a version, then a V2 `service` command, neither starting a daemon.
async fn validate_binary(binary: &str) -> Value {
    if binary.is_empty() {
        return json!({"valid": false, "error": "Missing binary path"});
    }
    let probe = parse_version(&run(binary, &["--version"]).await);
    if !probe.valid {
        return json!({"valid": false, "error": probe.error});
    }
    let mut result = json!({"valid": false});
    if let Some(version) = &probe.version {
        result["version"] = json!(version);
    }
    let help = run(binary, &["service", "--help"]).await;
    if let Some(error) = help.error {
        result["error"] = json!(error);
    } else if daemon::service_unavailable(&help.stdout, &help.stderr) {
        result["errorCode"] = json!("opencode_v2_required");
    } else if help.status == Some(0) {
        result["valid"] = json!(service_help(&help.stdout, &help.stderr));
    } else {
        let detail = Some(help.stderr.trim()).filter(|s| !s.is_empty()).unwrap_or(help.stdout.trim());
        let detail: String = String::from_utf16_lossy(&detail.encode_utf16().take(1024).collect::<Vec<_>>());
        let code = help.status.map_or("null".into(), |c| c.to_string());
        let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
        result["error"] = json!(format!("OpenCode service probe exited with code {code}{suffix}"));
    }
    result
}

/// `POST /api/storage/binaries/validate` `{ path }`; `opencode` and `opencode2` name the default installation.
pub async fn validate(headers: HeaderMap, bytes: Bytes) -> Response {
    let body = match fastify::body(&headers, &bytes) {
        Ok(Some(fastify::Body::Json(body))) => body,
        Ok(None) => json!({}),
        Ok(Some(fastify::Body::Text(_))) => Value::Null,
        Err(e) => return e.into_response(),
    };
    let Some(path) = body.get("path").and_then(Value::as_str) else {
        return (Status::BAD_REQUEST, Json(json!({"valid": false, "error": "Invalid request"}))).into_response();
    };
    let binary = if path == "opencode" || path == "opencode2" {
        install::plan::resolve_default().await.0
    } else {
        path.to_owned()
    };
    Json(validate_binary(&binary).await).into_response()
}

/// `^\d+\.\d+\.\d+$` or a historical V2 beta: versions this server can order.
fn comparable(version: &str) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^(?:[0-9]+\.[0-9]+\.[0-9]+|0\.0\.0-beta-[0-9]+)$").unwrap());
    PATTERN.is_match(version)
}
/// `compareOpenCodeVersionStrings` for comparable versions (betas by number, releases by number).
fn compare(left: &str, right: &str) -> Ordering {
    let beta = |v: &str| v.strip_prefix("0.0.0-beta-").and_then(|n| n.parse::<u64>().ok());
    if let (Some(l), Some(r)) = (beta(left), beta(right)) {
        return l.cmp(&r);
    }
    let parts = |v: &str| {
        let core = v.trim().trim_start_matches(['v', 'V']).split('-').next().unwrap_or("").to_owned();
        let number = |s: Option<&str>| {
            s.and_then(|s| s.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().ok())
                .unwrap_or(0)
        };
        let mut it = core.split('.');
        ([number(it.next()), number(it.next()), number(it.next())], v.contains('-'))
    };
    let ((l, l_pre), (r, r_pre)) = (parts(left), parts(right));
    l.cmp(&r).then(r_pre.cmp(&l_pre))
}

/// `canReplaceDaemon`: explicit troubleshooting can replace the same release, while keeping
/// the update path's authenticated-version fence against downgrades and unknown builds.
pub(crate) fn can_replace_daemon(installed: Option<&str>, running: Option<&str>) -> bool {
    match (installed, running) {
        (Some(installed), Some(running)) => {
            comparable(installed) && comparable(running) && compare(installed, running) != Ordering::Less
        }
        _ => false,
    }
}

/// Resolves the currently selected OpenCode executable `(resolved_path, source, is_default_selection)`.
pub(crate) async fn selected_binary(app: &crate::App) -> (String, Option<&'static str>, bool) {
    if app.native.is_pinned()
        && let Some(pinned) = app.native.binary()
    {
        return (pinned, None, false);
    }
    let user = install::plan::user_prefix();
    match launch::custom_binary(&app.settings) {
        Some(path) => (path, None, false),
        None => {
            let (path, source) = install::plan::resolve_default().await;
            let path = match (source, &user) {
                (Some("user" | "managed"), Some(prefix)) => install::installed(prefix).binary,
                _ => path,
            };
            (launch::resolve(&path), source, true)
        }
    }
}

/// `readCurrentVersion`: probes `--version`, refusing quoted Windows paths and failed probes.
pub(crate) async fn read_current_version(binary: &str) -> Result<String, String> {
    if cfg!(windows) && binary.contains(['"', '\r', '\n']) {
        return Err("The configured OpenCode binary path is invalid".into());
    }
    let probe = parse_version(&run(binary, &["--version"]).await);
    if !probe.valid {
        return Err(probe.error.unwrap_or_else(|| "Unable to read OpenCode version".into()));
    }
    Ok(probe.version.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).unwrap_or_else(|| "unknown".into()))
}

/// `OpenCodeUpdateService.getStatus` as JSON.
pub(crate) async fn status_value(app: &Shared, force: bool) -> Value {
    let plan = install::plan::plan(force).await;
    let user = install::plan::user_prefix();
    let (binary, source, default_selection) = selected_binary(app).await;
    let probe = parse_version(&run(&binary, &["--version"]).await);
    let quoted = cfg!(windows) && binary.contains(['"', '\r', '\n']);
    let current = (probe.valid && !quoted).then(|| {
        probe.version.clone().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).unwrap_or("unknown".into())
    });
    let (missing, invalid) = if current.is_some() { (false, false) } else { (probe.missing, !probe.missing) };
    let prefix = plan.prefix.as_ref().or(user.as_ref());
    let latest = match prefix {
        Some(prefix) => install::latest(prefix).await.ok(),
        None => None,
    };
    let state = if invalid {
        "error"
    } else if missing {
        "missing"
    } else if current.as_deref().is_some_and(|c| !admission::below_minimum(c)) {
        "ready"
    } else {
        "update_required"
    };
    let update = match (&latest, &current) {
        (Some(latest), Some(current)) if comparable(current) => Some(compare(latest, current) == Ordering::Greater),
        (Some(_), None) => Some(true),
        _ => None,
    };
    let needs_shared = source == Some("user");
    let notice = if default_selection { install::plan::notice(&plan) } else { json!({}) };
    let replaceable_or_foreign = notice.get("foreignInstallation").and_then(|v| v["path"].as_str()) == Some(&binary)
        || notice.get("legacyReplacement").and_then(|v| v["path"].as_str()) == Some(&binary);
    let can_upgrade = default_selection
        && !launch::wsl(&binary)
        && (!invalid || replaceable_or_foreign)
        && plan.prefix.is_some()
        && (update == Some(true) || needs_shared)
        && latest.as_deref().is_some_and(|version| !admission::below_minimum(version));
    let mut status = json!({"currentVersion": current, "latestVersion": latest, "updateAvailable": update,
        "canUpgrade": can_upgrade, "minimumVersion": MINIMUM_VERSION, "recommendedVersion": RECOMMENDED_VERSION,
        "state": state, "binaryPath": binary, "needsSharedInstallation": needs_shared,
        "target": if launch::wsl(&binary) { "wsl" } else { "host" }, "canRestart": false});
    if let Some(legacy) = notice.get("legacyReplacement") {
        status["legacyReplacement"] = legacy.clone();
    }
    if let Some(foreign) = notice.get("foreignInstallation") {
        status["foreignInstallation"] = foreign.clone();
    }
    if let Some(source) = source {
        status["installationSource"] = json!(source);
    }
    if latest.is_none() {
        status["checkError"] = json!("update_check_failed");
    }
    if !missing && !invalid {
        let deadline = Instant::now() + daemon::TIMEOUT;
        match app.native.discover(&binary, deadline).await {
            Err(_) => {
                (status["serviceState"], status["serviceError"]) = (json!("error"), json!("service_check_failed"))
            }
            Ok(endpoint) => {
                let daemon_version = endpoint.as_ref().map(|e| e.version.clone());
                let older = endpoint.as_ref().is_some_and(|e| {
                    current.as_deref().is_some_and(|c| {
                        comparable(c) && comparable(&e.version) && compare(c, &e.version) == Ordering::Greater
                    })
                });
                if let Some(endpoint) = &endpoint {
                    status["daemonVersion"] = json!(endpoint.version);
                }
                status["serviceState"] = json!("stopped");
                if let Some(endpoint) = endpoint {
                    match admission::inspect(&app.native.client, &endpoint).await {
                        Ok(capabilities) => {
                            status["serviceState"] = json!(if older { "restart_available" } else { "ready" });
                            status["state"] = json!("ready");
                            status["canReload"] = json!(app.native.can_reload() && capabilities.reload);
                        }
                        Err(Refusal::Unsupported { reason, .. }) => {
                            status["incompatibilityReason"] = json!(reason);
                            status["serviceState"] = json!(if older { "restart_required" } else { "incompatible" });
                        }
                        Err(Refusal::Failed(_)) => {
                            (status["serviceState"], status["serviceError"]) =
                                (json!("error"), json!("service_check_failed"))
                        }
                    }
                }
                let service_state = status["serviceState"].as_str().unwrap_or("");
                status["canRestart"] = json!(
                    app.native.can_restart()
                        && state == "ready"
                        && matches!(service_state, "ready" | "restart_required" | "restart_available")
                        && can_replace_daemon(current.as_deref(), daemon_version.as_deref())
                );
            }
        }
    }
    let effective = status["daemonVersion"].as_str().or(current.as_deref()).map(str::to_owned);
    if status.get("incompatibilityReason").is_none() && effective.as_deref().is_some_and(admission::below_minimum) {
        status["incompatibilityReason"] = json!("native_contract");
    }
    status["versionAssessment"] = json!(if status.get("incompatibilityReason").is_some() {
        "incompatible"
    } else if effective.as_deref() == Some(RECOMMENDED_VERSION) {
        "tested"
    } else {
        "untested"
    });
    status
}

/// `GET /api/opencode/update`: an explicit recheck refreshes the installation plan's cached probes.
pub async fn status(State(app): State<Shared>, Query(query): Query<Vec<(String, String)>>) -> Json<Value> {
    let force = query.iter().filter(|(key, _)| key == "recheck").map(|(_, value)| value.as_str()).eq(["1"]);
    Json(status_value(&app, force).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ran(status: i32, stdout: &str, stderr: &str) -> Run {
        Run { status: Some(status), error: None, missing: false, stdout: stdout.into(), stderr: stderr.into() }
    }

    #[test]
    fn versions_parse_and_order_like_the_reference() {
        assert_eq!(parse_version(&ran(0, "\n opencode 2.3.2\n", "")).version.as_deref(), Some("2.3.2"));
        assert_eq!(parse_version(&ran(0, "", "v2.4.0+build.1")).version.as_deref(), Some("2.4.0+build.1"));
        assert_eq!(parse_version(&ran(0, "custom-label", "")).version.as_deref(), Some("custom-label"));
        assert!(parse_version(&ran(0, "", "")).valid && parse_version(&ran(0, "", "")).version.is_none());
        assert_eq!(parse_version(&ran(2, "", " boom ")).error.as_deref(), Some("Exited with code 2: boom"));
        assert_eq!(parse_version(&ran(1, "", "")).error.as_deref(), Some("Exited with code 1"));
        assert_eq!(compare("2.10.0", "2.9.9"), Ordering::Greater);
        assert_eq!(compare("0.0.0-beta-9", "0.0.0-beta-10"), Ordering::Less);
        assert_eq!(compare("2.3.2", "2.3.2"), Ordering::Equal);
        assert!(comparable("0.0.0-beta-3") && comparable("2.3.2") && !comparable("2.3.2+x") && !comparable("unknown"));
    }

    #[test]
    fn service_help_needs_the_namespace_and_its_commands() {
        let help = "opencode service\n\nCommands:\n  opencode service start  Start\n  opencode service status\n  get   password\n";
        assert!(service_help(help, ""));
        assert!(!service_help("opencode service\n\nCommands:\n  start\n  status\n", ""));
        assert!(!service_help("Commands:\n  start\n  status\n  get\n", ""));
        assert!(service_help("", "\x1b[1mopencode2 service\x1b[0m\r\nSUBCOMMANDS\r\n start\r\n status\r\n get\r\n"));
    }
}
