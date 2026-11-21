use super::{
    bridge::{current_root, dir, session},
    creation_admission::Scope,
    run::{bad, foreign, held, id},
};
use crate::{App, Error};
use axum::http::{Method, StatusCode as Status};
use serde_json::{Value, json};

pub(super) async fn remove(app: &App, mut scope: Scope, co: Value, request: Value) -> Result<Value, Error> {
    let field = |key, max| request[key].as_str().filter(|s| id(s, max)).ok_or_else(bad);
    let mid = field("missionID", 100)?;
    let sid = field("sessionID", 240)?;
    field("deletionID", 100)?;
    if !sid.starts_with("ses_") || co["id"] == sid || request.as_object().is_none_or(|o| o.len() != 3) {
        return Err(bad());
    }
    current_root(app, &scope, &co).await?;
    let (status, body) = scope.call(app, "cleanupTarget", &request, 10, 32 * 1024).await?;
    if !status.is_success() || !body["output"].is_object() {
        return Err(held());
    }
    let target = &body["output"]["target"];
    if target.is_null() {
        return Ok(json!({"outcome":"retained"}));
    }
    if target["sessionID"] != sid
        || target["missionID"] != mid
        || target["coordinatorSessionID"] != co["id"]
        || target["projectID"] != scope.project
        || target["location"].get("workspaceID").is_some()
    {
        return Err(foreign());
    }
    scope.add_location(app, target["location"]["directory"].as_str().ok_or_else(foreign)?).await?;
    let _permit = scope.permit().ok_or_else(held)?;
    let removed = || json!({"outcome":"removed"});
    let retain = |reason: &str| json!({"outcome":"retained","reason":reason});
    let check = |row: &Value| {
        if row["location"] != target["location"] || dir(row).is_err() {
            return Some("moved");
        }
        let meta = &row["metadata"]["codenomad.mission"];
        if !row["parentID"].is_null() || meta["version"] != 1 || meta["kind"] != "actor" || meta["missionID"] != mid {
            return Some("identity");
        }
        None
    };
    let read_target = || async {
        match session(app, &scope, sid).await {
            Ok(row) => Ok(Some(row)),
            Err(e) if e.0 == Status::NOT_FOUND => Ok(None),
            Err(e) => Err(e),
        }
    };
    let Some(row) = read_target().await? else {
        return Ok(removed());
    };
    if let Some(reason) = check(&row) {
        return Ok(retain(reason));
    }
    let children = || async {
        let (status, page) = scope
            .request(app, Method::GET, "/api/session", &[("parentID", sid), ("limit", "1")], None, 10, 128 * 1024)
            .await?;
        let rows =
            page["data"].as_array().filter(|_| status.is_success() && page["cursor"].is_object()).ok_or_else(held)?;
        if rows.is_empty() && !page["cursor"]["next"].is_null() {
            return Err(held());
        }
        Ok(!rows.is_empty())
    };
    if children().await? {
        return Ok(retain("children"));
    }
    scope.refresh(app).await?;
    current_root(app, &scope, &co).await?;
    let (status, fresh) = scope.call(app, "cleanupTarget", &request, 10, 32 * 1024).await?;
    if !status.is_success() || fresh["output"]["target"] != *target {
        return Err(held());
    }
    if children().await? {
        return Ok(retain("children"));
    }
    let Some(row) = read_target().await? else {
        return Ok(removed());
    };
    if let Some(reason) = check(&row) {
        return Ok(retain(reason));
    }
    // OpenCode owns recursive deletion. The same target is proven childless
    // and still owned; a lost acknowledgement is never guessed "removed".
    let (status, body) =
        scope.request(app, Method::DELETE, &format!("/api/session/{sid}"), &[], None, 15, 128 * 1024).await?;
    if status.is_success()
        || status == Status::NOT_FOUND && body["_tag"] == "SessionNotFoundError" && body["sessionID"] == sid
    {
        return Ok(removed());
    }
    Err(held())
}
