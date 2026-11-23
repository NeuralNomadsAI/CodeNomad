//! `POST /api/workspaces/:id/session-history/:action`: history navigation through the
//! session-pruning plugin, schema-checked both ways.
use super::user_files;
use crate::{App, Error, Shared, auth::Principal, error, unavailable};
use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use serde_json::{Value, json, value::RawValue};
use std::{sync::Arc, time::Duration};
pub fn pending_valid(value: &Value) -> bool {
    crate::sessions::contracts::valid(crate::sessions::contracts::get("pending", true), value)
}

struct Placement {
    workspace: crate::Workspace,
    endpoint: Arc<crate::opencode::Endpoint>,
    source: Value,
    /// Physical checkout of the session's owned location (root or linked worktree).
    path: std::path::PathBuf,
    physical: same_file::Handle,
}

impl Placement {
    async fn admit(app: &App, id: &str, session: &str) -> Result<Self, Error> {
        let workspace = app.workspace(id)?;
        let endpoint = app.native.endpoint().ok_or_else(crate::opencode::upstream_error)?;
        let source = crate::opencode::session_record_at(app, &endpoint, session).await?;
        // Reference: `ownsLocation(id, session.location)`, linked worktrees included.
        let unavailable = || error(Status::SERVICE_UNAVAILABLE, "History placement unavailable");
        match crate::worktrees::placement(app, &workspace, &source["location"]).await {
            Ok(_) => {}
            Err(true) => return Err(error(Status::FORBIDDEN, "Session does not belong to workspace")),
            Err(false) => return Err(unavailable()),
        }
        let path = source["location"]["directory"]
            .as_str()
            .and_then(|d| dunce::canonicalize(d).ok())
            .ok_or_else(unavailable)?;
        let physical = same_file::Handle::from_path(&path).map_err(|_| unavailable())?;
        Ok(Self { workspace, endpoint, source, path, physical })
    }
    async fn current(&self, app: &App, id: &str, session: &str) -> bool {
        let Ok(newest) = crate::opencode::session_record_at(app, &self.endpoint, session).await else { return false };
        newest["id"] == self.source["id"]
            && newest["location"] == self.source["location"]
            && newest["projectID"] == self.source["projectID"]
            && newest["revert"] == self.source["revert"]
            && self.live(app, id)
    }

    fn live(&self, app: &App, id: &str) -> bool {
        app.native.endpoint().is_some_and(|endpoint| Arc::ptr_eq(&endpoint, &self.endpoint))
            && app.workspace(id).is_ok_and(|w| w.id == self.workspace.id && w.path == self.workspace.path)
            && self.source["location"]["directory"]
                .as_str()
                .and_then(|directory| dunce::canonicalize(directory).ok())
                .as_ref()
                == Some(&self.path)
            && same_file::Handle::from_path(&self.path).is_ok_and(|physical| physical == self.physical)
    }

    async fn ready(&self, app: &App, id: &str, session: &str) -> Option<&str> {
        let directory = self.source["location"]["directory"].as_str()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        crate::sessions::pending::await_plugin(
            app,
            crate::sessions::pending::SESSION_PRUNING_PLUGIN,
            directory,
            deadline,
        )
        .await
        .ok()?;
        crate::extensions::lifecycle::ready(directory, deadline).await.ok()?;
        self.current(app, id, session).await.then_some(directory)
    }
}

async fn rpc(
    app: &App,
    endpoint: &crate::opencode::Endpoint,
    directory: &str,
    method: &str,
    input: &Value,
) -> Result<(Status, Bytes), ()> {
    let response = app
        .native
        .client
        .post(endpoint.url.join(&format!("/api/rpc/codenomad.session-pruning/{method}")).map_err(|_| ())?)
        .basic_auth("opencode", Some(&endpoint.password))
        .query(&[("location[directory]", directory)])
        .json(&json!({"input": input}))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    Ok((status, crate::opencode::read_bytes(response, 24 * 1024 * 1024).await?.into()))
}

#[derive(serde::Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    output: Option<&'a RawValue>,
    #[serde(rename = "_tag")]
    tag: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn blocked(reason: &str) -> Response {
    Json(json!({"status":"blocked","reason":reason})).into_response()
}

pub async fn handle(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, action)): Path<(String, String)>,
    req: Request,
) -> Result<Response, Error> {
    let reference =
        action == "window" && req.headers().get("x-codenomad-user-files").is_some_and(|v| v == user_files::REFERENCE);
    let (method, limit) = match action.as_str() {
        "outline" => ("outlineLayout", 96 * 1024),
        "outlinePreview" => ("outlinePreview", 8192),
        "window" => (if reference { "windowUserFilesV1" } else { "window" }, 8192),
        _ => return Ok(unavailable()),
    };
    let defer = req.headers().get("x-codenomad-media").is_some();
    let invalid = || error(Status::BAD_REQUEST, "Invalid history navigation request");
    let bytes = to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| error(Status::PAYLOAD_TOO_LARGE, "Request body is too large"))?;
    let schema = crate::sessions::contracts::get(&action, false);
    let input: Option<Value> = serde_json::from_slice(&bytes).ok();
    let input = input.filter(|i| crate::sessions::contracts::valid(schema, i)).ok_or_else(invalid)?;
    let session = input["sessionID"].as_str().ok_or_else(invalid)?;
    let request = async {
        let placement = match Placement::admit(&app, &id, session).await {
            Ok(placement) => placement,
            Err((Status::FORBIDDEN, body)) => return (Status::FORBIDDEN, body).into_response(),
            Err(_) => return blocked("unavailable"),
        };
        if !placement.current(&app, &id, session).await {
            return blocked("conflict");
        }
        // Reference: `desktopPluginsReady` for the session's own Location, which
        // may be a linked worktree the plugin has not served yet.
        let Some(directory) = placement.ready(&app, &id, session).await else { return blocked("unavailable") };
        let Ok((mut status, mut body)) = rpc(&app, &placement.endpoint, directory, method, &input).await else {
            return blocked("unavailable");
        };
        let Ok(mut envelope) = serde_json::from_slice::<Envelope>(&body) else { return blocked("unavailable") };
        if action == "outline"
            && status == Status::BAD_REQUEST
            && envelope.tag.as_deref() == Some("RpcError")
            && envelope.kind.as_deref() == Some("rpc.method_not_found")
        {
            if !placement.current(&app, &id, session).await {
                return blocked("conflict");
            }
            let Ok(fallback) = rpc(&app, &placement.endpoint, directory, "outline", &input).await else {
                return blocked("unavailable");
            };
            drop(envelope);
            (status, body) = fallback;
            let Ok(fallback) = serde_json::from_slice::<Envelope>(&body) else { return blocked("unavailable") };
            envelope = fallback;
        }
        let Some(raw) = envelope.output else { return blocked("unavailable") };
        let Ok(mut output) = serde_json::from_str::<Value>(raw.get()) else { return blocked("unavailable") };
        if reference && output["status"] == "window" && !user_files::validate_window(&mut output) {
            return blocked("unavailable");
        }
        if !status.is_success()
            || !crate::sessions::contracts::valid(crate::sessions::contracts::get(&action, true), &output)
        {
            return blocked("unavailable");
        }
        if output["entries"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("omitted").is_some() != item["layout"].as_str().is_some_and(|layout| layout.contains('-'))
            })
        }) {
            return blocked("unavailable");
        }
        if defer && action == "window" && has_large_tool_image(&output) {
            return blocked("unavailable");
        }
        if !placement.current(&app, &id, session).await {
            return blocked("conflict");
        }
        ([(header::CONTENT_TYPE, "application/json")], body.slice_ref(raw.get().as_bytes())).into_response()
    };
    tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15),request) => Ok(result.unwrap_or_else(|_| blocked("unavailable"))),
    }
}

pub async fn attachment(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, session, message, index, sha)): Path<(String, String, String, String, String)>,
) -> Result<Response, Error> {
    let missing = || error(Status::NOT_FOUND, "Attachment not found");
    let invalid = || error(Status::BAD_REQUEST, "Invalid attachment reference");
    let index: usize = index
        .parse::<usize>()
        .ok()
        .filter(|n| *n < user_files::FILE_COUNT && n.to_string() == index)
        .ok_or_else(invalid)?;
    if [session.as_str(), message.as_str()].iter().any(|id| id.len() > 256 || !crate::opencode::valid_id(id))
        || !user_files::valid_digest(&sha)
    {
        return Err(invalid());
    }
    let request = async {
        let placement = Placement::admit(&app, &id, &session)
            .await
            .map_err(|e| if e.0 == Status::FORBIDDEN { e } else { missing() })?;
        let directory = placement.ready(&app, &id, &session).await.ok_or_else(missing)?;
        let mut input = json!({"sessionID":session,"messageID":message,"fileIndex":index,"sha256":sha});
        let (status, body) =
            rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
        if !status.is_success() {
            return Err(missing());
        }
        let output: Value = serde_json::from_slice(&body).map_err(|_| missing())?;
        let output = &output["output"];
        if !placement.current(&app, &id, &session).await {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        if output["status"] == "too_large" {
            return Err(error(Status::PAYLOAD_TOO_LARGE, "Attachment exceeds the size limit"));
        }
        if output["status"] != "file" {
            return Err(missing());
        }
        let bytes =
            user_files::inline(&output["data"]).filter(|bytes| user_files::digest(bytes) == sha).ok_or_else(missing)?;
        input["confirm"] = true.into();
        let (status, reply) =
            rpc(&app, &placement.endpoint, directory, "sessionAttachment", &input).await.map_err(|_| missing())?;
        let reply: Value = serde_json::from_slice(&reply).map_err(|_| missing())?;
        if !status.is_success() || reply["output"]["status"] != "current" {
            return Err(missing());
        }
        principal.live()?;
        if !placement.live(&app, &id) {
            return Err(error(Status::CONFLICT, "Session location changed"));
        }
        Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "private, no-store"),
                (header::CONTENT_DISPOSITION, "attachment"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response())
    };
    tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15), request) => result.unwrap_or_else(|_| Err(missing())),
    }
}

fn has_large_tool_image(output: &Value) -> bool {
    output["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["type"] == "assistant")
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "tool")
        .flat_map(|part| part["state"]["content"].as_array().into_iter().flatten())
        .any(|part| {
            part["type"] == "file"
                && part["mime"].as_str().is_some_and(|s| s.to_ascii_lowercase().starts_with("image/"))
                && part["uri"].as_str().is_some_and(|s| s.len() > 32 * 1024)
        })
}
