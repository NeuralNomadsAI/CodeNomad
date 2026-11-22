//! Thin, bounded adapter for CodeNomad workspace and native session contracts.
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Project {
    pub id: String,
    pub path: String,
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
    pub async fn server_id(&self) -> Result<String> {
        server_id(
            &read_json(
                self.client
                    .get(format!("{}api/meta", self.base))
                    .send()
                    .await?
                    .error_for_status()?,
            )
            .await?,
        )
    }
    /// Creates an independent occurrence; the request retains cleanup ownership until released.
    pub async fn create_project(&self, path: &str, request_id: &str) -> Result<Project> {
        if !crate::server_path::absolute(path) {
            return Err("absolute folder required".into());
        }
        let request_id = claim(request_id)?;
        let data = read_json(
            self.client
                .post(format!("{}api/workspaces", self.base))
                .json(&json!({"path":path,"requestId":request_id}))
                .send()
                .await?
                .error_for_status()?,
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
        let request = self.client.get(format!(
            "{}workspaces/{}/instance/api/session",
            self.base, project.id
        ));
        let request = match cursor {
            Some(cursor) => request.query(&[("cursor", cursor)]),
            None => request.query(&[("directory", project.path.as_str()), ("limit", "200")]),
        };
        let data = read_json(request.send().await?.error_for_status()?).await?;
        let rows = data["data"]
            .as_array()
            .filter(|v| v.len() <= 200)
            .ok_or("invalid session list")?;
        let mut ids = std::collections::HashSet::new();
        let mut sessions = vec![];
        for row in rows {
            let item = session(row, project)?;
            if !ids.insert(item.id.clone()) {
                return Err("duplicate session".into());
            }
            if row["parentID"].is_null() && !item.id.starts_with("ses_cn_schedule_") {
                sessions.push(item);
            }
        }
        let next = match &data["cursor"]["next"] {
            Value::Null => None,
            Value::String(v) if !v.is_empty() && v.len() <= 65536 => Some(v.clone()),
            _ => return Err("invalid session cursor".into()),
        };
        Ok(Sessions {
            rows: sessions,
            next,
        })
    }
    pub async fn create_session(&self, project: &Project, title: &str) -> Result<Session> {
        if title.trim().is_empty() || title.len() > 512 {
            return Err("session title required".into());
        }
        let data = read_json(
            self.client
                .post(format!(
                    "{}workspaces/{}/instance/api/session",
                    self.base, project.id
                ))
                .json(&json!({"title":title.trim(),"location":{"directory":project.path}}))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        session(&data["data"], project)
    }
    pub async fn bind(&self, project: &Project, id: &str, fresh: bool) -> Result<Self> {
        Ok(self.bind_session(project, id, fresh).await?.0)
    }
    pub async fn bind_session(
        &self,
        project: &Project,
        id: &str,
        fresh: bool,
    ) -> Result<(Self, Session)> {
        if !valid_id(id) || id.starts_with("ses_cn_schedule_") {
            return Err("invalid session".into());
        }
        let data = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{id}",
                    self.base, project.id
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let info = session(&data["data"], project)?;
        if info.id != id {
            return Err("session response identity mismatch".into());
        }
        let mut backend = self.clone();
        backend.workspace = project.id.clone();
        backend.session = id.into();
        backend.fresh_mode = fresh;
        backend.client_id = crate::http::client_id()?;
        Ok((backend, info))
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
    })
}
fn session(data: &Value, project: &Project) -> Result<Session> {
    let id = data["id"]
        .as_str()
        .filter(|v| valid_id(v))
        .ok_or("invalid session id")?;
    if !data["location"]["directory"]
        .as_str()
        .is_some_and(|p| crate::server_path::same(p, &project.path))
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
}
