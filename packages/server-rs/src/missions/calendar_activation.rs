//! Read-only native settings admission. A disabled Location needs a project
//! JSONC transaction with an attempted-write barrier under its file lock.
use super::{activation_pending, capability, flag, rpc, unavailable};
use crate::{App, Error, Workspace, files::node_path::Style, opencode::Endpoint};
use axum::{Json, http::StatusCode as Status};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
#[path = "calendar_activation_files.rs"]
pub(super) mod files;

pub(super) async fn settings(app: &App, endpoint: &Arc<Endpoint>, w: &Workspace, dir: &str) -> Result<Settings, Error> {
    Ok(view(app, endpoint, w, dir).await?.settings)
}

pub(super) async fn view(app: &App, endpoint: &Arc<Endpoint>, w: &Workspace, dir: &str) -> Result<files::View, Error> {
    let (flag, entries) = tokio::try_join!(flag(app, endpoint, w), capability::config_entries(app, endpoint, dir))?;
    Settings::from_native(&entries.entries, &flag, dir).ok_or_else(unavailable)?;
    let dir = dir.to_owned();
    tokio::task::spawn_blocking(move || files::View::load(dir, entries, flag)).await.map_err(|_| unavailable())?
}

pub(super) struct Settings {
    pub enabled: bool,
    pub provenance: String,
    pub origin: Option<String>,
    refusal: Option<Value>,
    target: Option<String>,
}

impl Settings {
    fn from_native(entries: &[Value], flag: &Value, directory: &str) -> Option<Self> {
        Self::resolve(Style::of(directory), entries, flag, directory, None)
    }

    pub(super) fn from_documents(
        style: Style,
        entries: &[Value],
        flag: &Value,
        directory: &str,
        documents: &[(bool, &str, Option<&'static str>)],
    ) -> Option<Self> {
        Self::resolve(style, entries, flag, directory, Some(documents))
    }

    fn resolve(
        style: Style,
        entries: &[Value],
        flag: &Value,
        directory: &str,
        documents: Option<&[(bool, &str, Option<&'static str>)]>,
    ) -> Option<Self> {
        if entries.iter().any(|entry| match entry["type"].as_str() {
            Some("directory") => !path(entry).is_some_and(|p| style.valid_absolute(p)),
            Some("document") => {
                !entry["info"].is_object()
                    || entry.get("path").is_some() && !path(entry).is_some_and(|p| style.valid_absolute(p))
                    || entry["info"].get("automations").is_some_and(|value| !value.is_boolean())
                    || capability::experimental(entry).is_some_and(|block| {
                        !block.is_object()
                            || ["automations", "schedules", "all_flags"]
                                .iter()
                                .any(|key| block.get(key).is_some_and(|value| !value.is_boolean()))
                    })
            }
            _ => true,
        }) {
            return None;
        }
        if !super::valid_flag(flag) {
            return None;
        }
        let enabled = flag["enabled"].as_bool()?;
        let provenance = flag["provenance"].as_str()?;
        let global = entries.iter().find(|e| e["type"] == "directory").and_then(path);
        let nested = style.join(directory, ".opencode");
        let selected = |parent: &str| {
            ["opencode.jsonc", "opencode.json"].into_iter().map(|name| style.join(parent, name)).find(|p| {
                entries.iter().any(|e| e["type"] == "document" && path(e).is_some_and(|actual| style.same(actual, p)))
            })
        };
        let inherited = entries.iter().filter(|e| e["type"] == "document").filter_map(path).any(|p| {
            let parent = style.dirname(p);
            let root = style.dirname(&parent);
            style.basename(&parent) == ".opencode"
                && global.is_none_or(|g| !style.same(g, &parent))
                && !style.same(&root, directory)
                && style.contains(&root, directory)
        });
        let global_file = global.and_then(selected);
        let project_file = selected(&nested).or_else(|| (!inherited).then(|| selected(directory)).flatten());
        let layer = |p: Option<&str>| match p {
            None => "imposed",
            Some(p) => {
                if let Some(docs) = documents {
                    match docs.iter().find(|(_, doc_path, _)| style.same(doc_path, p)) {
                        Some((true, _, _)) => "project",
                        Some((false, _, _)) => "global",
                        None => "inherited",
                    }
                } else if global_file.as_ref().is_some_and(|f| style.same(f, p)) {
                    "global"
                } else if project_file.as_ref().is_some_and(|f| style.same(f, p)) {
                    "project"
                } else {
                    "inherited"
                }
            }
        };
        let finish = |refusal: Option<Value>, target: Option<String>| {
            Some(Self {
                enabled,
                provenance: provenance.into(),
                origin: capability::origin(entries, flag).map(str::to_owned),
                refusal,
                target,
            })
        };

        // Inspect every discovered layer (including OFF hidden by a higher ON), then owned raw
        // documents to fence watcher lag, then environment and daemon-reported hidden OFFs.
        for entry in entries.iter().filter(|e| e["type"] == "document") {
            let p = path(entry);
            if entry["info"].get("automations") == Some(&Value::Bool(false)) {
                return finish(Some(refusal("explicit-off", "automations-setting", layer(p), p)), None);
            }
            if capability::experimental(entry).is_some_and(|block| {
                block.get("automations").or_else(|| block.get("schedules")) == Some(&Value::Bool(false))
            }) {
                return finish(Some(refusal("explicit-off", "experimental-block", layer(p), p)), None);
            }
        }
        if let Some(docs) = documents {
            for &(is_project, p, off) in docs {
                if let Some(off_provenance) = off {
                    return finish(
                        Some(refusal("explicit-off", off_provenance, if is_project { "project" } else { "global" }, Some(p))),
                        None,
                    );
                }
            }
        }
        if !enabled && provenance == "environment" {
            return finish(Some(refusal("explicit-off", "environment", "environment", None)), None);
        }
        if let Some(first_hidden) = flag.get("hiddenOff").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str) {
            let src = capability::source_path(first_hidden);
            return finish(Some(refusal("explicit-off", "experimental-block", layer(src), src)), None);
        }
        if enabled {
            return finish(None, None);
        }
        // Runtimes with the top-level setting are on unless a source turns them off; never write the legacy block there.
        if provenance == "automations-setting" || flag["path"].is_string() {
            let src = flag["path"].as_str().and_then(capability::source_path);
            return finish(Some(refusal("explicit-off", provenance, layer(src), src)), None);
        }
        if let Some(docs) = documents {
            let Some((_, project_path, _)) = docs.iter().find(|(is_project, _, _)| *is_project) else {
                return finish(None, None);
            };
            let (_, after) = target_position(style, entries, project_path, directory)?;
            if let Some(imposed) = entries[after..].iter().find(|entry| capability::experimental(entry).is_some()) {
                return finish(Some(refusal("masked", "experimental-block", "imposed", path(imposed))), None);
            }
            return finish(None, Some((*project_path).to_owned()));
        }
        let target = project_file.clone().unwrap_or_else(|| style.join(&nested, "opencode.jsonc"));
        let first_above = target_position(style, entries, &target, directory).map(|(_, after)| after);
        let masked = first_above
            .and_then(|i| entries[i..].iter().find(|e| capability::experimental(e).is_some()))
            .map(|entry| refusal("masked", "experimental-block", "imposed", path(entry)));
        finish(masked, None)
    }

    pub fn diagnostic(&self, api: bool) -> Value {
        if !api {
            return json!({"available":false,"reason":"unavailable","targets":[]});
        }
        if let Some(refusal) = &self.refusal {
            return json!({"available":false,"reason":"forbidden","targets":[],
                "code":"schedule-activation-refused","refusal":refusal});
        }
        if self.enabled {
            json!({"available":true,"targets":[]})
        } else if let Some(path) = &self.target {
            json!({"available":true,"targets":[{"scope":"project","path":path}]})
        } else {
            json!({"available":false,"reason":"unavailable","targets":[]})
        }
    }

    pub fn require_enabled(&self, not_applied: Option<&Activation>) -> Result<(), Error> {
        self.check_refusal(not_applied)?;
        if !self.enabled {
            return Err(if not_applied.is_some() { disabled() } else { activation_pending() });
        }
        Ok(())
    }

    pub fn check_refusal(&self, not_applied: Option<&Activation>) -> Result<(), Error> {
        if let Some(refusal) = &self.refusal {
            let mut body = json!({"error":"Mission schedule configuration remains unconfirmed",
                "code":"schedule-activation-refused","refusal":refusal});
            if let Some(input) = not_applied {
                body["notApplied"] =
                    json!({"requestID":input.request,"expectedRevision":input.expected_document_revision});
            }
            return Err((Status::FORBIDDEN, Json(body)));
        }
        Ok(())
    }
}

fn path(entry: &Value) -> Option<&str> {
    entry["path"].as_str()
}

fn target_position(style: Style, entries: &[Value], target: &str, directory: &str) -> Option<(usize, usize)> {
    let parent = style.dirname(target);
    let matches = |entry: &Value, kind: &str, path: &str| {
        entry["type"] == kind && entry["path"].as_str().is_some_and(|p| style.same(p, path))
    };
    entries
        .iter()
        .position(|e| matches(e, "document", target))
        .map(|i| (i, i + 1))
        .or_else(|| entries.iter().position(|e| matches(e, "directory", &parent)).map(|i| (i, i)))
        .or_else(|| {
            if style.basename(&parent) != ".opencode" || !style.same(&style.dirname(&parent), directory) {
                return None;
            }
            entries
                .iter()
                .rposition(|entry| {
                    let Some(path) = entry["path"].as_str() else { return false };
                    let parent = if entry["type"] == "directory" { path.to_owned() } else { style.dirname(path) };
                    let root = if style.basename(&parent) == ".opencode" { style.dirname(&parent) } else { parent };
                    style.contains(&root, directory)
                })
                .or_else(|| entries.iter().position(|e| e["type"] == "directory"))
                .map(|i| (i + 1, i + 1))
        })
}

fn refusal(reason: &str, provenance: &str, layer: &str, path: Option<&str>) -> Value {
    let mut result = json!({"reason":reason,"provenance":provenance,"layer":layer,"openable":false});
    if let Some(path) = path {
        result["path"] = json!(path);
        let style = Style::host();
        let root = crate::settings::document::home().join(".config").join("opencode");
        for (name, id) in
            [("opencode.json", "opencode-global-config"), ("opencode.jsonc", "opencode-global-config-jsonc")]
        {
            if root.join(name).to_str().is_some_and(|file| style.same(file, path)) {
                result["openable"] = json!(true);
                result["configFileID"] = json!(id);
            }
        }
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    #[serde(rename = "requestID")]
    pub(super) request: String,
    pub(super) expected_document_revision: u64,
}

impl Activation {
    pub fn valid(&self) -> bool {
        (1..=128).contains(&self.request.encode_utf16().count())
            && self.expected_document_revision <= crate::missions::recurrence_contract::SAFE
    }
    fn exact(&self, intent: &Value) -> bool {
        intent["requestID"] == self.request && intent["expectedRevision"] == self.expected_document_revision
    }
}

pub(super) struct Journal<'a> {
    pub app: &'a App,
    pub endpoint: &'a Arc<Endpoint>,
    pub dir: &'a str,
    pub mission: &'a str,
    pub input: &'a Activation,
}

impl Journal<'_> {
    pub async fn phase(&self, action: &str, fields: Value) -> Result<Value, Error> {
        let mut input = json!({"missionID":self.mission,"requestID":self.input.request,
            "expectedRevision":self.input.expected_document_revision,"action":action});
        if let Some(fields) = fields.as_object() {
            input.as_object_mut().unwrap().extend(fields.clone());
        }
        let result = rpc(self.app, self.endpoint, self.dir, "documentActivation", input, super::READ)
            .await
            .map_err(|_| activation_pending())?;
        if !counter(&result["document"]["revision"]) || !valid_intent(result["document"].get("scheduleActivation")) {
            return Err(activation_pending());
        }
        Ok(result)
    }

    pub fn confirms(&self, result: &Value, state: &str, authority: &str) -> bool {
        let doc = &result["document"];
        let intent = &doc["scheduleActivation"];
        doc["state"] == "paused"
            && doc["revision"].as_u64().is_some_and(|n| n >= self.input.expected_document_revision)
            && self.input.exact(intent)
            && intent["state"] == state
            && intent["authority"] == authority
    }
}

fn counter(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= crate::missions::recurrence_contract::SAFE)
}

fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn valid_intent(intent: Option<&Value>) -> bool {
    let Some(intent) = intent else { return false };
    intent.is_null()
        || intent["requestID"].as_str().is_some_and(|s| (1..=128).contains(&s.encode_utf16().count()))
            && counter(&intent["expectedRevision"])
            && digest(&intent["authority"])
            && matches!(intent["state"].as_str(), Some("prepared" | "partial" | "ready" | "failed"))
            && intent["targets"].as_array().is_some_and(|targets| {
                targets.len() <= 2
                    && targets.iter().enumerate().all(|(i, target)| {
                        matches!(target["scope"].as_str(), Some("global" | "project"))
                            && target["path"].as_str().is_some_and(|s| (1..=4096).contains(&s.encode_utf16().count()))
                            && digest(&target["expectation"])
                            && digest(&target["resultDigest"])
                            && target["attempted"].is_boolean()
                            && target["acknowledged"].is_boolean()
                            && (target["acknowledged"] == false || target["attempted"] == true)
                            && (intent["state"] != "ready" || target["acknowledged"] == true)
                            && targets[..i]
                                .iter()
                                .all(|other| other["path"] != target["path"] && other["scope"] != target["scope"])
                    })
            })
            && (intent["state"] != "ready"
                || intent.get("effectiveOrigin").is_some_and(|origin| {
                    origin.is_null() || origin.as_str().is_some_and(|s| (1..=4096).contains(&s.encode_utf16().count()))
                }))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Admission {
    Fresh,
    Resume,
    VerifyReady,
}

pub(super) fn admit(doc: &Value, input: &Activation, authority: &str) -> Result<Admission, Error> {
    if doc["state"] != "paused" || !crate::missions::configuration::requires_calendar(&doc["launch"]) {
        return Err(disabled());
    }
    let intent = &doc["scheduleActivation"];
    let exact = input.exact(intent);
    let current = doc["revision"] == input.expected_document_revision;
    if intent["state"] == "ready" && (exact || current) {
        return if intent["authority"] == authority {
            Ok(Admission::VerifyReady)
        } else {
            Err(activation_pending())
        };
    }
    if exact {
        return if intent["authority"] == authority
            && matches!(intent["state"].as_str(), Some("prepared" | "partial" | "failed"))
        {
            Ok(Admission::Resume)
        } else {
            Err(activation_pending())
        };
    }
    if current
        && (intent.is_null()
            || intent["state"] == "failed"
                && intent["requestID"] != input.request
                && intent["targets"].as_array().is_some_and(|targets| targets.iter().all(|t| t["attempted"] == false)))
    {
        Ok(Admission::Fresh)
    } else {
        Err((
            Status::CONFLICT,
            Json(json!({"error":"Original Mission activation remains unresolved",
            "code":"schedule-activation-conflict"})),
        ))
    }
}

pub(super) fn disabled() -> Error {
    (
        Status::CONFLICT,
        Json(json!({"error":"Mission schedule preparation unavailable","code":"schedule-activation-unavailable"})),
    )
}

pub(super) async fn execute<F: Future<Output = bool> + Send>(
    journal: Journal<'_>, w: &Workspace, legacy_authority: &str, guarded: impl Fn() -> F + Sync,
) -> Result<Value, Error> {
    let result = apply(&journal, w, legacy_authority, &guarded).await;
    if result.is_err() && guarded().await
        && let Ok(seen) = journal.phase("read", Value::Null).await
    {
        let intent = &seen["document"]["scheduleActivation"];
        if journal.input.exact(intent) && intent["state"] != "ready" && guarded().await {
            let _ = journal.phase("failed", json!({"errorCode":"configuration-unconfirmed"})).await;
        }
    }
    result
}

async fn apply<F: Future<Output = bool> + Send>(
    journal: &Journal<'_>, w: &Workspace, legacy_authority: &str, guarded: &(impl Fn() -> F + Sync),
) -> Result<Value, Error> {
    let Journal { app, endpoint, dir, input, .. } = journal;
    if !guarded().await {
        return Err(unavailable());
    }
    let old = journal.phase("read", Value::Null).await?;
    let (api, initial) = tokio::try_join!(super::automation_api(app, endpoint), view(app, endpoint, w, dir))?;
    if !guarded().await {
        return Err(activation_pending());
    }
    let authority = initial.authority();
    let saved = &old["document"]["scheduleActivation"];
    let saved_legacy = saved["authority"] == legacy_authority && saved["targets"] == json!([]);
    let journal_authority = if saved_legacy { legacy_authority } else { &authority };
    let admission = admit(&old["document"], input, journal_authority)?;
    let fresh = admission == Admission::Fresh;
    if api["available"] != true {
        return Err(if fresh { disabled() } else { activation_pending() });
    }
    initial.settings.check_refusal(fresh.then_some(input))?;
    if admission == Admission::VerifyReady {
        initial.settings.require_enabled(None)?;
        let seen = journal.phase("read", Value::Null).await?;
        if seen != old || !guarded().await {
            return Err(activation_pending());
        }
        return Ok(seen);
    }
    let mut edit = initial.planned()?;
    let targets = if fresh {
        let targets: Vec<_> = edit.iter().map(|e| e.target.clone()).collect();
        let seen = journal.phase("prepare", json!({"authority":journal_authority,"targets":targets})).await?;
        if !journal.confirms(&seen, "prepared", journal_authority)
            || seen["document"]["scheduleActivation"]["targets"] != json!(targets)
        {
            return Err(activation_pending());
        }
        targets
    } else {
        saved["targets"].as_array().ok_or_else(activation_pending)?.clone()
    };
    if let Some(proposed) = edit.take().filter(|_| {
        targets.len() == 1 && targets[0]["scope"] == "project" && targets[0]["attempted"] == false
    }) {
        let target = &targets[0];
        if !files::same_target(&proposed.target, target) {
            return Err(activation_pending());
        }
        let prepared = files::prepare(proposed).await?;
        let live = view(app, endpoint, w, dir).await?;
        live.settings.check_refusal(None)?;
        if live.authority() != authority || !guarded().await
            || !live.planned()?.is_some_and(|change| files::same_target(&change.target, target))
        {
            return Err(activation_pending());
        }
        let attempting = journal.phase("attempting", json!({"scope":"project","resultDigest":target["resultDigest"]})).await?;
        let seen = &attempting["document"]["scheduleActivation"]["targets"][0];
        if !journal.confirms(&attempting, "partial", journal_authority)
            || !files::same_target(seen, target) || seen["attempted"] != true || !guarded().await
        {
            return Err(activation_pending());
        }
        let before_commit = view(app, endpoint, w, dir).await?;
        before_commit.settings.check_refusal(None)?;
        if before_commit.authority() != authority || !guarded().await
            || !before_commit.planned()?.is_some_and(|change| files::same_target(&change.target, target))
        {
            return Err(activation_pending());
        }
        // Keep the lock and this request's lifetime through the rename.
        prepared.commit().map_err(|_| activation_pending())?;
    }
    if !targets.is_empty() {
        let live = view(app, endpoint, w, dir).await?;
        if live.authority() != authority || !guarded().await {
            return Err(activation_pending());
        }
        let exact = journal.phase("read", Value::Null).await?;
        let seen = &exact["document"]["scheduleActivation"];
        if !input.exact(seen) || seen["authority"] != journal_authority {
            return Err(activation_pending());
        }
        for target in &targets {
            let recorded = seen["targets"].as_array().and_then(|a| a.iter().find(|x| files::same_target(x, target)));
            if !recorded.is_some_and(|x| x["attempted"] == true) || !live.confirms(target) || !guarded().await {
                return Err(activation_pending());
            }
            if recorded.is_some_and(|x| x["acknowledged"] == false) {
                let ack = journal.phase("acknowledged", json!({"scope":target["scope"],"resultDigest":target["resultDigest"]})).await?;
                if !ack["document"]["scheduleActivation"]["targets"].as_array().is_some_and(|a|
                    a.iter().any(|x| files::same_target(x, target) && x["acknowledged"] == true)) {
                    return Err(activation_pending());
                }
            }
        }
    }
    let origin = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let live = view(app, endpoint, w, dir).await?;
            live.settings.check_refusal(None)?;
            if live.authority() != authority || !guarded().await || !targets.iter().all(|t| live.confirms(t)) {
                return Err(activation_pending());
            }
            if live.settings.enabled {
                return Ok(live.settings.origin);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.map_err(|_| activation_pending())??;
    let result = journal.phase("ready", json!({"effectiveOrigin":origin})).await?;
    if !journal.confirms(&result, "ready", journal_authority) || !guarded().await
        || result["document"]["scheduleActivation"]["effectiveOrigin"] != json!(origin)
    {
        return Err(activation_pending());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIRECTORY: &str = "/root/project";
    const GLOBAL: &str = "/profile/opencode.jsonc";
    const PROJECT: &str = "/root/project/opencode.jsonc";
    const REQUEST: &str = "activation request";
    const AUTHORITY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn document(path: &str, block: Value) -> Value {
        json!({"type":"document","path":path,"info":{"experimental":block}})
    }
    fn resolve(entries: &[Value], enabled: bool, provenance: &str) -> Settings {
        Settings::from_native(entries, &json!({"enabled":enabled,"provenance":provenance}), DIRECTORY).unwrap()
    }
    fn input(request: &str, expected_document_revision: u64) -> Activation {
        Activation { request: request.into(), expected_document_revision }
    }

    #[test]
    fn hidden_off_has_a_discovered_layer_even_with_effective_on() {
        let global = json!({"type":"directory","path":"/profile"});
        let virtual_on = json!({"type":"document","info":{"experimental":{"automations":true}}});
        for (path, layer) in [(GLOBAL, "global"), ("/root/.opencode/opencode.jsonc", "inherited"), (PROJECT, "project")]
        {
            let entries = [global.clone(), document(path, json!({"schedules":false})), virtual_on.clone()];
            let settings = resolve(&entries, true, "experimental-block");
            assert!(settings.enabled);
            assert_eq!(settings.origin, None);
            let expected = json!({"reason":"explicit-off","provenance":"experimental-block","layer":layer,
                "path":path,"openable":false});
            assert_eq!(settings.diagnostic(true)["refusal"], expected);
            let request = input(REQUEST, 3);
            let (status, Json(body)) = settings.require_enabled(Some(&request)).unwrap_err();
            assert_eq!(status, Status::FORBIDDEN);
            assert_eq!(body["refusal"], expected);
            assert_eq!(body["notApplied"], json!({"requestID":REQUEST,"expectedRevision":3}));
            assert!(settings.require_enabled(None).unwrap_err().1.0.get("notApplied").is_none());
        }
    }

    #[test]
    fn whole_block_order_alias_and_missing_flag_are_distinct() {
        let global = json!({"type":"directory","path":"/profile"});
        let base = document(GLOBAL, json!({"all_flags":false,"subagent_depth":0}));
        let direct = document(PROJECT, json!({"todo":true}));
        let entries = [base.clone(), global.clone(), direct.clone()];
        let settings = resolve(&entries, false, "channel-default");
        assert_eq!(settings.diagnostic(true), json!({"available":false,"reason":"unavailable","targets":[]}));
        assert_eq!(
            settings.require_enabled(Some(&input(REQUEST, 3))).unwrap_err().1.0["code"],
            "schedule-activation-unavailable"
        );
        assert_eq!(resolve(&entries, false, "environment").diagnostic(true)["refusal"]["layer"], "environment");
        assert_eq!(resolve(&entries, true, "environment").diagnostic(true), json!({"available":true,"targets":[]}));
        let imposed = json!({"type":"document","info":{"experimental":{}}});
        for entries in [
            [base.clone(), global.clone(), direct.clone(), imposed.clone()].as_slice(),
            [base.clone(), global.clone(), imposed.clone()].as_slice(),
        ] {
            assert_eq!(resolve(entries, false, "channel-default").diagnostic(true)["refusal"]["reason"], "masked");
        }
        let inherited = document("/root/.opencode/opencode.jsonc", json!({"subagent_depth":0}));
        let entries = [base, global, direct, inherited];
        assert!(resolve(&entries, false, "channel-default").diagnostic(true).get("refusal").is_none());
        let alias = document(PROJECT, json!({"automations":true,"schedules":false}));
        assert_eq!(resolve(&[alias], true, "experimental-block").origin.as_deref(), Some(PROJECT));
    }

    #[test]
    fn windows_discovery_folds_case_without_using_host_path_rules() {
        let dir = "D:\\Root\\Project";
        let entries = [
            json!({"type":"directory","path":"D:\\Profile"}),
            document("d:/ROOT/Project/.opencode/opencode.jsonc", json!({"automations":false})),
        ];
        let settings =
            Settings::from_native(&entries, &json!({"enabled":true,"provenance":"environment"}), dir).unwrap();
        assert_eq!(settings.diagnostic(true)["refusal"]["layer"], "project");
    }

    fn paused(intent: Value) -> Value {
        json!({"state":"paused","revision":7,"scheduleActivation":intent,
            "launch":{"when":[{"kind":"cron","expression":"0 9 * * *","zone":"UTC"}]}})
    }
    fn intent(state: &str, targets: Value) -> Value {
        json!({"requestID":REQUEST,"expectedRevision":5,"authority":AUTHORITY,"state":state,"targets":targets})
    }

    #[test]
    fn replay_requires_the_original_pair_and_never_replaces_an_attempt() {
        let exact = input(REQUEST, 5);
        let changed = input(REQUEST, 7);
        let new = input("new request", 7);
        let prepared = paused(intent("prepared", json!([])));
        assert_eq!(admit(&prepared, &exact, AUTHORITY).unwrap(), Admission::Resume);
        assert!(admit(&prepared, &changed, AUTHORITY).is_err());
        assert!(admit(&prepared, &new, AUTHORITY).is_err());
        assert!(admit(&prepared, &exact, "different authority").is_err());
        let failed = paused(intent("failed", json!([])));
        assert!(admit(&failed, &changed, AUTHORITY).is_err());
        assert_eq!(admit(&failed, &new, AUTHORITY).unwrap(), Admission::Fresh);
        let attempted = paused(intent(
            "failed",
            json!([{"scope":"project","path":PROJECT,"expectation":AUTHORITY,
            "resultDigest":AUTHORITY,"attempted":true,"acknowledged":false}]),
        ));
        assert!(valid_intent(attempted.get("scheduleActivation")));
        assert!(admit(&attempted, &new, AUTHORITY).is_err());
        assert_eq!(admit(&attempted, &exact, AUTHORITY).unwrap(), Admission::Resume);
        let mut ready = intent("ready", json!([]));
        ready["effectiveOrigin"] = json!(PROJECT);
        assert!(valid_intent(Some(&ready)));
        let ready = paused(ready);
        assert_eq!(admit(&ready, &exact, AUTHORITY).unwrap(), Admission::VerifyReady);
        assert_eq!(admit(&ready, &new, AUTHORITY).unwrap(), Admission::VerifyReady);
        assert!(admit(&ready, &new, "different authority").is_err());
    }

    #[test]
    fn top_level_setting_runtimes_refuse_explicit_and_hidden_off_without_writing() {
        let global = json!({"type":"directory","path":"/profile"});
        let gdoc = json!({"type":"document","path":GLOBAL,"info":{"experimental":{"subagent_depth":2}}});
        let pdoc = json!({"type":"document","path":PROJECT,"info":{"experimental":{"subagent_depth":8}}});
        let base = [global.clone(), gdoc.clone(), pdoc.clone()];

        let on = Settings::from_native(&base, &json!({"enabled":true,"provenance":"channel-default"}), DIRECTORY).unwrap();
        assert_eq!(on.diagnostic(true), json!({"available":true,"targets":[]}));
        assert_eq!(on.origin, None);

        let legacy_off = Settings::from_native(
            &base,
            &json!({"enabled":false,"provenance":"experimental-block","path":GLOBAL,"hiddenOff":[]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(legacy_off.origin.as_deref(), Some(GLOBAL));
        assert_eq!(
            legacy_off.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"experimental-block","layer":"global","path":GLOBAL,"openable":false})
        );

        let top_off = Settings::from_native(
            &base,
            &json!({"enabled":false,"provenance":"automations-setting","path":PROJECT,"hiddenOff":[]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(top_off.origin.as_deref(), Some(PROJECT));
        assert_eq!(
            top_off.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"automations-setting","layer":"project","path":PROJECT,"openable":false})
        );

        for pathless in [capability::INLINE_CONFIG_SOURCE, capability::REMOTE_CONFIG_SOURCE] {
            let imposed = Settings::from_native(
                &base,
                &json!({"enabled":false,"provenance":"automations-setting","path":pathless,"hiddenOff":[]}),
                DIRECTORY,
            )
            .unwrap();
            assert_eq!(imposed.origin, None);
            assert_eq!(
                imposed.diagnostic(true)["refusal"],
                json!({"reason":"explicit-off","provenance":"automations-setting","layer":"imposed","openable":false})
            );
        }

        let entry_off = [
            global.clone(),
            json!({"type":"document","path":GLOBAL,"info":{"automations":false}}),
            pdoc.clone(),
        ];
        let hidden_entry = Settings::from_native(
            &entry_off,
            &json!({"enabled":true,"provenance":"automations-setting","path":PROJECT,"hiddenOff":[]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(
            hidden_entry.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"automations-setting","layer":"global","path":GLOBAL,"openable":false})
        );

        let ancestor = "/root/ancestor.jsonc";
        let hidden_ancestor = Settings::from_native(
            &base,
            &json!({"enabled":true,"provenance":"automations-setting","path":PROJECT,"hiddenOff":[ancestor]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(
            hidden_ancestor.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"experimental-block","layer":"inherited","path":ancestor,"openable":false})
        );

        for pathless in [capability::INLINE_CONFIG_SOURCE, capability::REMOTE_CONFIG_SOURCE] {
            let hidden_imposed = Settings::from_native(
                &base,
                &json!({"enabled":true,"provenance":"channel-default","hiddenOff":[pathless]}),
                DIRECTORY,
            )
            .unwrap();
            assert_eq!(
                hidden_imposed.diagnostic(true)["refusal"],
                json!({"reason":"explicit-off","provenance":"experimental-block","layer":"imposed","openable":false})
            );
        }

        // Legacy 2.4 OFF in an unowned ancestor file refuses with layer "inherited" without writing.
        let inherited_legacy_off = Settings::from_native(
            &base,
            &json!({"enabled":false,"provenance":"experimental-block","path":ancestor,"hiddenOff":[]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(
            inherited_legacy_off.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"experimental-block","layer":"inherited","path":ancestor,"openable":false})
        );

        // Precedence: environment OFF takes precedence over hiddenOff, and discovered entry OFF takes precedence over environment OFF.
        let env_beats_hidden = Settings::from_native(
            &base,
            &json!({"enabled":false,"provenance":"environment","hiddenOff":[ancestor]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(
            env_beats_hidden.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"environment","layer":"environment","openable":false})
        );
        let entry_beats_env = Settings::from_native(
            &entry_off,
            &json!({"enabled":false,"provenance":"environment","hiddenOff":[ancestor]}),
            DIRECTORY,
        )
        .unwrap();
        assert_eq!(
            entry_beats_env.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"automations-setting","layer":"global","path":GLOBAL,"openable":false})
        );

        let bad_entry = [global, json!({"type":"document","path":PROJECT,"info":{"automations":"yes"}})];
        assert!(Settings::from_native(&bad_entry, &json!({"enabled":true,"provenance":"channel-default"}), DIRECTORY).is_none());
    }

    #[test]
    fn raw_disk_top_level_and_legacy_off_fence_watcher_lag_and_block_writes() {
        struct TempGuard(std::path::PathBuf);
        impl Drop for TempGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let root = crate::shared::test_dir("calendar-2-4-disk");
        let _guard = TempGuard(root.clone());
        let global_dir = root.join("global");
        let project_dir = root.join("project");
        std::fs::create_dir_all(&global_dir).unwrap();
        std::fs::create_dir_all(&project_dir).unwrap();
        let global_file = global_dir.join("opencode.jsonc");
        let project_file = project_dir.join("opencode.jsonc");
        std::fs::write(&global_file, "{\"automations\":false}\n").unwrap();
        std::fs::write(&project_file, "{\"automations\":true}\n").unwrap();

        let global_dir_str = global_dir.to_string_lossy().into_owned();
        let project_dir_str = project_dir.to_string_lossy().into_owned();
        let global_file_str = global_file.to_string_lossy().into_owned();
        let project_file_str = project_file.to_string_lossy().into_owned();

        let stale_entries = vec![
            json!({"type":"document","path":global_file_str,"info":{}}),
            json!({"type":"directory","path":global_dir_str}),
            json!({"type":"document","path":project_file_str,"info":{"automations":true}}),
        ];
        // Raw disk OFF fences watcher lag AND takes precedence over environment OFF / hiddenOff.
        let config = capability::ConfigEntries {
            entries: stale_entries.clone(),
            experimental: vec![None, None, None],
        };
        let view = files::View::load(
            project_dir_str.clone(),
            config,
            json!({"enabled":false,"provenance":"environment","hiddenOff":[capability::INLINE_CONFIG_SOURCE]}),
        )
        .unwrap();
        assert_eq!(
            view.settings.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"automations-setting","layer":"global","path":global_file_str,"openable":false})
        );

        // Top-level ON beside a legacy experimental OFF in the same document still refuses.
        std::fs::write(&global_file, "{}\n").unwrap();
        std::fs::write(&project_file, "{\"automations\":true,\"experimental\":{\"automations\":false}}\n").unwrap();
        let config = capability::ConfigEntries {
            entries: stale_entries.clone(),
            experimental: vec![None, None, None],
        };
        let view = files::View::load(
            project_dir_str.clone(),
            config,
            json!({"enabled":true,"provenance":"automations-setting","path":project_file_str,"hiddenOff":[]}),
        )
        .unwrap();
        assert_eq!(
            view.settings.diagnostic(true)["refusal"],
            json!({"reason":"explicit-off","provenance":"experimental-block","layer":"project","path":project_file_str,"openable":false})
        );

        // Clean 2.4 ON requires no write; 2.4 OFF never plans a legacy experimental write.
        std::fs::write(&project_file, "{}\n").unwrap();
        let config_on = capability::ConfigEntries {
            entries: stale_entries.clone(),
            experimental: vec![None, None, None],
        };
        let view_on = files::View::load(
            project_dir_str.clone(),
            config_on,
            json!({"enabled":true,"provenance":"channel-default","hiddenOff":[]}),
        )
        .unwrap();
        assert!(view_on.planned().unwrap().is_none());

        let config_off = capability::ConfigEntries {
            entries: stale_entries,
            experimental: vec![None, None, None],
        };
        let view_off = files::View::load(
            project_dir_str,
            config_off,
            json!({"enabled":false,"provenance":"automations-setting","path":project_file_str,"hiddenOff":[]}),
        )
        .unwrap();
        assert_eq!(view_off.settings.diagnostic(true)["refusal"]["provenance"], "automations-setting");
        assert!(view_off.planned().is_err());
    }
}
