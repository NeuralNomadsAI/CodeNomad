//! Location fences and credential projection for conversation quota reads.
use std::sync::Arc;

use axum::http::StatusCode as Status;
use serde_json::{Value, json};

use super::{
    Context, Provider, Query, Refusal, plans,
    shared::{Fields, text},
};
use crate::{App, Workspace, opencode::Endpoint, shared::js_trim};

pub(super) struct Owned<'a> {
    pub(super) app: &'a App,
    pub(super) query: &'a Query,
    pub(super) endpoint: Arc<Endpoint>,
    pub(super) workspace: Workspace,
    pub(super) directory: String,
}
impl Owned<'_> {
    fn current(&self) -> Result<(), Refusal> {
        if !self.app.native.endpoint().is_some_and(|e| Arc::ptr_eq(&e, &self.endpoint)) {
            return Err(Refusal::Unavailable);
        }
        if !self.app.workspace(&self.query.instance).is_ok_and(|w| {
            w.id == self.workspace.id && w.path == self.workspace.path && w.created_at == self.workspace.created_at
        }) {
            return Err(Refusal::Foreign);
        }
        Ok(())
    }
    pub(super) async fn native(&self, path: &str, location: bool) -> Result<Value, Refusal> {
        self.current()?;
        let mut url = self.endpoint.url.join(path).map_err(|_| Refusal::Unavailable)?;
        if location {
            url.query_pairs_mut().append_pair("location[directory]", &self.directory);
        }
        let response = self
            .app
            .native
            .client
            .get(url)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .send()
            .await
            .map_err(|_| Refusal::Unavailable)?;
        let status = response.status();
        let data = crate::opencode::read_json(response, 8 * 1024 * 1024).await.map_err(|_| Refusal::Unavailable)?;
        self.current()?;
        if status == Status::NOT_FOUND && data["_tag"] == "SessionNotFoundError" && path.starts_with("/api/session/") {
            return Err(Refusal::Session);
        }
        if status != Status::OK {
            return Err(Refusal::Unavailable);
        }
        Ok(data)
    }
    pub(super) async fn session(&self) -> Result<String, Refusal> {
        if matches!(self.query.session.as_str(), "." | "..") {
            return Err(Refusal::Unavailable);
        }
        let p = self.native(&format!("/api/session/{}", plans::encode(&self.query.session)), false).await?;
        let s = &p["data"];
        let directory = s["location"]["directory"].as_str().ok_or(Refusal::Unavailable)?;
        if s["id"] != self.query.session
            || s["location"].get("workspaceID").is_some()
            || !crate::worktrees::owns(self.app, &self.workspace, directory).await
        {
            return Err(Refusal::Foreign);
        }
        self.current()?;
        Ok(directory.to_owned())
    }
    pub(super) async fn credentials(&self) -> Result<Value, Refusal> {
        let p = self.native("/api/credential", false).await?;
        p["data"].as_array().map(|entries| project(entries)).ok_or(Refusal::Unavailable)
    }
    pub(super) async fn provider(&self, id: &str) -> Result<Value, Refusal> {
        self.binding("provider", id).await
    }
    pub(super) async fn binding(&self, kind: &str, id: &str) -> Result<Value, Refusal> {
        if matches!(id, "" | "." | "..") {
            return Err(Refusal::Unavailable);
        }
        let doc = self.native(&format!("/api/{kind}/{}", plans::encode(id)), true).await?;
        if doc["location"]["directory"] != self.directory
            || doc["location"].get("workspaceID").is_some()
            || doc["data"]["id"] != id
        {
            return Err(Refusal::Unavailable);
        }
        Ok(doc["data"].clone())
    }
}

pub(super) fn project(entries: &[Value]) -> Value {
    let mut auth = Fields::new();
    for e in entries {
        let v = &e["value"];
        let Some(id) = e["integrationID"].as_str() else { continue };
        if e["active"] != true || !matches!(v["type"].as_str(), Some("key" | "oauth")) {
            continue;
        }
        let metadata = &v["metadata"];
        let mut out = if v["type"] == "key" {
            if id == "opencode" && auth.get(id).is_some_and(|e| e["type"] == "oauth") {
                continue;
            }
            json!({"type":"api","key":v["key"]})
        } else {
            let mut out = json!({"type":"oauth"});
            for field in ["methodID", "access", "refresh", "expires"] {
                if let Some(v) = v.get(field) {
                    out[field] = v.clone();
                }
            }
            if let Some(account) = metadata["accountID"].as_str() {
                out["accountId"] = json!(account);
            }
            if id == "google" {
                if let Some(id) = e.get("id") {
                    out["credentialID"] = id.clone();
                }
                if let Some(meta) = v.get("metadata") {
                    out["metadata"] = meta.clone();
                }
            }
            if id == "github-copilot"
                && let Some(url) = metadata.get("enterpriseUrl")
            {
                out["enterpriseUrl"] = url.clone();
            }
            out
        };
        if let Some(org) = metadata["orgID"].as_str() {
            out["orgId"] = json!(org);
        }
        if let Some(server) = metadata.get("server").filter(|s| id == "opencode" || s.is_string()) {
            out["server"] = server.clone();
        }
        auth.insert(id.into(), out);
    }
    Value::Object(auth)
}

pub(super) fn settings(p: Option<&Value>, requested: &str, provider: &Provider) -> Context {
    let mut out = Context { status: if p.is_some() { "available" } else { "unavailable" }, ..Default::default() };
    if let Some(p) = p {
        if provider.id != "opencode-go" || p["id"] == "opencode-go" || p["canonical"] == "opencode-go" {
            out.integration = Some(p["integrationID"].as_str().unwrap_or(requested).to_owned());
        }
        let s = &p["settings"];
        if let Some(base) = s.get("baseURL") {
            out.base_url = Some(base.as_str().map(js_trim).unwrap_or("").into());
        }
        for field in ["baseURL", "apiKey"] {
            if let Some(raw) = s[field].as_str() {
                let lower = raw.to_ascii_lowercase();
                if lower.contains("{env:") || lower.contains("{file:") {
                    out.status = "unresolved";
                } else if field == "apiKey" {
                    out.api_key = text(&s[field]).map(str::to_owned);
                }
            }
        }
    }
    if provider.id == "kimi-for-coding" && out.integration.is_none() {
        out.integration = Some(requested.to_ascii_lowercase());
    }
    out
}
