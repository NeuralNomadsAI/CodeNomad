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
    pub fn projects(&self) -> Result<Vec<Project>> {
        let data = read_json(
            self.client
                .get(format!("{}api/workspaces", self.base))
                .send()?
                .error_for_status()?,
        )?;
        data.as_array()
            .filter(|v| v.len() <= 128)
            .ok_or("invalid workspace inventory")?
            .iter()
            .map(project)
            .collect()
    }
    pub fn open_project(&self, path: &str) -> Result<Project> {
        if path.len() > 32768 || !std::path::Path::new(path).is_absolute() {
            return Err("absolute folder required".into());
        }
        // Reuse an already-open physical folder without creating another server occurrence.
        if let Some(found) = self
            .projects()?
            .into_iter()
            .find(|p| same_path(&p.path, path))
        {
            return Ok(found);
        }
        project(&read_json(
            self.client
                .post(format!("{}api/workspaces", self.base))
                .json(&json!({"path":path}))
                .send()?
                .error_for_status()?,
        )?)
    }
    pub fn sessions(&self, project: &Project, cursor: Option<&str>) -> Result<Sessions> {
        let request = self.client.get(format!(
            "{}workspaces/{}/instance/api/session",
            self.base, project.id
        ));
        let request = match cursor {
            Some(cursor) => request.query(&[("cursor", cursor)]),
            None => request.query(&[("directory", project.path.as_str()), ("limit", "200")]),
        };
        let data = read_json(request.send()?.error_for_status()?)?;
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
    pub fn create_session(&self, project: &Project, title: &str) -> Result<Session> {
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
                .send()?
                .error_for_status()?,
        )?;
        session(&data["data"], project)
    }
    pub fn bind(&self, project: &Project, id: &str, fresh: bool) -> Result<Self> {
        if !valid_id(id) || id.starts_with("ses_cn_schedule_") {
            return Err("invalid session".into());
        }
        let data = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{id}",
                    self.base, project.id
                ))
                .send()?
                .error_for_status()?,
        )?;
        session(&data["data"], project)?;
        let mut backend = self.clone();
        backend.workspace = project.id.clone();
        backend.session = id.into();
        backend.fresh_mode = fresh;
        backend.client_id = format!(
            "rune-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        );
        Ok(backend)
    }
}
fn project(data: &Value) -> Result<Project> {
    let id = data["id"]
        .as_str()
        .filter(|v| valid_id(v))
        .ok_or("invalid workspace id")?;
    let path = data["location"]["directory"]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 32768)
        .ok_or("invalid workspace location")?;
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
        .is_some_and(|p| same_path(p, &project.path))
        || !data["location"]["workspaceID"].is_null()
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
fn same_path(a: &str, b: &str) -> bool {
    let normalize = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalize(a) == normalize(b)
}
