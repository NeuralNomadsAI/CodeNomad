//! Authority for one-time native plugin callbacks. Native effects only use
//! identities and content reconstructed from the current journal.
use super::{
    creation_admission::Scope,
    run::{bad, foreign, held, id, ordinary},
};
use crate::{App, Error, Shared};
use axum::http::{Method, StatusCode as Status};
use serde_json::{Value, json};

pub(super) fn find<'a>(value: &'a Value, list: &str, field: &str, id: &str) -> Option<&'a Value> {
    value[list].as_array()?.iter().find(|row| row[field] == id)
}

pub(super) fn dir(row: &Value) -> Result<&str, Error> {
    row["location"]["directory"].as_str().filter(|_| row["location"].get("workspaceID").is_none()).ok_or_else(foreign)
}

pub(super) async fn owner(app: &App, sid: &str) -> Result<(Scope, Value), Error> {
    if !id(sid, 240) || sid.starts_with("ses_cn_schedule_") {
        return Err(foreign());
    }
    let endpoint = app.native.endpoint().ok_or_else(held)?;
    let who = crate::opencode::session_record_at(app, &endpoint, sid).await?;
    let directory = dir(&who)?;
    let mut candidates = app.inner.lock().unwrap().workspaces.clone();
    // Distinct occurrences in this backend share one native connection and profile.
    candidates.sort_by_key(|w| w.location["directory"] != directory);
    for workspace in candidates {
        if let Ok(scope) = Scope::open(app, workspace, Some(directory)).await {
            if !std::sync::Arc::ptr_eq(&scope.endpoint, &endpoint)
                || who["projectID"] != scope.project
                || who["id"] != sid
            {
                return Err(foreign());
            }
            let fresh = session(app, &scope, sid).await?;
            if dir(&fresh)? != directory || fresh["parentID"] != who["parentID"] {
                return Err(foreign());
            }
            return Ok((scope, fresh));
        }
    }
    Err(foreign())
}

pub(super) async fn session(app: &App, scope: &Scope, sid: &str) -> Result<Value, Error> {
    if !id(sid, 240) {
        return Err(bad());
    }
    let (status, body) =
        scope.request(app, Method::GET, &format!("/api/session/{sid}"), &[], None, 10, 1024 * 1024).await?;
    if status == Status::NOT_FOUND && body["_tag"] == "SessionNotFoundError" && body["sessionID"] == sid {
        return Err(crate::error(Status::NOT_FOUND, "Mission session not found"));
    }
    let row = body.get("data").unwrap_or(&body);
    if !status.is_success() || row["id"] != sid || row["projectID"] != scope.project {
        return Err(foreign());
    }
    Ok(row.clone())
}

pub(super) async fn with_snapshot<T>(
    app: &App,
    scope: &Scope,
    project: impl FnOnce(Value) -> Result<T, Error>,
) -> Result<T, Error> {
    let slot = app.mission_read_slot.clone().acquire_owned().await.map_err(|_| held())?;
    let (status, mut body, slot) =
        scope.call_holding(app, "snapshot", &json!({}), 10, super::run::LARGE_MISSION_RPC_LIMIT, slot).await?;
    let Some(s) = body.as_object_mut().and_then(|o| o.remove("output")) else {
        drop(body);
        drop(slot);
        return Err(held());
    };
    drop(body);
    if !status.is_success()
        || s["projectID"] != scope.project
        || !s["missions"].is_array()
        || s["discardedEvents"] != 0
        || s["controlUnavailable"] == true
    {
        drop(s);
        drop(slot);
        return Err(held());
    }
    let projected = project(s);
    drop(slot);
    projected
}

pub(super) fn take_mission(mut s: Value, mid: &str, co: &Value) -> Result<Value, Error> {
    let missions = s.get_mut("missions").and_then(Value::as_array_mut).ok_or_else(foreign)?;
    let pos = missions.iter().position(|row| row["id"] == mid).ok_or_else(foreign)?;
    let m = missions.swap_remove(pos);
    drop(s);
    if !ordinary(&m)
        || m["coordinatorSessionId"] != co["id"]
        || m["projectID"] != co["projectID"]
        || !co["parentID"].is_null()
        || !recorded(&m, co)
    {
        return Err(foreign());
    }
    Ok(m)
}

pub(super) fn running(m: &Value) -> bool {
    ordinary(m)
        && m["controlUnavailable"] != true
        && m["status"] == "active"
        && (m["runState"].is_null() || m["runState"] == "running")
        && (m["document"].is_null() || m["document"]["state"] == "running")
        && (m["control"].is_null() || m["control"]["pending"].as_array().is_some_and(Vec::is_empty))
}

pub(super) fn mission<'a>(s: &'a Value, mid: &str, co: &Value) -> Result<&'a Value, Error> {
    let m = find(s, "missions", "id", mid).ok_or_else(foreign)?;
    if !ordinary(m)
        || m["coordinatorSessionId"] != co["id"]
        || m["projectID"] != co["projectID"]
        || !co["parentID"].is_null()
        || !recorded(m, co)
    {
        return Err(foreign());
    }
    Ok(m)
}

pub(super) fn recorded(m: &Value, row: &Value) -> bool {
    row["id"]
        .as_str()
        .and_then(|s| find(m, "actors", "sessionId", s))
        .is_some_and(|a| a["location"] == row["location"] && dir(row).is_ok())
}

pub(super) fn matches_execution(contract: &Value, row: &Value) -> bool {
    (contract["agent"].is_null() || contract["agent"] == row["agent"])
        && (contract["model"].is_null()
            || contract["model"]["id"] == row["model"]["id"]
                && contract["model"]["providerID"] == row["model"]["providerID"]
                && contract["model"]["variant"].as_str().unwrap_or("default")
                    == row["model"]["variant"].as_str().unwrap_or("default"))
}

pub(super) async fn current_root(app: &App, scope: &Scope, earlier: &Value) -> Result<Value, Error> {
    let row = session(app, scope, earlier["id"].as_str().ok_or_else(foreign)?).await?;
    if row["location"] != earlier["location"] || !row["parentID"].is_null() {
        return Err(foreign());
    }
    Ok(row)
}

pub(super) async fn send(app: &App, scope: &Scope, method: Method, path: &str, input: &Value) -> Result<Value, Error> {
    let (status, body) = scope.request(app, method, path, &[], Some(input), 15, 128 * 1024).await?;
    if !status.is_success() {
        return Err(held());
    }
    Ok(body)
}

pub(super) async fn sync_environment(app: &App, scope: &Scope, sid: &str) -> Result<(), Error> {
    if crate::opencode::launch::wsl(&scope.workspace.binary_id.to_string_lossy()) {
        // The local profile cannot supply a Linux base environment. Refuse
        // instead of overwriting the WSL session with a Windows snapshot.
        return Err(held());
    }
    let settings = app.settings.raw_config_owner("server").map_err(|_| held())?;
    let configured = settings.get("environmentVariables").map(|v| v.as_object().ok_or_else(held)).transpose()?;
    let mut variables = environment(crate::opencode::launch::daemon_environment(), configured, cfg!(windows))?;
    // A launcher may carry the daemon's credential under its own variable
    // name; the authenticated connection supplies the exact value to exclude.
    variables.retain(|_, value| value.as_str() != Some(scope.endpoint.password.as_str()));
    send(app, scope, Method::PUT, &format!("/api/session/{sid}/environment"), &json!({"variables":variables})).await?;
    Ok(())
}

/// Advisory Git availability context, scoped to the already-authorized native root session.
/// Mirrors `packages/server/src/workspaces/session-git-context.ts` and `git-requirement.ts`
/// within one 2 s budget.
pub(super) async fn sync_git_context(app: &Shared, scope: &Scope, row: &Value) {
    const KEY: &str = "codenomad.git-availability";
    const CONTEXT: &str = "CodeNomad cannot run Git from its backend process PATH. Git is a prerequisite for full functionality, but directory-only conversation access is tolerated so the user can consult you and ask for installation help. CodeNomad Git operations and worktree discovery, creation, removal and moves are unavailable. Session access is limited to the explicitly opened physical folder; other checkouts can be opened separately. The agent's execution host may differ from the CodeNomad backend (for example WSL or a remote connection): Git working in your shell does not prove it works in the backend. Help install Git for the backend account when requested. Windows supports per-user installation without administrator rights; on Linux/macOS choose an installation method appropriate to the user's permissions and existing tools. After changing the backend PATH, fully restart CodeNomad or its server process. Do not restart the shared OpenCode daemon just to refresh CodeNomad's PATH. This context reports a dependency limitation, not a request to interrupt the user's current task.";
    let Some(sid) = row["id"].as_str() else { return };
    let work = async {
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let available = match cmd.output().await {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Some(false),
            Ok(out)
                if out.status.success()
                    && std::str::from_utf8(&out.stdout).ok().is_some_and(is_git_version_output) =>
            {
                Some(true)
            }
            _ => None,
        };
        let Some(available) = available else {
            return;
        };
        if current_root(app, scope, row).await.is_err() {
            return;
        }
        let path = format!("/api/experimental/session/{sid}/instructions/entries/{KEY}");
        if available {
            let _ = scope.request(app, Method::DELETE, &path, &[], None, 2, 4096).await;
        } else {
            let platform = if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                std::env::consts::OS
            };
            let value = json!({
                "value": {
                    "backendPlatform": platform,
                    "gitAvailable": false,
                    "context": CONTEXT,
                }
            });
            let _ = scope.request(app, Method::PUT, &path, &[], Some(&value), 2, 4096).await;
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), work).await;
}

fn is_git_version_output(stdout: &str) -> bool {
    let trimmed = stdout.trim();
    trimmed.len() > 12
        && trimmed.is_char_boundary(12)
        && trimmed[..12].eq_ignore_ascii_case("git version ")
        && trimmed[12..].chars().next().is_some_and(|c| !c.is_whitespace())
}

/// Optional named instruction, pinned to the same root and connection as
/// admission. An uncertain optional put clears only its own entry.
pub(super) async fn sync_memory(app: &Shared, scope: &Scope, row: &Value) {
    let Some(sid) = row["id"].as_str() else { return };
    let work = async {
        let context = crate::memory::prepare_instruction(app, sid).await;
        if context["supported"] != true || current_root(app, scope, row).await.is_err() {
            return;
        }
        let path = format!("/api/experimental/session/{sid}/instructions/entries/codenomad.memory");
        if let Some(v) = context["value"].as_str() {
            let done = scope.request(app, Method::PUT, &path, &[], Some(&json!({"value":v})), 2, 4096).await;
            if done.is_ok_and(|(status, _)| status.is_success()) || current_root(app, scope, row).await.is_err() {
                return;
            }
        }
        let _ = scope.request(app, Method::DELETE, &path, &[], None, 2, 4096).await;
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), work).await;
}

fn environment(
    inherited: impl IntoIterator<Item = (String, String)>,
    configured: Option<&serde_json::Map<String, Value>>,
    windows: bool,
) -> Result<serde_json::Map<String, Value>, Error> {
    let private = |key: &str| {
        let name = key.to_ascii_uppercase();
        name.starts_with("CNRS_")
            || matches!(
                name.as_str(),
                "OPENCODE_PASSWORD"
                    | "OPENCODE_SERVER_PASSWORD"
                    | "CODENOMAD_SERVER_PASSWORD"
                    | "CODENOMAD_AUTOMATION_BRIDGE_TOKEN"
                    | "CODENOMAD_BOOTSTRAP_TOKEN"
                    | "OPENCODE_DB"
                    | "XDG_STATE_HOME"
                    | "OPENCODE_CONFIG_CONTENT"
            )
    };
    let valid = |key: &str, value: &str| !key.is_empty() && !key.contains(['=', '\0']) && !value.contains('\0');
    let mut vars = std::collections::BTreeMap::new();
    let index = |key: &str| if windows { key.to_uppercase() } else { key.to_owned() };
    for (key, value) in inherited {
        if !private(&key) && valid(&key, &value) {
            vars.insert(index(&key), (key, json!(value)));
        }
    }
    for (key, value) in configured.into_iter().flatten() {
        if private(key) {
            continue;
        }
        if !value.as_str().is_some_and(|value| valid(key, value)) {
            return Err(held());
        }
        vars.insert(index(key), (key.clone(), value.clone()));
    }
    Ok(vars.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn environment_applies_owned_overrides_and_drops_bridge_credentials() {
        let inherited =
            vec![("Path".to_owned(), "native".to_owned()), ("CNRS_FIXTURE_PASSWORD".into(), "private".into())];
        let configured = json!({"PATH":"configured","VISIBLE":"","opencode_password":"private"});
        assert_eq!(
            Value::Object(environment(inherited, configured.as_object(), true).unwrap()),
            json!({
                "PATH":"configured","VISIBLE":""
            })
        );
        assert!(environment([], json!({"FIELD":2}).as_object(), false).is_err());
    }
}
