//! Fixed brokers for the bundled plugin's chronological and ranked history reads.
mod cursor;
mod ranked;

use axum::{
    Json,
    body::to_bytes,
    extract::Request,
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};

use super::{contracts, history};
use crate::{
    Error, Shared, Workspace,
    auth::Principal,
    error,
    opencode::Endpoint,
    worktrees::{
        self,
        ownership::{DirectoryProof, HistoryInventory},
    },
};

pub(super) async fn handle(
    app: Shared,
    principal: Principal,
    id: String,
    action: &str,
    req: Request,
) -> Result<Response, Error> {
    let ranked = action == "ranked";
    let delta = if ranked { 65_536 } else { 16_384 };
    let invalid =
        || error(Status::BAD_REQUEST, if ranked { "Invalid ranked history query" } else { "Invalid history query" });
    let (parts, body) = req.into_parts();
    if let Some(kind) = parts.headers.get(header::CONTENT_TYPE) {
        let essence = kind.to_str().unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if !matches!(essence.as_str(), "application/json" | "text/plain") {
            return Err(crate::shared::fastify::error(
                Status::UNSUPPORTED_MEDIA_TYPE,
                "FST_ERR_CTP_INVALID_MEDIA_TYPE",
                "Unsupported Media Type",
            ));
        }
    }
    let bytes = to_bytes(body, delta).await.map_err(|_| {
        crate::shared::fastify::error(
            Status::PAYLOAD_TOO_LARGE,
            "FST_ERR_CTP_BODY_TOO_LARGE",
            "Request body is too large",
        )
    })?;
    let mut input: Value = match crate::shared::fastify::body(&parts.headers, &bytes)? {
        Some(crate::shared::fastify::Body::Json(value)) => value,
        Some(crate::shared::fastify::Body::Text(_)) | None => return Err(invalid()),
    };
    if ranked {
        for key in ["version", "limit"] {
            if let Some(value) = input.get_mut(key)
                && value.is_f64()
                && let Some(number) = value.as_f64().filter(|n| (0. ..=40.).contains(n) && n.fract() == 0.)
            {
                *value = json!(number as u64);
            }
        }
    }
    if !contracts::valid(contracts::get(action, false), &input) {
        return Err(invalid());
    }
    let Some(options) = input.as_object_mut() else { return Err(invalid()) };
    let token =
        options.remove("cursor").and_then(|cursor| cursor.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
    options.entry("includeTechnical").or_insert(json!(!ranked));
    if ranked {
        if !ranked::valid_dates(options.get("since"), options.get("until")) {
            return Err(invalid());
        }
        options.entry("limit").or_insert(json!(10));
    } else {
        options.entry("query").or_insert(json!(""));
        options.entry("purpose").or_insert(json!("search"));
        if input["purpose"] == "prune" && input.get("sessionID").is_none() {
            return Err(invalid());
        }
    }
    let workspace = app.workspace(&id).map_err(|_| error(Status::NOT_FOUND, "Workspace not found"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let root = display(&workspace.path);
    let run = async {
        let Ok(endpoint) = app.native.acquire(deadline).await else { return Ok(blocked()) };
        let scope = Scope { app: &app, workspace, endpoint, root, deadline, inventory: Mutex::new(None) };
        let result = if ranked {
            ranked::run(&scope, input, token.as_deref()).await
        } else {
            query(&scope, input, token.as_deref()).await
        };
        principal.live()?;
        result
    };
    tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout_at(deadline, run) => result.unwrap_or_else(|_| Ok(blocked())),
    }
}

fn blocked() -> Response {
    Json(json!({"status":"blocked","reason":"unavailable"})).into_response()
}
fn location_denied() -> Error {
    error(Status::FORBIDDEN, "History location does not belong to workspace")
}
fn display(path: &Path) -> Arc<AtomicBool> {
    worktrees::fence::capture_display(&worktrees::fence::identity(path))
}

struct Scope<'a> {
    app: &'a Shared,
    workspace: Workspace,
    endpoint: Arc<Endpoint>,
    root: Arc<AtomicBool>,
    deadline: Instant,
    inventory: Mutex<Option<(u64, Arc<HistoryInventory>)>>,
}
struct Owned {
    directory: String,
    path: PathBuf,
    anchor: PathBuf,
    identity: same_file::Handle,
    proof: DirectoryProof,
    fence: Arc<AtomicBool>,
    inventory_rev: u64,
}
impl Owned {
    fn current_local(&self, scope: &Scope<'_>) -> bool {
        self.fence.load(Relaxed)
            && scope.current()
            && worktrees::ownership::resolve_media_path(&scope.app.scope, &self.directory)
                .is_some_and(|(path, anchor)| path == self.path && anchor == self.anchor)
            && same_file::Handle::from_path(&self.anchor).is_ok_and(|identity| identity == self.identity)
            && self.proof.history_live(&scope.workspace.path, &self.path)
    }
}
impl Scope<'_> {
    fn current(&self) -> bool {
        self.root.load(Relaxed)
            && self.app.native.current(&self.endpoint)
            && super::permission_mode::workspace_current(self.app, &self.workspace)
    }
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    async fn owned_current(&self, owned: &Owned) -> bool {
        if !owned.current_local(self) {
            return false;
        }
        if worktrees::inventory_revision(self.app) == owned.inventory_rev {
            return true;
        }
        self.own(&owned.directory).await.is_some()
    }
    async fn own(&self, directory: &str) -> Option<Owned> {
        let (path, anchor) = worktrees::ownership::resolve_media_path(&self.app.scope, directory)?;
        let identity = same_file::Handle::from_path(&anchor).ok()?;
        let fence = display(&anchor);
        let (inventory_rev, inventory) = self.inventory().await?;
        let proof = inventory.prove(&self.workspace.path, &path)?;
        let owned = Owned { directory: directory.into(), path, anchor, identity, proof, fence, inventory_rev };
        owned.current_local(self).then_some(owned)
    }
    async fn inventory(&self) -> Option<(u64, Arc<HistoryInventory>)> {
        let rev = worktrees::inventory_revision(self.app);
        let mut guard = self.inventory.lock().await;
        if let Some((cached_rev, inv)) = guard.as_ref()
            && *cached_rev == rev
        {
            return Some((*cached_rev, inv.clone()));
        }
        let loaded = Arc::new(HistoryInventory::load(self.app, &self.workspace).await?);
        let loaded_rev = worktrees::inventory_revision(self.app);
        *guard = Some((loaded_rev, loaded.clone()));
        Some((loaded_rev, loaded))
    }
    /// Matches TS `session-history.ts:67-72` & `session-history-ranked.ts:73-75`: for any non-root
    /// worktree target, resolve native `GET /api/location` and confirm it echoes the exact owned
    /// directory with no `workspaceID` before preparing plugins or calling the history RPC.
    async fn verify_native_location(&self, directory: &str, include_header: bool) -> Result<(), Option<Error>> {
        if self.workspace.location["directory"].as_str() == Some(directory) {
            return Ok(());
        }
        let left = self.remaining();
        if left.is_zero() || !self.current() {
            return Err(None);
        }
        let mut req = self
            .app
            .native
            .client
            .get(self.endpoint.url.join("/api/location").map_err(|_| None)?)
            .basic_auth("opencode", Some(&self.endpoint.password))
            .query(&[("location[directory]", directory)])
            .timeout(left);
        if include_header {
            req = req.header("x-opencode-directory", crate::sessions::media::encode(directory));
        }
        let response = req.send().await.map_err(|_| None)?;
        if !self.current() || !response.status().is_success() {
            return Err(None);
        }
        let raw = crate::opencode::read_json(response, 128 * 1024).await.map_err(|_| None)?;
        let loc = raw.get("data").unwrap_or(&raw);
        if !self.current() {
            return Err(None);
        }
        if loc.get("workspaceID").is_some() || loc["directory"].as_str() != Some(directory) {
            return Err(Some(location_denied()));
        }
        let rechecked = self.own(directory).await;
        if !self.current() {
            return Err(None);
        }
        if rechecked.is_none() {
            return Err(Some(location_denied()));
        }
        Ok(())
    }
    async fn directories(&self) -> Option<Vec<String>> {
        let root = self.workspace.location["directory"].as_str()?.to_owned();
        let mut all = vec![root.clone()];
        all.extend(self.inventory().await?.1.directories().map(str::to_owned));
        all.sort();
        all.dedup();
        let normalized = |directory: &str| {
            let directory = if cfg!(windows) { directory.replace('\\', "/") } else { directory.to_owned() };
            directory.trim_end_matches('/').to_owned()
        };
        let paths: Vec<_> = all.iter().map(|directory| normalized(directory)).collect();
        let dirs = all
            .into_iter()
            .enumerate()
            .filter_map(|(index, directory)| {
                (!paths.iter().enumerate().any(|(i, parent)| {
                    i != index && paths[index].strip_prefix(parent).is_some_and(|suffix| suffix.starts_with('/'))
                }))
                .then_some(directory)
            })
            .collect();
        self.current().then_some(dirs)
    }
    async fn call(&self, owned: &Owned, method: &str, input: &Value, source: Option<(&str, &Value)>) -> Option<Call> {
        let ready = self.deadline.min(Instant::now() + Duration::from_secs(5));
        history::prepare(self.app, &self.endpoint, &owned.directory, ready).await?;
        if !self.session_current(source).await || !self.owned_current(owned).await {
            return None;
        }
        let left = self.remaining();
        let (status, bytes) =
            history::rpc_with_timeout(self.app, &self.endpoint, &owned.directory, method, input, left).await.ok()?;
        if !self.session_current(source).await || !self.owned_current(owned).await {
            return None;
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        if status == Status::BAD_REQUEST
            && crate::opencode::native_rpc_absent(&value, status)
            && value["type"] == "rpc.method_not_found"
        {
            return Some(Call::Unsupported);
        }
        if !status.is_success() {
            return None;
        }
        let mut output = value.get("output")?.clone();
        let action = if method == "historyRanked" { "ranked" } else { "query" };
        if action == "ranked" && output["status"] == "ranked" {
            let result = output.as_object_mut()?;
            for (key, fallback) in [
                ("prefilterBypassed", json!(0)),
                ("examinedBefore", json!(0)),
                ("cursor", Value::Null),
                ("exclusions", json!([])),
            ] {
                result.entry(key).or_insert(fallback);
            }
            for owner in result.get_mut("sessions")?.as_array_mut()? {
                owner.as_object_mut()?.entry("prefilterBypassed").or_insert(json!(0));
            }
        }
        contracts::valid(contracts::get(action, true), &output).then_some(Call::Result(output))
    }
    async fn session_current(&self, source: Option<(&str, &Value)>) -> bool {
        match source {
            None => true,
            Some((session, before)) => {
                let left = self.remaining();
                if left.is_zero() {
                    return false;
                }
                crate::opencode::session_record_opaque_at(
                    self.app,
                    &self.endpoint,
                    session,
                    left,
                    true,
                    16 * 1024 * 1024,
                )
                .await
                .is_ok_and(|current| {
                    current["location"]["directory"] == before["location"]["directory"]
                        && current["location"].get("workspaceID") == before["location"].get("workspaceID")
                })
            }
        }
    }
    async fn filter<'s>(&self, sessions: &'s [Value], session: Option<&str>) -> Option<Vec<&'s Value>> {
        let mut owners = BTreeMap::<&str, Option<Owned>>::new();
        for owner in sessions {
            if session.is_some_and(|id| owner["sessionID"] != id) {
                return None;
            }
            if owner.get("workspaceID").is_some() {
                continue;
            }
            let directory = owner["directory"].as_str()?;
            if !owners.contains_key(directory) {
                owners.insert(directory, self.own(directory).await);
            }
        }
        if !self.current() {
            return None;
        }
        let mut out = Vec::with_capacity(sessions.len());
        for owner in sessions {
            if owner.get("workspaceID").is_none()
                && let Some(dir) = owner["directory"].as_str()
                && let Some(owned) = owners.get(dir).and_then(Option::as_ref)
                && self.owned_current(owned).await
            {
                out.push(owner);
            }
        }
        Some(out)
    }
}
enum Call {
    Result(Value),
    Unsupported,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryCursor {
    directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<String>,
    binding: String,
}

async fn query(scope: &Scope<'_>, mut input: Value, token: Option<&str>) -> Result<Response, Error> {
    let session = input["sessionID"].as_str().map(str::to_owned);
    let source = if let Some(session) = &session {
        let left = scope.remaining();
        if left.is_zero() {
            return Ok(blocked());
        }
        let Ok(record) = crate::opencode::session_record_opaque_at(
            scope.app,
            &scope.endpoint,
            session,
            left,
            true,
            16 * 1024 * 1024,
        )
        .await
        else {
            return Ok(blocked());
        };
        if record["location"].get("workspaceID").is_some() {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        let Some(directory) = record["location"]["directory"].as_str() else { return Ok(blocked()) };
        let owned = scope.own(directory).await;
        if !scope.current() {
            return Ok(blocked());
        }
        if owned.is_none() {
            return Err(error(Status::FORBIDDEN, "Session does not belong to workspace"));
        }
        Some(record)
    } else {
        None
    };
    let directories = if let Some(record) = &source {
        vec![record["location"]["directory"].as_str().unwrap_or_default().to_owned()]
    } else {
        let Some(directories) = scope.directories().await else { return Ok(blocked()) };
        directories
    };
    let binding = cursor::digest(&json!([
        scope.workspace.id,
        session,
        input["query"],
        input["includeTechnical"],
        input["purpose"],
        directories
    ]));
    let invalid = || error(Status::BAD_REQUEST, "Invalid history cursor");
    let (index, page) = if let Some(token) = token {
        let cursor: QueryCursor = cursor::decode(token).ok_or_else(invalid)?;
        if cursor.binding != binding || cursor.page.as_ref().is_some_and(|page| page.encode_utf16().count() > 4096) {
            return Err(invalid());
        }
        (directories.iter().position(|directory| directory == &cursor.directory).ok_or_else(invalid)?, cursor.page)
    } else {
        (0, None)
    };
    let directory = directories.get(index).ok_or_else(|| error(Status::NOT_FOUND, "History location not found"))?;
    let owned = scope.own(directory).await;
    if !scope.current() {
        return Ok(blocked());
    }
    let owned = owned.ok_or_else(location_denied)?;
    if source.is_none() {
        match scope.verify_native_location(directory, false).await {
            Ok(()) => {}
            Err(Some(err)) => return Err(err),
            Err(None) => return Ok(blocked()),
        }
    }
    if let Some(page) = page {
        input["cursor"] = json!(page);
    }
    let Some(Call::Result(mut output)) =
        scope.call(&owned, "history", &input, session.as_deref().zip(source.as_ref())).await
    else {
        return Ok(blocked());
    };
    if output["status"] != "page" {
        return Ok(Json(output).into_response());
    }
    let owners = output.as_object_mut().and_then(|out| out.remove("sessions")).unwrap_or_default();
    let Some(approved) = scope.filter(list(&owners), session.as_deref()).await else { return Ok(blocked()) };
    if !scope.owned_current(&owned).await {
        return Ok(blocked());
    }
    let ids: HashSet<_> = approved.iter().filter_map(|owner| owner["sessionID"].as_str()).collect();
    let next = output["cursor"]
        .as_str()
        .filter(|page| !page.is_empty())
        .map(|page| (directory.clone(), Some(page.to_owned())))
        .or_else(|| directories.get(index + 1).map(|directory| (directory.clone(), None)));
    for key in ["scanned", "tools", "reasoning", "skipped"] {
        let Some(count) = sum(&approved, key) else { return Ok(blocked()) };
        output[key] = json!(count);
    }
    output["hits"] = json!(
        list(&output["hits"])
            .iter()
            .filter(|hit| hit["sessionID"].as_str().is_some_and(|id| ids.contains(id)))
            .collect::<Vec<_>>()
    );
    if !session.as_deref().is_some_and(|session| ids.contains(session)) {
        output["candidates"] = json!([]);
    }
    output["cursor"] =
        json!(next.and_then(|(directory, page)| cursor::encode(&QueryCursor { directory, page, binding })));
    Ok(Json(output).into_response())
}
fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn sum(entries: &[&Value], field: &str) -> Option<u64> {
    entries.iter().try_fold(0u64, |count, entry| count.checked_add(entry[field].as_u64()?))
}
