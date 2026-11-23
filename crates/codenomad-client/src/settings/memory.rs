use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

pub fn timestamp(value: &str) -> Option<i64> {
    let time =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    (time.unix_timestamp_nanos() / 1_000_000).try_into().ok()
}

pub fn valid_title(title: &str) -> bool {
    title.chars().count() <= 60
        && title.chars().any(|c| {
            !matches!(c,
            '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        })
        && !title
            .chars()
            .any(|c| matches!(c, '\0'..='\u{1f}' | '\u{7f}'))
}

pub async fn enabled(backend: &Backend) -> Result<bool> {
    let url = format!("{}api/memory/settings", backend.base);
    let response = backend
        .client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    decode(read_json_limited(response, 4096).await?)
}

pub async fn set_enabled(backend: &Backend, enabled: bool) -> Result<bool> {
    let url = format!("{}api/memory/settings", backend.base);
    let response = backend
        .client
        .put(url)
        .timeout(Duration::from_secs(40))
        .json(&json!({"enabled":enabled}))
        .send()
        .await?
        .error_for_status()?;
    decode(read_json_limited(response, 4096).await?)
}

fn decode(value: Value) -> Result<bool> {
    value["enabled"]
        .as_bool()
        .ok_or_else(|| "Invalid memory preference".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    pub fn key(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    pub fn limit(self) -> usize {
        match self {
            Self::Global => 60,
            Self::Project => 200,
        }
    }
}

#[derive(Clone, Deserialize)]
pub struct Entry {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created: String,
    #[serde(rename = "updatedAt")]
    pub updated: String,
    pub revision: String,
    pub flagged: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Fact,
    Preference,
    Reference,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Reference => "reference",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub entries: Vec<Entry>,
    pub scope_key: String,
    pub observed_at: String,
    #[serde(default)]
    pub cleanup_writable: bool,
    pub cleanup_directory: Option<String>,
}

pub async fn list(
    backend: &Backend,
    scope: Scope,
    project: Option<(&str, Option<&str>)>,
) -> Result<List> {
    let directory = match project {
        Some((workspace, Some(session))) => {
            Some(super::session_directory(backend, workspace, session).await?)
        }
        _ => None,
    };
    list_at(
        backend,
        scope,
        project.map(|(workspace, _)| (workspace, directory.as_deref())),
    )
    .await
}

pub async fn list_at(
    backend: &Backend,
    scope: Scope,
    context: Option<(&str, Option<&str>)>,
) -> Result<List> {
    decode_list(
        scope,
        operation(backend, scope, context, json!({"action":"list"})).await?,
    )
}

fn decode_list(scope: Scope, value: Value) -> Result<List> {
    let list: List = serde_json::from_value(value)?;
    let mut ids = std::collections::HashSet::new();
    if list.entries.len() > scope.limit()
        || list.scope_key.is_empty()
        || list.scope_key.len() > 128
        || list.observed_at.len() > 40
        || timestamp(&list.observed_at).is_none()
        || list
            .cleanup_directory
            .as_deref()
            .is_some_and(|directory| !crate::absolute_server_path(directory))
        || !list.entries.iter().all(|entry| {
            !entry.id.is_empty()
                && entry.id.len() <= 128
                && ids.insert(&entry.id)
                && valid_title(&entry.title)
                && entry.text.chars().count() <= 2000
                && entry.revision.len() == 64
                && entry.revision.bytes().all(|b| b.is_ascii_hexdigit())
                && entry.created.len() <= 40
                && timestamp(&entry.created).is_some()
                && entry.updated.len() <= 40
                && timestamp(&entry.updated).is_some()
        })
    {
        return Err("Invalid memory review".into());
    }
    Ok(list)
}

#[derive(Debug)]
pub struct Refused(pub &'static str);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Refused {}

pub async fn operation(
    backend: &Backend,
    scope: Scope,
    context: Option<(&str, Option<&str>)>,
    mut input: Value,
) -> Result<Value> {
    input["scope"] = json!(scope.key());
    let mut request = json!({"operation":input});
    if let Some((workspace, directory)) = context {
        if !crate::history::valid_id(workspace)
            || directory.is_some_and(|path| !crate::absolute_server_path(path))
        {
            return Err("Invalid memory Location".into());
        }
        request["context"] = json!({"workspaceId":workspace});
        if let Some(directory) = directory {
            request["context"]["directory"] = json!(directory);
        }
    } else if scope == Scope::Project {
        return Err("Missing project memory context".into());
    }
    let response = backend
        .client
        .post(format!("{}api/memory", backend.base))
        .timeout(Duration::from_secs(40))
        .json(&request)
        .send()
        .await?;
    let ok = response.status().is_success();
    let value = read_json_limited(response, if ok { 2 * 1024 * 1024 } else { 4096 }).await?;
    if !ok {
        let label = match value["code"].as_str() {
            Some("conflict") => "settings.memory.error.conflict",
            Some("disabled") => "settings.memory.error.disabled",
            Some("full") => "settings.memory.error.full",
            Some("invalid") => "settings.memory.error.invalid",
            Some("unreadable") => "settings.memory.error.unreadable",
            Some("git_unavailable") => "settings.memory.error.git_unavailable",
            Some("malformed") => "settings.memory.error.malformed",
            _ => "settings.memory.error.unavailable",
        };
        return Err(Refused(label).into());
    }
    Ok(value)
}

pub async fn create_cleanup_session(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    title: &str,
) -> Result<Backend> {
    if !crate::history::valid_id(workspace) || !crate::absolute_server_path(directory) {
        return Err("Invalid cleanup Location".into());
    }
    let response = backend
        .client
        .post(format!(
            "{}workspaces/{workspace}/instance/api/session",
            backend.base
        ))
        .json(&json!({"title":title,"location":{"directory":directory}}))
        .send()
        .await?
        .error_for_status()?;
    let value = read_json_limited(response, 65536).await?;
    let session = &value["data"];
    let id = session["id"]
        .as_str()
        .filter(|id| crate::history::valid_id(id))
        .ok_or("Invalid cleanup session identity")?;
    if session["location"].get("workspaceID").is_some()
        || !session["location"]["directory"]
            .as_str()
            .is_some_and(|actual| crate::same_server_path(actual, directory))
    {
        return Err("Cleanup Location changed".into());
    }
    let mut created = backend.clone();
    created.workspace = workspace.into();
    created.session = id.into();
    created.fresh_mode = false;
    Ok(created)
}

#[cfg(test)]
#[test]
fn memory_titles_follow_the_server_control_and_whitespace_contract() {
    assert!(valid_title("Before\u{85}after"));
    assert!(valid_title("\u{85}"));
    assert!(!valid_title("\u{feff}\u{a0}"));
    assert!(!valid_title("Before\nafter"));
    let date = "2026-01-01T00:00:00.000Z";
    let list = decode_list(
        Scope::Global,
        json!({
            "scopeKey":"global","observedAt":date,"entries":[{
                "id":"fixture","title":"Before\u{85}after","type":"fact","text":"fixture",
                "createdAt":date,"updatedAt":date,"revision":"a".repeat(64),"flagged":false
            }]
        }),
    )
    .unwrap();
    assert_eq!(list.entries[0].title, "Before\u{85}after");
}

#[cfg(test)]
#[test]
fn memory_setting_requires_an_explicit_boolean() {
    assert!(!decode(json!({"enabled":false})).unwrap());
    assert!(decode(json!({"enabled":true})).unwrap());
    for invalid in [
        json!({}),
        json!(true),
        json!({"enabled":"true"}),
        json!({"enabled":null}),
    ] {
        assert!(decode(invalid).is_err());
    }
}
