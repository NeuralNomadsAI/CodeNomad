//! Prompt attachment admission from `server/prompt-attachment-budget.ts` and
//! `http-server.ts::readPromptFilePaths`; native fields keep their upstream validation.
use crate::{App, Error, Workspace, error, shared::decode_component};
use axum::http::{HeaderMap, StatusCode as Status, header};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub const BODY_LIMIT: usize = 32 * 1024 * 1024;
const FILE_LIMIT: usize = 5 * 1024 * 1024;
const TOTAL_LIMIT: usize = 20 * 1024 * 1024;

pub(super) fn parse(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Session input requires a JSON object");
    if bytes.is_empty() {
        return Ok(serde_json::json!({}));
    }
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(invalid());
    }
    let data: Value = serde_json::from_slice(bytes).map_err(|_| {
        (
            Status::BAD_REQUEST,
            axum::Json(serde_json::json!({
                "statusCode":400,"error":"Bad Request","message":"Invalid JSON request body"
            })),
        )
    })?;
    if !data.is_object() { Err(invalid()) } else { Ok(data) }
}

fn invalid_data() -> Error {
    error(Status::BAD_REQUEST, "Prompt attachment data is invalid")
}
fn invalid_file() -> Error {
    error(Status::BAD_REQUEST, "Prompt file does not belong to workspace")
}
fn inline_size(uri: &str) -> Option<usize> {
    let (metadata, payload) = uri.get(5..)?.split_once(',')?;
    static BASE64: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i);base64(?:;|$)").unwrap());
    if BASE64.is_match(metadata) {
        let plain = payload.trim_end_matches('=');
        let padding = payload.len() - plain.len();
        if payload.len() % 4 != 0
            || padding > 2
            || !plain.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        {
            return None;
        }
        Some(payload.len() / 4 * 3 - padding)
    } else {
        Some(decode_component(payload)?.len())
    }
}

/// Count only `files[].uri` data bodies, as the reference does; `source` stays native input.
fn inline_budget(files: &[Value]) -> Result<(), Error> {
    let (mut count, mut total) = (0, 0);
    for uri in files.iter().filter_map(|file| file["uri"].as_str()) {
        if !uri.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:")) {
            continue;
        }
        let size = inline_size(uri).ok_or_else(invalid_data)?;
        count += 1;
        total += size;
        if size > FILE_LIMIT || count > 10 || total > TOTAL_LIMIT {
            return Err(error(Status::PAYLOAD_TOO_LARGE, "Prompt attachments exceed the supported limits"));
        }
    }
    Ok(())
}

pub(super) fn budget(body: &Value) -> Result<(), Error> {
    match body.get("files").and_then(Value::as_array) {
        Some(files) => inline_budget(files),
        None => Ok(()),
    }
}

/// Known public authority selectors retain the reference's validation even though
/// native prompt fields are forwarded transparently.
pub(super) fn locations(body: &Value, default: &str) -> Result<Vec<String>, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Location does not belong to workspace");
    let mut directories = Vec::new();
    let mut add = |directory: Option<&Value>| -> Result<(), Error> {
        let directory = match directory {
            None | Some(Value::Null) => default,
            Some(value) => value.as_str().ok_or_else(invalid)?,
        };
        if crate::shared::js_trim(directory).is_empty() || directory.contains('\0') {
            return Err(invalid());
        }
        directories.push(directory.into());
        Ok(())
    };
    if body.get("workspace").is_some() || body.get("workspaceID").is_some() {
        return Err(invalid());
    }
    if body.get("directory").is_some() {
        add(body.get("directory"))?;
    }
    if let Some(location) = body.get("location").filter(|value| !value.is_null()) {
        let location = location.as_object().ok_or_else(invalid)?;
        if location.contains_key("workspace") || location.contains_key("workspaceID") {
            return Err(invalid());
        }
        add(location.get("directory"))?;
    }
    Ok(directories)
}

pub(super) fn context(value: &Value) -> Result<&str, Error> {
    let invalid = || error(Status::BAD_REQUEST, "Invalid location context");
    let object = value.as_object().filter(|object| object.len() == 1).ok_or_else(invalid)?;
    object
        .get("directory")
        .and_then(Value::as_str)
        .filter(|directory| !crate::shared::js_trim(directory).is_empty() && !directory.contains('\0'))
        .ok_or_else(invalid)
}

fn file_path(uri: &str) -> Result<Option<String>, Error> {
    use crate::files::node_path::Style;
    if Style::host().is_absolute(uri) || Style::Win32.is_absolute(uri) {
        return if uri.contains('\0') { Err(invalid_file()) } else { Ok(Some(uri.into())) };
    }
    let parsed = reqwest::Url::parse(uri).map_err(|_| invalid_file())?;
    match parsed.scheme() {
        "data" | "http" | "https" => Ok(None),
        "file" => {
            if parsed.host_str().is_some_and(|s| s != "localhost")
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || parsed.path().to_ascii_lowercase().contains("%2f")
                || parsed.path().to_ascii_lowercase().contains("%5c")
            {
                return Err(invalid_file());
            }
            let decoded = decode_component(parsed.path()).ok_or_else(invalid_file)?;
            let bytes = decoded.as_bytes();
            let local =
                if bytes.len() >= 4 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2..4] == *b":/" {
                    &decoded[1..]
                } else {
                    &decoded
                };
            if local.is_empty() || local.contains('\0') { Err(invalid_file()) } else { Ok(Some(local.into())) }
        }
        _ => Err(invalid_file()),
    }
}

fn physical(scope: &Path, candidate: &str) -> Option<PathBuf> {
    // Refuse lexical network/device forms before physical reads.
    let normalized = crate::files::node_path::Style::host().normalize(candidate);
    if !crate::files::paths::under(scope, Path::new(&normalized)) {
        return None;
    }
    // Resolve exactly the path forwarded to native, including physical symlink/.. semantics.
    dunce::canonicalize(candidate).ok().filter(|target| target.starts_with(scope))
}

async fn owns_physical(app: &App, workspace: &Workspace, target: &Path) -> bool {
    if target.starts_with(&workspace.path) {
        return dunce::canonicalize(&workspace.path).ok().as_ref() == Some(&workspace.path);
    }
    crate::worktrees::linked::catalogue(app, workspace, false)
        .await
        .is_ok_and(|catalogue| catalogue.trees.iter().any(|tree| tree.contains_live(target)))
}

pub(super) async fn directory(app: &App, workspace: &Workspace, candidate: &str) -> Result<String, Error> {
    let foreign = || error(Status::FORBIDDEN, "Location does not belong to workspace");
    let candidate = crate::shared::js_trim(candidate);
    let normalized = crate::files::node_path::Style::host().normalize(candidate);
    if !crate::files::paths::under(&app.scope, Path::new(&normalized)) {
        return Err(foreign());
    }
    let target = crate::worktrees::ownership::resolve_directory(candidate)
        .filter(|target| target.starts_with(&app.scope))
        .ok_or_else(foreign)?;
    if !owns_physical(app, workspace, &target).await {
        return Err(foreign());
    }
    target.to_str().map(str::to_owned).ok_or_else(foreign)
}

pub(super) fn translate(body: &mut Value, directories: &BTreeMap<String, String>) {
    let replace = |value: &mut Value| {
        if let Some(directory) = value.as_str().and_then(|directory| directories.get(directory)) {
            *value = Value::String(directory.clone());
        }
    };
    for key in ["directory", "cwd"] {
        if let Some(value) = body.get_mut(key) {
            replace(value);
        }
    }
    if let Some(value) = body.get_mut("location").and_then(|location| location.get_mut("directory")) {
        replace(value);
    }
}

pub async fn validate(app: &App, workspace: &Workspace, body: &serde_json::Map<String, Value>) -> Result<(), Error> {
    let Some(files) = body.get("files") else { return Ok(()) };
    let files = files.as_array().ok_or_else(invalid_file)?;
    let paths = files
        .iter()
        .map(|file| {
            let uri = file
                .as_object()
                .and_then(|file| file.get("uri"))
                .and_then(Value::as_str)
                .filter(|uri| !crate::shared::js_trim(uri).is_empty())
                .ok_or_else(invalid_file)?;
            file_path(uri)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for path in paths.iter().flatten() {
        let target = physical(&app.scope, path);
        if target.is_none() || !owns_physical(app, workspace, target.as_deref().ok_or_else(invalid_file)?).await {
            return Err(error(Status::FORBIDDEN, "Prompt file does not belong to workspace"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[cfg(unix)]
    fn raw_parent_after_a_symlink_keeps_physical_authority() {
        let base = crate::shared::test_dir("prompt-raw-parent");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(outside.join("sub")).unwrap();
        std::fs::write(root.join("file"), "owned").unwrap();
        std::fs::write(outside.join("file"), "foreign").unwrap();
        std::os::unix::fs::symlink(outside.join("sub"), root.join("link")).unwrap();
        let raw = root.join("link/../file");
        assert_eq!(physical(&base, raw.to_str().unwrap()), Some(outside.join("file")));
        assert!(physical(&root, raw.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn data_sizes_follow_javascript_budget() {
        for (uri, expected) in [
            ("data:;base64,", Some(0)),
            ("DATA:;BASE64,AA==", Some(1)),
            ("data:;base64,abc", None),
            ("data:;base64,AB==", Some(1)),
            ("data:,é", Some(2)),
            ("data:,%C3%A9", Some(2)),
            ("data:,%zz", None),
            ("data:,%ED%A0%80", None),
        ] {
            assert_eq!(inline_size(uri), expected, "{uri}");
        }
        assert_eq!(inline_budget(&vec![json!({"uri":"data:,a"}); 10]).is_ok(), true);
        assert_eq!(inline_budget(&vec![json!({"uri":"data:,a"}); 11]).unwrap_err().0, Status::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn file_uri_paths_preserve_encoded_names() {
        assert_eq!(file_path("file:///D:/a%20b%23%25.txt").unwrap(), Some("D:/a b#%.txt".into()));
        assert!(file_path("https://fixture.invalid/a").unwrap().is_none());
        for uri in [
            "relative.txt",
            "file://foreign/a",
            "file:///D:/a%2fb",
            "file:///D:/a?x",
            "file:///D:/a#x",
            "file:///D:/%zz",
        ] {
            assert!(file_path(uri).is_err(), "{uri}");
        }
    }
}
