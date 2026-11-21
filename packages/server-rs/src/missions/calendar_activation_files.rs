use super::{Settings, activation_pending, capability, refusal, target_position, unavailable};
use crate::{
    Error, files::node_path::Style,
    subagent_depth::{document::{self, Document}, fs, jsonc::{self, J, Text}, resolve_targets},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) struct Edit {
    pub original: Document,
    pub updated: Text,
    pub target: Value,
}

pub(crate) struct View {
    dir: String,
    entries: Vec<Value>,
    experimental: Vec<Option<J>>,
    documents: Vec<(bool, String, Document)>,
    pub settings: Settings,
}

pub(super) fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn text_hash(text: &[u16]) -> String {
    hash(jsonc::string(text).as_bytes())
}

fn explicit_off(d: &Document) -> Result<bool, Error> {
    let field = |key| document::read(d, &["experimental", key]).map_err(|_| unavailable());
    let primary = field("automations")?;
    let alias = field("schedules")?;
    let depth = field("subagent_depth")?;
    if [&primary, &alias].into_iter().flatten().any(|value| !matches!(value, J::Bool(_)))
        || depth.is_some_and(|value| value.safe_integer().is_none_or(|n| n < 0.0))
    {
        return Err(unavailable());
    }
    Ok(primary.or(alias) == Some(J::Bool(false)))
}

impl View {
    pub(super) fn load(dir: String, config: capability::ConfigEntries, mut settings: Settings) -> Result<Self, Error> {
        let capability::ConfigEntries { entries, experimental } = config;
        let style = Style::host();
        let global = entries.iter().find(|e| e["type"] == "directory").and_then(super::path).ok_or_else(unavailable)?;
        if !style.valid_absolute(&dir) || !style.valid_absolute(global) {
            return Err(unavailable());
        }
        let documents = resolve_targets(style, global, &dir, &entries, true).map_err(|_| unavailable())?
            .into_iter().map(|target| {
                let doc = fs::load(&target.io).map_err(|_| unavailable())?;
                if target.project && !style.contains(&dir, &doc.write) {
                    return Err(unavailable());
                }
                if explicit_off(&doc)? && settings.refusal.is_none() {
                    settings.refusal = Some(refusal("explicit-off", "experimental-block",
                        if target.project { "project" } else { "global" }, Some(&target.path)));
                }
                Ok((target.project, target.path, doc))
            }).collect::<Result<Vec<_>, Error>>()?;
        if !settings.enabled && settings.refusal.is_none() {
            if let Some((_, path, _)) = documents.iter().find(|(project, _, _)| *project) {
                let (_, after) = target_position(style, &entries, path, &dir).ok_or_else(unavailable)?;
                if let Some(imposed) = entries[after..].iter().find(|entry| capability::experimental(entry).is_some()) {
                    settings.refusal = Some(refusal("masked", "experimental-block", "imposed", super::path(imposed)));
                } else {
                    settings.target = Some(path.clone());
                }
            }
        }
        Ok(Self { dir, entries, experimental, documents, settings })
    }

    pub(in super::super) fn authority(&self) -> String {
        let targets: Vec<_> = self.documents.iter().map(|(project, path, doc)|
            json!([if *project { "project" } else { "global" }, path, doc.write])).collect();
        hash(json!(["host", self.dir, targets]).to_string())
    }

    pub(super) fn planned(&self) -> Result<Option<Edit>, Error> {
        if self.settings.enabled {
            return Ok(None);
        }
        let (project, path, doc) = self.documents.iter().find(|(project, _, _)| *project).ok_or_else(unavailable)?;
        let (before, _) = target_position(Style::host(), &self.entries, path, &self.dir).ok_or_else(unavailable)?;
        let mut current = doc.clone();
        if document::read(doc, &["experimental"]).map_err(|_| unavailable())?.is_none() {
            if let Some(J::Obj(block)) = self.experimental[..before].iter().rev().flatten().next() {
                for (name, value) in block {
                    let key = jsonc::string(name);
                    if key == "automations" { continue; }
                    let text = document::edit_setting(&current, &["experimental", &key], Some(value.clone()))
                        .map_err(|_| unavailable())?;
                    current = document::with_text(&current, &text);
                }
            }
        }
        let updated = document::edit_setting(&current, &["experimental", "automations"], Some(J::Bool(true)))
            .map_err(|_| unavailable())?;
        Ok(Some(Edit {
            target: json!({"scope":if *project {"project"} else {"global"},"path":path,
                "expectation":document::expectation(doc),"resultDigest":text_hash(&updated),
                "attempted":false,"acknowledged":false}),
            original: doc.clone(), updated,
        }))
    }

    pub(in super::super) fn confirms(&self, target: &Value) -> bool {
        self.documents.iter().any(|(project, path, doc)| {
            target["scope"] == if *project { "project" } else { "global" }
                && target["path"] == *path && doc.exists && target["resultDigest"] == text_hash(&document::full(doc))
        })
    }
}

pub(in super::super) fn same_target(plan: &Value, recorded: &Value) -> bool {
    ["scope", "path", "expectation", "resultDigest"].iter().all(|key| plan[*key] == recorded[*key])
}

pub(super) async fn prepare(edit: Edit) -> Result<fs::Prepared, Error> {
    tokio::task::spawn_blocking(move || fs::prepare(&edit.original, &edit.updated))
        .await.map_err(|_| activation_pending())?.map_err(|_| activation_pending())
}
