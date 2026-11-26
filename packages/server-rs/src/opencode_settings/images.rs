//! `GET`/`PUT /api/workspaces/:id/image-settings`:
//! `server/routes/image-settings.ts` and `opencode/image-settings.ts`.

use std::{sync::Arc, time::Duration};

use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    Scope, acquire_ready_connection, assert_current, bad_request, edit_config_document, fail, fail_response,
    has_control_chars, mapped, native_get, parse_location_object, principal_token, query_directory, raw,
    read_config_documents, read_json_body,
};
use crate::{
    Shared, Workspace,
    auth::Principal,
    opencode::Endpoint,
    subagent_depth::{
        Fail, Target,
        document::{self as doc, Document},
        jsonc::{self, J},
        rules,
    },
};

const INVALID_REQUEST: &str = "Invalid image settings request";
const GENERIC_UNAVAILABLE: &str = "Image settings are unavailable";
const GENERATION_KEYS: [&str; 2] = ["experimental", "image_generate"];
const MEDIA_STORAGE_KEYS: [&str; 2] = ["experimental", "media_blob"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Capability {
    pub(super) generation: bool,
    pub(super) media_storage: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum GenerationValue {
    Bool(bool),
    Model(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Change {
    Generation(GenerationValue),
    MediaStorage(bool),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Mutation {
    pub(super) directory: String,
    pub(super) change: Change,
}

/// Native `ConfigModel.Selection` string form: `/^[^/#]+\/[^#]+(?:#[^#]+)?$/`.
pub(super) fn is_image_model_ref(value: &str) -> bool {
    let Some((provider, rest)) = value.split_once('/') else {
        return false;
    };
    if provider.is_empty() || provider.contains('#') {
        return false;
    }
    match rest.split_once('#') {
        Some((model, variant)) => !model.is_empty() && !variant.is_empty() && !variant.contains('#'),
        None => !rest.is_empty(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub(super) fn capability(contract: &Value) -> Capability {
    let properties =
        &contract["components"]["schemas"]["Config.InfoEncoded"]["properties"]["experimental"]["properties"];
    let has = |key: &str| properties.is_object() && truthy(properties.get(key));
    Capability { generation: has("image_generate"), media_storage: has("media_blob") }
}

/// Reads `experimental.image_generate` as OpenCode does: only `false` disables it, unset means on.
pub(super) fn generation_selection_json(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Bool(true);
    };
    if *value == Value::Bool(false) {
        return Value::Bool(false);
    }
    let Some(obj) = value.as_object() else {
        return Value::Bool(true);
    };
    match obj.get("model") {
        Some(Value::String(s)) => {
            if is_image_model_ref(s) {
                Value::String(s.clone())
            } else {
                Value::Bool(true)
            }
        }
        Some(Value::Object(model)) => {
            match (model.get("providerID").and_then(Value::as_str), model.get("model").and_then(Value::as_str)) {
                (Some(provider), Some(id)) => match model.get("variant").and_then(Value::as_str) {
                    Some(variant) => Value::String(format!("{provider}/{id}#{variant}")),
                    None => Value::String(format!("{provider}/{id}")),
                },
                _ => Value::Bool(true),
            }
        }
        _ => Value::Bool(true),
    }
}

pub(super) fn generation_selection_j(value: Option<&J>) -> Value {
    let Some(value) = value else {
        return Value::Bool(true);
    };
    if *value == J::Bool(false) {
        return Value::Bool(false);
    }
    if !value.is_obj() {
        return Value::Bool(true);
    }
    match value.get("model") {
        Some(J::Str(raw)) => {
            let s = jsonc::string(raw);
            if is_image_model_ref(&s) { Value::String(s) } else { Value::Bool(true) }
        }
        Some(model) if model.is_obj() => match (model.get("providerID"), model.get("model")) {
            (Some(J::Str(provider)), Some(J::Str(id))) => {
                let provider = jsonc::string(provider);
                let id = jsonc::string(id);
                match model.get("variant") {
                    Some(J::Str(variant)) => Value::String(format!("{provider}/{id}#{}", jsonc::string(variant))),
                    _ => Value::String(format!("{provider}/{id}")),
                }
            }
            _ => Value::Bool(true),
        },
        _ => Value::Bool(true),
    }
}

pub(super) fn parse_mutation(value: &Value) -> Option<Mutation> {
    let map = value.as_object().filter(|m| m.len() == 2)?;
    let directory = parse_location_object(map.get("location")?)?;
    if let Some(generation) = map.get("generation") {
        let parsed = match generation {
            Value::Bool(b) => GenerationValue::Bool(*b),
            Value::String(s) if s.encode_utf16().count() <= 512 && is_image_model_ref(s) && !has_control_chars(s) => {
                GenerationValue::Model(s.clone())
            }
            _ => return None,
        };
        return Some(Mutation { directory, change: Change::Generation(parsed) });
    }
    if let Some(Value::Bool(media_storage)) = map.get("mediaStorage") {
        return Some(Mutation { directory, change: Change::MediaStorage(*media_storage) });
    }
    None
}

fn located(entry: &Value) -> Value {
    match rules::path_of(entry) {
        Some(path) => json!({ "path": path }),
        None => json!({}),
    }
}

fn override_of(winner: Option<&Value>, target: &str) -> Option<Value> {
    let entry = winner?;
    if rules::path_of(entry).is_some_and(|p| rules::same_layer(p, target)) { None } else { Some(located(entry)) }
}

fn deciding_project<'a>(winner: Option<&Value>, documents: &'a [(Target, Document)]) -> Option<&'a (Target, Document)> {
    let project = documents.iter().find(|(t, _)| t.project)?;
    let winner_path = rules::path_of(winner?)?;
    rules::same_layer(winner_path, &project.0.path).then_some(project)
}

fn document_entries(entries: &[Value]) -> Vec<&Value> {
    entries.iter().filter(|e| e["type"] == "document").rev().collect()
}

struct ImageContext {
    workspace: Workspace,
    endpoint: Arc<Endpoint>,
    location: String,
    entries: Vec<Value>,
    documents: Vec<(Target, Document)>,
    capability: Capability,
}

async fn context(
    app: &Shared,
    workspace_id: &str,
    directory: &str,
    principal: Option<&CancellationToken>,
) -> Result<ImageContext, Fail> {
    let (workspace, endpoint) = acquire_ready_connection(app, workspace_id, "OpenCode is unavailable").await?;
    // Document acquisition proves directory ownership before any native contract request.
    let snapshot = read_config_documents(app, workspace_id, directory, Some(endpoint.clone()), principal).await?;
    assert_current(app, &endpoint, &workspace, principal)?;
    let contract = native_get(app, &endpoint, "/openapi.json", &[], Duration::from_secs(5), 8 * 1024 * 1024)
        .await
        .map_err(|_| Fail::Generic)?;
    assert_current(app, &endpoint, &workspace, principal)?;
    let contract = if contract.is_object() { contract } else { json!({}) };
    Ok(ImageContext {
        workspace: snapshot.workspace,
        endpoint,
        location: snapshot.location,
        entries: snapshot.entries,
        documents: snapshot.documents,
        capability: capability(&contract),
    })
}

async fn image_models(app: &Shared, ctx: &ImageContext, principal: Option<&CancellationToken>) -> Result<Value, Fail> {
    let query = [("location[directory]", ctx.location.as_str()), ("types", "image")];
    let response = native_get(app, &ctx.endpoint, "/api/model", &query, Duration::from_secs(5), 16 * 1024 * 1024).await;
    // Every catalog outcome, failures included, still belongs to the connection that produced the snapshot.
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal)?;
    let Ok(body) = response else {
        return Ok(Value::Null);
    };
    let Some(items) = body.get("data").and_then(Value::as_array) else {
        return Ok(Value::Null);
    };
    let models: Vec<Value> = items
        .iter()
        .filter_map(|model| {
            let provider = model.get("providerID")?.as_str()?;
            let id = model.get("id")?.as_str()?;
            let name = model.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(id);
            Some(json!({ "ref": format!("{provider}/{id}"), "name": name }))
        })
        .collect();
    Ok(Value::Array(models))
}

async fn read(
    app: &Shared,
    workspace_id: &str,
    directory: &str,
    principal: Option<&CancellationToken>,
) -> Result<Value, Fail> {
    let ctx = context(app, workspace_id, directory, principal).await?;
    let global = ctx.documents.iter().find(|(t, _)| !t.project);
    let settings = document_entries(&ctx.entries);

    let generation = if ctx.capability.generation
        && let Some((global_target, global_doc)) = global
    {
        let winner = settings.iter().copied().find(|entry| {
            entry.get("info").and_then(|i| i.get("experimental")).and_then(|e| e.get("image_generate")).is_some()
        });
        let overridden = override_of(winner, &global_target.path);
        let global_value = doc::read(global_doc, &GENERATION_KEYS).map_err(raw)?;
        let effective_value = winner.and_then(|entry| entry.get("info")?.get("experimental")?.get("image_generate"));
        let models = image_models(app, &ctx, principal).await?;
        let mut group = json!({
            "global": generation_selection_j(global_value.as_ref()),
            "effective": generation_selection_json(effective_value),
            "models": models,
        });
        if let Some(ov) = overridden {
            group["override"] = ov;
        }
        group
    } else {
        Value::Null
    };

    let media_storage = if ctx.capability.media_storage
        && let Some((global_target, global_doc)) = global
    {
        let winner =
            settings.iter().copied().find(|entry| entry.get("info").and_then(|i| i.get("experimental")).is_some());
        let project = deciding_project(winner, &ctx.documents);
        let overridden = if project.is_some() { None } else { override_of(winner, &global_target.path) };
        let global_enabled = doc::read(global_doc, &MEDIA_STORAGE_KEYS).map_err(raw)? == Some(J::Bool(true));
        let effective_enabled = winner.and_then(|entry| entry.get("info")?.get("experimental")?.get("media_blob"))
            == Some(&Value::Bool(true));
        let mut group = json!({
            "global": global_enabled,
            "effective": effective_enabled,
        });
        if let Some((project_target, _)) = project {
            group["project"] = json!({ "path": project_target.path });
        } else if let Some(ov) = overridden {
            group["override"] = ov;
        }
        group
    } else {
        Value::Null
    };

    let blocked = if (!generation.is_null() || !media_storage.is_null())
        && let Some((global_target, global_doc)) = global
    {
        let has_experimental = doc::read(global_doc, &["experimental"]).map_err(raw)?.is_some();
        if has_experimental {
            None
        } else {
            rules::masked_by(&ctx.entries, &global_target.path).map(|index| located(&ctx.entries[index]))
        }
    } else {
        None
    };

    let mut out = json!({
        "location": { "directory": ctx.location },
        "generation": generation,
        "mediaStorage": media_storage,
    });
    if let Some(blocked_by) = blocked {
        out["blockedBy"] = blocked_by;
    }
    Ok(out)
}

async fn update(
    app: &Shared,
    workspace_id: &str,
    directory: &str,
    change: Change,
    principal: Option<CancellationToken>,
) -> Result<(), Fail> {
    let ctx = context(app, workspace_id, directory, principal.as_ref()).await?;
    let is_generation = matches!(change, Change::Generation(_));
    let supported = if is_generation { ctx.capability.generation } else { ctx.capability.media_storage };
    if !supported {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "This OpenCode configuration has no such image setting"));
    }
    let keys = if is_generation { GENERATION_KEYS } else { MEDIA_STORAGE_KEYS };
    let value = match &change {
        Change::Generation(GenerationValue::Bool(b)) => J::Bool(*b),
        Change::Generation(GenerationValue::Model(model)) => J::obj(&[("model", J::s(model))]),
        Change::MediaStorage(b) => J::Bool(*b),
    };

    let acquired = ctx.documents.iter().find(|(t, _)| !t.project).map(|(t, d)| (t.path.clone(), d.requested.clone()));
    let entries_for_mask = ctx.entries.clone();
    edit_config_document(
        app,
        workspace_id,
        directory,
        Scope::Global,
        Some(ctx.endpoint.clone()),
        principal.clone(),
        move |document| {
            let Some((acquired_path, acquired_requested)) = acquired else {
                return Err(fail(Status::CONFLICT, "OpenCode configuration changed; refresh before saving"));
            };
            if document.requested != acquired_requested {
                return Err(fail(Status::CONFLICT, "OpenCode configuration changed; refresh before saving"));
            }
            let has_experimental = doc::read(document, &["experimental"]).map_err(mapped)?.is_some();
            if !has_experimental && rules::masked_by(&entries_for_mask, &acquired_path).is_some() {
                return Err(fail(Status::CONFLICT, "Saving would hide inherited experimental OpenCode settings"));
            }
            doc::edit_setting(document, &keys, Some(value)).map_err(mapped)
        },
    )
    .await?;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal.as_ref())?;

    let Change::MediaStorage(media_storage) = change else {
        return Ok(());
    };
    let settings = document_entries(&ctx.entries);
    let winner = settings.iter().copied().find(|entry| entry.get("info").and_then(|i| i.get("experimental")).is_some());
    let Some((_, project_doc)) = deciding_project(winner, &ctx.documents) else {
        return Ok(());
    };
    let project_requested = project_doc.requested.clone();
    edit_config_document(
        app,
        workspace_id,
        directory,
        Scope::Project,
        Some(ctx.endpoint.clone()),
        principal.clone(),
        move |document| {
            if document.requested != project_requested {
                return Err(fail(Status::CONFLICT, "OpenCode configuration changed; refresh before saving"));
            }
            let has_experimental = doc::read(document, &["experimental"]).map_err(mapped)?.is_some();
            if !has_experimental {
                return Err(fail(Status::CONFLICT, "OpenCode configuration changed; refresh before saving"));
            }
            doc::edit_setting(document, &MEDIA_STORAGE_KEYS, Some(J::Bool(media_storage))).map_err(mapped)
        },
    )
    .await?;
    assert_current(app, &ctx.endpoint, &ctx.workspace, principal.as_ref())?;
    Ok(())
}

pub(super) async fn get(
    State(app): State<Shared>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    principal: Option<Extension<Principal>>,
) -> Response {
    let Some(directory) = query_directory(query.as_deref()) else {
        return bad_request(INVALID_REQUEST);
    };
    let principal = principal_token(principal);
    match read(&app, &id, &directory, principal.as_ref()).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => fail_response(error, GENERIC_UNAVAILABLE),
    }
}

pub(super) async fn put(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    principal: Option<Extension<Principal>>,
    body: Body,
) -> Response {
    let json_body = match read_json_body(&headers, body, INVALID_REQUEST).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(mutation) = parse_mutation(&json_body) else {
        return bad_request(INVALID_REQUEST);
    };
    let principal = principal_token(principal);
    match update(&app, &id, &mutation.directory, mutation.change, principal).await {
        Ok(()) => Status::NO_CONTENT.into_response(),
        Err(error) => fail_response(error, GENERIC_UNAVAILABLE),
    }
}
