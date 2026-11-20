//! Session-list cursors: a continuation keeps the native scope it was issued for.
use axum::http::StatusCode as Status;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde_json::Value;

use crate::{Error, error};
#[derive(Debug)]
pub enum CursorScope {
    Directory,
    Project(String),
}

// Continuations carry the complete scope; caller-supplied replacement selectors
// cannot widen or replace the scope embedded in the native token.
pub fn authorize_cursor(target: &mut Url, directory: &str) -> Result<Option<CursorScope>, Error> {
    let bad = || error(Status::BAD_REQUEST, "Session list does not belong to workspace");
    let pairs: Vec<_> = target.query_pairs().into_owned().collect();
    let mut cursors = pairs.iter().filter(|(key, _)| key == "cursor");
    let Some((_, cursor)) = cursors.next() else { return Ok(None) };
    if cursors.next().is_some() || cursor.is_empty() || cursor.len() > 65536 {
        return Err(bad());
    }
    let decoded = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| bad())?;
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| bad())?;
    let Some(fields) = value.as_object() else { return Err(bad()) };
    let anchor = &value["anchor"];
    if fields.contains_key("workspaceID")
        || fields.contains_key("workspace")
        || !anchor["id"].as_str().is_some_and(|s| !s.is_empty())
        || !anchor["time"].is_number()
        || !matches!(anchor["direction"].as_str(), Some("next" | "previous"))
        || fields.get("search").is_some_and(|v| !v.is_string())
        || fields.get("order").is_some_and(|v| !matches!(v.as_str(), Some("asc" | "desc")))
        || fields.get("parentID").is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(bad());
    }
    let foreign = || error(Status::FORBIDDEN, "Session list does not belong to workspace");
    let resolved = if let Some(scope) = value["directory"].as_str().filter(|s| !s.trim().is_empty()) {
        if fields.contains_key("project") || fields.contains_key("subpath") {
            return Err(bad());
        }
        if scope != directory {
            return Err(foreign());
        }
        CursorScope::Directory
    } else if let Some(project) = value["project"].as_str().filter(|s| !s.trim().is_empty()) {
        if fields.contains_key("directory") || fields.get("subpath").is_some_and(|p| !p.is_string()) {
            return Err(bad());
        }
        if let Some(path) = value["subpath"].as_str() {
            if !safe_subpath(path) {
                return Err(bad());
            }
            if !matches!(path, "" | ".") {
                return Err(foreign());
            }
        }
        CursorScope::Project(project.into())
    } else {
        return Err(bad());
    };
    target.set_query(None);
    target.query_pairs_mut().extend_pairs(
        pairs
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "directory" | "location[directory]" | "project" | "subpath")),
    );
    Ok(Some(resolved))
}

pub fn safe_subpath(path: &str) -> bool {
    !path.starts_with(['/', '\\']) && !path.contains(':') && !path.split(['/', '\\']).any(|part| part == "..")
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(scoped: Value) -> Url {
        let mut url = Url::parse("http://127.0.0.1:1234/api/session").unwrap();
        url.query_pairs_mut()
            .append_pair("cursor", &URL_SAFE_NO_PAD.encode(scoped.to_string()))
            .append_pair("directory", "/other");
        url
    }

    #[test]
    fn directory_cursor_keeps_only_native_scope() {
        let mut req = target(json!({"directory":"/owned","anchor":{"id":"ses_x","time":15,"direction":"next"}}));
        assert!(matches!(authorize_cursor(&mut req, "/owned").unwrap(), Some(CursorScope::Directory)));
        assert_eq!(req.query_pairs().count(), 1);
        assert_eq!(req.query_pairs().next().unwrap().0, "cursor");
    }

    #[test]
    fn foreign_and_invalid_cursors_fail_before_dispatch() {
        let valid = json!({"directory":"/owned","anchor":{"id":"ses_x","time":15,"direction":"next"}});
        assert_eq!(authorize_cursor(&mut target(valid.clone()), "/other").unwrap_err().0, Status::FORBIDDEN);
        let mut conflict = valid.clone();
        conflict["workspaceID"] = json!("workspace");
        assert_eq!(authorize_cursor(&mut target(conflict), "/owned").unwrap_err().0, Status::BAD_REQUEST);
        let mut malformed = valid;
        malformed["anchor"]["direction"] = json!("foreign");
        assert_eq!(authorize_cursor(&mut target(malformed), "/owned").unwrap_err().0, Status::BAD_REQUEST);
    }
}
