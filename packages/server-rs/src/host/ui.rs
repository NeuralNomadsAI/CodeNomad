//! The UI on the local listener (`setupStaticUi`, `setupDevProxy`): the built bundle (`--ui-dir`,
//! else `public/` beside the executable) with the single-page fallback, or a development server.
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::UNIX_EPOCH,
};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    response::{IntoResponse, Response},
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
                let mut meta = json!({"source": kind});
                if let Some(version) = file.get("uiVersion").or(file.get("version")).and_then(Value::as_str) {
                    meta["version"] = json!(version);
                }
                meta
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
        Source::Dir(dir, _) => {
            let (head, _) = req.into_parts();
            let path = if head.uri.path() == "/" { "/index.html" } else { head.uri.path() };
            if let Some(response) = asset(dir, &head.method, path, &head.headers).await {
                return response;
            }
            if head.extensions.get::<crate::auth::Principal>().is_none() {
                return (Status::NOT_FOUND, axum::Json(json!({"message": "Not Found"}))).into_response();
            }
            if path != "/index.html"
                && let Some(response) = asset(dir, &head.method, "/index.html", &head.headers).await
            {
                return response;
            }
            (Status::NOT_FOUND, axum::Json(json!({"message": "UI bundle missing"}))).into_response()
        }
    }
}

pub(crate) fn is_html_path(mut path: &str) -> bool {
    while let Some((stem, extension)) = path.rsplit_once('.') {
        match extension.to_ascii_lowercase().as_str() {
            "html" | "htm" => return true,
            "br" | "gz" | "deflate" => path = stem,
            _ => break,
        }
    }
    false
}

/// A regular file of the bundle for GET and HEAD, never a dotfile or a path leaving the folder.
async fn asset(dir: &Path, method: &Method, path: &str, request_headers: &HeaderMap) -> Option<Response> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8().ok()?;
    let root = dunce::canonicalize(dir).ok()?;
    let mut file = root.clone();
    for part in decoded.split('/').filter(|p| !p.is_empty()) {
        if part.starts_with('.') || part.contains(['\\', ':', '\0']) {
            return None;
        }
        file.push(part);
    }
    let (codings, identity) = accepted(request_headers);
    for coding in codings.into_iter().flatten().map(Some).chain([None]) {
        let candidate = match coding {
            Some((_, suffix)) => {
                let mut name = file.as_os_str().to_owned();
                name.push(suffix);
                PathBuf::from(name)
            }
            None => file.clone(),
        };
        let Ok(real) = dunce::canonicalize(candidate) else { continue };
        if !real.starts_with(&root) {
            continue;
        }
        let Ok(meta) = tokio::fs::metadata(&real).await else { continue };
        if !meta.is_file() {
            continue;
        }
        if coding.is_none() && !identity {
            return Some((Status::NOT_ACCEPTABLE, [(header::VARY, "Origin, Accept-Encoding")]).into_response());
        }
        let logical = if coding.is_some() { &file } else { &real };
        let extension = logical.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let modified = meta.modified().ok()?;
        let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
        let etag = format!("W/\"{:x}-{millis:x}\"", meta.len());
        let mut response =
            if request_headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
                Status::NOT_MODIFIED.into_response()
            } else {
                let body = if *method == Method::HEAD {
                    Body::empty()
                } else {
                    let Ok(opened) = tokio::fs::File::open(real).await else { continue };
                    Body::from_stream(tokio_util::io::ReaderStream::new(opened))
                };
                ([(header::CONTENT_LENGTH, meta.len().to_string())], body).into_response()
            };
        let headers = response.headers_mut();
        if let Some((encoding, _)) = coding {
            headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
        }
        headers.insert(header::VARY, HeaderValue::from_static("Origin, Accept-Encoding"));
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&extension)));
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(if is_html_path(&decoded) || matches!(extension.as_str(), "html" | "htm") {
                "no-store"
            } else {
                "public, max-age=0"
            }),
        );
        let date = chrono::DateTime::<chrono::Utc>::from(modified).format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        headers.insert(header::LAST_MODIFIED, HeaderValue::from_str(&date).ok()?);
        headers.insert(header::ETAG, HeaderValue::from_str(&etag).ok()?);
        return Some(response);
    }
    None
}

type Coding = (&'static str, &'static str);

fn accepted(headers: &HeaderMap) -> ([Option<Coding>; 3], bool) {
    let mut codings = [("br", ".br", None::<f32>), ("gzip", ".gz", None), ("deflate", ".deflate", None)];
    let (mut wildcard, mut identity) = (None::<f32>, None::<f32>);
    for header in headers.get_all(header::ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()) {
        for item in header.split(',') {
            let (name, quality) = item.split_once(';').map_or((item, 1.), |(name, param)| {
                let quality = param
                    .split_once('=')
                    .filter(|(key, _)| key.trim().eq_ignore_ascii_case("q"))
                    .and_then(|(_, value)| value.trim().parse::<f32>().ok())
                    .unwrap_or(0.);
                (name, quality)
            });
            let name = name.trim();
            let quality = if (0. ..=1.).contains(&quality) { quality } else { 0. };
            if name == "*" {
                wildcard = Some(wildcard.unwrap_or_default().max(quality));
            } else if name.eq_ignore_ascii_case("identity") {
                identity = Some(identity.unwrap_or_default().max(quality));
            } else if let Some((_, _, q)) = codings.iter_mut().find(|(coding, _, _)| coding.eq_ignore_ascii_case(name))
            {
                *q = Some(q.unwrap_or_default().max(quality));
            }
        }
    }
    let mut codings = codings.map(|(coding, suffix, q)| (coding, suffix, q.or(wildcard).unwrap_or_default()));
    codings.sort_by(|a, b| b.2.total_cmp(&a.2));
    (
        codings.map(|(coding, suffix, q)| (q > 0. && q >= identity.unwrap_or_default()).then_some((coding, suffix))),
        identity.or(wildcard).unwrap_or(1.) > 0.,
    )
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
