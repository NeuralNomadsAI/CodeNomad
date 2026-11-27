//! Thin, bounded adapter for CodeNomad workspace and native session contracts.
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use futures_lite::StreamExt;
use serde_json::{Value, json};

mod binding;
mod inventory;
pub use inventory::{InventoryPage, InventoryScope, Member};

#[derive(Debug)]
pub struct CreationRefused;
impl std::fmt::Display for CreationRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("workspace creation refused before publication")
    }
}
impl std::error::Error for CreationRefused {}

#[derive(Debug)]
pub struct SessionMissing;
impl std::fmt::Display for SessionMissing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("native session is no longer available in the workspace")
    }
}
impl std::error::Error for SessionMissing {}

#[derive(Debug)]
pub struct LocationUnavailable;
impl std::fmt::Display for LocationUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("worktree location does not belong to workspace")
    }
}
impl std::error::Error for LocationUnavailable {}

#[derive(Debug)]
pub struct CreateRejected;
impl std::fmt::Display for CreateRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("session creation rejected before admission")
    }
}
impl std::error::Error for CreateRejected {}

async fn creation_response(response: reqwest::Response) -> Result<Value> {
    if response.status() != reqwest::StatusCode::BAD_REQUEST {
        return read_json(response.error_for_status()?).await;
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 512 {
            return Err("workspace creation rejection unavailable".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let message = std::str::from_utf8(&bytes)?;
    // These terminal validations precede record publication in the shared servers.
    if matches!(
        message,
        "Workspace directory is not authorized"
            | "OpenCode location is unavailable"
            | "Workspace folder changed during opening"
            | "Too many open workspaces"
            | "Too many workspace creations are already in progress"
            | "Workspace directory is being removed"
            | "Workspace manager is shutting down"
    ) {
        return Err(CreationRefused.into());
    }
    Err("workspace creation rejected with uncertain ownership".into())
}

#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub temporary: bool,
}
#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub title: String,
}
pub struct Sessions {
    pub rows: Vec<Session>,
    pub next: Option<String>,
}

impl Backend {
    async fn probe_server_meta(&self) -> Result<(String, Vec<String>, bool, u64, u64, u64)> {
        let (generation, seq, drop_epoch) = self.client.begin_meta_probe();
        let request = self
            .client
            .get(format!("{}api/meta", self.base))
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        let response = request.send().await?;
        let status = response.status();
        let response = match response.error_for_status() {
            Ok(response) => response,
            Err(err) => {
                if self.client.server_identity().is_some()
                    && !status.is_server_error()
                    && status != reqwest::StatusCode::REQUEST_TIMEOUT
                    && status != reqwest::StatusCode::TOO_MANY_REQUESTS
                {
                    self.client.revoke_server_attestation_at(generation, seq);
                }
                return Err(err.into());
            }
        };
        let meta = match read_json(response).await {
            Ok(meta) => meta,
            Err(err) => {
                if self.client.server_identity().is_some() {
                    self.client.revoke_server_attestation_at(generation, seq);
                }
                return Err(err);
            }
        };
        let id = match server_id(&meta) {
            Ok(id) => id,
            Err(err) => {
                if self.client.server_identity().is_some() {
                    self.client.revoke_server_attestation_at(generation, seq);
                }
                return Err(err);
            }
        };
        if self
            .client
            .server_identity()
            .is_some_and(|current| current != id)
        {
            self.client.record_server_identity_mismatch(generation, seq);
            return Ok((id, Vec::new(), false, generation, seq, drop_epoch));
        }
        let capabilities: Vec<String> = meta["capabilities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let same_gen = self.client.drop_generation() == generation;
        if same_gen {
            self.client.observe_capabilities_at(
                generation,
                seq,
                capabilities.iter().any(|cap| cap == "service-usage"),
                capabilities
                    .iter()
                    .any(|cap| cap == "settings-atomic-patches"),
            );
        }
        Ok((id, capabilities, same_gen, generation, seq, drop_epoch))
    }

    pub async fn server_id(&self) -> Result<String> {
        self.probe_server_meta().await.map(|(id, _, _, _, _, _)| id)
    }

    pub async fn attest_server(&self) -> Result<String> {
        self.client.require_attestation();
        let (id, capabilities, same_gen, generation, seq, drop_epoch) =
            self.probe_server_meta().await?;
        if self
            .client
            .server_identity()
            .is_some_and(|current| current != id)
        {
            return Err("Server identity changed".into());
        }
        if !same_gen {
            return Err("Transport changed during server attestation".into());
        }
        if self
            .client
            .verify_server_identity_at(&id, capabilities, generation, seq)
        {
            self.client.mark_drop_epoch_attested(drop_epoch);
            Ok(id)
        } else {
            Err("Server identity changed".into())
        }
    }
    /// Creates an independent occurrence; the request retains cleanup ownership until released.
    pub async fn create_project(&self, path: &str, request_id: &str) -> Result<Project> {
        if !crate::server_path::absolute(path) {
            return Err(CreationRefused.into());
        }
        let request_id = claim(request_id)?;
        let data = creation_response(
            self.client
                .post(format!("{}api/workspaces", self.base))
                .json(&json!({"path":path,"requestId":request_id}))
                .send()
                .await?,
        )
        .await?;
        if data["requestId"].as_str() != Some(request_id) {
            return Err("workspace creation claim mismatch".into());
        }
        project(&data)
    }
    pub async fn cancel_project_creation(&self, request_id: &str) -> Result<()> {
        let request_id = claim(request_id)?;
        no_content(
            self.client
                .post(format!("{}api/workspaces/creation/cancel", self.base))
                .json(&json!({"requestId":request_id}))
                .send()
                .await?,
        )
    }
    pub async fn release_project_creation(
        &self,
        workspace_id: &str,
        request_id: &str,
    ) -> Result<()> {
        if !valid_id(workspace_id) {
            return Err("invalid workspace id".into());
        }
        let request_id = claim(request_id)?;
        no_content(
            self.client
                .post(format!(
                    "{}api/workspaces/{workspace_id}/creation/release",
                    self.base
                ))
                .json(&json!({"requestId":request_id}))
                .send()
                .await?,
        )
    }
    /// Removes only the logical record; ordinary DELETE retains its physical folder.
    pub async fn release_project(&self, workspace_id: &str) -> Result<()> {
        if !valid_id(workspace_id) {
            return Err("invalid workspace id".into());
        }
        no_content(
            self.client
                .delete(format!("{}api/workspaces/{workspace_id}", self.base))
                .send()
                .await?,
        )
    }
    pub async fn projects(&self) -> Result<Vec<Project>> {
        let data = read_json(
            self.client
                .get(format!("{}api/workspaces", self.base))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        data.as_array()
            .filter(|v| v.len() <= 128)
            .ok_or("invalid workspace inventory")?
            .iter()
            .map(project)
            .collect()
    }
    pub async fn open_project(&self, path: &str) -> Result<Project> {
        if !crate::server_path::absolute(path) {
            return Err("absolute folder required".into());
        }
        // Reuse an already-open physical folder without creating another server occurrence.
        if let Some(found) = self
            .projects()
            .await?
            .into_iter()
            .find(|p| crate::server_path::same(&p.path, path))
        {
            return Ok(found);
        }
        project(
            &read_json(
                self.client
                    .post(format!("{}api/workspaces", self.base))
                    .json(&json!({"path":path}))
                    .send()
                    .await?
                    .error_for_status()?,
            )
            .await?,
        )
    }
    pub async fn sessions(&self, project: &Project, cursor: Option<&str>) -> Result<Sessions> {
        self.session_page(project, &project.path, None, cursor)
            .await
    }
    pub async fn linked_session_directories(&self, project: &Project) -> Result<Vec<String>> {
        Ok(self
            .session_directories(project)
            .await?
            .into_iter()
            .skip(1)
            .collect())
    }
    pub async fn linked_session_page(
        &self,
        project: &Project,
        directory: &str,
        cursor: Option<&str>,
    ) -> Result<Sessions> {
        self.session_page(project, directory, None, cursor).await
    }
    pub async fn workspace_missing(&self, id: &str) -> Result<bool> {
        Ok(self
            .projects()
            .await?
            .into_iter()
            .all(|workspace| workspace.id != id))
    }
    async fn session_page(
        &self,
        project: &Project,
        directory: &str,
        search: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Sessions> {
        let request = self.client.get(format!(
            "{}workspaces/{}/instance/api/session",
            self.base, project.id
        ));
        let request = request.query(&[("directory", directory)]);
        let request = match cursor {
            Some(cursor) => request.query(&[("cursor", cursor)]),
            None => {
                let request = request.query(&[("limit", "200")]);
                match search {
                    Some(search) => request.query(&[("search", search)]),
                    None => request,
                }
            }
        };
        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(LocationUnavailable.into());
        }
        let data = read_json(response.error_for_status()?).await?;
        let page = inventory::decode_page(&data)?;
        let mut sessions = vec![];
        for member in page.members {
            if !crate::server_path::same(&member.directory, directory) {
                return Err("foreign session location".into());
            }
            if member.parent.is_none() && !member.session.id.starts_with("ses_cn_schedule_") {
                sessions.push(member.session);
            }
        }
        Ok(Sessions {
            rows: sessions,
            next: page.next,
        })
    }
    async fn session_directories(&self, project: &Project) -> Result<Vec<String>> {
        let data = read_json(
            self.client
                .get(format!(
                    "{}api/workspaces/{}/worktrees",
                    self.base, project.id
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let trees = data["worktrees"]
            .as_array()
            .filter(|trees| trees.len() <= 128)
            .ok_or("invalid worktree inventory")?;
        let mut directories = vec![project.path.clone()];
        for tree in trees {
            if tree["nestedFolderMissing"].as_bool() == Some(true) {
                continue;
            }
            let directory = tree["serviceDirectory"]
                .as_str()
                .or_else(|| tree["directory"].as_str())
                .filter(|d| crate::server_path::absolute(d))
                .ok_or("invalid worktree directory")?;
            if !directories
                .iter()
                .any(|d| crate::server_path::same(d, directory))
            {
                directories.push(directory.into());
            }
        }
        Ok(directories)
    }
    pub async fn search_sessions(&self, project: &Project, query: &str) -> Result<Vec<Session>> {
        use std::collections::HashSet;
        if query.is_empty() || query.len() > 4096 {
            return Err("invalid session search query".into());
        }
        let mut matches = Vec::new();
        let mut ids = HashSet::new();
        for directory in self.session_directories(project).await? {
            let mut cursor = None;
            let mut cursors = HashSet::new();
            loop {
                let page = self
                    .session_page(project, &directory, Some(query), cursor.as_deref())
                    .await?;
                matches.extend(page.rows.into_iter().filter(|r| ids.insert(r.id.clone())));
                if matches.len() > 2000 {
                    return Err("session search result limit reached".into());
                }
                let Some(next) = page.next else { break };
                if cursors.len() >= 10 || !cursors.insert(next.clone()) {
                    return Err("invalid or excessive session search cursors".into());
                }
                cursor = Some(next);
            }
        }
        Ok(matches)
    }
    pub async fn create_session(&self, project: &Project, title: &str) -> Result<Session> {
        if title.trim().is_empty() || title.len() > 512 {
            return Err("session title required".into());
        }
        let response = self
            .client
            .post(format!(
                "{}workspaces/{}/instance/api/session",
                self.base, project.id
            ))
            .json(&json!({"title":title.trim(),"location":{"directory":project.path}}))
            .send()
            .await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err(CreateRejected.into());
        }
        let data = read_json(response.error_for_status()?).await?;
        session(&data["data"], project)
    }
    pub async fn create_untitled_session(
        &self,
        project: &Project,
        directory: &str,
    ) -> Result<Session> {
        let same_root = crate::server_path::same(&project.path, directory);
        let location = if same_root {
            project.path.as_str()
        } else {
            directory
        };
        let mut request = self.client.post(format!(
            "{}workspaces/{}/instance/api/session",
            self.base, project.id
        ));
        if !same_root {
            request = request.query(&[("directory", location)]);
        }
        let response = request
            .json(&json!({"location":{"directory":location}}))
            .send()
            .await?;
        if matches!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::FORBIDDEN
        ) {
            return Err(CreateRejected.into());
        }
        let data = read_json(response.error_for_status()?).await?;
        session_at(&data["data"], location)
    }
}
fn server_id(data: &Value) -> Result<String> {
    let id = data["serverId"].as_str().ok_or("invalid server identity")?;
    if data["apiContract"].as_u64() != Some(1)
        || id.trim().is_empty()
        || id.encode_utf16().count() > 512
        || id.chars().any(char::is_control)
    {
        return Err("invalid server identity".into());
    }
    Ok(id.to_owned())
}
fn claim(request_id: &str) -> Result<&str> {
    let request_id = request_id.trim();
    if request_id.is_empty() || request_id.encode_utf16().count() > 128 {
        return Err("invalid workspace creation request".into());
    }
    Ok(request_id)
}
fn no_content(response: reqwest::Response) -> Result<()> {
    let response = response.error_for_status()?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("invalid workspace release acknowledgement".into());
    }
    Ok(())
}
fn project(data: &Value) -> Result<Project> {
    let id = data["id"]
        .as_str()
        .filter(|v| valid_id(v))
        .ok_or("invalid workspace id")?;
    let path = data["location"]["directory"]
        .as_str()
        .filter(|v| crate::server_path::absolute(v))
        .ok_or("invalid workspace location")?;
    if data["location"].get("workspaceID").is_some() {
        return Err("foreign workspace location".into());
    }
    Ok(Project {
        id: id.into(),
        path: path.into(),
        temporary: data["temporary"].as_bool().unwrap_or(false),
    })
}
fn session(data: &Value, project: &Project) -> Result<Session> {
    session_at(data, &project.path)
}
fn session_at(data: &Value, directory: &str) -> Result<Session> {
    let id = data["id"]
        .as_str()
        .filter(|v| valid_id(v))
        .ok_or("invalid session id")?;
    if !data["location"]["directory"]
        .as_str()
        .is_some_and(|p| crate::server_path::same(p, directory))
        || data["location"].get("workspaceID").is_some()
    {
        return Err("foreign session location".into());
    }
    let title = data["title"].as_str().unwrap_or("");
    if title.len() > 4096 {
        return Err("oversized session title".into());
    }
    Ok(Session {
        id: id.into(),
        title: title.into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_admits_windows_and_posix_locations_without_client_os_assumptions() {
        for path in [r"D:\Project", r"\\Server\Share\Project", "/Project"] {
            let project =
                project(&json!({"id":"workspace", "location":{"directory":path}})).unwrap();
            assert!(
                session(
                    &json!({"id":"session", "location":{"directory":path}}),
                    &project
                )
                .is_ok()
            );
        }
        let project = Project {
            id: "workspace".into(),
            path: r"D:\Project".into(),
            temporary: false,
        };
        assert!(
            session(
                &json!({"id":"session", "location":{"directory":"d:/PROJECT/"}}),
                &project
            )
            .is_ok()
        );
    }
    #[test]
    fn foreign_locations_and_native_workspace_scopes_are_rejected() {
        let project = Project {
            id: "workspace".into(),
            path: "/Project".into(),
            temporary: false,
        };
        for path in [
            "/project",
            "/Project/nested",
            "/other",
            r"C:\Project",
            "relative",
        ] {
            assert!(
                session(
                    &json!({"id":"session", "location":{"directory":path}}),
                    &project
                )
                .is_err()
            );
        }
        for workspace in [json!("foreign"), Value::Null] {
            let location = json!({"directory":"/Project", "workspaceID":workspace});
            assert!(session(&json!({"id":"session", "location":location}), &project).is_err());
            assert!(super::project(&json!({"id":"workspace", "location":location})).is_err());
        }
        assert!(
            super::project(&json!({"id":"workspace", "location":{"directory":"relative"}}))
                .is_err()
        );
    }

    #[test]
    fn project_decodes_temporary_flag_with_false_default() {
        let temp = project(&json!({
            "id": "ws-temp",
            "location": {"directory": "/tmp/ws"},
            "temporary": true
        }))
        .unwrap();
        assert!(temp.temporary);
        let normal = project(&json!({
            "id": "ws-normal",
            "location": {"directory": "/tmp/ws"}
        }))
        .unwrap();
        assert!(!normal.temporary);
        let malformed = project(&json!({
            "id": "ws-bad",
            "location": {"directory": "/tmp/ws"},
            "temporary": "yes"
        }))
        .unwrap();
        assert!(!malformed.temporary);
    }
}
