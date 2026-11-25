use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::{Value, json};
use std::collections::HashSet;

use super::providers::{encode_location_header, label, route_unavailable, workspace_directory};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchProvider {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchConnection {
    Env { name: String },
    Credential { id: String, label: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchIntegration {
    pub id: String,
    pub name: String,
    pub supports_key: bool,
    pub connections: Vec<SearchConnection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Global => "settings.websearch.global",
            Self::Project => "settings.websearch.project",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Selection {
    Default,
    Off,
    Provider(String),
}

impl Selection {
    fn from_value(value: &Value) -> Result<Self> {
        if value.is_null() {
            Ok(Self::Default)
        } else if value.as_bool() == Some(false) {
            Ok(Self::Off)
        } else if let Some(provider) = label(value) {
            Ok(Self::Provider(provider))
        } else {
            Err("Invalid web search selection".into())
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Default => Value::Null,
            Self::Off => Value::Bool(false),
            Self::Provider(id) => Value::String(id.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeEntry {
    pub scope: Scope,
    pub path: String,
    pub selection: Selection,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefaultsSnapshot {
    pub effective: Selection,
    pub scopes: Vec<ScopeEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub directory: String,
    pub catalog_available: bool,
    pub providers: Vec<SearchProvider>,
    pub integrations: Vec<SearchIntegration>,
    /// `None` when the backend does not expose `/api/workspaces/:id/websearch-settings` (501 or missing route).
    pub defaults: Option<DefaultsSnapshot>,
}

pub async fn load(backend: &Backend, workspace: &str, session: Option<&str>) -> Result<Snapshot> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err("Invalid web search Location".into());
    }
    let requested = if let Some(session) = session {
        Some(super::session_directory(backend, workspace, session).await?)
    } else {
        None
    };
    let base = format!("{}workspaces/{workspace}/instance/api", backend.base);
    let fetch_native = |kind: &'static str, dir: Option<&str>| {
        let mut request = backend.client.get(format!("{base}/{kind}"));
        if let Some(dir) = dir {
            request = request.query(&[("location[directory]", dir)]);
        }
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        async move {
            let response = request.send().await?;
            let Some(response) = route_unavailable(response).await? else {
                return Ok(None);
            };
            Ok::<_, crate::history::Error>(Some(read_json_limited(response, 512 * 1024).await?))
        }
    };

    let (providers_json, integrations_json) = futures_lite::future::zip(
        fetch_native("websearch/provider", requested.as_deref()),
        fetch_native("integration", requested.as_deref()),
    )
    .await;
    let (providers_json, integrations_json) = (providers_json?, integrations_json?);

    let (directory, catalog_available, providers, integrations) =
        match (providers_json, integrations_json) {
            (Some(p_doc), Some(i_doc)) => {
                let p_dir = p_doc["location"]["directory"]
                    .as_str()
                    .filter(|path| crate::absolute_server_path(path))
                    .ok_or("Invalid web search Location")?;
                let i_dir = i_doc["location"]["directory"]
                    .as_str()
                    .filter(|path| crate::absolute_server_path(path))
                    .ok_or("Invalid web search Location")?;
                if !crate::same_server_path(p_dir, i_dir)
                    || requested
                        .as_deref()
                        .is_some_and(|req| !crate::same_server_path(req, p_dir))
                {
                    return Err("Web search Location changed".into());
                }
                let providers = parse_providers(&p_doc["data"])?;
                let integrations = parse_integrations(&i_doc["data"], &providers)?;
                (p_dir.to_owned(), true, providers, integrations)
            }
            _ => {
                let dir = match requested {
                    Some(dir) => dir,
                    None => workspace_directory(backend, workspace, None).await?,
                };
                (dir, false, Vec::new(), Vec::new())
            }
        };

    let defaults = read_defaults(backend, workspace, &directory).await?;
    Ok(Snapshot {
        directory,
        catalog_available,
        providers,
        integrations,
        defaults,
    })
}

async fn read_defaults(
    backend: &Backend,
    workspace: &str,
    directory: &str,
) -> Result<Option<DefaultsSnapshot>> {
    let request = backend
        .client
        .get(format!(
            "{}api/workspaces/{workspace}/websearch-settings",
            backend.base
        ))
        .query(&[("directory", directory)]);
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    let Some(response) = route_unavailable(response).await? else {
        return Ok(None);
    };
    let value = read_json_limited(response, 64 * 1024).await?;
    Ok(Some(parse_defaults(&value, directory)?))
}

pub async fn save_default(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    scope: Scope,
    provider: &Selection,
) -> Result<()> {
    if !valid_id(workspace) || !crate::absolute_server_path(directory) {
        return Err("Invalid web search settings request".into());
    }
    if let Selection::Provider(id) = provider
        && (id.is_empty() || id.chars().count() > 256 || id.chars().any(char::is_control))
    {
        return Err("Invalid web search provider".into());
    }
    backend
        .client
        .put(format!(
            "{}api/workspaces/{workspace}/websearch-settings",
            backend.base
        ))
        .json(&json!({
            "location": { "directory": directory },
            "scope": scope.as_str(),
            "provider": provider.to_value(),
        }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn connect_key(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    integration_id: &str,
    key: &str,
) -> Result<()> {
    let trimmed = key.trim();
    if !valid_id(workspace)
        || !crate::absolute_server_path(directory)
        || integration_id.is_empty()
        || integration_id.contains('/')
        || integration_id.chars().any(char::is_control)
        || trimmed.is_empty()
    {
        return Err("Invalid web search integration key request".into());
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}workspaces/{workspace}/instance/api/integration",
        backend.base
    ))?;
    url.path_segments_mut()
        .map_err(|_| "Invalid integration URL")?
        .extend([integration_id, "connect", "key"]);
    backend
        .client
        .post(url)
        .query(&[("location[directory]", directory)])
        .json(&json!({ "key": trimmed }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn remove_credential(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    credential_id: &str,
) -> Result<()> {
    if !valid_id(workspace)
        || !crate::absolute_server_path(directory)
        || credential_id.is_empty()
        || credential_id.contains('/')
        || credential_id.chars().any(char::is_control)
    {
        return Err("Invalid credential identifier".into());
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}workspaces/{workspace}/instance/api/credential",
        backend.base
    ))?;
    url.path_segments_mut()
        .map_err(|_| "Invalid credential URL")?
        .push(credential_id);
    backend
        .client
        .delete(url)
        .header("x-codenomad-location", encode_location_header(directory))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub(crate) fn parse_providers(value: &Value) -> Result<Vec<SearchProvider>> {
    let items = value
        .as_array()
        .filter(|rows| rows.len() <= 512)
        .ok_or("Invalid search providers")?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Some(id) = label(&item["id"]) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let name = label(&item["name"]).unwrap_or_else(|| id.clone());
        out.push(SearchProvider { id, name });
    }
    Ok(out)
}

pub(crate) fn parse_integrations(
    value: &Value,
    providers: &[SearchProvider],
) -> Result<Vec<SearchIntegration>> {
    let items = value
        .as_array()
        .filter(|rows| rows.len() <= 2048)
        .ok_or("Invalid integrations")?;
    let allowed: HashSet<&str> = providers.iter().map(|p| p.id.as_str()).collect();
    let mut out = Vec::new();
    for item in items {
        let Some(id) = label(&item["id"]) else {
            continue;
        };
        if !allowed.contains(id.as_str()) {
            continue;
        }
        let name = label(&item["name"]).unwrap_or_else(|| id.clone());
        let supports_key = item["methods"]
            .as_array()
            .is_some_and(|methods| methods.iter().any(|m| m["type"].as_str() == Some("key")));
        let mut connections = Vec::new();
        if let Some(entries) = item["connections"].as_array() {
            for entry in entries.iter().take(64) {
                match entry["type"].as_str() {
                    Some("env") => {
                        if let Some(env_name) = label(&entry["name"]) {
                            connections.push(SearchConnection::Env { name: env_name });
                        }
                    }
                    Some("credential") => {
                        if let (Some(cred_id), Some(cred_label)) =
                            (label(&entry["id"]), label(&entry["label"]))
                        {
                            connections.push(SearchConnection::Credential {
                                id: cred_id,
                                label: cred_label,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        out.push(SearchIntegration {
            id,
            name,
            supports_key,
            connections,
        });
    }
    Ok(out)
}

pub(crate) fn parse_defaults(value: &Value, expected_directory: &str) -> Result<DefaultsSnapshot> {
    let response_directory = value["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or("Invalid web search settings Location")?;
    if !crate::same_server_path(expected_directory, response_directory) {
        return Err("Web search settings Location changed".into());
    }
    let effective = Selection::from_value(&value["effective"])?;
    let raw_scopes = value["scopes"]
        .as_array()
        .filter(|rows| rows.len() <= 8)
        .ok_or("Invalid web search scopes")?;
    let mut scopes = Vec::with_capacity(raw_scopes.len());
    for entry in raw_scopes {
        let scope = match entry["scope"].as_str() {
            Some("global") => Scope::Global,
            Some("project") => Scope::Project,
            _ => return Err("Invalid web search scope".into()),
        };
        let path = entry["path"]
            .as_str()
            .filter(|p| !p.contains(char::is_control) && p.len() <= 4096)
            .unwrap_or_default()
            .to_owned();
        let selection = Selection::from_value(&entry["selection"])?;
        scopes.push(ScopeEntry {
            scope,
            path,
            selection,
        });
    }
    Ok(DefaultsSnapshot { effective, scopes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_search_integrations_and_filters_non_search() {
        let providers = parse_providers(&json!([
            {"id": "exa", "name": "Exa"},
            {"id": "tavily", "name": "Tavily"}
        ]))
        .unwrap();
        let integrations = parse_integrations(
            &json!([
                {
                    "id": "exa",
                    "name": "Exa",
                    "methods": [{"type": "key"}],
                    "connections": [
                        {"type": "env", "name": "EXA_API_KEY"},
                        {"type": "credential", "id": "cred-1", "label": "Saved key"}
                    ]
                },
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "methods": [{"type": "key"}],
                    "connections": []
                }
            ]),
            &providers,
        )
        .unwrap();
        assert_eq!(integrations.len(), 1);
        assert_eq!(integrations[0].id, "exa");
        assert!(integrations[0].supports_key);
        assert_eq!(integrations[0].connections.len(), 2);
    }

    #[test]
    fn parses_websearch_defaults_snapshot() {
        let doc = json!({
            "location": {"directory": "/repo"},
            "effective": "exa",
            "scopes": [
                {"scope": "global", "path": "/home/opencode.jsonc", "selection": "exa"},
                {"scope": "project", "path": "/repo/opencode.jsonc", "selection": null}
            ]
        });
        let snap = parse_defaults(&doc, "/repo").unwrap();
        assert_eq!(snap.effective, Selection::Provider("exa".into()));
        assert_eq!(snap.scopes.len(), 2);
        assert_eq!(snap.scopes[0].scope, Scope::Global);
        assert_eq!(snap.scopes[1].selection, Selection::Default);
        assert!(parse_defaults(&doc, "/other").is_err());
        assert_eq!(
            encode_location_header("/repo/worktree"),
            "%7B%22directory%22%3A%22%2Frepo%2Fworktree%22%7D"
        );
        assert!(super::super::providers::is_route_not_found_body(
            r#"{"message":"Not Found"}"#
        ));
        assert!(super::super::providers::is_route_not_found_body(
            r#"{"statusCode":404,"error":"Not Found","message":"Route GET:/api/workspaces/ws1/websearch-settings not found"}"#
        ));
        assert!(super::super::providers::is_route_not_found_body(
            "404 Not Found"
        ));
        assert!(!super::super::providers::is_route_not_found_body(
            r#"{"error":"Workspace not found"}"#
        ));
        assert!(!super::super::providers::is_route_not_found_body(
            r#"{"message":"Workspace not found"}"#
        ));
        assert!(!super::super::providers::is_route_not_found_body(""));
        assert_eq!(
            super::super::providers::provider_change(&json!({
                "type": "instance.event",
                "instanceId": "ws1",
                "event": {"type": "session.moved", "data": {"sessionID": "ses-1"}}
            })),
            Some("ws1")
        );
    }
}
