//! `POST /api/workspaces/:id/session-history/:action`: history navigation through the
//! session-pruning plugin, schema-checked both ways.
use crate::{App, Error, Shared, auth::Principal, error, unavailable};
use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::StatusCode as Status,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
pub fn pending_valid(value: &Value) -> bool {
    crate::sessions::contracts::valid(crate::sessions::contracts::get("pending", true), value)
}

struct Placement {
    workspace: crate::Workspace,
    source: Value,
    /// Physical checkout of the session's owned location (root or linked worktree).
    path: std::path::PathBuf,
    physical: same_file::Handle,
}

impl Placement {
    async fn admit(app: &App, id: &str, session: &str) -> Result<Self, Error> {
        let workspace = app.workspace(id)?;
        let source = crate::opencode::session_record(app, session).await?;
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
        Ok(Self { workspace, source, path, physical })
    }
    async fn current(&self, app: &App, id: &str, session: &str) -> bool {
        let Ok(newest) = crate::opencode::session_record(app, session).await else { return false };
        newest["id"] == self.source["id"]
            && newest["location"] == self.source["location"]
            && newest["projectID"] == self.source["projectID"]
            && newest["revert"] == self.source["revert"]
            && app.workspace(id).is_ok_and(|w| w.id == self.workspace.id && w.path == self.workspace.path)
            && same_file::Handle::from_path(&self.path).is_ok_and(|physical| physical == self.physical)
    }
}

async fn rpc(app: &App, directory: &str, method: &str, input: &Value) -> Result<(Status, Value), ()> {
    let response = app
        .native
        .rpc(&format!("codenomad.session-pruning/{method}"), directory, input)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| ())?;
    let status = response.status();
    Ok((status, crate::opencode::read_json(response, 24 * 1024 * 1024).await?))
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
    let (method, limit) = match action.as_str() {
        "outline" => ("outlineLayout", 96 * 1024),
        "outlinePreview" => ("outlinePreview", 8192),
        "window" => ("window", 8192),
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
        let directory = placement.source["location"]["directory"].as_str().unwrap();
        // Reference: `desktopPluginsReady` for the session's own Location, which
        // may be a linked worktree the plugin has not served yet.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        if crate::sessions::pending::await_plugin(
            &app,
            crate::sessions::pending::SESSION_PRUNING_PLUGIN,
            directory,
            deadline,
        )
        .await
        .is_err()
            || crate::extensions::lifecycle::ready(directory, deadline).await.is_err()
            || !placement.current(&app, &id, session).await
        {
            return blocked("unavailable");
        }
        let Ok((mut status, mut body)) = rpc(&app, directory, method, &input).await else {
            return blocked("unavailable");
        };
        if action == "outline"
            && status == Status::BAD_REQUEST
            && body["_tag"] == "RpcError"
            && body["type"] == "rpc.method_not_found"
        {
            if !placement.current(&app, &id, session).await {
                return blocked("conflict");
            }
            let Ok(fallback) = rpc(&app, directory, "outline", &input).await else { return blocked("unavailable") };
            (status, body) = fallback;
        }
        let output = &body["output"];
        if !status.is_success()
            || !crate::sessions::contracts::valid(crate::sessions::contracts::get(&action, true), output)
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
        if defer && action == "window" && has_large_tool_image(output) {
            return blocked("unavailable");
        }
        if !placement.current(&app, &id, session).await {
            return blocked("conflict");
        }
        Json(output.clone()).into_response()
    };
    tokio::select! {
        _ = principal.0.cancelled() => Err(crate::auth::unauthorized()),
        result = tokio::time::timeout(Duration::from_secs(15),request) => Ok(result.unwrap_or_else(|_| blocked("unavailable"))),
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
