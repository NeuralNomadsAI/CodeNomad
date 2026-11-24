//! Admission on the HTTPS listener: a paired device's cookie bound to its connection, the reviewed
//! route catalog and CORS.
use crate::{Shared, auth::Principal, auth::devices, auth::tls};
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode as Status, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::json;
use std::sync::LazyLock;

// Intersection of the reviewed TS server-device catalog and Rust's
// implemented endpoints. Host switches, outbound, account secrets, push,
// and unported routes are never admitted by the destination.
static CATALOG: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
    ("GET",r"^/api/(?:meta|events|auth/status|filesystem|storage/(?:state/ui|config/(?:ui|server))|panel-extensions|workspaces)$"),
    ("GET",r"^/api/workspaces/[^/]+(?:/(?:worktrees|pending-requests|sessions/[^/]+/permission-receipts))?$"),
    ("GET PUT",r"^/api/workspaces/[^/]+/sessions/[^/]+/permission-mode$"),
    ("GET",r"^/api/workspaces/[^/]+/(?:files(?:/preview|/search)?|worktrees/[^/]+/(?:git-status|git-diff|git-history(?:/[a-f0-9]+)?))$"),
    ("PUT",r"^/api/workspaces/[^/]+/files/content$"),
    ("POST",r"^/api/workspaces/[^/]+/(?:git-init|worktrees/[^/]+/git-(?:stage|unstage|commit))$"),
    ("POST",r"^/api/workspaces/[^/]+/(?:worktrees|sessions/[^/]+/worktree)$"),
    ("DELETE",r"^/api/workspaces/[^/]+/worktrees/[^/]+$"),
    ("GET",r"^/workspaces/[^/]+/instance/api/vcs/status$"),
    ("GET",r"^/api/(?:missions/playbooks|workspaces/[^/]+/missions(?:/msn_[a-z0-9]+(?:/(?:content|tasks))?)?)$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/creation/[A-Za-z0-9_-]+$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/recurrence$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/recurrence/[^/]+/(?:current|run-now/status|passages/[^/]+|current/[^/]+/content)$"),
    ("POST",r"^/api/workspaces/[^/]+/missions/recurrence/[^/]+/(?:control(?:/status)?|run-now|current/[^/]+/page)$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/(?:scheduled|msn_[a-z0-9]+/schedule)$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/scheduled/(?:capabilities|requests/[a-zA-Z0-9_-]+)$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/msn_[a-z0-9]+/schedule-settings$"),
    ("POST",r"^/api/workspaces/[^/]+/missions(?:/panel-page|/msn_[a-z0-9]+/control)?$"),
    ("GET PUT DELETE",r"^/api/storage/instances/[^/]+$"),
    ("PATCH",r"^/api/storage/(?:state/ui|config/[^/]+)$"),
    ("GET",r"^/api/(?:remote-control/status|config-files|opencode/update)$"),
    ("GET",r"^/api/workspaces/[^/]+/provider-accounts/[^/]+$"),
    ("GET PUT",r"^/api/config-files/[^/]+/content$"),
    ("POST",r"^/api/storage/binaries/validate$"),
    ("POST",r"^/api/(?:client-connections/pong|workspaces(?:/creation/cancel|/[^/]+/creation/release)?)$"),
    ("POST",r"^/api/workspaces/[^/]+/session-history/(?:outline|outlinePreview|window|query|ranked)$"),
    ("GET",r"^/api/workspaces/[^/]+/session-attachment/[^/]+/[^/]+/[0-9]+/[a-f0-9]{64}$"),
    ("GET",r"^/api/workspaces/[^/]+/session-media/[^/]+/[^/]+/[^/]+/[^/]+/[^/]+$"),
    ("DELETE",r"^/api/workspaces/[^/]+$"),
    ("GET",r"^/api/panel-extensions/[^/]+/panel$"),
    ("GET",r"^/workspaces/[^/]+/instance/api/(?:agent(?:/[^/]+)?|command|location|mcp|model(?:/default)?|provider|project|session(?:/active|/[^/]+(?:/(?:inbox|permission|form|message(?:/[^/]+)?))?)?|experimental/session/[^/]+/log)$"),
    ("POST",r"^/workspaces/[^/]+/instance/api/session(?:/[^/]+/(?:prompt|command|agent|model|interrupt))?$"),
    ("PUT DELETE",r"^/workspaces/[^/]+/instance/api/experimental/session/[^/]+/instructions/entries/[^/]+$"),
    ("GET PUT",r"^/api/workspaces/[^/]+/subagent-depth$"),
    ("GET POST",r"^/api/sidecars$"),
    ("POST",r"^/api/previews$"),
    ("DELETE",r"^/api/previews/[^/]+$"),
    ("GET",r"^/api/usage/[^/]+$"),
    ("PUT DELETE",r"^/api/sidecars/[^/]+$"),
    ("GET",r"^/api/workspaces/[^/]+/service-usage(?:/(?:owner|cache))?$"),
    // `isMemoryRelayRoute`: browser devices only (`memory::routes` refuses server devices).
    ("POST",r"^/api/memory$"),
    ("GET PUT",r"^/api/memory/settings$"),
].into_iter().map(|(method,path)|(method,Regex::new(path).unwrap())).collect()
});

#[derive(Clone)]
pub(crate) struct BrowserDevice(pub uuid::Uuid);

fn reply(code: Status, text: &str) -> Response {
    (code, [(header::CONNECTION, "close")], Json(json!({"error":text}))).into_response()
}
fn status(paired: bool) -> Response {
    Json(if paired {
        json!({"authenticated":true,"username":"codenomad","passwordUserProvided":true})
    } else {
        json!({"authenticated":false,"pairingRequired":true})
    })
    .into_response()
}
fn browser_metadata(h: &HeaderMap) -> bool {
    h.keys().any(|k| {
        let k = k.as_str();
        k == "origin" || k == "referer" || k.starts_with("sec-") || k.starts_with("access-control-request-")
    })
}
/// `Vary`, the credentialed CORS grant and the reference's JSON charset (native bodies kept as relayed).
pub(super) fn cors(mut response: Response, origin: Option<HeaderValue>) -> Response {
    let raw = response.extensions().get::<crate::opencode::NativeBody>().is_some();
    let h = response.headers_mut();
    h.entry(header::VARY).or_insert(HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    }
    if !raw && h.get(header::CONTENT_TYPE).is_some_and(|v| v == "application/json") {
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    }
    response
}
fn route_path(uri: &axum::http::Uri) -> Option<String> {
    let path = uri.path();
    if uri.scheme().is_some()
        || uri.authority().is_some()
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', ';', '#'])
        || path.as_bytes().iter().enumerate().any(|(i, b)| {
            *b == b'%' && !path.as_bytes().get(i + 1..i + 3).is_some_and(|x| x.iter().all(u8::is_ascii_hexdigit))
        })
    {
        return None;
    }
    let mut output = String::new();
    let media_route = path.starts_with("/api/workspaces/") && path[1..].split('/').nth(3) == Some("session-media");
    for (index, segment) in path[1..].split('/').enumerate() {
        let decoded = percent_encoding::percent_decode_str(segment).decode_utf8().ok()?;
        // The instance storage route accepts encoded physical paths as its
        // final key, and rechecks them against an open workspace.
        let storage = index == 3 && path.starts_with("/api/storage/instances/");
        let media_id = media_route && matches!(index, 4 | 5);
        if decoded == "."
            || decoded == ".."
            || decoded.contains('\0')
            || (!media_id && decoded.contains([';', '#', '?']))
            || (!storage && !media_id && decoded.contains('/'))
            || (!storage && decoded.contains('\\'))
            || (!storage && !media_id && decoded.contains('%'))
        {
            return None;
        }
        output.push('/');
        // Axum matches static segments literally; never classify an encoded
        // alias as a static security route it won't actually dispatch.
        output.push_str(segment);
    }
    Some(output)
}

pub async fn admit(
    State((app, bundle)): State<(Shared, Option<crate::host::ui::RemoteBundle>)>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(channel) = tls::https_only(&req).cloned() else { return reply(Status::FORBIDDEN, "TLS required") };
    let Some(path) = route_path(req.uri()) else { return reply(Status::BAD_REQUEST, "Invalid request path") };
    let authority = channel.origin.strip_prefix("https://").unwrap_or_default();
    let h = req.headers();
    let only = |name: axum::http::HeaderName| h.get_all(name).iter().count() <= 1;
    if h.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(authority) || !only(header::HOST) {
        return reply(Status::MISDIRECTED_REQUEST, "Misdirected request");
    }
    if path.starts_with("/previews/") {
        return crate::previews::admit_remote(&app, req).await;
    }
    if !only(header::ORIGIN)
        || !only(header::REFERER)
        || !only(header::CONTENT_TYPE)
        || !only(axum::http::HeaderName::from_static("x-codenomad-server-pairing"))
        || !only(axum::http::HeaderName::from_static("x-codenomad-server-request"))
        || h.contains_key(header::UPGRADE)
    {
        return reply(Status::FORBIDDEN, "Cross-origin request rejected");
    }
    let supplied = h.get(header::ORIGIN).cloned();
    let origin_ok = supplied.as_ref().is_some_and(|v| v == channel.origin.as_str());
    let server = h.get("x-codenomad-server-request").is_some_and(|v| v == "1");
    let server_pair = path == "/api/remote-control/server-pair";
    if server_pair {
        if !channel.ingress {
            return (
                Status::NOT_FOUND,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"error":"Server pairing request rejected"})),
            )
                .into_response();
        }
        if req.method() != Method::POST
            || h.get("x-codenomad-server-pairing").is_none_or(|v| v != "1")
            || h.get(header::CONTENT_TYPE).is_none_or(|v| v != "application/json")
            || browser_metadata(h)
            || ["cookie", "cookie2", "authorization", "proxy-authorization"].iter().any(|name| h.contains_key(*name))
        {
            return cors(reply(Status::FORBIDDEN, "Server pairing request rejected"), None);
        }
        return cors(next.run(req).await, None);
    }
    let direct = channel.ingress || devices::direct_origin(&channel.origin);
    let entry = direct
        && !server
        && matches!(*req.method(), Method::GET | Method::HEAD)
        && matches!(path.as_str(), "/" | "/remote-pair");
    if supplied.is_some() && !origin_ok
        || !entry
            && h.get(header::REFERER).is_some_and(|v| {
                !v.to_str()
                    .ok()
                    .and_then(|s| reqwest::Url::parse(s).ok())
                    .is_some_and(|u| u.origin().ascii_serialization() == channel.origin)
            })
    {
        return cors(reply(Status::FORBIDDEN, "Cross-origin request rejected"), None);
    }
    if server && (!channel.ingress || browser_metadata(h)) {
        return cors(
            reply(if channel.ingress { Status::FORBIDDEN } else { Status::UNAUTHORIZED }, "This device is not paired"),
            None,
        );
    }
    let method = req.method().clone();
    let ui = bundle
        .as_ref()
        .filter(|_| !server && direct)
        .and_then(|bundle| bundle.path(&method, &path).map(|asset| (bundle, asset)));
    let form_reply = !server
        && path.strip_prefix("/workspaces/").and_then(|s| s.split_once("/instance")).is_some_and(|(id, route)| {
            !id.is_empty() && !id.contains('/') && crate::missions::human_answer::form_reply(route, &method).is_some()
        });
    let backend_ui = !server && crate::previews::backend::enabled(&app) && preview_control(&path, &method);
    if entry && path == "/remote-pair" {
        if let Some(crate::host::ui::RemoteBundle::Rune(dir)) = &bundle
            && let Some(page) = crate::host::ui::rune_pair_page(dir, method).await
        {
            return cors(devices::pairing_page(page), supplied);
        }
        return cors(next.run(req).await, supplied);
    }
    if path == "/api/remote-control/pair" && method == Method::POST && !server {
        if !origin_ok || !direct {
            return cors(reply(Status::NOT_FOUND, "Not found"), None);
        }
        return cors(next.run(req).await, supplied);
    }
    if path.starts_with("/api/auth/") && path != "/api/auth/status"
        || (path.starts_with("/api/backends/") && !backend_ui)
        // `REMOTE_MANAGEMENT_READS`: the status is the one management read open to devices.
        || path.starts_with("/api/remote-control/") && path != "/api/remote-control/status"
        || path == "/api/remote-control"
        || path.starts_with("/api/push/")
    {
        return cors(reply(Status::NOT_FOUND, "Not found"), supplied);
    }
    if !server && !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) && !origin_ok {
        return cors(reply(Status::FORBIDDEN, "Cross-origin request rejected"), None);
    }
    if !entry
        && !backend_ui
        && !form_reply
        && ui.is_none()
        && !CATALOG.iter().any(|(methods, pat)| {
            methods.split(' ').any(|m| m == if method == Method::HEAD { "GET" } else { method.as_str() })
                && pat.is_match(&path)
        })
    {
        return cors(reply(Status::NOT_FOUND, "Not found"), supplied);
    }
    let Ok((_, token)) = crate::auth::cookies(h, app.auth.cookie_name()) else {
        return cors(reply(Status::BAD_REQUEST, "Invalid cookie"), supplied);
    };
    let owner = token.filter(|_| direct).and_then(|token| {
        app.devices
            .as_ref()?
            .lock()
            .unwrap()
            .authenticate(&token, (!channel.ingress).then_some(channel.origin.as_str()))
    });
    if path == "/api/auth/status" && owner.is_none() {
        return cors(status(false), supplied);
    }
    if owner.is_none()
        && let Some((bundle, asset)) = ui
        && bundle.public(asset)
    {
        let response = bundle.serve(req, asset).await;
        let response = if response.headers().get(header::CACHE_CONTROL).is_some_and(|value| value == "no-store") {
            reply(Status::UNAUTHORIZED, "This device is not paired")
        } else {
            response
        };
        return cors(response, supplied);
    }
    if owner.is_none()
        && (entry && path == "/"
            || channel.ingress
                && method == Method::GET
                && ui.is_some_and(|(bundle, asset)| {
                    matches!(bundle, crate::host::ui::RemoteBundle::Solid(_)) && !bundle.public(asset)
                }))
        && h.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|v| {
            let accept = v.to_ascii_lowercase();
            accept.contains("text/html") || accept.contains("application/xhtml")
        })
    {
        return cors(
            (
                Status::FOUND,
                [
                    (header::LOCATION, "/remote-pair"),
                    (header::CACHE_CONTROL, "no-store"),
                    (header::CONNECTION, "close"),
                ],
            )
                .into_response(),
            supplied,
        );
    }
    let Some((id, principal)) = owner else {
        return cors(reply(Status::UNAUTHORIZED, "This device is not paired"), supplied);
    };
    {
        let mut socket = channel.principal.lock().unwrap();
        if socket.is_some_and(|previous| previous != id) {
            return reply(Status::FORBIDDEN, "Device socket authority changed");
        }
        if socket.is_none() {
            *socket = Some(id);
            let (principal, socket) = (principal.clone(), channel.socket.clone());
            tokio::spawn(async move {
                tokio::select! {_ = principal.cancelled()=>socket.cancel(),_ = socket.cancelled()=>{}}
            });
        }
    }
    if path == "/api/auth/status" {
        return cors(status(!principal.is_cancelled()), supplied);
    }
    for name in super::AUTHORITY_HEADERS {
        if !backend_ui || name != crate::previews::backend::PROOF {
            req.headers_mut().remove(name);
        }
    }
    req.extensions_mut().insert(Principal(principal.clone()));
    if !server {
        req.extensions_mut().insert(BrowserDevice(id));
    }
    let dispatch = async {
        match ui {
            Some((bundle, asset)) => bundle.serve(req, asset).await,
            None => next.run(req).await,
        }
    };
    let response = tokio::select! {
        biased;
        _=principal.cancelled()=>return reply(Status::UNAUTHORIZED,"This device is not paired"),
        response=dispatch=>response,
    };
    let (parts, body) = response.into_parts();
    let body = axum::body::Body::from_stream(body.into_data_stream().take_until(principal.cancelled_owned()));
    cors(Response::from_parts(parts, body), supplied)
}

fn preview_control(path: &str, method: &Method) -> bool {
    let Some((id, route)) = path.strip_prefix("/api/backends/").and_then(|p| p.split_once('/')) else {
        return false;
    };
    crate::previews::backend::id_ok(id)
        && match *method {
            Method::GET => route == "api/meta",
            Method::POST => route == "preview-capabilities",
            Method::DELETE => route
                .strip_prefix("preview-capabilities/")
                .is_some_and(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()),
            _ => false,
        }
}
