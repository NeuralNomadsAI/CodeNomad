use super::*;
use crate::backend::Backend;
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Harness {
    shared: Rc<RefCell<Preferences>>,
    remote: Remote,
    wake: Waker,
}

fn harness_view(s: &Harness, cx: &mut rune::Cx<Harness>) -> El {
    crate::strings::with_locale("en", || {
        layout::render(cx, |_| {
            s.remote.view(
                &s.shared,
                |s: &mut Harness| Some(&mut s.remote),
                |s| &mut s.remote,
            )
        })
    })
}

fn future_expiry() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 180;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

struct MockServer {
    base: String,
    log: Arc<Mutex<Vec<(String, String, String)>>>,
}

impl MockServer {
    async fn start(
        handler: impl Fn(&str, &str, &str) -> (u16, &'static str, String) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let log_clone = log.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let log = log_clone.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let header_end = loop {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
                    let content_len = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while raw.len() < header_end + content_len {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&tmp[..n]);
                    }
                    let mut lines = head.lines();
                    let first = lines.next().unwrap_or_default();
                    let mut parts = first.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_owned();
                    let path = parts.next().unwrap_or_default().to_owned();
                    let body = String::from_utf8_lossy(
                        &raw[header_end..header_end + content_len.min(raw.len() - header_end)],
                    )
                    .into_owned();
                    log.lock()
                        .unwrap()
                        .push((method.clone(), path.clone(), body.clone()));
                    let (status, content_type, reply_body) = handler(&method, &path, &body);
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        400 => "Bad Request",
                        403 => "Forbidden",
                        409 => "Conflict",
                        500 => "Internal Server Error",
                        503 => "Service Unavailable",
                        _ => "Error",
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply_body}",
                        reply_body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            base: format!("http://127.0.0.1:{port}/"),
            log,
        }
    }
}

fn new_runtime(base: &str) -> Runtime<Harness> {
    let wake: Waker = Arc::new(|| {});
    let shared = Rc::new(RefCell::new(Preferences::default()));
    {
        let mut prefs = shared.borrow_mut();
        prefs.fixture_locale("en");
        prefs.backend = Some(Backend::unauthenticated(base).unwrap());
        prefs.window_wake = Some(wake.clone());
    }
    Runtime::new(
        Harness {
            shared,
            remote: Remote::default(),
            wake,
        },
        harness_view,
        (960.0, 2000.0),
        Env::new(false, 1.0),
    )
}

async fn pump(rt: &mut Runtime<Harness>, label: &str, until: impl Fn(&Harness) -> bool) {
    for _ in 0..100 {
        rt.update(|s, _| {
            let prefs = s.shared.borrow();
            s.remote.poll(&prefs, &s.wake);
        });
        rt.frame(0.02);
        if until(&rt.state) {
            rt.frame(1.0);
            return;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    panic!(
        "condition '{label}' did not settle in time; error={:?}, snapshot={:?}",
        rt.state.remote.error,
        rt.state
            .remote
            .snapshot
            .as_ref()
            .map(|(s, _)| (s.enabled, s.previews, s.state))
    );
}

fn click(rt: &mut Runtime<Harness>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
}

fn find_text(node: &Value, needle: &str) -> bool {
    node.to_string().contains(needle)
}

#[test]
fn remote_control_tunnel_start_previews_stop_and_devices_flow() {
    platform::block_on(async {
        let tunnel_url = "https://codenomad-test.opentunnel.xyz";
        let device_id = "11111111-2222-3333-4444-555555555555";
        let state = Arc::new(Mutex::new((false, false, true)));
        let state_srv = state.clone();
        let server = MockServer::start(move |method, path, body| {
            let mut s = state_srv.lock().unwrap();
            match (method, path) {
                ("GET", "/api/remote-control/status") => (
                    200,
                    "application/json",
                    json!({
                        "manageable": true,
                        "enabled": s.0,
                        "startsOnLaunch": s.0,
                        "previews": s.1,
                        "state": if s.0 { "connected" } else { "stopped" },
                        "pairedDevices": if s.2 { 1 } else { 0 },
                        "remoteUrl": s.0.then_some(tunnel_url),
                    })
                    .to_string(),
                ),
                ("GET", "/api/remote-control/devices") => {
                    let devices = if s.2 {
                        json!([{
                            "id": device_id,
                            "name": "iPhone · Safari",
                            "origin": null,
                            "lastSeenAt": "2026-11-25T10:00:00Z"
                        }])
                    } else {
                        json!([])
                    };
                    (200, "application/json", json!({"devices": devices}).to_string())
                }
                ("POST", "/api/remote-control/start") => {
                    s.0 = true;
                    (
                        200,
                        "application/json",
                        json!({
                            "status": {
                                "manageable": true,
                                "enabled": true,
                                "startsOnLaunch": true,
                                "previews": s.1,
                                "state": "connected",
                                "pairedDevices": 1,
                                "remoteUrl": tunnel_url,
                            },
                            "pairing": {
                                "url": format!("{tunnel_url}/remote-pair#abcdefghijklmnopqrstuv"),
                                "expiresAt": future_expiry(),
                            }
                        })
                        .to_string(),
                    )
                }
                ("PUT", "/api/remote-control/previews") => {
                    let v: Value = serde_json::from_str(body).unwrap();
                    s.1 = v["enabled"].as_bool().unwrap();
                    (
                        200,
                        "application/json",
                        json!({
                            "manageable": true,
                            "enabled": s.0,
                            "startsOnLaunch": s.0,
                            "previews": s.1,
                            "state": if s.0 { "connected" } else { "stopped" },
                            "pairedDevices": 1,
                            "remoteUrl": s.0.then_some(tunnel_url),
                        })
                        .to_string(),
                    )
                }
                ("DELETE", "/api/remote-control") => {
                    s.0 = false;
                    (
                        200,
                        "application/json",
                        json!({
                            "manageable": true,
                            "enabled": false,
                            "startsOnLaunch": false,
                            "previews": s.1,
                            "state": "stopped",
                            "pairedDevices": 1,
                        })
                        .to_string(),
                    )
                }
                ("GET", "/api/meta") => (
                    200,
                    "application/json",
                    json!({
                        "listeningMode": "local",
                        "localRequest": true,
                        "localUrl": "http://127.0.0.1:9898",
                        "addresses": []
                    })
                    .to_string(),
                ),
                ("GET", "/api/auth/status") => (
                    200,
                    "application/json",
                    json!({"authenticated": true, "username": "codenomad", "passwordUserProvided": false})
                        .to_string(),
                ),
                _ => (404, "application/json", json!({"error": "not found"}).to_string()),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "initial-load", |h| {
            h.remote.snapshot.is_some() && h.remote.direct.meta_loaded()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Remote Control is off"));
        assert!(find_text(&tree, "iPhone · Safari"));
        // Direct access disclosure stays collapsed when listeningMode == "local".
        assert!(rt.find("remote-listening-mode-switch").is_none());

        click(&mut rt, "remote-control-start");
        pump(&mut rt, "start-tunnel", |h| {
            h.remote.flight.is_none() && h.remote.snapshot.as_ref().is_some_and(|(s, _)| s.enabled)
        })
        .await;
        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Ready for remote connections"));
        assert!(find_text(
            &tree,
            "https://codenomad-test.opentunnel.xyz/remote-pair#"
        ));
        assert!(rt.find("remote-control-new-link").is_some());

        click(&mut rt, "remote-control-previews-switch");
        pump(&mut rt, "enable-previews", |h| {
            h.remote.flight.is_none() && h.remote.snapshot.as_ref().is_some_and(|(s, _)| s.previews)
        })
        .await;

        click(&mut rt, "remote-control-stop");
        pump(&mut rt, "stop-tunnel", |h| {
            h.remote.flight.is_none() && h.remote.snapshot.as_ref().is_some_and(|(s, _)| !s.enabled)
        })
        .await;
        assert!(rt.state.remote.pairing.is_none());
        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Remote Control is off"));
        assert!(find_text(&tree, "iPhone · Safari"));
    });
}

#[test]
fn direct_access_listening_mode_password_and_addresses_flow() {
    platform::block_on(async {
        let authenticated = Arc::new(Mutex::new(true));
        let auth_srv = authenticated.clone();
        let server = MockServer::start(move |method, path, body| match (method, path) {
            ("GET", "/api/remote-control/status") => (
                200,
                "application/json",
                json!({
                    "manageable": true,
                    "enabled": false,
                    "startsOnLaunch": true,
                    "state": "error",
                    "error": "Relay unreachable",
                })
                .to_string(),
            ),
            ("GET", "/api/remote-control/devices") => {
                (200, "application/json", json!({"devices": []}).to_string())
            }
            ("GET", "/api/meta") => (
                200,
                "application/json",
                json!({
                    "listeningMode": "all",
                    "listeningLocked": false,
                    "localRequest": true,
                    "host": "0.0.0.0",
                    "localUrl": "http://127.0.0.1:9898",
                    "addresses": [
                        {"ip": "192.168.1.42", "family": "ipv4", "scope": "external", "remoteUrl": "https://192.168.1.42:9899"},
                        {"ip": "10.0.0.9", "family": "ipv4", "scope": "internal", "remoteUrl": "https://10.0.0.9:9899"}
                    ]
                })
                .to_string(),
            ),
            ("GET", "/api/auth/status") => {
                let authed = *auth_srv.lock().unwrap();
                let body = if authed {
                    json!({"authenticated": true, "username": "operator", "passwordUserProvided": false})
                } else {
                    json!({"authenticated": false})
                };
                (200, "application/json", body.to_string())
            }
            ("PATCH", "/api/storage/config/server") => {
                let v: Value = serde_json::from_str(body).unwrap();
                (200, "application/json", v.to_string())
            }
            ("POST", "/api/auth/password") => {
                let v: Value = serde_json::from_str(body).unwrap();
                if v["password"] == "conflict-pass" {
                    (409, "text/plain", "Server password is provided via CLI/env".into())
                } else {
                    // Matches server-rs/src/auth/mod.rs: saving a password revokes the session.
                    *auth_srv.lock().unwrap() = false;
                    (
                        200,
                        "application/json",
                        json!({"ok": true, "username": "operator", "passwordUserProvided": true})
                            .to_string(),
                    )
                }
            }
            _ => (404, "application/json", json!({"error": "not found"}).to_string()),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "direct-load", |h| {
            h.remote.snapshot.is_some() && h.remote.direct.meta_loaded()
        })
        .await;

        let tree = rt.accessibility_json();
        // Failed resume with startsOnLaunch keeps Stop available alongside Start.
        assert!(rt.find("remote-control-start").is_some());
        assert!(rt.find("remote-control-stop").is_some());
        assert!(find_text(&tree, "Relay unreachable"));
        // Direct access disclosure auto-opens when listeningMode == "all".
        assert!(rt.find("remote-listening-mode-switch").is_some());
        assert!(find_text(&tree, "http://127.0.0.1:9898"));
        assert!(find_text(&tree, "https://192.168.1.42:9899"));
        assert!(!find_text(&tree, "https://10.0.0.9:9899"));

        // Expanding other addresses reveals the secondary interface.
        click(&mut rt, "remote-addresses-toggle-other");
        assert!(find_text(&rt.accessibility_json(), "https://10.0.0.9:9899"));

        // Listening mode switch requires confirmation before PATCHing server config.
        click(&mut rt, "remote-listening-mode-switch");
        assert!(rt.find("remote-listening-confirm-apply").is_some());
        click(&mut rt, "remote-listening-confirm-apply");
        pump(&mut rt, "listening-mode-apply", |h| {
            h.remote.direct.restart_notice_shown()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Restart the app to apply the change."
        ));

        // Password form: local validation catches too-short and mismatch before hitting server.
        click(&mut rt, "remote-password-toggle");
        rt.update(|s, _| {
            s.remote.direct.set_password_drafts("short", "short");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        assert!(find_text(
            &rt.accessibility_json(),
            "Password must be at least 8 characters."
        ));

        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("long-enough-1", "different-pass");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        assert!(find_text(
            &rt.accessibility_json(),
            "Passwords do not match."
        ));

        // Server 409 conflict surfaces the plain-text error while keeping the form open.
        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("conflict-pass", "conflict-pass");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        pump(&mut rt, "password-conflict", |h| {
            h.remote.direct.password_idle()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Server password is provided via CLI/env"
        ));

        // Valid save closes the form, wipes password drafts, and re-reads /api/auth/status
        // so a revoked session is no longer presented as authenticated.
        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("new-valid-pass", "new-valid-pass");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        pump(&mut rt, "password-save", |h| {
            h.remote.direct.password_saved()
        })
        .await;
        assert!(rt.find("remote-password-new").is_none());
        assert!(find_text(
            &rt.accessibility_json(),
            "Authentication status unavailable."
        ));
        assert!(rt.state.remote.direct.password_drafts_empty());
        // Before restart, the listening-mode switch still reflects live /api/meta ("all").
        assert!(find_text(
            &rt.accessibility_json(),
            "https://192.168.1.42:9899"
        ));

        let requests = server.log.lock().unwrap();
        assert!(requests.iter().any(|(m, p, b)| m == "PATCH"
            && p == "/api/storage/config/server"
            && b.contains("\"local\"")));
    });
}

#[test]
fn administrator_policies_lock_remote_control_and_listening_mode() {
    platform::block_on(async {
        let device_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let server = MockServer::start(move |method, path, _| match (method, path) {
            ("GET", "/api/remote-control/status") => (
                200,
                "application/json",
                json!({
                    "manageable": true,
                    "enabled": false,
                    "disabledByAdministrator": true,
                    "state": "stopped",
                    "pairedDevices": 1,
                })
                .to_string(),
            ),
            ("GET", "/api/remote-control/devices") => (
                200,
                "application/json",
                json!({"devices": [{
                    "id": device_id,
                    "name": "Linux · Firefox",
                    "origin": null,
                    "lastSeenAt": "2026-11-25T10:00:00Z",
                    "revocationPending": true
                }]})
                .to_string(),
            ),
            ("GET", "/api/meta") => (
                200,
                "application/json",
                json!({
                    "listeningMode": "all",
                    "listeningLocked": true,
                    "localRequest": true,
                    "host": "10.20.30.40",
                    "localUrl": "http://127.0.0.1:9898",
                    "addresses": []
                })
                .to_string(),
            ),
            ("GET", "/api/auth/status") => (
                200,
                "application/json",
                json!({"authenticated": false}).to_string(),
            ),
            _ => (
                404,
                "application/json",
                json!({"error": "not found"}).to_string(),
            ),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "admin-policy-load", |h| {
            h.remote.snapshot.is_some() && h.remote.direct.meta_loaded()
        })
        .await;
        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Disabled by administrator"));
        assert!(rt.find("remote-control-start").is_none());
        assert!(rt.find("remote-control-previews-switch").is_none());
        assert!(find_text(&tree, "Linux · Firefox"));
        assert!(find_text(&tree, "Revocation pending"));
        assert!(find_text(&tree, "Binding to 10.20.30.40"));
        assert!(find_text(&tree, "Authentication status unavailable."));
    });
}

#[test]
fn partial_stop_and_devices_failure_keep_status_recheck_and_stop_available() {
    platform::block_on(async {
        // (enabled, starts_on_launch, state, devices_ok)
        let state = Arc::new(Mutex::new((true, true, "connecting", false)));
        let state_srv = state.clone();
        let server = MockServer::start(move |method, path, _| {
            let mut s = state_srv.lock().unwrap();
            match (method, path) {
                ("GET", "/api/remote-control/status") => (
                    200,
                    "application/json",
                    json!({
                        "manageable": true,
                        "enabled": s.0,
                        "startsOnLaunch": s.1,
                        "state": s.2,
                        "pairedDevices": 0,
                        "directOrigins": ["https://192.168.1.42:9899", "https://10.0.0.9:9899"],
                    })
                    .to_string(),
                ),
                ("GET", "/api/remote-control/devices") => {
                    if s.3 {
                        (200, "application/json", json!({"devices": []}).to_string())
                    } else {
                        (
                            500,
                            "application/json",
                            json!({"error": "Device registry unavailable"}).to_string(),
                        )
                    }
                }
                ("DELETE", "/api/remote-control") => {
                    // Partial stop: tunnel stopped, but startsOnLaunch could not be cleared.
                    s.0 = false;
                    s.1 = true;
                    s.2 = "stopped";
                    s.3 = true;
                    (
                        503,
                        "application/json",
                        json!({"error": "Failed to clear launch persistence"}).to_string(),
                    )
                }
                ("GET", "/api/meta") => (
                    200,
                    "application/json",
                    json!({
                        "listeningMode": "local",
                        "localRequest": true,
                        "localUrl": "http://127.0.0.1:9898",
                        "addresses": []
                    })
                    .to_string(),
                ),
                ("GET", "/api/auth/status") => (
                    200,
                    "application/json",
                    json!({"authenticated": true, "username": "operator", "passwordUserProvided": true})
                        .to_string(),
                ),
                _ => (
                    404,
                    "application/json",
                    json!({"error": "not found"}).to_string(),
                ),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "devices-error-with-connecting-status", |h| {
            h.remote.flight.is_none() && h.remote.snapshot.is_some()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Connecting"));
        assert!(find_text(&tree, "Device registry unavailable"));
        assert!(rt.state.remote.recheck.is_some());
        assert!(find_text(
            &tree,
            "Create HTTPS pairing link · https://192.168.1.42:9899"
        ));
        assert!(find_text(
            &tree,
            "Create HTTPS pairing link · https://10.0.0.9:9899"
        ));

        // Partial Stop returns 503 and leaves startsOnLaunch=true with state="stopped".
        // The error must survive the follow-up refresh and Stop must remain available.
        click(&mut rt, "remote-control-stop");
        pump(&mut rt, "partial-stop-refresh", |h| {
            h.remote.flight.is_none()
                && h.remote
                    .snapshot
                    .as_ref()
                    .is_some_and(|(s, _)| !s.enabled && s.starts_on_launch)
        })
        .await;
        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Failed to clear launch persistence"));
        assert!(rt.find("remote-control-stop").is_some());
        assert!(rt.find("remote-control-start").is_some());
    });
}

#[test]
fn direct_access_client_errors_localize_while_server_errors_surface_verbatim() {
    fn fr_view(s: &Harness, cx: &mut rune::Cx<Harness>) -> El {
        crate::strings::with_locale("fr", || {
            layout::render(cx, |_| {
                s.remote.view(
                    &s.shared,
                    |s: &mut Harness| Some(&mut s.remote),
                    |s| &mut s.remote,
                )
            })
        })
    }

    platform::block_on(async {
        let server = MockServer::start(move |method, path, body| match (method, path) {
            ("GET", "/api/remote-control/status") => (
                200,
                "application/json",
                json!({
                    "manageable": true,
                    "enabled": false,
                    "state": "stopped",
                    "pairedDevices": 0,
                })
                .to_string(),
            ),
            ("GET", "/api/remote-control/devices") => {
                (200, "application/json", json!({"devices": []}).to_string())
            }
            ("GET", "/api/meta") => (
                200,
                "application/json",
                json!({
                    "listeningMode": "all",
                    "localRequest": true,
                    "localUrl": "http://127.0.0.1:9898",
                    "addresses": []
                })
                .to_string(),
            ),
            ("GET", "/api/auth/status") => (
                200,
                "application/json",
                json!({"authenticated": true, "username": "codenomad", "passwordUserProvided": true})
                    .to_string(),
            ),
            ("PATCH", "/api/storage/config/server") => (400, "application/json", String::new()),
            ("POST", "/api/auth/password") => {
                if body.contains("unconfirmed-pass") {
                    (200, "application/json", json!({"ok": false}).to_string())
                } else {
                    (
                        409,
                        "application/json",
                        json!({"error": "Server password is provided via CLI/env"}).to_string(),
                    )
                }
            }
            _ => (
                404,
                "application/json",
                json!({"error": "not found"}).to_string(),
            ),
        })
        .await;

        let wake: Waker = Arc::new(|| {});
        let shared = Rc::new(RefCell::new(Preferences::default()));
        {
            let mut prefs = shared.borrow_mut();
            prefs.fixture_locale("fr");
            prefs.backend = Some(Backend::unauthenticated(&server.base).unwrap());
            prefs.window_wake = Some(wake.clone());
        }
        let mut rt = Runtime::new(
            Harness {
                shared,
                remote: Remote::default(),
                wake,
            },
            fr_view,
            (960.0, 2000.0),
            Env::new(false, 1.0),
        );

        pump(&mut rt, "initial-load-fr", |h| {
            h.remote.snapshot.is_some() && h.remote.direct.meta_loaded()
        })
        .await;

        // Rejected listening-mode PATCH must display localized French error, not English Rust prose.
        click(&mut rt, "remote-listening-mode-switch");
        click(&mut rt, "remote-listening-confirm-apply");
        pump(&mut rt, "listening-mode-rejected", |h| {
            h.remote.direct.mode_idle()
        })
        .await;
        let tree = rt.accessibility_json();
        let expected_fr = crate::strings::with_locale("fr", || t("settings.preferenceSaveFailed"));
        assert_eq!(count_text(&tree, expected_fr), 1);
        assert!(!find_text(&tree, "Listening mode change"));

        // Unconfirmed password response (ok: false) must also display the localized French error
        // independently on the password card.
        click(&mut rt, "remote-password-toggle");
        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("unconfirmed-pass", "unconfirmed-pass");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        pump(&mut rt, "password-unconfirmed", |h| {
            h.remote.direct.password_idle()
        })
        .await;
        assert!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p, b)| m == "POST"
                    && p == "/api/auth/password"
                    && b.contains("unconfirmed-pass"))
        );
        let tree = rt.accessibility_json();
        assert_eq!(count_text(&tree, expected_fr), 2);
        assert!(!find_text(&tree, "Password update was not confirmed"));

        // Explicit server error message still surfaces verbatim.
        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("conflict-pass", "conflict-pass");
        });
        rt.frame(0.02);
        click(&mut rt, "remote-password-save");
        pump(&mut rt, "password-server-error", |h| {
            h.remote.direct.password_idle()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Server password is provided via CLI/env"
        ));
    });
}

#[test]
fn remote_revoke_error_survives_reconciliation_and_stale_profile_submission_is_refused() {
    platform::block_on(async {
        let device_id = "22222222-3333-4444-5555-666666666666";
        let devices_present = Arc::new(Mutex::new(true));
        let devices_srv = devices_present.clone();
        let server_a = MockServer::start(move |method, path, _| {
            match (method, path) {
            ("GET", "/api/remote-control/status") => (
                200,
                "application/json",
                json!({
                    "manageable": true,
                    "enabled": true,
                    "state": "connected",
                    "remoteUrl": "https://codenomad-test.opentunnel.xyz",
                    "pairedDevices": usize::from(*devices_srv.lock().unwrap()),
                })
                .to_string(),
            ),
            ("GET", "/api/remote-control/devices") => {
                let list = if *devices_srv.lock().unwrap() {
                    json!({"devices": [{
                        "id": device_id,
                        "name": "Phone",
                        "origin": null,
                        "lastSeenAt": "2026-11-25T10:00:00Z",
                        "revocationPending": false
                    }]})
                } else {
                    json!({"devices": []})
                };
                (200, "application/json", list.to_string())
            }
            ("DELETE", path) if path == format!("/api/remote-control/devices/{device_id}") => {
                *devices_srv.lock().unwrap() = false;
                (
                    404,
                    "application/json",
                    json!({"error": "Remote device not found"}).to_string(),
                )
            }
            ("GET", "/api/meta") => (
                200,
                "application/json",
                json!({
                    "listeningMode": "all",
                    "localRequest": true,
                    "localUrl": "http://127.0.0.1:9898",
                    "addresses": []
                })
                .to_string(),
            ),
            ("GET", "/api/auth/status") => (
                200,
                "application/json",
                json!({"authenticated": true, "username": "operator", "passwordUserProvided": true})
                    .to_string(),
            ),
            _ => (
                404,
                "application/json",
                json!({"error": "not found"}).to_string(),
            ),
        }
        })
        .await;

        let server_b = MockServer::start(move |method, path, _| match (method, path) {
            ("POST", "/api/auth/password") => (
                200,
                "application/json",
                json!({"ok": true, "username": "other", "passwordUserProvided": true}).to_string(),
            ),
            _ => (
                200,
                "application/json",
                json!({"manageable": true, "enabled": true, "state": "stopped"}).to_string(),
            ),
        })
        .await;

        let mut rt = new_runtime(&server_a.base);
        pump(&mut rt, "revoke-load", |h| {
            h.remote.snapshot.is_some() && h.remote.direct.meta_loaded()
        })
        .await;

        // Revoke fails with explicit 404 while follow-up GET returns empty devices: error must stay visible.
        click(&mut rt, &format!("remote-device-revoke-{device_id}"));
        pump(&mut rt, "revoke-reconciled", |h| h.remote.flight.is_none()).await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Remote device not found"
        ));

        // Explicit manual Refresh clears the confirmed error.
        click(&mut rt, "remote-control-refresh");
        pump(&mut rt, "explicit-refresh", |h| h.remote.flight.is_none()).await;
        assert!(!find_text(
            &rt.accessibility_json(),
            "Remote device not found"
        ));

        // Open password form on A, switch Preferences backend to B BEFORE Remote::poll runs,
        // and submit the still-rendered form: profile B must receive zero POST /api/auth/password.
        click(&mut rt, "remote-password-toggle");
        rt.update(|s, _| {
            s.remote
                .direct
                .set_password_drafts("secret-for-a", "secret-for-a");
            s.shared.borrow_mut().backend = Some(Backend::unauthenticated(&server_b.base).unwrap());
        });
        click(&mut rt, "remote-password-save");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !server_b
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p, _)| m == "POST" && p == "/api/auth/password")
        );
    });
}

fn count_text(tree: &Value, needle: &str) -> usize {
    let here = usize::from(
        tree["name"]
            .as_str()
            .is_some_and(|name| name.contains(needle)),
    );
    here + tree["children"].as_array().map_or(0, |children| {
        children.iter().map(|c| count_text(c, needle)).sum()
    })
}
