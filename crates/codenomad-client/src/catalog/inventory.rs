use super::{Backend, Project, Result, Session, read_json, valid_id};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct Member {
    pub session: Session,
    pub directory: String,
    pub parent: Option<String>,
    pub updated: u64,
}

pub struct InventoryPage {
    pub members: Vec<Member>,
    pub next: Option<String>,
}

/// The project selector only discovers candidates; the caller projects local families.
pub enum InventoryScope<'a> {
    Directory(&'a str),
    NativeProject(&'a str),
    Continue(&'a str),
}

impl Backend {
    pub async fn native_project(&self, project: &Project) -> Result<Option<String>> {
        let location = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/location",
                    self.base, project.id
                ))
                .query(&[("location[directory]", &project.path)])
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let location = location.get("data").unwrap_or(&location);
        if !location["directory"]
            .as_str()
            .is_some_and(crate::absolute_server_path)
        {
            return Err("invalid native project location".into());
        }
        match &location["project"]["id"] {
            Value::Null => Ok(None),
            Value::String(id) if id == "global" => Ok(None),
            Value::String(id) if valid_id(id) => Ok(Some(id.clone())),
            _ => Err("invalid native project id".into()),
        }
    }

    pub async fn session_inventory(
        &self,
        project: &Project,
        scope: InventoryScope<'_>,
    ) -> Result<InventoryPage> {
        let request = self.client.get(format!(
            "{}workspaces/{}/instance/api/session",
            self.base, project.id
        ));
        let request = match scope {
            InventoryScope::Directory(dir) if crate::absolute_server_path(dir) => {
                request.query(&[("directory", dir), ("limit", "200"), ("order", "desc")])
            }
            InventoryScope::NativeProject(id) if valid_id(id) && id != "global" => {
                request.query(&[("project", id), ("limit", "200"), ("order", "desc")])
            }
            InventoryScope::Continue(cursor) if !cursor.is_empty() && cursor.len() <= 65536 => {
                request.query(&[("cursor", cursor)])
            }
            _ => return Err("invalid session inventory scope".into()),
        };
        let value = read_json(request.send().await?.error_for_status()?).await?;
        decode_page(&value)
    }
}

pub(super) fn decode_page(value: &Value) -> Result<InventoryPage> {
    let rows = value["data"]
        .as_array()
        .filter(|rows| rows.len() <= 200)
        .ok_or("invalid session inventory")?;
    let mut ids = HashSet::new();
    let mut members = Vec::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("invalid session id")?;
        if !ids.insert(id) {
            return Err("duplicate session".into());
        }
        let directory = row["location"]["directory"]
            .as_str()
            .filter(|d| crate::absolute_server_path(d))
            .ok_or("invalid session directory")?;
        if row["location"].get("workspaceID").is_some() {
            return Err("invalid session location".into());
        }
        let parent = match &row["parentID"] {
            Value::Null => None,
            Value::String(id) if valid_id(id) => Some(id.clone()),
            _ => return Err("invalid session parent".into()),
        };
        let title = row["title"].as_str().unwrap_or("");
        if title.len() > 4096 {
            return Err("oversized session title".into());
        }
        let updated = session_updated(row);
        members.push(Member {
            session: Session {
                id: id.into(),
                title: title.into(),
            },
            parent,
            directory: directory.into(),
            updated,
        });
    }
    let cursor = match &value["cursor"] {
        Value::Null => None,
        Value::Object(cursor) => cursor.get("next"),
        _ => return Err("invalid session cursor".into()),
    };
    let next = match cursor {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) if !v.is_empty() && v.len() <= 65536 => Some(v.clone()),
        _ => return Err("invalid session cursor".into()),
    };
    Ok(InventoryPage { members, next })
}

fn session_updated(row: &Value) -> u64 {
    let time = &row["time"];
    let num = |key| {
        time[key].as_u64().or_else(|| {
            time[key]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v as u64)
        })
    };
    num("updated")
        .into_iter()
        .chain(num("busy"))
        .chain(num("idle"))
        .chain(num("created"))
        .max()
        .unwrap_or(0)
}
