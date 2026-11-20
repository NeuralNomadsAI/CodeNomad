//! The UI on the local listener (`setupStaticUi`, `setupDevProxy`): the built bundle (`--ui-dir`,
//! else `public/` beside the executable) with the single-page fallback, or a development server.
use std::{path::PathBuf, sync::LazyLock, time::UNIX_EPOCH};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, Method, StatusCode as Status, header},
    response::{Html, IntoResponse, Response},
};
use serde_json::{Value, json};

pub enum Source {
    Dev(reqwest::Url),
    /// The bundle folder and how it was chosen: `override`, `bundled` or `missing`.
    Dir(PathBuf, &'static str),
    /// The positional launch: no UI, unmatched paths stay unavailable.
    Absent,
}

impl Source {
    pub fn bundled() -> Self {
        let dir = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("public"))).unwrap_or_default();
        let kind = if dir.join("index.html").is_file() { "bundled" } else { "missing" };
        Self::Dir(dir, kind)
    }
    /// `serverMeta.ui`.
    pub fn meta(&self) -> Value {
        match self {
            Self::Dev(_) => json!({"source": "dev-proxy"}),
            Self::Absent => json!({"source": "missing"}),
            Self::Dir(dir, kind) => {
                let file: Value = std::fs::read(dir.join("ui-version.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or_default();
                let version = file.get("uiVersion").or(file.get("version")).and_then(Value::as_str);
                json!({"source": kind, "version": version})
            }
        }
    }
}

/// Paths no route matched: API paths stay unavailable, everything else is the UI.
pub async fn serve(source: &Source, req: Request) -> Response {
    let path = req.uri().path();
    if path == "/api" || path.starts_with("/api/") || path.starts_with("/workspaces/") {
        return crate::unavailable();
    }
    match source {
        Source::Absent => crate::unavailable(),
        Source::Dev(base) => proxy(base, req).await,
        Source::Dir(dir, _) => match asset(
            dir,
            req.method().clone(),
            req.uri().path().to_owned(),
            req.headers().get(header::IF_NONE_MATCH).cloned(),
        )
        .await
        {
            Some(response) => response,
            None => match tokio::fs::read_to_string(dir.join("index.html")).await {
                Ok(page) => Html(page).into_response(),
                Err(_) => (Status::NOT_FOUND, axum::Json(json!({"message": "UI bundle missing"}))).into_response(),
            },
        },
    }
}

/// A regular file of the bundle for GET and HEAD, never a dotfile or a path leaving the folder.
async fn asset(dir: &PathBuf, method: Method, path: String, cached: Option<HeaderValue>) -> Option<Response> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(&path).decode_utf8().ok()?;
    let mut file = dir.clone();
    for part in decoded.split('/').filter(|p| !p.is_empty()) {
        if part.starts_with('.') || part.contains(['\\', ':', '\0']) {
            return None;
        }
        file.push(part);
    }
    let real = dunce::canonicalize(&file).ok()?;
    if !real.starts_with(dunce::canonicalize(dir).ok()?) {
        return None;
    }
    let meta = tokio::fs::metadata(&real).await.ok().filter(|m| m.is_file())?;
    let modified = meta.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let etag = format!("W/\"{:x}-{millis:x}\"", meta.len());
    let mut response = if cached.is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        Status::NOT_MODIFIED.into_response()
    } else if method == Method::HEAD {
        ([(header::CONTENT_LENGTH, meta.len().to_string())], Body::empty()).into_response()
    } else {
        tokio::fs::read(&real).await.ok()?.into_response()
    };
    let extension = real.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&extension)));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=0"));
    let date = chrono::DateTime::<chrono::Utc>::from(modified).format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    headers.insert(header::LAST_MODIFIED, HeaderValue::from_str(&date).ok()?);
    headers.insert(header::ETAG, HeaderValue::from_str(&etag).ok()?);
    Some(response)
}

fn content_type(extension: &str) -> &'static str {
    match extension {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().no_proxy().build().expect("static client"));

/// `proxyToDevServer`: method and headers (without `Host`), no request body; the dev server's answer.
async fn proxy(base: &reqwest::Url, req: Request) -> Response {
    let target = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let Ok(url) = base.join(target) else {
        return (Status::BAD_GATEWAY, "UI dev server is unavailable").into_response();
    };
    let mut headers = req.headers().clone();
    headers.remove(header::HOST);
    let method = req.method().clone();
    let head = method == Method::HEAD;
    let upstream = async {
        let response = CLIENT.request(method, url).headers(headers).send().await?;
        let (status, headers) = (response.status(), response.headers().clone());
        Ok::<_, reqwest::Error>((status, headers, if head { Default::default() } else { response.bytes().await? }))
    };
    match upstream.await {
        Ok((status, upstream_headers, body)) => {
            let mut response = Response::new(Body::from(body));
            *response.status_mut() = status;
            for (name, value) in &upstream_headers {
                if ![header::TRANSFER_ENCODING, header::CONNECTION, header::CONTENT_LENGTH].contains(name) {
                    response.headers_mut().append(name, value.clone());
                }
            }
            response
        }
        Err(_) => (Status::BAD_GATEWAY, "UI dev server is unavailable").into_response(),
    }
}
