use crate::{
    backend::{Backend, read_json},
    files::EntryKind,
    history::{Result, valid_id},
};
use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Catalogue {
    Agents,
    Skills,
    Commands,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub id: String,
    pub name: String,
    pub description: String,
    pub primary: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectMatch {
    pub path: String,
    pub kind: EntryKind,
}

impl Backend {
    pub async fn prompt_directory(&self) -> Result<String> {
        if !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid prompt catalogue session".into());
        }
        let response = self
            .control_get(&format!("session/{}", self.session))
            .await?;
        let location = &response["data"]["location"];
        if response["data"]["id"] != self.session || location.get("workspaceID").is_some() {
            return Err("foreign prompt catalogue session".into());
        }
        location["directory"]
            .as_str()
            .filter(|path| crate::absolute_server_path(path))
            .map(str::to_owned)
            .ok_or_else(|| "invalid prompt catalogue directory".into())
    }

    pub async fn prompt_catalogue(&self, directory: &str, kind: Catalogue) -> Result<Vec<Named>> {
        if !valid_id(&self.workspace) || !crate::absolute_server_path(directory) {
            return Err("invalid prompt catalogue scope".into());
        }
        let route = match kind {
            Catalogue::Agents => "agent",
            Catalogue::Skills => "skill",
            Catalogue::Commands => "command",
        };
        let result = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/{route}",
                    self.base, self.workspace
                ))
                .query(&[("location[directory]", directory)])
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        if result["location"].get("workspaceID").is_some()
            || !result["location"]["directory"]
                .as_str()
                .is_some_and(|path| crate::same_server_path(path, directory))
        {
            return Err("foreign prompt catalogue".into());
        }
        decode(&result["data"], kind)
    }

    pub async fn prompt_files(&self, directory: &str, query: &str) -> Result<Vec<ProjectMatch>> {
        if !valid_id(&self.workspace)
            || !crate::absolute_server_path(directory)
            || query.len() > 4096
        {
            return Err("invalid prompt file scope".into());
        }
        let query = query.trim();
        if query.is_empty() {
            return Ok(self
                .files(directory, ".")
                .await?
                .into_iter()
                .map(|item| ProjectMatch {
                    kind: item.kind,
                    path: item.path,
                })
                .collect());
        }
        let result = read_json(
            self.client
                .get(format!(
                    "{}api/workspaces/{}/files/search",
                    self.base, self.workspace
                ))
                .query(&[("directory", directory), ("q", query), ("limit", "100")])
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        decode_files(&result, directory)
    }
}

fn string<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= limit)
        .ok_or_else(|| "invalid prompt catalogue field".into())
}
fn decode(rows: &Value, kind: Catalogue) -> Result<Vec<Named>> {
    let rows = rows
        .as_array()
        .filter(|rows| rows.len() <= 4096)
        .ok_or("invalid prompt catalogue")?;
    let mut seen = std::collections::HashSet::new();
    let mut output = Vec::with_capacity(rows.len());
    for item in rows {
        if matches!(kind, Catalogue::Agents) && item["hidden"] == true {
            continue;
        }
        let name = string(item, "name", 1024)?;
        let id = match kind {
            Catalogue::Agents | Catalogue::Commands => name,
            Catalogue::Skills => string(item, "id", 512)?,
        };
        if !seen.insert(id) {
            continue;
        }
        output.push(Named {
            id: id.into(),
            name: name.into(),
            description: item["description"]
                .as_str()
                .filter(|s| s.len() <= 4096)
                .unwrap_or_default()
                .into(),
            primary: matches!(kind, Catalogue::Agents)
                && matches!(item["mode"].as_str(), Some("primary" | "all")),
        });
    }
    Ok(output)
}

fn decode_files(rows: &Value, directory: &str) -> Result<Vec<ProjectMatch>> {
    let rows = rows
        .as_array()
        .filter(|rows| rows.len() <= 100)
        .ok_or("invalid prompt file results")?;
    let mut seen = std::collections::HashSet::new();
    rows.iter()
        .map(|row| {
            let path = string(row, "path", 4096)?;
            if path.contains('\0')
                || path
                    .split('/')
                    .any(|segment| matches!(segment, "" | "." | ".."))
                || !directory.starts_with('/')
                    && (path.contains('\\') || crate::absolute_server_path(path))
                || !seen.insert(path)
            {
                return Err("invalid prompt file path".into());
            }
            let kind = match row["type"].as_str() {
                Some("file") => EntryKind::File,
                Some("directory") => EntryKind::Directory,
                _ => return Err("invalid prompt file kind".into()),
            };
            Ok(ProjectMatch {
                path: path.into(),
                kind,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalogues_project_names_and_descriptions_without_hidden_agents_or_skill_content() {
        let rows = decode(
            &json!([
                {"name":"build","mode":"primary","request":{"key":"private"}},
                {"name":"hidden","mode":"all","hidden":true},
                {"name":"review","mode":"subagent","description":"Review changes"}
            ]),
            Catalogue::Agents,
        )
        .unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| (row.name.as_str(), row.primary))
                .collect::<Vec<_>>(),
            [("build", true), ("review", false)]
        );
        let skills = decode(
            &json!([{"id":"some/id","name":"visible","content":"private"}]),
            Catalogue::Skills,
        )
        .unwrap();
        assert_eq!(skills[0].name, "visible");
        assert!(!format!("{skills:?}").contains("private"));
    }

    #[test]
    fn search_rejects_traversal_and_preserves_reserved_path_characters() {
        let files = |path| decode_files(&json!([{"path":path,"type":"file"}]), "D:/project");
        for path in ["../escaped", "/rooted", "D:/rooted", "a//b", r"a\b"] {
            assert!(files(path).is_err(), "{path}");
        }
        assert_eq!(files("folder/é #%.txt").unwrap()[0].path, "folder/é #%.txt");
    }
}
