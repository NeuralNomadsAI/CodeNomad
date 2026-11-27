//! `GET`/`PUT /api/workspaces/:id/websearch-settings`:
//! `server/routes/websearch-settings.ts` and `opencode/websearch-settings.ts`.

use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use super::{
    Scope, bad_request, edit_config_document, fail_response, has_control_chars, mapped, parse_location_object,
    principal_token, query_directory, raw, read_config_documents, read_json_body,
};
use crate::{
    Shared,
    auth::Principal,
    subagent_depth::{
        Fail,
        document::{self as doc, Document},
        jsonc::{self, J},
    },
};

const INVALID_REQUEST: &str = "Invalid web search settings request";
const GENERIC_UNAVAILABLE: &str = "Web search settings unavailable";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum WebSearchProvider {
    Provider(String),
    Disabled,
    Inherit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Mutation {
    pub(super) directory: String,
    pub(super) scope: Scope,
    pub(super) provider: WebSearchProvider,
}

pub(super) fn parse_mutation(value: &Value) -> Option<Mutation> {
    let map = value.as_object().filter(|m| m.len() == 3)?;
    let directory = parse_location_object(map.get("location")?)?;
    let scope = match map.get("scope")?.as_str()? {
        "global" => Scope::Global,
        "project" => Scope::Project,
        _ => return None,
    };
    let provider = match map.get("provider")? {
        Value::Null => WebSearchProvider::Inherit,
        Value::Bool(false) => WebSearchProvider::Disabled,
        Value::String(s) if (1..=256).contains(&s.encode_utf16().count()) && !has_control_chars(s) => {
            WebSearchProvider::Provider(s.clone())
        }
        _ => return None,
    };
    Some(Mutation { directory, scope, provider })
}

fn selection_json(value: &Value) -> Value {
    if *value == Value::Bool(false) {
        return Value::Bool(false);
    }
    if let Some(provider) = value.as_object().and_then(|o| o.get("provider")).and_then(Value::as_str) {
        return Value::String(provider.to_owned());
    }
    Value::Null
}

fn selection_j(value: Option<&J>) -> Value {
    match value {
        Some(J::Bool(false)) => Value::Bool(false),
        Some(J::Obj(_)) => match value.and_then(|v| v.get("provider")) {
            Some(J::Str(s)) => Value::String(jsonc::string(s)),
            _ => Value::Null,
        },
        _ => Value::Null,
    }
}

pub(super) fn edit_websearch(document: &Document, provider: &WebSearchProvider) -> Result<jsonc::Text, Fail> {
    let previous = doc::read(document, &["websearch"]).map_err(mapped)?;
    match provider {
        WebSearchProvider::Provider(name) if previous.as_ref().is_some_and(J::is_obj) => {
            doc::edit_setting(document, &["websearch", "provider"], Some(J::s(name))).map_err(mapped)
        }
        WebSearchProvider::Provider(name) => {
            doc::edit_setting(document, &["websearch"], Some(J::obj(&[("provider", J::s(name))]))).map_err(mapped)
        }
        WebSearchProvider::Disabled => {
            doc::edit_setting(document, &["websearch"], Some(J::Bool(false))).map_err(mapped)
        }
        WebSearchProvider::Inherit => doc::edit_setting(document, &["websearch"], None).map_err(mapped),
    }
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
    let provider = mutation.provider;
    match edit_config_document(&app, &id, &mutation.directory, mutation.scope, None, principal, move |document| {
        edit_websearch(document, &provider)
    })
    .await
    {
        Ok(()) => Status::NO_CONTENT.into_response(),
        Err(error) => fail_response(error, GENERIC_UNAVAILABLE),
    }
}

async fn read(
    app: &Shared,
    workspace_id: &str,
    directory: &str,
    principal: Option<&tokio_util::sync::CancellationToken>,
) -> Result<Value, Fail> {
    let snapshot = read_config_documents(app, workspace_id, directory, None, principal).await?;
    let mut effective = Value::Null;
    for entry in &snapshot.entries {
        if entry["type"] == "document" {
            let info = entry.get("info").filter(|v| v.is_object()).ok_or(Fail::Generic)?;
            if let Some(ws) = info.get("websearch") {
                effective = selection_json(ws);
            }
        }
    }
    let mut scopes = Vec::with_capacity(snapshot.documents.len());
    for (target, document) in &snapshot.documents {
        let raw_value = doc::read(document, &["websearch"]).map_err(raw)?;
        let scope = if target.project { Scope::Project } else { Scope::Global };
        scopes.push(json!({
            "scope": scope.as_str(),
            "path": target.path,
            "selection": selection_j(raw_value.as_ref()),
        }));
    }
    Ok(json!({
        "location": { "directory": snapshot.location },
        "effective": effective,
        "scopes": scopes,
    }))
}
