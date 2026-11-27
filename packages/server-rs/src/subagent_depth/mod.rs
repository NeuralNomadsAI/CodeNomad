//! `GET`/`PUT /api/workspaces/:id/subagent-depth`: `server/routes/subagent-depth-settings.ts`,
//! `opencode/subagent-depth-settings.ts` and the `plugin-controls.ts` document acquisition they use
//! (owned Location, native `config.get`, Global/Project targets, strict layers, atomic replacement).

pub(crate) mod document;
pub(crate) mod jsonc;
mod jsonc_edit;
mod jsonc_value;
pub(crate) mod rules;

use crate::files::node_path::Style;
use crate::shared::fastify;
use crate::{App, Error, Shared, Workspace, error};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use document::{self as doc, DocError, Document};
use jsonc::J;
use serde_json::{Value, json};
use std::time::Duration;

pub fn routes() -> axum::Router<Shared> {
    axum::Router::new().route("/api/workspaces/{id}/subagent-depth", axum::routing::get(get).put(put))
}

const MAX_SAFE: f64 = 9007199254740991.0;

/// `PluginControlsError` (status, message) or any other error (generic 503).
#[derive(Clone, Debug, PartialEq)]
pub enum Fail {
    Status(Status, &'static str),
    Generic,
}
impl From<Fail> for Error {
    fn from(f: Fail) -> Error {
        match f {
            Fail::Status(s, m) => error(s, m),
            // Upstream errors can contain credential-bearing requests; never serialize them.
            Fail::Generic => error(Status::SERVICE_UNAVAILABLE, "Native subagent depth is unavailable"),
        }
    }
}
const fn fail(s: Status, m: &'static str) -> Fail {
    Fail::Status(s, m)
}
/// `mapDocumentError`.
fn mapped(e: DocError) -> Fail {
    match e {
        DocError::Invalid(m) => fail(Status::UNPROCESSABLE_ENTITY, m),
        DocError::Conflict(m) => fail(Status::CONFLICT, m),
        DocError::Filesystem(m) => fail(Status::SERVICE_UNAVAILABLE, m),
        DocError::Plain => Fail::Generic,
    }
}
/// A document error escaping unmapped (the reference's read path): generic.
fn raw(_: DocError) -> Fail {
    Fail::Generic
}
fn invalid_request() -> Error {
    error(Status::BAD_REQUEST, "Invalid subagent depth request")
}

fn decode(s: &str) -> String {
    let plus = s.replace('+', " ");
    percent_encoding::percent_decode_str(&plus).decode_utf8().map(|c| c.into_owned()).unwrap_or(plus)
}
/// zod `z.string().trim().min(1).max(32_768)`.
fn location_directory(v: &str) -> Option<String> {
    let d = crate::shared::js_trim(v).to_owned();
    (1..=32_768).contains(&d.encode_utf16().count()).then_some(d)
}
/// The strict `Location` query: exactly one `directory`.
fn query_directory(raw: Option<&str>) -> Option<String> {
    let mut found = None;
    for pair in raw.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if decode(k) != "directory" || found.is_some() {
            return None;
        }
        found = Some(decode(v));
    }
    location_directory(&found?)
}
/// The strict `Mutation` body.
fn mutation(body: &[u8]) -> Option<(String, Option<f64>, String)> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let o = v
        .as_object()
        .filter(|o| o.len() == 3 && ["location", "depth", "expectation"].iter().all(|k| o.contains_key(*k)))?;
    let location = o["location"].as_object().filter(|l| l.len() == 1)?;
    let directory = location_directory(location.get("directory")?.as_str()?)?;
    let depth = match &o["depth"] {
        Value::Null => None,
        n => Some(n.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SAFE)?),
    };
    let expectation = o["expectation"]
        .as_str()
        .filter(|e| e.len() == 64 && e.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
    Some((directory, depth.map(|d| d + 0.0), expectation.into()))
}

/// The owned service directory for `dir` (`getServiceDirectoryForPath`), subfolders included
/// (`worktrees::ownership`).
async fn service_directory(app: &App, w: &Workspace, dir: &str) -> Option<String> {
    crate::worktrees::ownership::resolve(app, w, dir).await.map(|o| o.directory)
}
async fn native(app: &App, path: &str, query: &[(&str, &str)], timeout: u64, max: usize) -> Result<Value, ()> {
    let url = app.native.url().join(path).map_err(|_| ())?;
    let response = app
        .native
        .request(Method::GET, url)
        .query(query)
        .timeout(Duration::from_secs(timeout))
        .send()
        .await
        .map_err(|_| ())?;
    if response.status() != Status::OK { Err(()) } else { crate::opencode::read_json(response, max).await }
}
fn workspace(app: &App, id: &str) -> Option<Workspace> {
    app.workspace(id).ok().filter(|w| w.status == "ready")
}

#[derive(Clone, Debug)]
pub(crate) struct Target {
    pub(crate) project: bool,
    pub(crate) path: String,
    pub(crate) io: String,
    pub(crate) requested_io: String,
    pub(crate) exists: bool,
}
struct Located {
    location: String,
    entries: Vec<Value>,
    targets: Vec<Target>,
}

/// `PluginControls.readContext` (what the depth editor consumes) and `resolveTargets`.
async fn read_context(app: &App, w: &Workspace, requested: &str, strict: bool) -> Result<Located, Fail> {
    let directory = crate::shared::js_trim(requested).to_owned();
    if directory.is_empty() || directory.contains('\0') {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "Invalid OpenCode location"));
    }
    let foreign = fail(Status::FORBIDDEN, "Location is not owned by this workspace");
    let location = service_directory(app, w, &directory).await.ok_or(foreign.clone())?;
    if service_directory(app, w, &location).await.is_none() {
        return Err(foreign);
    }
    let query = [("location[directory]", location.as_str())];
    let (config, plugin) = tokio::join!(
        native(app, "/api/config", &query, 12, 16 * 1024 * 1024),
        native(app, "/api/plugin", &query, 12, 16 * 1024 * 1024)
    );
    let unreadable = || fail(Status::SERVICE_UNAVAILABLE, "Unable to read OpenCode plugin configuration");
    let entries = match (config, plugin) {
        (Ok(Value::Array(entries)), Ok(p)) if p["data"].is_array() => entries,
        _ => return Err(unreadable()),
    };
    let style = Style::host();
    let global = entries
        .iter()
        .find(|e| e["type"] == "directory")
        .and_then(rules::path_of)
        .filter(|g| style.valid_absolute(g))
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode did not report its global configuration directory"))?
        .to_string();
    if !style.valid_absolute(&location) {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "OpenCode location directory is invalid"));
    }
    let (project, list) = (location.clone(), entries.clone());
    let targets = tokio::task::spawn_blocking(move || resolve_targets(style, &global, &project, &list, strict))
        .await
        .map_err(|_| Fail::Generic)??;
    Ok(Located { location, entries, targets })
}
pub(crate) fn resolve_targets(
    style: Style,
    global: &str,
    project: &str,
    entries: &[Value],
    strict: bool,
) -> Result<Vec<Target>, Fail> {
    // Native (non-WSL) services share the host path syntax.
    let io = Style::host();
    if !io.is_absolute(global) || !io.is_absolute(project) {
        return Err(fail(
            Status::SERVICE_UNAVAILABLE,
            "OpenCode configuration paths could not be mapped to the execution host",
        ));
    }
    let candidates = |root: &str, names: &[String]| -> Vec<(String, String)> {
        names.iter().map(|n| (style.join(root, n), io.join(root, n))).collect()
    };
    let names: Vec<String> = ["opencode.json", "opencode.jsonc"].map(String::from).into();
    let nested: Vec<String> = names.iter().map(|n| style.join(".opencode", n)).collect();
    let gc = candidates(global, &names);
    let pc = candidates(project, &[names.clone(), nested].concat());
    let mut inspected = Vec::new();
    for (_, path) in gc.iter().chain(&pc) {
        inspected.push(fs::inspect(path).map_err(mapped)?);
    }
    if strict && inspected.chunks(2).any(|pair| pair.len() == 2 && pair[0].1 && pair[1].1) {
        return Err(fail(Status::CONFLICT, "OpenCode configuration changed: JSON and JSONC coexist in one layer"));
    }
    let select = |project: bool, candidates: &[(String, String)], inspected: &[(String, bool)]| {
        let mut selected = candidates.last().cloned().unwrap_or_default();
        let mut requested_io = selected.1.clone();
        let mut exists = false;
        for (c, r) in candidates.iter().zip(inspected) {
            if r.1 {
                selected = (c.0.clone(), r.0.clone());
                requested_io = c.1.clone();
                exists = true;
            }
        }
        if !exists {
            selected.1 = inspected.last().map(|r| r.0.clone()).unwrap_or_default();
        }
        Target { project, path: selected.0, io: selected.1, requested_io, exists }
    };
    let global_target = select(false, &gc, &inspected[..2]);
    let inherited_layer = entries.iter().any(|e| {
        let Some(p) = rules::path_of(e).filter(|p| e["type"] == "document" && !p.is_empty()) else { return false };
        let dir = style.dirname(p);
        let root = style.dirname(&dir);
        style.basename(&dir) == ".opencode"
            && !style.same(&dir, global)
            && !style.same(&root, project)
            && style.contains(&root, project)
    });
    let project_target =
        if inherited_layer { select(true, &pc[2..], &inspected[4..]) } else { select(true, &pc, &inspected[2..]) };
    // Never expose two scopes backed by one file, nor a project write outside the location.
    if style.same(global, project)
        || io.same(&global_target.io, &project_target.io)
        || inherited_layer && !io.contains(project, &project_target.io)
    {
        return Ok(vec![global_target]);
    }
    Ok(vec![global_target, project_target])
}

struct Context {
    located: Located,
    docs: Vec<(Target, Document)>,
    capability: Option<(Option<f64>, Option<f64>)>,
    media: bool,
    rules: Option<Vec<Value>>,
}
impl Context {
    fn project(&self) -> Option<&(Target, Document)> {
        self.docs.iter().find(|(t, _)| t.project)
    }
}
/// `subagentDepthCapability`: (maximum, default) when the contract declares a usable integer.
fn capability(contract: &Value) -> Option<(Option<f64>, Option<f64>)> {
    let v = &contract["components"]["schemas"]["Config.InfoEncoded"]["properties"]["experimental"]["properties"]["subagent_depth"];
    if v["type"] != "integer" || v["minimum"].as_f64() != Some(0.0) {
        return None;
    }
    let safe = |x: &Value| x.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE && *n >= 0.0);
    let maximum = match v.get("maximum") {
        None => None,
        Some(m) => Some(safe(m)?),
    };
    let default = match v.get("default") {
        None => None,
        Some(d) => Some(safe(d).filter(|d| maximum.is_none_or(|m| *d <= m))?),
    };
    Some((maximum, default))
}
fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v.as_f64() != Some(0.0) && v.as_str() != Some("")
}
async fn context(app: &App, id: &str, directory: &str) -> Result<(Workspace, Context), Fail> {
    let w = workspace(app, id).ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode is unavailable"))?;
    // Document acquisition proves directory ownership before the schema request.
    let located = read_context(app, &w, directory, true).await?;
    let targets = located.targets.clone();
    let docs = tokio::task::spawn_blocking(move || {
        targets.into_iter().map(|t| fs::load(&t.io).map(|d| (t, d))).collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| Fail::Generic)?
    .map_err(raw)?;
    let query = [("location[directory]", located.location.as_str())];
    let (contract, agents) = tokio::join!(
        native(app, "/openapi.json", &[], 5, 8 * 1024 * 1024),
        native(app, "/api/agent", &query, 5, 16 * 1024 * 1024)
    );
    let contract = contract.map_err(|_| Fail::Generic)?;
    let contract = if contract.is_object() { contract } else { json!({}) };
    let rules = agents.ok().and_then(|a| {
        let general = a["data"].as_array()?.iter().find(|x| x["id"] == rules::AGENT)?;
        general["permissions"].as_array().cloned()
    });
    let properties =
        &contract["components"]["schemas"]["Config.InfoEncoded"]["properties"]["experimental"]["properties"];
    let media = properties.is_object() && truthy(&properties["media_blob"]);
    Ok((w, Context { capability: capability(&contract), media, rules, located, docs }))
}
/// `exposedMediaStorage`: the `media_blob` removing the project block would expose, when certain.
fn exposed_media(ctx: &Context, target: &str) -> Option<bool> {
    let (global_target, global) = ctx.docs.iter().find(|(t, _)| !t.project)?;
    let lower = &ctx.located.entries[rules::masked_by(&ctx.located.entries, target)?];
    if !ctx.media || !global.exists || !rules::path_of(lower).is_some_and(|p| rules::same_layer(p, &global_target.path))
    {
        return None;
    }
    let fresh = doc::read(global, &["experimental"]).ok()?;
    let native = lower["info"].get("experimental").map(J::from_json);
    if fresh.is_none() || fresh != native {
        return None;
    }
    Some(native.and_then(|n| n.get("media_blob").cloned()) == Some(J::Bool(true)))
}
fn depth_value(v: Option<&J>) -> Result<Option<f64>, Fail> {
    match v {
        None => Ok(None),
        Some(j) => j
            .safe_integer()
            .filter(|n| *n >= 0.0)
            .map(Some)
            .ok_or(fail(Status::UNPROCESSABLE_ENTITY, "Invalid native subagent depth")),
    }
}
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE { json!(n as i64) } else { json!(n) }
}

pub async fn get(
    State(app): State<Shared>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Response, Error> {
    let directory = query_directory(query.as_deref()).ok_or_else(invalid_request)?;
    Ok(Json(read(&app, &id, &directory).await?).into_response())
}
async fn read(app: &App, id: &str, directory: &str) -> Result<Value, Fail> {
    let (_, ctx) = context(app, id, directory).await?;
    let entries = &ctx.located.entries;
    let mut experimental = None;
    for entry in entries.iter().rev() {
        if let Some(block) = rules::experimental_of(entry).map_err(raw)? {
            experimental = Some((entry, block));
            break;
        }
    }
    let configured = experimental.as_ref().and_then(|(_, b)| b.get("subagent_depth"));
    let effective = match configured {
        None => ctx.capability.and_then(|c| c.1),
        Some(_) => depth_value(configured)?,
    };
    let ignore_case = Style::host() == Style::Win32;
    let effect = ctx.rules.as_deref().and_then(|r| rules::nesting_effect(r, ignore_case));
    let project = match ctx.project() {
        None => Value::Null,
        Some((target, document)) => {
            let depth = depth_value(doc::read(document, &["experimental", "subagent_depth"]).map_err(raw)?.as_ref())?;
            let mut p =
                json!({"path": target.path, "depth": depth.map(number), "expectation": doc::expectation(document)});
            if depth.is_some() && rules::nesting_rule_skipped(document) {
                p["nestingSkipped"] = json!(true);
            }
            if rules::without_redundant(document, exposed_media(&ctx, &target.path), None).map_err(raw)?.is_some() {
                p["emptyExperimental"] = json!(true);
            }
            p
        }
    };
    let nesting = match effect {
        None => Value::Null,
        Some(e) => {
            let mut n = json!({"effect": e});
            if ctx.rules.as_deref().is_some_and(|r| rules::tool_hidden(r, ignore_case)) {
                n["hidden"] = json!(true);
            }
            n
        }
    };
    let capability = ctx.capability.map_or(Value::Null, |(maximum, default)| {
        let mut c = json!({"minimum": 0});
        if let Some(m) = maximum {
            c["maximum"] = number(m);
        }
        if let Some(d) = default {
            c["default"] = number(d);
        }
        c
    });
    let origin = experimental.map_or(Value::Null, |(e, _)| e.get("path").cloned().unwrap_or(Value::Null));
    Ok(
        json!({"location": {"directory": ctx.located.location}, "capability": capability, "effectiveDepth": effective.map(number),
        "nesting": nesting, "origin": origin, "project": project}),
    )
}

/// Only a JSON body reaches the route schema.
fn content(headers: &HeaderMap, body: &[u8]) -> Result<(), Error> {
    match fastify::body(headers, body)? {
        Some(fastify::Body::Json(_)) => Ok(()),
        _ => Err(invalid_request()),
    }
}
pub async fn put(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Error> {
    content(&headers, &body)?;
    let (directory, depth, expected) = mutation(&body).ok_or_else(invalid_request)?;
    update(&app, &id, &directory, depth, &expected).await?;
    Ok(Status::NO_CONTENT.into_response())
}
async fn update(app: &App, id: &str, directory: &str, value: Option<f64>, expected: &str) -> Result<(), Fail> {
    let (_, ctx) = context(app, id, directory).await?;
    let (Some((maximum, _)), Some((project, _))) = (ctx.capability, ctx.project()) else {
        return Err(fail(Status::SERVICE_UNAVAILABLE, "Native subagent depth editing is unavailable"));
    };
    let exposed = exposed_media(&ctx, &project.path);
    if value.is_some_and(|v| maximum.is_some_and(|m| v > m)) {
        return Err(fail(Status::UNPROCESSABLE_ENTITY, "Subagent depth is outside the native contract"));
    }
    // `editConfigDocument`: the per-target queue, ownership and layers read again, then the
    // worktree-deletion fence admits the write or refuses it at once.
    let _queue = crate::worktrees::fence::serialize(crate::worktrees::fence::project_key(id, directory)).await;
    let w = app.workspace(id).map_err(|_| fail(Status::NOT_FOUND, "Workspace not found"))?;
    let located = read_context(app, &w, directory, true).await?;
    let target = located
        .targets
        .iter()
        .find(|t| t.project)
        .cloned()
        .ok_or(fail(Status::SERVICE_UNAVAILABLE, "OpenCode configuration scope is unavailable"))?;
    let Some(owner) = crate::worktrees::ownership::resolve(app, &w, &located.location).await else {
        return Err(fail(Status::FORBIDDEN, "Location is not owned by an active worktree"));
    };
    let Some(admitted) = crate::worktrees::fence::enter(&[crate::worktrees::fence::identity(&owner.checkout)]) else {
        return Err(fail(Status::CONFLICT, "Worktree deletion is in progress"));
    };
    let expected = expected.to_string();
    // The admission and the queue end with the write itself, even if the client goes away.
    tokio::task::spawn_blocking(move || {
        let _held = (admitted, _queue);
        let document = fs::load(&target.io).map_err(mapped)?;
        let text = edit(&document, &located.entries, &target.path, &located.location, value, &expected, exposed)?;
        fs::replace(&document, &text).map_err(mapped)
    })
    .await
    .map_err(|_| Fail::Generic)?
}
/// The reference's edit callback: expectation, cleanup or depth edit, then the marked General rule.
pub fn edit(
    document: &Document,
    entries: &[Value],
    path: &str,
    location: &str,
    value: Option<f64>,
    expected: &str,
    exposed: Option<bool>,
) -> Result<jsonc::Text, Fail> {
    if doc::expectation(document) != expected {
        return Err(fail(Status::CONFLICT, "OpenCode configuration changed; refresh before saving"));
    }
    edit_text(document, entries, path, location, value, exposed).map_err(mapped)
}
pub fn edit_text(
    document: &Document,
    entries: &[Value],
    path: &str,
    location: &str,
    value: Option<f64>,
    exposed: Option<bool>,
) -> doc::R<jsonc::Text> {
    // An emptied project `experimental` object would still hide every inherited setting.
    let cleaned =
        if value.is_none() { rules::without_redundant(document, exposed, Some("subagent_depth"))? } else { None };
    let text = match cleaned {
        Some(t) => t,
        None => rules::edit_depth(document, value, &rules::inherited(entries, path, location)?)?,
    };
    let edited = doc::with_text(document, &text);
    // A project override consents to nesting up to it: the marked rule follows it, Inherit removes it.
    let nested =
        if value.is_none() { rules::without_nesting_rule(&edited)? } else { rules::with_nesting_rule(&edited)? };
    Ok(nested.unwrap_or(text))
}

pub mod fs;

#[cfg(test)]
mod tests;
