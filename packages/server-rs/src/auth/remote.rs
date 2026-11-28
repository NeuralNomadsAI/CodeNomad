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
    // `instance/api` delegates route and ownership enforcement to `opencode::proxy::relay`.
    ("GET POST PUT PATCH DELETE",r"^/workspaces/[^/]+/instance/api/.+$"),
    ("GET",r"^/api/(?:missions/playbooks|workspaces/[^/]+/missions(?:/msn_[a-z0-9]+(?:/(?:content|tasks))?)?)$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/[^/]+/admission$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/creation/[A-Za-z0-9_-]+$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/recurrence$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/recurrence/[^/]+/(?:current|run-now/status|passages/[^/]+|current/[^/]+/content)$"),
    ("POST",r"^/api/workspaces/[^/]+/missions/recurrence/[^/]+/(?:control(?:/status)?|run-now|current/[^/]+/page)$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/(?:scheduled|msn_[a-z0-9]+/schedule)$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/scheduled/(?:capabilities|requests/[a-zA-Z0-9_-]+)$"),
    ("GET POST",r"^/api/workspaces/[^/]+/missions/msn_[a-z0-9]+/schedule-settings$"),
    ("GET",r"^/api/workspaces/[^/]+/missions/calendars$"),
    ("POST",r"^/api/workspaces/[^/]+/missions(?:/panel-page|/msn_[a-z0-9]+/control)?$"),
    ("GET PUT DELETE",r"^/api/storage/instances/[^/]+$"),
    ("PATCH",r"^/api/storage/(?:state/ui|config/[^/]+)$"),
    ("GET",r"^/api/(?:remote-control/status|config-files|opencode/update)$"),
    ("POST",r"^/api/opencode/(?:service|update)$"),
    ("GET PUT",r"^/api/workspaces/[^/]+/provider-accounts/[^/]+$"),
    ("GET PUT",r"^/api/config-files/[^/]+/content$"),
    ("POST",r"^/api/storage/binaries/validate$"),
    ("POST",r"^/api/(?:client-connections/pong|workspaces(?:/clone|/creation/cancel|/[^/]+/creation/release)?)$"),
    ("GET POST",r"^/api/workspaces/temporary$"),
    ("POST",r"^/api/workspaces/temporary/abandon$"),
    ("POST",r"^/api/workspaces/[^/]+/(?:keep|discard)$"),
    ("POST",r"^/api/workspaces/[^/]+/session-history/(?:outline|outlinePreview|window|query|ranked|prune)$"),
    ("POST",r"^/api/workspaces/[^/]+/session-pruning/(?:preview|prune)$"),
    ("GET",r"^/api/workspaces/[^/]+/session-attachment/[^/]+/[^/]+/[0-9]+/[a-f0-9]{64}$"),
    ("GET",r"^/api/workspaces/[^/]+/session-media/[^/]+/[^/]+/[^/]+/[^/]+/[^/]+$"),
    ("DELETE",r"^/api/workspaces/[^/]+$"),
    ("GET",r"^/api/panel-extensions/[^/]+/panel$"),
    ("GET PUT",r"^/api/workspaces/[^/]+/(?:websearch-settings|image-settings|subagent-depth)$"),
    ("GET PATCH",r"^/api/workspaces/[^/]+/plugin-controls$"),
    ("POST DELETE",r"^/api/workspaces/[^/]+/plugin-sources$"),
    ("GET",r"^/api/workspaces/[^/]+/integrations$"),
    ("GET",r"^/api/workspaces/[^/]+/integrations/[^/]+/(?:hosts|binding)$"),
    ("POST",r"^/api/workspaces/[^/]+/integrations/[^/]+/(?:install|attach|detach|install-host)$"),
    ("GET POST",r"^/api/sidecars$"),
    ("GET",r"^/api/speech/capabilities$"),
    ("POST",r"^/api/speech/(?:transcribe|synthesize/stream)$"),
    ("POST",r"^/api/previews$"),
    ("DELETE",r"^/api/previews/[^/]+$"),
    ("GET",r"^/api/usage/[^/]+$"),
    ("PUT DELETE",r"^/api/sidecars/[^/]+$"),
    ("GET",r"^/api/workspaces/[^/]+/service-usage(?:/(?:owner|cache))?$"),
].into_iter().map(|(method,path)|(method,Regex::new(path).unwrap())).collect()
});

#[derive(Clone)]
pub(crate) struct BrowserDevice(pub uuid::Uuid);

// Browser-only workspace routes omitted from TS `SERVER_DEVICE_ROUTES`.
static BROWSER_ONLY_SESSION_CLEANUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/api/workspaces/[^/]+/session-cleanup/[^/]+$").unwrap());
static BROWSER_ONLY_MISSION_CALENDAR_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/api/workspaces/[^/]+/missions/calendars/[^/]+$").unwrap());
static BROWSER_ONLY_MISSION_CALENDAR_ACTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/api/workspaces/[^/]+/missions/calendars/[^/]+/(?:pause|resume)$").unwrap());

/// Per-device preview logout epoch captured at remote middleware admission time so a concurrent
/// `POST /api/auth/logout` between admission and preview creation still fences publication.
#[derive(Clone, Copy)]
pub(crate) struct DeviceAdmission {
    pub id: uuid::Uuid,
    pub logout_epoch: u64,
}

fn reply(code: Status, text: &str) -> Response {
    (code, [(header::CONNECTION, "close")], Json(json!({"error":text}))).into_response()
}
pub(crate) fn is_no_store_account_path(path: &str) -> bool {
    let matches_raw = |p: &str| {
        (p.starts_with("/api/workspaces/") && p.contains("/provider-accounts/"))
            || (p.starts_with("/workspaces/")
                && (p.contains("/instance/api/credential")
                    || (p.contains("/instance/api/integration/") && p.contains("/connect/"))))
    };
    if matches_raw(path) {
        return true;
    }
    percent_encoding::percent_decode_str(path).decode_utf8().ok().is_some_and(|decoded| matches_raw(&decoded))
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
    match h.get(header::VARY).and_then(|v| v.to_str().ok()) {
        None => {
            h.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
        Some(existing) if existing.split(',').any(|part| part.trim().eq_ignore_ascii_case("origin")) => {}
        Some(existing) => {
            if let Ok(merged) = HeaderValue::from_str(&format!("{existing}, Origin")) {
                h.insert(header::VARY, merged);
            }
        }
    }
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
            || (!storage && !media_id && decoded.contains('\\'))
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
    state: State<(Shared, Option<crate::host::ui::RemoteBundle>)>,
    req: Request,
    next: Next,
) -> Response {
    let no_store_account = is_no_store_account_path(req.uri().path());
    let no_store_integrations = crate::integrations::is_integrations_path(req.uri().path());
    let mut response = admit_inner(state, req, next).await;
    if no_store_integrations || (no_store_account && !response.status().is_success()) {
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn admit_inner(
    State((app, bundle)): State<(Shared, Option<crate::host::ui::RemoteBundle>)>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(mut channel) = tls::https_only(&req).cloned() else { return reply(Status::FORBIDDEN, "TLS required") };
    let Some(path) = route_path(req.uri()) else { return reply(Status::BAD_REQUEST, "Invalid request path") };
    let h = req.headers();
    let only = |name: axum::http::HeaderName| h.get_all(name).iter().count() <= 1;
    let matched = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|_| only(header::HOST))
        .and_then(|host| channel.origins.iter().find(|o| o.strip_prefix("https://") == Some(host)))
        .cloned();
    let Some(matched_origin) = matched else {
        return reply(Status::MISDIRECTED_REQUEST, "Misdirected request");
    };
    channel.origin = matched_origin;
    req.extensions_mut().insert(channel.clone());
    let h = req.headers();
    let only = |name: axum::http::HeaderName| h.get_all(name).iter().count() <= 1;
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
    let direct = channel.ingress || devices::direct_origin(&channel.origin);
    let server_pair = path == "/api/remote-control/server-pair";
    if server_pair {
        if !direct {
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
            let mut denied = reply(Status::FORBIDDEN, "Server pairing request rejected");
            denied.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return cors(denied, None);
        }
        return cors(next.run(req).await, None);
    }
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
    if !channel.ingress && server && (!direct || browser_metadata(h)) {
        return cors(reply(Status::UNAUTHORIZED, "This device is not paired"), None);
    }
    let method = req.method().clone();
    let ui = bundle
        .as_ref()
        .filter(|_| !server && direct)
        .and_then(|bundle| bundle.path(&method, &path).map(|asset| (bundle, asset)));
    let has_server_header = h.contains_key("x-codenomad-server-request");
    let memory_path = path == "/api/memory" || path.starts_with("/api/memory/");
    let memory_route = memory_relay_route(&path, &method);
    // Direct HTTPS server-device catalog retains authenticated memory relay; ingress stays closed.
    let server_memory = server && !channel.ingress && memory_route;
    let remote_logout = !server && method == Method::POST && path == "/api/auth/logout";
    let browser_only_cleanup = !server && method == Method::POST && BROWSER_ONLY_SESSION_CLEANUP.is_match(&path);
    let browser_only_calendars = !server
        && ((matches!(method, Method::PUT | Method::DELETE) && BROWSER_ONLY_MISSION_CALENDAR_ITEM.is_match(&path))
            || (method == Method::POST && BROWSER_ONLY_MISSION_CALENDAR_ACTION.is_match(&path)));
    if entry && path == "/remote-pair" {
        if let Some(crate::host::ui::RemoteBundle::Rune(dir)) = &bundle
            && let Some(page) = crate::host::ui::rune_pair_page(dir, method).await
        {
            return cors(devices::pairing_page(page), supplied);
        }
        return cors(next.run(req).await, supplied);
    }
    if path == "/api/remote-control/pair" && method == Method::POST && !server {
        if !direct {
            return cors(reply(Status::NOT_FOUND, "Not found"), None);
        }
        if !channel.ingress {
            if !origin_ok {
                return cors(reply(Status::NOT_FOUND, "Not found"), None);
            }
            return cors(next.run(req).await, supplied);
        }
        let native_pairing =
            supplied.is_none() && !h.contains_key(header::REFERER) && !h.contains_key("sec-fetch-site");
        if !origin_ok && !native_pairing {
            return cors(reply(Status::FORBIDDEN, "Cross-origin request rejected"), None);
        }
        return cors(next.run(req).await, supplied);
    }
    let Ok((_, token)) = crate::auth::cookies(h, app.auth.cookie_name()) else {
        return cors(reply(Status::BAD_REQUEST, "Invalid cookie"), supplied);
    };
    let tunnel_active = app.remote_control.is_tunnel_active();
    let owner = token.filter(|_| direct).and_then(|token| {
        app.devices.as_ref()?.lock().unwrap().authenticate(
            &token,
            (!channel.ingress).then_some(channel.origin.as_str()),
            tunnel_active,
        )
    });
    let server_authenticated = server && !browser_metadata(h) && owner.is_some();
    // Direct HTTPS server-device requests authenticate before origin/catalog checks
    // (TS `gate.ts:133-138`); ingress unauthenticated mutations fail origin check with 403
    // even when `x-codenomad-server-request: 1` is sent (`gate.ts:177-183`).
    if !channel.ingress && server && owner.is_none() {
        return cors(reply(Status::UNAUTHORIZED, "This device is not paired"), supplied);
    }
    if !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) && !origin_ok && !server_authenticated {
        return cors(reply(Status::FORBIDDEN, "Cross-origin request rejected"), None);
    }
    if !channel.ingress && owner.is_none() && memory_path {
        return cors(reply(Status::UNAUTHORIZED, "This device is not paired"), supplied);
    }
    let multi_backend = !has_server_header && owner.is_some() && crate::previews::backend::enabled(&app);
    let preview_ui = multi_backend && preview_control(&path, &method);
    let memory_ui = multi_backend && memory_route;
    if path.starts_with("/api/auth/") && path != "/api/auth/status" && !remote_logout
        || (path.starts_with("/api/backends/") && !preview_ui)
        || (memory_path && !memory_ui && !server_memory)
        // `REMOTE_MANAGEMENT_READS`: the status is the one management read open to devices.
        || path.starts_with("/api/remote-control/") && path != "/api/remote-control/status"
        || path == "/api/remote-control"
        || path.starts_with("/api/push/")
    {
        return cors(reply(Status::NOT_FOUND, "Not found"), supplied);
    }
    if !entry
        && !preview_ui
        && !memory_ui
        && !server_memory
        && !browser_only_cleanup
        && !browser_only_calendars
        && !remote_logout
        && ui.is_none()
        && !CATALOG.iter().any(|(methods, pat)| {
            methods.split(' ').any(|m| m == if method == Method::HEAD { "GET" } else { method.as_str() })
                && pat.is_match(&path)
        })
    {
        return cors(reply(Status::NOT_FOUND, "Not found"), supplied);
    }
    if path == "/api/auth/status" && owner.is_none() {
        return cors(status(false), supplied);
    }
    if owner.is_none()
        && let Some((bundle, asset)) = ui
        && bundle.public(asset)
    {
        let response = bundle.serve(req, asset).await;
        let response = if response.headers().get(header::CACHE_CONTROL).is_some_and(|value| value == "no-store") {
            let mut r = reply(Status::UNAUTHORIZED, "This device is not paired");
            r.headers_mut().insert("x-codenomad-before-dispatch", HeaderValue::from_static("1"));
            r
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
        let mut r = reply(Status::UNAUTHORIZED, "This device is not paired");
        r.headers_mut().insert("x-codenomad-before-dispatch", HeaderValue::from_static("1"));
        return cors(r, supplied);
    };
    let paired_server = app.devices.as_ref().is_some_and(|d| d.lock().unwrap().is_server_device(id));
    if (browser_only_cleanup || browser_only_calendars || remote_logout) && paired_server {
        return cors(reply(Status::NOT_FOUND, "Not found"), supplied);
    }
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
        if !preview_ui || name != crate::previews::backend::PROOF {
            req.headers_mut().remove(name);
        }
    }
    let logout_epoch = app.previews.logout_epoch(id);
    req.extensions_mut().insert(Principal(principal.clone()));
    req.extensions_mut().insert(DeviceAdmission { id, logout_epoch });
    if !server && !paired_server {
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

fn memory_relay_route(path: &str, method: &Method) -> bool {
    (path == "/api/memory" && *method == Method::POST)
        || (path == "/api/memory/settings" && matches!(*method, Method::GET | Method::HEAD | Method::PUT))
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

#[cfg(test)]
#[path = "remote_tests.rs"]
mod remote_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{App, auth, files, opencode, settings};
    use axum::{Extension, middleware::from_fn_with_state};
    use std::{path::PathBuf, sync::Arc, time::Duration};
    use tokio_util::sync::CancellationToken;

    fn admitted(method: &str, path: &str) -> bool {
        let effective = if method == "HEAD" { "GET" } else { method };
        CATALOG.iter().any(|(methods, pat)| methods.split(' ').any(|m| m == effective) && pat.is_match(path))
    }

    #[test]
    fn remote_catalog_admits_opencode_service_and_update_but_not_logs() {
        assert!(admitted("GET", "/api/opencode/update"));
        assert!(admitted("POST", "/api/opencode/update"));
        assert!(admitted("POST", "/api/opencode/service"));
        assert!(!admitted("GET", "/api/opencode/service"));
        assert!(!admitted("GET", "/api/opencode/logs"));
        assert!(!admitted("POST", "/api/opencode/logs"));
    }

    #[test]
    fn remote_catalog_admits_mission_admission_get_and_head_only() {
        assert!(admitted("GET", "/api/workspaces/ws-1/missions/msn_abc123/admission"));
        assert!(admitted("HEAD", "/api/workspaces/ws-1/missions/msn_abc123/admission"));
        assert!(admitted("GET", "/api/workspaces/ws-1/missions/legacy-1/admission"));
        assert!(admitted("GET", "/api/workspaces/ws-1/missions/msn_abc123/tasks"));
        assert!(admitted("GET", "/api/workspaces/ws-1/missions/msn_abc123/content"));
        assert!(!admitted("POST", "/api/workspaces/ws-1/missions/msn_abc123/admission"));
        assert!(!admitted("GET", "/api/workspaces/ws-1/missions/msn_abc123/admission/extra"));
    }

    #[tokio::test]
    async fn multi_origin_pairing_binds_cookie_to_selected_origin_and_refuses_foreign_host_or_origin() {
        let dir = crate::shared::test_dir("multi-origin-remote");
        let first = "https://192.168.1.20:9898";
        let second = "https://10.0.0.5:9898";
        let origins = vec![first.to_owned(), second.to_owned(), "https://127.0.0.1:9898".to_owned()];
        let devices = devices::open_for_test(&dir, first.to_owned(), origins.clone());
        let auth = auth::Auth::new(auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings =
            settings::Settings::new(settings::document::Location::resolve(dir.join("config.yaml").to_str().unwrap()));
        let native = opencode::Native::test_connection(([127, 0, 0, 1], 9).into());
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            serde_json::Value::Null,
            native,
            PathBuf::new(),
            Some(devices),
            files::watch::Watches::new(tx),
            None,
        ));

        // 1. Local status lists both non-loopback directOrigins and excludes loopback.
        let status = devices::status(State(app.clone()), None).await.0;
        assert_eq!(status["directOrigins"], json!([first, second]));

        // 2. Local pairing link issued for the second origin targets that exact origin.
        let issued =
            devices::issue(State(app.clone()), axum::body::Bytes::from(format!(r#"{{"origin":"{second}"}}"#))).await;
        assert_eq!(issued.status(), Status::OK);
        let body = axum::body::to_bytes(issued.into_body(), 4096).await.unwrap();
        let link: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let url = link["url"].as_str().unwrap();
        let code = url.strip_prefix(&format!("{second}/remote-pair#")).expect(url);

        // 3. Spin up the real `admit` + `auth::remote_routes` stack over a loopback socket.
        let channel = tls::Channel {
            origin: first.to_owned(),
            origins: Arc::from(origins),
            ingress: false,
            socket: CancellationToken::new(),
            principal: Arc::new(std::sync::Mutex::new(None)),
        };
        let router = auth::remote_routes()
            .layer(from_fn_with_state((app.clone(), None), admit))
            .layer(Extension(channel))
            .with_state(app);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");

        // Unknown Host -> 421 Misdirected Request.
        let rogue = client
            .get(format!("{base}/api/auth/status"))
            .header(header::HOST, "evil.invalid:9898")
            .send()
            .await
            .unwrap();
        assert_eq!(rogue.status(), Status::MISDIRECTED_REQUEST);

        // Foreign Origin on the second Host -> 403 Cross-origin request rejected.
        let cross = client
            .post(format!("{base}/api/remote-control/pair"))
            .header(header::HOST, "10.0.0.5:9898")
            .header(header::ORIGIN, first)
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(cross.status(), Status::FORBIDDEN);

        // Exchanging the code issued for `second` on `first` fails (401).
        let wrong_iface = client
            .post(format!("{base}/api/remote-control/pair"))
            .header(header::HOST, "192.168.1.20:9898")
            .header(header::ORIGIN, first)
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_iface.status(), Status::UNAUTHORIZED);

        // Exchanging on `second` succeeds and binds the device cookie to `second`.
        let paired = client
            .post(format!("{base}/api/remote-control/pair"))
            .header(header::HOST, "10.0.0.5:9898")
            .header(header::ORIGIN, second)
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(paired.status(), Status::OK);
        let cookie = paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned();

        // Cookie authenticates on `second`...
        let ok_status: serde_json::Value = client
            .get(format!("{base}/api/auth/status"))
            .header(header::HOST, "10.0.0.5:9898")
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok_status["authenticated"], true);

        // ...but is rejected on `first`!
        let rejected_status: serde_json::Value = client
            .get(format!("{base}/api/auth/status"))
            .header(header::HOST, "192.168.1.20:9898")
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(rejected_status["authenticated"], false);

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
