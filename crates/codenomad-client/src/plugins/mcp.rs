//! OpenCode V2 MCP server status and connect/disconnect actions.
use super::{
    ActionError, MAX_ITEMS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT, classify_action_error,
    route_unavailable,
};
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpState {
    Running,
    Stopped,
    Error(Option<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServer {
    pub name: String,
    pub status: McpState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpSnapshot {
    pub directory: String,
    pub servers: Vec<McpServer>,
}

pub async fn load_mcp(backend: &Backend, directory: Option<&str>) -> Result<Option<McpSnapshot>> {
    if !valid_id(&backend.workspace) {
        return Err("Invalid workspace identifier".into());
    }
    let resolved = if let Some(dir) = directory.or(backend.session_directory.as_deref()) {
        if !crate::absolute_server_path(dir) {
            return Err("Invalid MCP Location".into());
        }
        Some(dir.to_owned())
    } else if valid_id(&backend.session) {
        let dir = backend.prompt_directory().await?;
        if !crate::absolute_server_path(&dir) {
            return Err("Invalid MCP session Location".into());
        }
        Some(dir)
    } else {
        None
    };
    let mut request = backend
        .client
        .get(format!(
            "{}workspaces/{}/instance/api/mcp",
            backend.base, backend.workspace
        ))
        .timeout(REQUEST_TIMEOUT);
    if let Some(dir) = resolved.as_deref() {
        request = request.query(&[("location[directory]", dir)]);
    }
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    let Some(response) = route_unavailable(response).await? else {
        return Ok(None);
    };
    let value = read_json_limited(response, MAX_RESPONSE_BYTES).await?;
    Ok(Some(parse_mcp_snapshot(&value, resolved.as_deref())?))
}

pub async fn toggle_mcp(
    backend: &Backend,
    directory: &str,
    server: &str,
    connect: bool,
) -> std::result::Result<(), ActionError> {
    if !valid_id(&backend.workspace)
        || !crate::absolute_server_path(directory)
        || !valid_server_name(server)
    {
        return Err(ActionError::Failed);
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}workspaces/{}/instance/api/experimental/mcp",
        backend.base, backend.workspace
    ))
    .map_err(|_| ActionError::Failed)?;
    url.path_segments_mut()
        .map_err(|_| ActionError::Failed)?
        .extend([server, if connect { "connect" } else { "disconnect" }]);
    let response = backend
        .client
        .post(url)
        .query(&[("location[directory]", directory)])
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ActionError::Failed)?;
    if !response.status().is_success() {
        return Err(classify_action_error(response).await);
    }
    Ok(())
}

fn valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 256
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

pub(crate) fn parse_mcp_snapshot(value: &Value, requested: Option<&str>) -> Result<McpSnapshot> {
    let dir = value["location"]["directory"]
        .as_str()
        .filter(|p| crate::absolute_server_path(p))
        .ok_or("Invalid MCP Location")?;
    if let Some(req) = requested
        && !super::location_matches(req, dir)
    {
        return Err("MCP Location mismatch".into());
    }
    let Some(items) = value["data"].as_array() else {
        return Err("Invalid MCP server list".into());
    };
    if items.len() > MAX_ITEMS {
        return Err("Too many MCP servers".into());
    }
    let mut servers = Vec::with_capacity(items.len());
    for item in items {
        let name = item["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Missing MCP server name")?;
        let status = match item["status"]["status"].as_str() {
            Some("connected") => McpState::Running,
            Some("failed") => McpState::Error(
                item["status"]["error"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            ),
            Some(_) => McpState::Stopped,
            None => return Err("Missing MCP server status".into()),
        };
        servers.push(McpServer {
            name: name.to_owned(),
            status,
        });
    }
    Ok(McpSnapshot {
        directory: dir.to_owned(),
        servers,
    })
}
