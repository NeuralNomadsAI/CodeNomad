//! Panel extensions (inspected, stored and served sandboxed) and the bundled OpenCode
//! plugins: payloads (`artifact`), provisioning, readiness and their lifecycle.
pub mod artifact;
pub mod lifecycle;
pub mod provision;
pub mod readiness;

use crate::{App, Shared, auth::Principal, storage, unavailable};

pub fn routes() -> axum::Router<Shared> {
    use axum::routing::{any, get, post};
    axum::Router::new()
        .route("/api/panel-extensions", get(root).post(root))
        .route("/api/panel-extensions/inspect", post(inspect))
        .route("/api/panel-extensions/{id}", any(change))
        .route("/api/panel-extensions/{id}/panel", get(panel))
}
use axum::{
    Extension, Json,
    body::to_bytes,
    extract::{Path, Query, Request, State},
    http::{Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read},
    sync::LazyLock,
};

const ZIP_LIMIT: usize = 2 * 1024 * 1024;
const STORE_LIMIT: usize = 16 * 1024 * 1024;
const REQUEST_LIMIT: usize = ZIP_LIMIT.div_ceil(3) * 4 + 4096;
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$").unwrap());
static VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.-]{1,40})?$").unwrap());
static PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$").unwrap());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    author: String,
    license: String,
    repository: String,
    api_version: u8,
    permissions: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    manifest: Manifest,
    html: String,
    digest: String,
    global: bool,
}
type Failure = (Status, &'static str);
const INVALID: Failure = (Status::BAD_REQUEST, "invalid");
const LIMIT: Failure = (Status::PAYLOAD_TOO_LARGE, "limit");
const MISSING: Failure = (Status::NOT_FOUND, "missing");
const DISABLED: Failure = (Status::FORBIDDEN, "disabled");
const CONFLICT: Failure = (Status::CONFLICT, "conflict");
const UNAVAILABLE: Failure = (Status::SERVICE_UNAVAILABLE, "unavailable");
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|x| x.is_ascii_digit() || matches!(x, b'a'..=b'f'))
}
/// `ManifestSchema` cases whose grants this host honors: API 1, and API 4 with
/// `opencode.designAgent` alone (no host method: the backend's leases request
/// Design). Other API 4 permissions, and APIs 2 and 3, have no ported surface:
/// rejected rather than offered for install or activation.
fn ported_permissions(api: u8, permissions: &[String]) -> bool {
    let has = |p: &str| permissions.iter().any(|x| x == p);
    match api {
        1 => permissions == ["session.context"],
        4 => permissions.len() == 2 && has("session.context") && has("opencode.designAgent"),
        _ => false,
    }
}
fn valid_manifest(m: &Manifest) -> bool {
    let sized = |s: &str, n| !s.is_empty() && s.encode_utf16().count() <= n;
    ported_permissions(m.api_version, &m.permissions)
        && ID.is_match(&m.id)
        && VERSION.is_match(&m.version)
        && sized(&m.name, 80)
        && sized(&m.author, 120)
        && sized(&m.license, 80)
        && sized(&m.repository, 512)
        && reqwest::Url::parse(&m.repository).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && PATH.is_match(url.path())
        })
}
fn archive(value: String) -> Result<Record, Failure> {
    if value.len() > ZIP_LIMIT.div_ceil(3) * 4 {
        return Err(LIMIT);
    }
    let bytes = STANDARD.decode(value).map_err(|_| INVALID)?;
    if bytes.is_empty() || bytes.len() > ZIP_LIMIT {
        return Err(LIMIT);
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|_| INVALID)?;
    if zip.len() != 2 || !two_central_entries(&bytes, zip.central_directory_start()) {
        return Err(INVALID);
    }
    let mut manifest = None;
    let mut html = None;
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|_| INVALID)?;
        let (target, limit) = match entry.name_raw() {
            b"manifest.json" => (&mut manifest, 4096),
            b"panel.html" => (&mut html, ZIP_LIMIT),
            _ => return Err(INVALID),
        };
        if target.is_some()
            || entry.encrypted()
            || !entry.is_file()
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000)
            || entry.size() > limit as u64
        {
            return Err(INVALID);
        }
        let mut contents = Vec::new();
        let declared = entry.size();
        entry.take(limit as u64 + 1).read_to_end(&mut contents).map_err(|_| INVALID)?;
        if contents.len() as u64 != declared || contents.len() > limit {
            return Err(INVALID);
        }
        *target = Some(String::from_utf8(contents).map_err(|_| INVALID)?);
    }
    let mut manifest: Manifest = serde_json::from_str(&manifest.ok_or(INVALID)?).map_err(|_| INVALID)?;
    manifest.name = manifest.name.trim().into();
    manifest.author = manifest.author.trim().into();
    manifest.license = manifest.license.trim().into();
    let html = html.ok_or(INVALID)?;
    if !valid_manifest(&manifest) || html.trim().is_empty() {
        return Err(INVALID);
    }
    Ok(Record { manifest, html, digest: format!("{:x}", Sha256::digest(bytes)), global: false })
}
// ZipArchive indexes by name and coalesces duplicates. Count the actual
// central-directory entries first; still let ZipArchive validate and decode.
fn two_central_entries(bytes: &[u8], start: u64) -> bool {
    let Ok(mut offset) = usize::try_from(start) else { return false };
    if offset > bytes.len() {
        return false;
    }
    for _ in 0..2 {
        let Some(head) = bytes.get(offset..offset + 46) else { return false };
        if !head.starts_with(b"PK\x01\x02") {
            return false;
        }
        offset +=
            46 + [28, 30, 32].iter().map(|i| u16::from_le_bytes([head[*i], head[*i + 1]]) as usize).sum::<usize>();
    }
    let Some(end) = bytes.get(offset..offset + 22) else { return false };
    end.starts_with(b"PK\x05\x06")
        && end[4..12] == [0, 0, 0, 0, 2, 0, 2, 0]
        && offset + 22 + u16::from_le_bytes([end[20], end[21]]) as usize == bytes.len()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u8,
    records: Vec<Record>,
}
fn read(app: &App) -> Result<Vec<Record>, Failure> {
    let data =
        storage::read_bounded(&app.data.join("panel-extensions.json"), json!({"version":1,"records":[]}), STORE_LIMIT)
            .map_err(|_| UNAVAILABLE)?;
    let parsed: Catalog = serde_json::from_value(data).map_err(|_| UNAVAILABLE)?;
    let mut ids = std::collections::HashSet::new();
    if parsed.version != 1
        || parsed.records.len() > 32
        || !parsed.records.iter().all(|row| {
            valid_manifest(&row.manifest)
                && digest(&row.digest)
                && row.html.len() <= ZIP_LIMIT
                && !row.html.trim().is_empty()
                && ids.insert(row.manifest.id.as_str())
        })
    {
        return Err(UNAVAILABLE);
    }
    Ok(parsed.records)
}
fn save(app: &App, records: &[Record]) -> Result<(), Failure> {
    let value = json!({"version":1,"records":records});
    if records.len() > 32 || value.to_string().len() > STORE_LIMIT {
        return Err(LIMIT);
    }
    storage::write(&app.data.join("panel-extensions.json"), &value).map_err(|_| UNAVAILABLE)?;
    app.emit(json!({"type":"storage.stateChanged","owner":"panelExtensions","value":{}}));
    // The store's change callback refreshes this backend's Design request.
    crate::extensions::lifecycle::refresh_design(app);
    Ok(())
}
fn response(result: Result<serde_json::Value, Failure>) -> Response {
    let (status, data) = match result {
        Ok(value) => (Status::OK, value),
        Err((status, code)) => (status, json!({"error":format!("panel-extension-{code}")})),
    };
    (status, [(header::CACHE_CONTROL, "no-store")], Json(data)).into_response()
}
async fn payload<T: serde::de::DeserializeOwned>(req: Request, max: usize) -> Result<T, Failure> {
    if !req.headers().get(header::CONTENT_TYPE).is_some_and(|value| value.as_bytes().starts_with(b"application/json")) {
        return Err(INVALID);
    }
    let bytes = to_bytes(req.into_body(), max).await.map_err(|_| LIMIT)?;
    serde_json::from_slice(&bytes).map_err(|_| INVALID)
}
async fn parse_archive(app: &App, input: String) -> Result<Record, Failure> {
    let permit = app.extension_jobs.clone().try_acquire_owned().map_err(|_| UNAVAILABLE)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        archive(input)
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inspect {
    archive_base64: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Install {
    archive_base64: String,
    digest: String,
    previous_digest: Option<String>,
    acknowledged: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Activate {
    digest: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    digest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Panel {
    instance_id: String,
    digest: String,
}

pub async fn root(State(app): State<Shared>, Extension(principal): Extension<Principal>, req: Request) -> Response {
    let result = async {
        if req.uri().query().is_some() {
            return Err(INVALID);
        }
        if req.method() == Method::GET {
            return Ok(json!(
                read(&app)?
                    .into_iter()
                    .map(|row| json!({"manifest":row.manifest,"digest":row.digest,"enabled":row.global}))
                    .collect::<Vec<_>>()
            ));
        }
        let p: Install = payload(req, REQUEST_LIMIT).await?;
        if !p.acknowledged || !digest(&p.digest) || p.previous_digest.as_deref().is_some_and(|d| !digest(d)) {
            return Err(INVALID);
        }
        let record = parse_archive(&app, p.archive_base64).await?;
        if principal.0.is_cancelled() {
            return Err(DISABLED);
        }
        if record.digest != p.digest {
            return Err(CONFLICT);
        }
        let mut data = read(&app)?;
        let position = data.iter().position(|row| row.manifest.id == record.manifest.id);
        if position.map(|i| data[i].digest.as_str()) != p.previous_digest.as_deref() {
            return Err(CONFLICT);
        }
        if let Some(position) = position {
            if data[position].digest == record.digest {
                return Ok(json!({"installed":true}));
            }
            data.remove(position);
        }
        data.push(record);
        save(&app, &data)?;
        Ok(json!({"installed":true}))
    }
    .await;
    response(result)
}
pub async fn inspect(State(app): State<Shared>, req: Request) -> Response {
    response(
        async {
            let p: Inspect = payload(req, REQUEST_LIMIT).await?;
            let archive = parse_archive(&app, p.archive_base64).await?;
            Ok(json!({"manifest":archive.manifest,"digest":archive.digest}))
        }
        .await,
    )
}
pub async fn change(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    if !matches!(*req.method(), Method::PATCH | Method::DELETE) {
        return unavailable();
    }
    response(
        async {
            if !ID.is_match(&id) || req.uri().query().is_some() {
                return Err(INVALID);
            }
            let (selected, enabled) = if req.method() == Method::PATCH {
                let p: Activate = payload(req, 8192).await?;
                (p.digest, Some(p.enabled))
            } else {
                let p: Remove = payload(req, 8192).await?;
                (p.digest, None)
            };
            if principal.0.is_cancelled() {
                return Err(DISABLED);
            }
            if !digest(&selected) {
                return Err(INVALID);
            }
            let mut data = read(&app)?;
            let pos = data.iter().position(|r| r.manifest.id == id).ok_or(MISSING)?;
            if data[pos].digest != selected {
                return Err(CONFLICT);
            }
            let result = if let Some(enabled) = enabled {
                data[pos].global = enabled;
                json!({"updated":true})
            } else {
                data.remove(pos);
                json!({"removed":true})
            };
            save(&app, &data)?;
            Ok(result)
        }
        .await,
    )
}
pub async fn panel(
    State(app): State<Shared>,
    Path(id): Path<String>,
    query: Result<Query<Panel>, axum::extract::rejection::QueryRejection>,
) -> Response {
    response((|| {
        let Query(p) = query.map_err(|_| INVALID)?;
        if !ID.is_match(&id)
            || !digest(&p.digest)
            || p.instance_id.is_empty()
            || p.instance_id.encode_utf16().count() > 256
        {
            return Err(INVALID);
        }
        app.workspace(&p.instance_id).map_err(|_| MISSING)?;
        let record = read(&app)?.into_iter().find(|r| r.manifest.id == id).ok_or(MISSING)?;
        if record.digest != p.digest {
            return Err(CONFLICT);
        }
        if !record.global {
            return Err(DISABLED);
        }
        Ok(json!({"html":record.html}))
    })())
}

/// Reference `extensionsRequestDesign`: an installed, enabled extension declaring
/// `opencode.designAgent`. Unreadable: none.
pub fn requests_design(app: &App) -> bool {
    read(app).is_ok_and(|rows| {
        rows.iter().any(|r| r.global && r.manifest.permissions.iter().any(|p| p == "opencode.designAgent"))
    })
}

#[cfg(test)]
mod tests {
    use super::ported_permissions;

    #[test]
    fn only_permissions_with_a_ported_surface_are_admitted() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(ported_permissions(1, &p(&["session.context"])));
        assert!(ported_permissions(4, &p(&["session.context", "opencode.designAgent"])));
        assert!(ported_permissions(4, &p(&["opencode.designAgent", "session.context"])), "order is free");
        assert!(!ported_permissions(4, &p(&["session.context"])), "API 4 needs one more permission");
        assert!(!ported_permissions(4, &p(&["opencode.designAgent", "opencode.designAgent"])));
        assert!(!ported_permissions(4, &p(&["session.context", "opencode.designAgent", "composer.prefill"])));
        assert!(!ported_permissions(4, &p(&["session.context", "session.images.read"])));
        assert!(!ported_permissions(1, &p(&["session.context", "opencode.designAgent"])));
        assert!(!ported_permissions(2, &p(&["session.context", "session.assets.read"])));
    }
}
