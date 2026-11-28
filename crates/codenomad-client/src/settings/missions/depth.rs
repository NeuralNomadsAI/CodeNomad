//! Location-scoped Subagent depth HTTP contract (`/api/workspaces/{id}/subagent-depth`).
use crate::{
    backend::{Backend, read_json},
    history::valid_id,
};
use reqwest::StatusCode;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthCapability {
    pub minimum: u64,
    pub maximum: Option<u64>,
    pub default: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthProject {
    pub path: String,
    pub depth: Option<u64>,
    pub expectation: String,
    pub nesting_skipped: bool,
    pub empty_experimental: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthNesting {
    pub effect: String,
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentDepthSnapshot {
    pub directory: String,
    pub capability: Option<SubagentDepthCapability>,
    pub effective_depth: Option<u64>,
    pub nesting: Option<SubagentDepthNesting>,
    pub origin: Option<String>,
    pub project: Option<SubagentDepthProject>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentDepthError {
    Unsupported,
    Conflict,
    Failed,
}

fn valid_expectation(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub async fn resolve_workspace_directory(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> std::result::Result<String, SubagentDepthError> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err(SubagentDepthError::Failed);
    }
    if let Some(session) = session {
        return super::super::session_directory(backend, workspace, session)
            .await
            .map_err(|_| SubagentDepthError::Failed);
    }
    let projects = backend
        .projects()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    projects
        .into_iter()
        .find(|project| project.id == workspace)
        .map(|project| project.path)
        .ok_or(SubagentDepthError::Failed)
}

pub async fn read_subagent_depth(
    backend: &Backend,
    workspace: &str,
    directory: &str,
) -> std::result::Result<SubagentDepthSnapshot, SubagentDepthError> {
    if !valid_id(workspace) || !crate::absolute_server_path(directory) {
        return Err(SubagentDepthError::Failed);
    }
    let response = backend
        .client
        .get(format!(
            "{}api/workspaces/{workspace}/subagent-depth",
            backend.base
        ))
        .query(&[("directory", directory)])
        .send()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    match response.status() {
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => {
            return Err(SubagentDepthError::Unsupported);
        }
        status if !status.is_success() => return Err(SubagentDepthError::Failed),
        _ => {}
    }
    let value = read_json(response)
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    let snapshot = parse_subagent_depth(&value).ok_or(SubagentDepthError::Failed)?;
    if !crate::same_server_path(&snapshot.directory, directory) {
        return Err(SubagentDepthError::Failed);
    }
    Ok(snapshot)
}

pub async fn set_subagent_depth(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    depth: Option<u64>,
    expectation: &str,
) -> std::result::Result<(), SubagentDepthError> {
    set_subagent_depth_checked(backend, workspace, directory, depth, expectation, || true).await
}

pub async fn set_subagent_depth_checked(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    depth: Option<u64>,
    expectation: &str,
    can_send: impl FnOnce() -> bool,
) -> std::result::Result<(), SubagentDepthError> {
    if !valid_id(workspace)
        || !crate::absolute_server_path(directory)
        || !valid_expectation(expectation)
    {
        return Err(SubagentDepthError::Failed);
    }
    let request = backend
        .client
        .put(format!(
            "{}api/workspaces/{workspace}/subagent-depth",
            backend.base
        ))
        .json(&json!({
            "location": { "directory": directory },
            "depth": depth,
            "expectation": expectation,
        }));
    if !can_send() {
        return Err(SubagentDepthError::Failed);
    }
    let response = request
        .send()
        .await
        .map_err(|_| SubagentDepthError::Failed)?;
    match response.status() {
        StatusCode::NO_CONTENT => Ok(()),
        StatusCode::CONFLICT => Err(SubagentDepthError::Conflict),
        StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED => Err(SubagentDepthError::Unsupported),
        _ => Err(SubagentDepthError::Failed),
    }
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn parse_safe_u64(value: &Value, min: u64) -> Option<u64> {
    value
        .as_u64()
        .filter(|&n| n >= min && n <= MAX_SAFE_INTEGER)
}

fn parse_subagent_depth(value: &Value) -> Option<SubagentDepthSnapshot> {
    let map = value.as_object()?;
    let location = map.get("location")?;
    if location.get("workspaceID").is_some() {
        return None;
    }
    let directory = location.get("directory")?.as_str()?.to_owned();
    if !crate::absolute_server_path(&directory) {
        return None;
    }
    let capability = match map.get("capability")? {
        Value::Null => None,
        Value::Object(cap) => {
            let minimum = parse_safe_u64(cap.get("minimum")?, 0)?;
            let maximum = match cap.get("maximum") {
                None | Some(Value::Null) => None,
                Some(v) => Some(parse_safe_u64(v, minimum)?),
            };
            let default = match cap.get("default") {
                None | Some(Value::Null) => None,
                Some(v) => Some(parse_safe_u64(v, 0)?),
            };
            Some(SubagentDepthCapability {
                minimum,
                maximum,
                default,
            })
        }
        _ => return None,
    };
    let effective_depth = match map.get("effectiveDepth") {
        None | Some(Value::Null) => None,
        Some(v) => Some(parse_safe_u64(v, 0)?),
    };
    let nesting = match map.get("nesting") {
        None | Some(Value::Null) => None,
        Some(Value::Object(n)) => Some(SubagentDepthNesting {
            effect: n.get("effect")?.as_str()?.to_owned(),
            hidden: n.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => return None,
    };
    let origin = match map.get("origin") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str()?.to_owned()),
    };
    let project = match map.get("project")? {
        Value::Null => None,
        Value::Object(p) => {
            let expectation = p.get("expectation")?.as_str()?;
            if !valid_expectation(expectation) {
                return None;
            }
            Some(SubagentDepthProject {
                path: p.get("path")?.as_str()?.to_owned(),
                depth: match p.get("depth") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(parse_safe_u64(v, 0)?),
                },
                expectation: expectation.to_owned(),
                nesting_skipped: p
                    .get("nestingSkipped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                empty_experimental: p
                    .get("emptyExperimental")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        }
        _ => return None,
    };
    Some(SubagentDepthSnapshot {
        directory,
        capability,
        effective_depth,
        nesting,
        origin,
        project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_depth_rejects_invalid_location_bounds_and_bad_expectation() {
        let valid = json!({
            "location": {"directory": "/repo"},
            "capability": {"minimum": 0, "maximum": 10, "default": 2},
            "effectiveDepth": 3,
            "nesting": {"effect": "allow", "hidden": false},
            "origin": "/repo/opencode.jsonc",
            "project": {
                "path": "/repo/opencode.jsonc",
                "depth": 3,
                "expectation": "a".repeat(64),
                "nestingSkipped": true,
                "emptyExperimental": false
            }
        });
        assert!(parse_subagent_depth(&valid).is_some());
        let mut relative = valid.clone();
        relative["location"]["directory"] = json!("relative/path");
        assert!(parse_subagent_depth(&relative).is_none());
        let mut with_ws = valid.clone();
        with_ws["location"]["workspaceID"] = json!("foreign");
        assert!(parse_subagent_depth(&with_ws).is_none());
        let mut inverted = valid.clone();
        inverted["capability"] = json!({"minimum": 2, "maximum": 1});
        assert!(parse_subagent_depth(&inverted).is_none());
        let mut bad_etag = valid.clone();
        bad_etag["project"]["expectation"] = json!("not-hex");
        assert!(parse_subagent_depth(&bad_etag).is_none());
    }
}
