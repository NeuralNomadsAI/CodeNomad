use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde_json::{Value, json};

use super::providers::{label, route_unavailable, workspace_directory};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationSelection {
    Off,
    Auto,
    Model(String),
}

impl GenerationSelection {
    fn from_value(value: &Value) -> Result<Self> {
        if let Some(enabled) = value.as_bool() {
            Ok(if enabled { Self::Auto } else { Self::Off })
        } else if let Some(model_ref) = value.as_str().filter(|s| valid_model_ref(s)) {
            Ok(Self::Model(model_ref.to_owned()))
        } else {
            Err("Invalid image generation selection".into())
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Off => Value::Bool(false),
            Self::Auto => Value::Bool(true),
            Self::Model(model_ref) => Value::String(model_ref.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOption {
    pub model_ref: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingOverride {
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationSettings {
    pub global: GenerationSelection,
    pub effective: GenerationSelection,
    pub overridden: Option<SettingOverride>,
    /// `None` when the native image-model catalog could not be read.
    pub models: Option<Vec<ModelOption>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaStorageSettings {
    pub global: bool,
    pub effective: bool,
    pub overridden: Option<SettingOverride>,
    pub project_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub directory: String,
    pub generation: Option<GenerationSettings>,
    pub media_storage: Option<MediaStorageSettings>,
    pub blocked_by: Option<SettingOverride>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mutation {
    Generation(GenerationSelection),
    MediaStorage(bool),
}

pub async fn load(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> Result<Option<Snapshot>> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err("Invalid image settings Location".into());
    }
    let directory = workspace_directory(backend, workspace, session).await?;
    let request = backend
        .client
        .get(format!(
            "{}api/workspaces/{workspace}/image-settings",
            backend.base
        ))
        .query(&[("directory", directory.as_str())]);
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?;
    let Some(response) = route_unavailable(response).await? else {
        return Ok(None);
    };
    let value = read_json_limited(response, 256 * 1024).await?;
    Ok(Some(parse_snapshot(&value, directory)?))
}

pub async fn save(
    backend: &Backend,
    workspace: &str,
    directory: &str,
    mutation: &Mutation,
) -> Result<()> {
    if !valid_id(workspace) || !crate::absolute_server_path(directory) {
        return Err("Invalid image settings request".into());
    }
    let body = match mutation {
        Mutation::Generation(selection) => {
            if let GenerationSelection::Model(model_ref) = selection
                && !valid_model_ref(model_ref)
            {
                return Err("Invalid image model reference".into());
            }
            json!({
                "location": { "directory": directory },
                "generation": selection.to_value(),
            })
        }
        Mutation::MediaStorage(enabled) => json!({
            "location": { "directory": directory },
            "mediaStorage": enabled,
        }),
    };
    backend
        .client
        .put(format!(
            "{}api/workspaces/{workspace}/image-settings",
            backend.base
        ))
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

fn valid_model_ref(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return false;
    }
    let Some((provider, rest)) = value.split_once('/') else {
        return false;
    };
    if provider.is_empty() || provider.contains('#') || rest.is_empty() {
        return false;
    }
    if let Some((model, variant)) = rest.split_once('#') {
        !model.is_empty() && !variant.is_empty() && !variant.contains('#')
    } else {
        true
    }
}

fn clean_path(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains(char::is_control))
        .map(str::to_owned)
}

fn parse_override(value: &Value) -> Option<SettingOverride> {
    value.is_object().then(|| SettingOverride {
        path: clean_path(&value["path"]),
    })
}

pub(crate) fn parse_snapshot(value: &Value, expected_directory: String) -> Result<Snapshot> {
    let response_directory = value["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or("Invalid image settings Location")?;
    if !crate::same_server_path(&expected_directory, response_directory) {
        return Err("Image settings Location changed".into());
    }
    let directory = expected_directory;

    let generation = if value["generation"].is_null() || value.get("generation").is_none() {
        None
    } else {
        let entry = &value["generation"];
        let global = GenerationSelection::from_value(&entry["global"])?;
        let effective = GenerationSelection::from_value(&entry["effective"])?;
        let overridden = parse_override(&entry["override"]);
        let models = if entry["models"].is_null() {
            None
        } else {
            let items = entry["models"]
                .as_array()
                .filter(|rows| rows.len() <= 1024)
                .ok_or("Invalid image models")?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Some(model_ref) = item["ref"].as_str().filter(|s| valid_model_ref(s)) else {
                    continue;
                };
                let name = label(&item["name"]).unwrap_or_else(|| model_ref.to_owned());
                out.push(ModelOption {
                    model_ref: model_ref.to_owned(),
                    name,
                });
            }
            Some(out)
        };
        Some(GenerationSettings {
            global,
            effective,
            overridden,
            models,
        })
    };

    let media_storage = if value["mediaStorage"].is_null() || value.get("mediaStorage").is_none() {
        None
    } else {
        let storage = &value["mediaStorage"];
        let global = storage["global"]
            .as_bool()
            .ok_or("Invalid media storage global setting")?;
        let effective = storage["effective"]
            .as_bool()
            .ok_or("Invalid media storage effective setting")?;
        let overridden = parse_override(&storage["override"]);
        let project_path = storage
            .get("project")
            .filter(|v| v.is_object())
            .and_then(|v| clean_path(&v["path"]));
        Some(MediaStorageSettings {
            global,
            effective,
            overridden,
            project_path,
        })
    };

    let blocked_by = parse_override(&value["blockedBy"]);
    Ok(Snapshot {
        directory,
        generation,
        media_storage,
        blocked_by,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_image_settings_snapshot_and_validates_model_refs() {
        let snap = parse_snapshot(
            &json!({
                "location": {"directory": "/repo"},
                "generation": {
                    "global": "openai/gpt-image-2#high",
                    "effective": true,
                    "override": {"path": "/repo/opencode.jsonc"},
                    "models": [
                        {"ref": "openai/gpt-image-2", "name": "GPT Image 2"},
                        {"ref": "bad-ref", "name": "Ignored"}
                    ]
                },
                "mediaStorage": {
                    "global": false,
                    "effective": true,
                    "project": {"path": "/repo/.opencode/opencode.jsonc"}
                }
            }),
            "/repo".into(),
        )
        .unwrap();
        let generation = snap.generation.unwrap();
        assert_eq!(
            generation.global,
            GenerationSelection::Model("openai/gpt-image-2#high".into())
        );
        assert_eq!(generation.effective, GenerationSelection::Auto);
        assert_eq!(
            generation.overridden.unwrap().path.as_deref(),
            Some("/repo/opencode.jsonc")
        );
        assert_eq!(generation.models.unwrap().len(), 1);
        let storage = snap.media_storage.unwrap();
        assert!(!storage.global);
        assert!(storage.effective);
        assert_eq!(
            storage.project_path.as_deref(),
            Some("/repo/.opencode/opencode.jsonc")
        );
    }

    #[test]
    fn preserves_null_models_and_blocked_by() {
        let snap = parse_snapshot(
            &json!({
                "location": {"directory": "/repo"},
                "generation": {"global": false, "effective": false, "models": null},
                "mediaStorage": null,
                "blockedBy": {"path": "/global/opencode.json"}
            }),
            "/repo".into(),
        )
        .unwrap();
        assert!(snap.generation.unwrap().models.is_none());
        assert!(snap.media_storage.is_none());
        assert_eq!(
            snap.blocked_by.unwrap().path.as_deref(),
            Some("/global/opencode.json")
        );
    }

    #[test]
    fn rejects_mismatched_or_missing_location_directory() {
        let doc = json!({
            "location": {"directory": "/other"},
            "generation": {"global": false, "effective": false, "models": []},
            "mediaStorage": {"global": false, "effective": false}
        });
        assert!(parse_snapshot(&doc, "/repo".into()).is_err());
        let missing = json!({
            "generation": {"global": false, "effective": false, "models": []},
            "mediaStorage": null
        });
        assert!(parse_snapshot(&missing, "/repo".into()).is_err());
    }
}
