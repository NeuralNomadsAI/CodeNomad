use super::super::*;
use crate::{backend::Backend, platform};
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
    catalog: Catalog,
    target: Option<Target>,
    available: bool,
    wake: rune::Waker,
}

fn harness_view(s: &Harness, cx: &mut rune::Cx<Harness>) -> El {
    crate::strings::with_locale("en", || {
        rune_theme_codenomad::layout::render(cx, |_| {
            let mut layers = Vec::new();
            let content = render_groups(
                &s.catalog,
                s.available,
                &mut layers,
                |s: &mut Harness| &mut s.catalog,
                #[cfg(not(target_arch = "wasm32"))]
                Some(&s.catalog.websearch_key),
                #[cfg(not(target_arch = "wasm32"))]
                Some(|s: &mut Harness| &mut s.catalog.websearch_key),
                #[cfg(target_arch = "wasm32")]
                None,
                #[cfg(target_arch = "wasm32")]
                None,
            );
            let mut root = col().full_width().child(content);
            for layer in layers {
                root = root.child(layer);
            }
            root
        })
    })
}

struct MockServer {
    base: String,
    log: Arc<Mutex<Vec<(String, String, String)>>>,
    location_headers: Arc<Mutex<Vec<(String, String, Option<String>)>>>,
}

impl MockServer {
    async fn start(
        handler: impl Fn(&str, &str, &str) -> (u16, &'static str, String) + Send + Sync + 'static,
    ) -> Self {
        let handler = Arc::new(handler);
        Self::start_async(move |method, path, body| {
            let handler = handler.clone();
            async move { handler(&method, &path, &body) }
        })
        .await
    }

    async fn start_async<F, Fut>(handler: F) -> Self
    where
        F: Fn(String, String, String) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = (u16, &'static str, String)> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let location_headers = Arc::new(Mutex::new(Vec::new()));
        let log_clone = log.clone();
        let headers_clone = location_headers.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let log = log_clone.clone();
                let headers = headers_clone.clone();
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
                    let location_header = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("x-codenomad-location")
                            .then(|| value.trim().to_owned())
                    });
                    while raw.len() < header_end + content_len {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&tmp[..n]);
                    }
                    let first = head.lines().next().unwrap_or_default();
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
                    headers
                        .lock()
                        .unwrap()
                        .push((method.clone(), path.clone(), location_header));
                    let (status, content_type, reply_body) = handler(method, path, body).await;
                    let reason = match status {
                        200 => "OK",
                        204 => "No Content",
                        400 => "Bad Request",
                        404 => "Not Found",
                        501 => "Not Implemented",
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
            location_headers,
        }
    }
}

fn new_runtime(base: &str) -> Runtime<Harness> {
    let wake: rune::Waker = Arc::new(|| {});
    let backend = Backend::unauthenticated(base).unwrap();
    let target = Target {
        backend,
        workspace: "ws1".into(),
        session: None,
        owned_tab: false,
        revision: 0,
        mission_catalog: 0,
        location_epoch: 0,
        observed: None,
        observed_location_revision: 0,
        observed_upstream_healthy: true,
        authority: 0,
        native_authority: 0,
        online: true,
        native_online: true,
        stats: [0; 2],
        stats_status: None,
        integrations: 0,
        integrations_session: 0,
    };
    Runtime::new(
        Harness {
            catalog: Catalog::default(),
            target: Some(target),
            available: true,
            wake,
        },
        harness_view,
        (960.0, 2200.0),
        Env::new(false, 1.0),
    )
}

async fn pump(rt: &mut Runtime<Harness>, label: &str, until: impl Fn(&Harness) -> bool) {
    for _ in 0..120 {
        rt.update(|s, tx| {
            let target = s.available.then_some(s.target.as_ref()).flatten();
            s.catalog
                .poll(target, 0.0, Some(&s.wake), tx, true, |s: &mut Harness| {
                    &mut s.catalog
                });
        });
        rt.frame(0.02);
        if until(&rt.state) {
            rt.frame(1.0);
            return;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    panic!("condition '{label}' did not settle in time");
}

fn click(rt: &mut Runtime<Harness>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.frame(1.0);
}

fn click_disclosure(rt: &mut Runtime<Harness>, index: usize) {
    let trigger = rt
        .elements()
        .into_iter()
        .filter(|e| e.key.as_deref() == Some("trigger"))
        .nth(index)
        .unwrap_or_else(|| panic!("missing disclosure trigger index {index}"));
    let x = trigger.rect[0] + trigger.rect[2] * 0.5;
    let y = trigger.rect[1] + trigger.rect[3] * 0.5;
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.frame(1.0);
}

fn find_text(node: &Value, needle: &str) -> bool {
    node.to_string().contains(needle)
}

#[test]
fn lazy_disclosures_preserve_window_fold_state_and_do_not_fetch_while_folded() {
    platform::block_on(async {
        let server = MockServer::start(move |method, path, _| match (method, path) {
            ("GET", "/workspaces/ws1/instance/api/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [{"id": "openai", "name": "OpenAI"}]}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/model") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [{"id": "gpt-5", "providerID": "openai"}]}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/integration") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [
                    {"id": "openai", "name": "OpenAI", "connections": [{"type": "env", "name": "OPENAI_API_KEY"}]},
                    {"id": "exa", "name": "Exa", "methods": [{"type": "key"}], "connections": []}
                ]}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [{"id": "exa", "name": "Exa"}]}).to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/websearch-settings") => (
                200,
                "application/json",
                json!({
                    "location": {"directory": "/repo"},
                    "effective": null,
                    "scopes": [{"scope": "global", "path": "/g", "selection": null}]
                })
                .to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => (
                200,
                "application/json",
                json!({
                    "location": {"directory": "/repo"},
                    "generation": {"global": true, "effective": true, "models": []},
                    "mediaStorage": {"global": false, "effective": false}
                })
                .to_string(),
            ),
            _ => (404, "application/json", json!({"error": "not found"}).to_string()),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-initial-load", |h| {
            h.catalog.models_settled()
        })
        .await;

        assert!(rt.state.catalog.models_expanded());
        assert!(!rt.state.catalog.websearch.borrow().is_expanded());
        assert!(!rt.state.catalog.images.borrow().is_expanded());
        {
            let requests = server.log.lock().unwrap();
            assert!(
                !requests
                    .iter()
                    .any(|(_, p, _)| p.contains("websearch-settings"))
            );
            assert!(
                !requests
                    .iter()
                    .any(|(_, p, _)| p.contains("image-settings"))
            );
        }

        // Open Web Search and Images lazily.
        click_disclosure(&mut rt, 1);
        pump(&mut rt, "websearch-lazy-load", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.is_expanded() && ws.has_snapshot() && ws.is_idle()
        })
        .await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-lazy-load", |h| {
            let img = h.catalog.images.borrow();
            img.is_expanded() && img.has_snapshot() && img.is_idle()
        })
        .await;

        // Suspending (leaving Preferences / switching section) preserves fold state while clearing data.
        rt.update(|s, _| s.catalog.suspend());
        rt.frame(0.02);
        assert!(rt.state.catalog.models_expanded());
        assert!(rt.state.catalog.websearch.borrow().is_expanded());
        assert!(rt.state.catalog.images.borrow().is_expanded());
        assert!(!rt.state.catalog.websearch.borrow().has_snapshot());
        assert!(!rt.state.catalog.images.borrow().has_snapshot());

        // Unavailable / no workspace shows the empty-instance notice in all open groups without HTTP calls.
        let count_before = server.log.lock().unwrap().len();
        rt.update(|s, _| s.available = false);
        rt.frame(0.02);
        pump(&mut rt, "unavailable-settle", |_| true).await;
        assert_eq!(server.log.lock().unwrap().len(), count_before);
        assert!(find_text(
            &rt.accessibility_json(),
            "Start a workspace to manage provider connections."
        ));
    });
}

#[test]
fn websearch_connections_key_connect_disconnect_and_defaults_flow() {
    platform::block_on(async {
        // (tavily_connected, exa_cred_present, global_sel, project_sel, fail_next_put)
        let state = Arc::new(Mutex::new((
            false,
            true,
            Value::String("exa".into()),
            Value::Null,
            false,
        )));
        let srv = state.clone();
        let server = MockServer::start(move |method, path, body| {
            let mut s = srv.lock().unwrap();
            match (method, path) {
                ("GET", "/workspaces/ws1/instance/api/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/model") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": [
                        {"id": "exa", "name": "Exa"},
                        {"id": "tavily", "name": "Tavily"}
                    ]})
                    .to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/integration") => {
                    let mut exa_conns = vec![json!({"type": "env", "name": "EXA_API_KEY"})];
                    if s.1 {
                        exa_conns.push(json!({"type": "credential", "id": "key-id", "label": "Saved key"}));
                    }
                    let tavily_conns = if s.0 {
                        vec![json!({"type": "credential", "id": "tav-1", "label": "Tavily key"})]
                    } else {
                        vec![]
                    };
                    (
                        200,
                        "application/json",
                        json!({"location": {"directory": "/repo"}, "data": [
                            {"id": "exa", "name": "Exa", "methods": [{"type": "key"}], "connections": exa_conns},
                            {"id": "tavily", "name": "Tavily", "methods": [{"type": "key"}], "connections": tavily_conns},
                            {"id": "openai", "name": "OpenAI", "methods": [{"type": "key"}], "connections": [{"type": "env", "name": "OPENAI_API_KEY"}]}
                        ]})
                        .to_string(),
                    )
                }
                ("POST", p) if p.starts_with("/workspaces/ws1/instance/api/integration/tavily/connect/key") => {
                    let v: Value = serde_json::from_str(body).unwrap();
                    assert_eq!(v["key"], "tvly-secret-123");
                    s.0 = true;
                    (204, "application/json", String::new())
                }
                ("DELETE", "/workspaces/ws1/instance/api/credential/key-id") => {
                    s.1 = false;
                    (204, "application/json", String::new())
                }
                ("GET", p) if p.starts_with("/api/workspaces/ws1/websearch-settings") => {
                    let effective = if s.3.is_null() { s.2.clone() } else { s.3.clone() };
                    (
                        200,
                        "application/json",
                        json!({
                            "location": {"directory": "/repo"},
                            "effective": effective,
                            "scopes": [
                                {"scope": "global", "path": "/home/opencode.jsonc", "selection": s.2},
                                {"scope": "project", "path": "/repo/opencode.jsonc", "selection": s.3}
                            ]
                        })
                        .to_string(),
                    )
                }
                ("PUT", "/api/workspaces/ws1/websearch-settings") => {
                    if s.4 {
                        s.4 = false;
                        return (
                            503,
                            "application/json",
                            json!({"error": "Web search settings unavailable"}).to_string(),
                        );
                    }
                    let v: Value = serde_json::from_str(body).unwrap();
                    if v["scope"] == "global" {
                        s.2 = v["provider"].clone();
                    } else {
                        s.3 = v["provider"].clone();
                    }
                    (204, "application/json", String::new())
                }
                _ => (404, "application/json", json!({"error": "not found"}).to_string()),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;

        // Open Web Search disclosure.
        click_disclosure(&mut rt, 1);
        pump(&mut rt, "websearch-load", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.has_snapshot() && ws.is_idle()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Exa"));
        assert!(find_text(
            &tree,
            "From environment: EXA_API_KEY (read-only)"
        ));
        assert!(!find_text(&tree, "websearch-configured-openai"));

        // Select Tavily via picker keyboard nav (ArrowDown + Escape test first), then paste API key.
        click(&mut rt, "websearch-provider-picker");
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-provider-opt-exa")));
        rt.key(rune::Key::Down.into());
        rt.frame(0.02);
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-provider-opt-tavily")));
        rt.key(rune::Key::Escape.into());
        rt.frame(0.02);
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-provider-picker")));
        assert!(rt.find("websearch-provider-opt-tavily").is_none());

        click(&mut rt, "websearch-provider-picker");
        click(&mut rt, "websearch-provider-opt-tavily");
        click(&mut rt, "websearch-connect-open");
        click(&mut rt, "websearch-api-key");
        rt.paste("tvly-secret-123");
        rt.frame(0.02);
        click(&mut rt, "websearch-connect-submit");
        pump(&mut rt, "websearch-connect-done", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.is_idle() && h.catalog.websearch_key.text.is_empty()
        })
        .await;
        assert!(rt.find("websearch-api-key").is_none());
        assert!(find_text(&rt.accessibility_json(), "Tavily key"));

        // Disconnect Exa saved credential and verify x-codenomad-location header ownership context.
        click(&mut rt, "websearch-disconnect-key-id");
        pump(&mut rt, "websearch-disconnect-done", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        assert!(rt.find("websearch-disconnect-key-id").is_none());
        assert!(
            server
                .location_headers
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p, h)| {
                    m == "DELETE"
                        && p == "/workspaces/ws1/instance/api/credential/key-id"
                        && h.as_deref() == Some("%7B%22directory%22%3A%22%2Frepo%22%7D")
                })
        );

        // Change global default to Disabled and project override to Tavily.
        click(&mut rt, "websearch-scope-global");
        click(&mut rt, "websearch-scope-global-off");
        pump(&mut rt, "websearch-global-off", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        click(&mut rt, "websearch-scope-project");
        click(&mut rt, "websearch-scope-project-provider-tavily");
        pump(&mut rt, "websearch-project-tavily", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        assert!(find_text(&rt.accessibility_json(), "Disabled"));
        assert!(find_text(&rt.accessibility_json(), "Tavily"));

        // Re-selecting already-selected Global value (Disabled) sends no PUT.
        let puts_before_noop = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
            .count();
        click(&mut rt, "websearch-scope-global");
        click(&mut rt, "websearch-scope-global-off");
        rt.frame(0.02);
        let puts_after_noop = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
            .count();
        assert_eq!(puts_before_noop, puts_after_noop);

        // Failed PUT keeps error alert visible after follow-up reload.
        state.lock().unwrap().4 = true;
        click(&mut rt, "websearch-scope-global");
        click(&mut rt, "websearch-scope-global-random");
        pump(&mut rt, "websearch-put-error", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Unable to update or read web search settings. Refresh to retry."
        ));
    });
}

#[test]
fn images_models_storage_overrides_blocked_and_error_flow() {
    platform::block_on(async {
        // (generation, media_storage, blocked, fail_next_put)
        let state = Arc::new(Mutex::new((Value::Bool(true), false, false, false)));
        let srv = state.clone();
        let server = MockServer::start(move |method, path, body| {
            let mut s = srv.lock().unwrap();
            match (method, path) {
                ("GET", "/workspaces/ws1/instance/api/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/model") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/integration") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => {
                    let mut doc = json!({
                        "location": {"directory": "/repo"},
                        "generation": {
                            "global": s.0,
                            "effective": "openai/gpt-image-2",
                            "override": {"path": "/repo/opencode.jsonc"},
                            "models": [{"ref": "openai/gpt-image-2", "name": "GPT Image 2"}]
                        },
                        "mediaStorage": {
                            "global": s.1,
                            "effective": s.1
                        }
                    });
                    if s.2 {
                        doc["blockedBy"] = json!({"path": "/global/opencode.json"});
                    }
                    (200, "application/json", doc.to_string())
                }
                ("PUT", "/api/workspaces/ws1/image-settings") => {
                    if s.3 {
                        s.3 = false;
                        return (
                            503,
                            "application/json",
                            json!({"error": "Image settings are unavailable"}).to_string(),
                        );
                    }
                    let v: Value = serde_json::from_str(body).unwrap();
                    if let Some(generation) = v.get("generation") {
                        s.0 = generation.clone();
                    }
                    if let Some(storage) = v.get("mediaStorage").and_then(Value::as_bool) {
                        s.1 = storage;
                    }
                    (204, "application/json", String::new())
                }
                _ => (
                    404,
                    "application/json",
                    json!({"error": "not found"}).to_string(),
                ),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;

        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-load", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "On, automatic model"));
        assert!(find_text(
            &tree,
            "Another OpenCode configuration takes precedence here: GPT Image 2."
        ));

        // Re-selecting the already-selected Images generation option (Auto) sends no PUT.
        click(&mut rt, "images-generation-picker");
        click(&mut rt, "images-generation-auto");
        rt.frame(0.02);
        assert_eq!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
                .count(),
            0
        );

        // Select a specific image model and enable Store images once.
        click(&mut rt, "images-generation-picker");
        click(&mut rt, "images-generation-model-openai/gpt-image-2");
        pump(&mut rt, "images-model-saved", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        click(&mut rt, "images-storage-switch");
        pump(&mut rt, "images-storage-saved", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;

        // Failed PUT keeps error alert visible after follow-up reload.
        state.lock().unwrap().3 = true;
        click(&mut rt, "images-storage-switch");
        pump(&mut rt, "images-put-error", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Unable to read or update image settings."
        ));

        // Blocked document shows blocked notice and disables controls.
        state.lock().unwrap().2 = true;
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.invalidate();
            }
        });
        pump(&mut rt, "images-blocked-reload", |h| {
            let img = h.catalog.images.borrow();
            img.is_idle() && img.is_blocked()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Saving here would hide other OpenCode settings."
        ));

        let requests = server.log.lock().unwrap();
        assert!(requests.iter().any(|(m, p, b)| m == "PUT"
            && p == "/api/workspaces/ws1/image-settings"
            && b.contains("openai/gpt-image-2")));
        assert!(requests.iter().any(|(m, p, b)| m == "PUT"
            && p == "/api/workspaces/ws1/image-settings"
            && b.contains("\"mediaStorage\":true")));
    });
}

#[test]
fn unsupported_404_501_endpoints_degrade_cleanly() {
    platform::block_on(async {
        let server = MockServer::start(move |method, path, _| match (method, path) {
            ("GET", "/workspaces/ws1/instance/api/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/model") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/integration") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [
                    {"id": "exa", "name": "Exa", "methods": [{"type": "key"}], "connections": [{"type": "env", "name": "EXA_API_KEY"}]}
                ]}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [{"id": "exa", "name": "Exa"}]}).to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/websearch-settings") => (
                404,
                "application/json",
                json!({"message": "Not Found"}).to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => (
                501,
                "application/json",
                json!({"error": "Not implemented"}).to_string(),
            ),
            _ => (404, "application/json", json!({"error": "not found"}).to_string()),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;

        click_disclosure(&mut rt, 1);
        pump(&mut rt, "websearch-404", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.has_snapshot() && ws.is_idle()
        })
        .await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-501", |h| {
            let img = h.catalog.images.borrow();
            img.is_unsupported() && img.is_idle()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "Exa"));
        assert!(!find_text(
            &tree,
            "Unable to update or read web search settings. Refresh to retry."
        ));
        // When websearch-settings is unavailable (404/501), Connect stays disabled.
        click(&mut rt, "websearch-connect-open");
        rt.frame(0.02);
        assert!(rt.find("websearch-api-key").is_none());
        assert!(find_text(
            &tree,
            "The connected OpenCode version has no image settings."
        ));
        assert!(!find_text(
            &tree,
            "Unable to read or update image settings."
        ));
    });
}

#[test]
fn domain_404_and_failed_post_write_readback_surface_error_and_lock_stale_controls() {
    platform::block_on(async {
        // (fail_next_get, media_storage, domain_404_images)
        let state = Arc::new(Mutex::new((false, false, false)));
        let srv = state.clone();
        let server = MockServer::start(move |method, path, body| {
            let mut s = srv.lock().unwrap();
            match (method, path) {
                ("GET", "/workspaces/ws1/instance/api/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/model") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/integration") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                ),
                ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => {
                    if s.2 {
                        return (
                            404,
                            "application/json",
                            json!({"error": "Workspace not found"}).to_string(),
                        );
                    }
                    if s.0 {
                        s.0 = false;
                        return (
                            503,
                            "application/json",
                            json!({"error": "Image settings are unavailable"}).to_string(),
                        );
                    }
                    (
                        200,
                        "application/json",
                        json!({
                            "location": {"directory": "/repo"},
                            "generation": {"global": true, "effective": true, "models": []},
                            "mediaStorage": {"global": s.1, "effective": s.1}
                        })
                        .to_string(),
                    )
                }
                ("PUT", "/api/workspaces/ws1/image-settings") => {
                    let v: Value = serde_json::from_str(body).unwrap();
                    if let Some(enabled) = v["mediaStorage"].as_bool() {
                        s.1 = enabled;
                    }
                    s.0 = true;
                    (204, "application/json", String::new())
                }
                _ => (
                    404,
                    "application/json",
                    json!({"error": "Not Found"}).to_string(),
                ),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;

        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-load", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;

        // Toggle mediaStorage -> PUT succeeds, post-write GET fails -> switch stays disabled until Refresh.
        click(&mut rt, "images-storage-switch");
        pump(&mut rt, "images-readback-failed", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        let puts_after_first = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
            .count();
        assert_eq!(puts_after_first, 1);
        click(&mut rt, "images-storage-switch");
        rt.frame(0.02);
        let puts_while_stale = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
            .count();
        assert_eq!(puts_while_stale, 1);

        // Refresh recovers confirmed state, then domain 404 surfaces error (not unsupported).
        click(&mut rt, "images-refresh");
        pump(&mut rt, "images-refresh-ok", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        state.lock().unwrap().2 = true;
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.invalidate();
            }
        });
        pump(&mut rt, "images-domain-404", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        assert!(!rt.state.catalog.images.borrow().is_unsupported());
        assert!(find_text(
            &rt.accessibility_json(),
            "Unable to read or update image settings."
        ));
    });
}

#[test]
fn folded_write_failure_surfaces_error_upon_reopen() {
    platform::block_on(async {
        let server = MockServer::start(move |method, path, _| match (method, path) {
            ("GET", "/workspaces/ws1/instance/api/provider")
            | ("GET", "/workspaces/ws1/instance/api/model")
            | ("GET", "/workspaces/ws1/instance/api/integration")
            | ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => (
                200,
                "application/json",
                json!({
                    "location": {"directory": "/repo"},
                    "generation": {"global": true, "effective": true, "models": []},
                    "mediaStorage": {"global": false, "effective": false}
                })
                .to_string(),
            ),
            ("PUT", "/api/workspaces/ws1/image-settings") => (
                503,
                "application/json",
                json!({"error": "Image settings are unavailable"}).to_string(),
            ),
            _ => (
                404,
                "application/json",
                json!({"error": "Not Found"}).to_string(),
            ),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-load", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;

        // Start a failing PUT, immediately fold Images, wait for write to settle, then reopen.
        click(&mut rt, "images-storage-switch");
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "folded-write-settled", |h| {
            let img = h.catalog.images.borrow();
            !img.is_expanded() && img.is_idle()
        })
        .await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "reopened-after-failure", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;
        assert!(find_text(
            &rt.accessibility_json(),
            "Unable to read or update image settings."
        ));
    });
}

#[test]
fn write_barrier_survives_project_switch_and_window_reopen() {
    platform::block_on(async {
        let storage_on = Arc::new(Mutex::new(false));
        let put_arrived = Arc::new(tokio::sync::Notify::new());
        let release_put = Arc::new(tokio::sync::Notify::new());
        let storage_srv = storage_on.clone();
        let arrived_srv = put_arrived.clone();
        let release_srv = release_put.clone();
        let server = MockServer::start_async(move |method, path, _| {
            let storage = storage_srv.clone();
            let arrived = arrived_srv.clone();
            let release = release_srv.clone();
            async move {
                match (method.as_str(), path.as_str()) {
                    ("GET", p)
                        if p.ends_with("/instance/api/provider")
                            || p.ends_with("/instance/api/model")
                            || p.ends_with("/instance/api/integration")
                            || p.ends_with("/instance/api/websearch/provider") =>
                    {
                        (
                            200,
                            "application/json",
                            json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
                        )
                    }
                    ("GET", p) if p.contains("/image-settings") => {
                        let on = *storage.lock().unwrap();
                        (
                            200,
                            "application/json",
                            json!({
                                "location": {"directory": "/repo"},
                                "generation": {"global": true, "effective": true, "models": []},
                                "mediaStorage": {"global": on, "effective": on}
                            })
                            .to_string(),
                        )
                    }
                    ("PUT", "/api/workspaces/ws1/image-settings") => {
                        arrived.notify_one();
                        release.notified().await;
                        *storage.lock().unwrap() = true;
                        (200, "application/json", json!({"ok": true}).to_string())
                    }
                    _ => (
                        404,
                        "application/json",
                        json!({"message": "Not Found"}).to_string(),
                    ),
                }
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-load", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;
        let initial_gets = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "GET" && p.contains("/image-settings"))
            .count();

        // Start a slow PUT on ws1 and wait until the server receives it.
        click(&mut rt, "images-storage-switch");
        put_arrived.notified().await;

        // Switch project A -> B -> A while PUT is still in flight.
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.workspace = "ws2".into();
            }
        });
        for _ in 0..4 {
            rt.update(|s, tx| {
                s.catalog.poll(
                    s.target.as_ref(),
                    0.0,
                    Some(&s.wake),
                    tx,
                    true,
                    |s: &mut Harness| &mut s.catalog,
                );
            });
            rt.frame(0.02);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.workspace = "ws1".into();
            }
        });
        for _ in 0..4 {
            rt.update(|s, tx| {
                s.catalog.poll(
                    s.target.as_ref(),
                    0.0,
                    Some(&s.wake),
                    tx,
                    true,
                    |s: &mut Harness| &mut s.catalog,
                );
            });
            rt.frame(0.02);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Recreate a fresh Preferences window while PUT is still in flight.
        let mut rt2 = new_runtime(&server.base);
        pump(&mut rt2, "rt2-models", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt2, 2);
        for _ in 0..4 {
            rt2.update(|s, tx| {
                s.catalog.poll(
                    s.target.as_ref(),
                    0.0,
                    Some(&s.wake),
                    tx,
                    true,
                    |s: &mut Harness| &mut s.catalog,
                );
            });
            rt2.frame(0.02);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // No replacement GET and no second PUT may have started while the barrier is held.
        let (gets_during_write, puts_during_write) = {
            let log = server.log.lock().unwrap();
            (
                log.iter()
                    .filter(|(m, p, _)| m == "GET" && p.contains("/image-settings"))
                    .count(),
                log.iter()
                    .filter(|(m, p, _)| m == "PUT" && p.contains("/image-settings"))
                    .count(),
            )
        };
        assert_eq!(gets_during_write, initial_gets);
        assert_eq!(puts_during_write, 1);

        // Release the PUT: both runtimes wake up and load the post-write snapshot.
        release_put.notify_waiters();
        pump(&mut rt, "rt1-after-barrier", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;
        pump(&mut rt2, "rt2-after-barrier", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;
        assert!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "GET" && p.contains("/image-settings"))
                .count()
                >= initial_gets + 2
        );
    });
}

#[test]
fn passive_refresh_preserves_open_picker_focus_and_scope_paths() {
    platform::block_on(async {
        let server = MockServer::start(move |method, path, _| match (method, path) {
            ("GET", "/workspaces/ws1/instance/api/provider")
            | ("GET", "/workspaces/ws1/instance/api/model") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": []}).to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/integration") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [
                    {"id": "exa", "name": "Exa", "methods": [{"type": "key"}], "connections": []}
                ]})
                .to_string(),
            ),
            ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                200,
                "application/json",
                json!({"location": {"directory": "/repo"}, "data": [{"id": "exa", "name": "Exa"}]})
                    .to_string(),
            ),
            ("GET", p) if p.starts_with("/api/workspaces/ws1/websearch-settings") => (
                200,
                "application/json",
                json!({
                    "location": {"directory": "/repo"},
                    "effective": "exa",
                    "scopes": [
                        {"scope": "global", "path": "/home/opencode.jsonc", "selection": null},
                        {"scope": "project", "path": "/repo/opencode.jsonc", "selection": "exa"}
                    ]
                })
                .to_string(),
            ),
            _ => (
                404,
                "application/json",
                json!({"message": "Not Found"}).to_string(),
            ),
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt, 1);
        pump(&mut rt, "websearch-load", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.has_snapshot() && ws.is_idle()
        })
        .await;

        let tree = rt.accessibility_json();
        assert!(find_text(&tree, "/home/opencode.jsonc"));
        assert!(find_text(&tree, "/repo/opencode.jsonc"));

        // Open the Global scope picker and move keyboard focus to Off.
        click(&mut rt, "websearch-scope-global");
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-scope-global-default")));
        rt.key(rune::Key::Down.into());
        rt.frame(0.02);
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-scope-global-off")));

        let reads_before = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| {
                m == "GET" && p.starts_with("/api/workspaces/ws1/websearch-settings")
            })
            .count();

        // Trigger a passive invalidation while the picker is open.
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.invalidate();
            }
        });
        pump(&mut rt, "passive-refresh-settled", |h| {
            let reads_now = server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| {
                    m == "GET" && p.starts_with("/api/workspaces/ws1/websearch-settings")
                })
                .count();
            reads_now > reads_before && h.catalog.websearch.borrow().is_idle()
        })
        .await;

        // The open picker and its keyboard focus remain intact across the passive refresh.
        assert!(rt.find("websearch-scope-global-off").is_some());
        rt.update(|_, tx| assert_eq!(tx.focused(), Some("websearch-scope-global-off")));
    });
}

#[test]
fn session_move_revokes_write_authority_and_barrier_tracks_exact_write_id() {
    // Barrier per-operation outcome and per-workspace error isolation.
    let wake: rune::Waker = Arc::new(|| {});
    let base = "http://127.0.0.1:1/barrier-exact-id-test/";
    let obs_a = write_barrier::next_observer();
    let obs_b = write_barrier::next_observer();
    let g1 = write_barrier::try_begin(
        write_barrier::Domain::WebSearch,
        base,
        "ws-a",
        obs_a,
        wake.clone(),
    )
    .unwrap();
    let id1 = g1.id();
    g1.finish(false);
    let g2 = write_barrier::try_begin(
        write_barrier::Domain::WebSearch,
        base,
        "ws-b",
        obs_b,
        wake.clone(),
    )
    .unwrap();
    let id2 = g2.id();
    g2.finish(true);
    assert_eq!(
        write_barrier::settled_status(write_barrier::Domain::WebSearch, base, id1),
        Some(false)
    );
    assert_eq!(
        write_barrier::settled_status(write_barrier::Domain::WebSearch, base, id2),
        Some(true)
    );
    let seen_a = write_barrier::observe(
        write_barrier::Domain::WebSearch,
        base,
        "ws-a",
        obs_a,
        true,
        &wake,
    );
    assert!(seen_a.unseen_error);

    platform::block_on(async {
        let dir = Arc::new(Mutex::new(("/repo/a".to_owned(), false)));
        let dir_srv = dir.clone();
        let server = MockServer::start(move |method, path, _| {
            let (current_dir, fail_reads) = dir_srv.lock().unwrap().clone();
            match (method, path) {
                ("GET", "/workspaces/ws1/instance/api/provider")
                | ("GET", "/workspaces/ws1/instance/api/model") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": current_dir}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/integration")
                | ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": current_dir}, "data": []}).to_string(),
                ),
                ("GET", p) if p.starts_with("/api/workspaces/ws1/image-settings") => {
                    if fail_reads {
                        return (
                            503,
                            "application/json",
                            json!({"error": "Unavailable"}).to_string(),
                        );
                    }
                    (
                        200,
                        "application/json",
                        json!({
                            "location": {"directory": current_dir},
                            "generation": {"global": true, "effective": true, "models": []},
                            "mediaStorage": {"global": false, "effective": false}
                        })
                        .to_string(),
                    )
                }
                ("PUT", "/api/workspaces/ws1/image-settings") => {
                    (200, "application/json", json!({"ok": true}).to_string())
                }
                _ => (
                    404,
                    "application/json",
                    json!({"message": "Not Found"}).to_string(),
                ),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt, 2);
        pump(&mut rt, "images-load-a", |h| {
            let img = h.catalog.images.borrow();
            img.has_snapshot() && img.is_idle()
        })
        .await;

        // Move session while post-move read fails: write authority must stay revoked.
        *dir.lock().unwrap() = ("/repo/b".into(), true);
        rt.update(|s, _| {
            if let Some(target) = &mut s.target {
                target.invalidate_location();
            }
        });
        pump(&mut rt, "post-move-failed", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        click(&mut rt, "images-storage-switch");
        rt.frame(0.02);
        assert_eq!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
                .count(),
            0
        );

        // Once Refresh confirms /repo/b, writes are admitted and target /repo/b.
        dir.lock().unwrap().1 = false;
        click(&mut rt, "images-refresh");
        pump(&mut rt, "post-move-confirmed", |h| {
            h.catalog.images.borrow().is_idle()
        })
        .await;
        click(&mut rt, "images-storage-switch");
        pump(&mut rt, "write-on-b", |h| {
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
                && h.catalog.images.borrow().is_idle()
        })
        .await;
        let put_body = server
            .log
            .lock()
            .unwrap()
            .iter()
            .find(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/image-settings")
            .unwrap()
            .2
            .clone();
        assert!(put_body.contains("/repo/b"));
    });
}

#[test]
fn native_stream_drop_and_reconnect_revoke_write_authority_until_fresh_location_read() {
    platform::block_on(async {
        let state = Arc::new(Mutex::new(("/repo/a".to_owned(), false)));
        let srv = state.clone();
        let server = MockServer::start(move |method, path, _| {
            let (current_dir, fail_reads) = srv.lock().unwrap().clone();
            match (method, path) {
                ("GET", "/workspaces/ws1/instance/api/provider")
                | ("GET", "/workspaces/ws1/instance/api/model") => (
                    200,
                    "application/json",
                    json!({"location": {"directory": current_dir}, "data": []}).to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/integration") => (
                    200,
                    "application/json",
                    json!({
                        "location": {"directory": current_dir},
                        "data": [{
                            "id": "tavily",
                            "name": "Tavily",
                            "methods": [{"type": "key", "label": "API key"}],
                            "connections": []
                        }]
                    })
                    .to_string(),
                ),
                ("GET", "/workspaces/ws1/instance/api/websearch/provider") => (
                    200,
                    "application/json",
                    json!({
                        "location": {"directory": current_dir},
                        "data": [{"id": "tavily", "name": "Tavily"}]
                    })
                    .to_string(),
                ),
                ("GET", p) if p.starts_with("/api/workspaces/ws1/websearch-settings") => {
                    if fail_reads {
                        return (
                            503,
                            "application/json",
                            json!({"error": "Unavailable"}).to_string(),
                        );
                    }
                    (
                        200,
                        "application/json",
                        json!({
                            "location": {"directory": current_dir},
                            "effective": null,
                            "scopes": [
                                {"scope": "global", "path": "/home/opencode.jsonc", "selection": null},
                                {"scope": "project", "path": format!("{current_dir}/opencode.jsonc"), "selection": null}
                            ]
                        })
                        .to_string(),
                    )
                }
                ("PUT", "/api/workspaces/ws1/websearch-settings") => {
                    (204, "application/json", String::new())
                }
                _ => (
                    404,
                    "application/json",
                    json!({"message": "Not Found"}).to_string(),
                ),
            }
        })
        .await;

        let mut rt = new_runtime(&server.base);
        pump(&mut rt, "models-load", |h| h.catalog.models_settled()).await;
        click_disclosure(&mut rt, 1);
        pump(&mut rt, "websearch-load-a", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.has_snapshot() && ws.is_idle()
        })
        .await;

        // 1. Native OpenCode stream drops while /api/events remains open: snapshot clears and
        //    writes stay unavailable even if the session moves from /repo/a to /repo/b.
        *state.lock().unwrap() = ("/repo/b".into(), true);
        rt.update(|s, _| {
            let target = s.target.as_mut().unwrap();
            assert!(target.observe_native_status(Some((false, Some(1)))));
            assert!(!target.online());
        });
        pump(&mut rt, "native-disconnected", |h| {
            let ws = h.catalog.websearch.borrow();
            !ws.has_snapshot() && ws.is_idle()
        })
        .await;
        assert!(rt.find("websearch-scope-project").is_none());

        // 2. Native stream reconnects while the fresh location read fails: no write with /repo/a.
        rt.update(|s, _| {
            let target = s.target.as_mut().unwrap();
            assert!(target.observe_native_status(Some((true, Some(2)))));
            target.invalidate_location();
            assert!(target.online());
        });
        pump(&mut rt, "reconnect-read-failed", |h| {
            let ws = h.catalog.websearch.borrow();
            !ws.has_snapshot() && ws.is_idle()
        })
        .await;
        assert_eq!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
                .count(),
            0
        );

        // 3. Once the fresh read confirms /repo/b, saving the project default targets /repo/b.
        state.lock().unwrap().1 = false;
        click(&mut rt, "websearch-refresh");
        pump(&mut rt, "reconnect-read-confirmed-b", |h| {
            let ws = h.catalog.websearch.borrow();
            ws.has_snapshot() && ws.is_idle()
        })
        .await;
        click(&mut rt, "websearch-scope-project");
        click(&mut rt, "websearch-scope-project-off");
        pump(&mut rt, "write-on-b", |h| {
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
                && h.catalog.websearch.borrow().is_idle()
        })
        .await;
        let first_put = server
            .log
            .lock()
            .unwrap()
            .iter()
            .find(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
            .unwrap()
            .2
            .clone();
        assert!(
            first_put.contains("/repo/b"),
            "unexpected body: {first_put}"
        );
        assert!(!first_put.contains("/repo/a"));

        // 4. Coalesced disconnect+reconnect between polls (location_epoch invalidated without
        //    observing native_online == false): open connect form & typed key are wiped and
        //    writes stay locked until fresh read confirms /repo/c.
        click(&mut rt, "websearch-connect-open");
        click(&mut rt, "websearch-api-key");
        rt.paste("stale-secret-key");
        rt.frame(0.02);
        assert_eq!(rt.state.catalog.websearch_key.text, "stale-secret-key");
        *state.lock().unwrap() = ("/repo/c".into(), true);
        rt.update(|s, _| {
            s.target.as_mut().unwrap().invalidate_location();
        });
        pump(&mut rt, "coalesced-reconnect-failed", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        assert!(rt.find("websearch-api-key").is_none());
        assert!(rt.state.catalog.websearch_key.text.is_empty());
        click(&mut rt, "websearch-scope-project");
        rt.frame(0.02);
        assert!(rt.find("websearch-scope-project-default").is_none());
        assert_eq!(
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
                .count(),
            1
        );

        state.lock().unwrap().1 = false;
        click(&mut rt, "websearch-refresh");
        pump(&mut rt, "coalesced-reconnect-confirmed-c", |h| {
            h.catalog.websearch.borrow().is_idle()
        })
        .await;
        click(&mut rt, "websearch-scope-project");
        click(&mut rt, "websearch-scope-project-off");
        pump(&mut rt, "write-on-c", |h| {
            server
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
                .count()
                == 2
                && h.catalog.websearch.borrow().is_idle()
        })
        .await;
        let second_put = server
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| m == "PUT" && p == "/api/workspaces/ws1/websearch-settings")
            .nth(1)
            .unwrap()
            .2
            .clone();
        assert!(
            second_put.contains("/repo/c"),
            "unexpected body: {second_put}"
        );
    });
}

#[test]
fn direct_native_outage_persists_before_capture_and_keeps_integrations_authority_isolated() {
    use codenomad_client::transport::{Event, WorkspaceEvent};

    let root = crate::init();
    assert!(root.screen.launcher().is_none());
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "ws-direct".into();
    backend.session = "ses-direct".into();
    root.settings.shared.borrow_mut().backend = Some(backend);

    // Native drop arrives while Preferences is closed (no Target yet) with the exact
    // transport.rs sequence: NativeStreamStatus(false) followed by ConnectionLost.
    crate::settings::connection_event(
        &root,
        &Event::Workspace(WorkspaceEvent::NativeStreamStatus {
            workspace_id: "ws-direct".into(),
            connected: false,
        }),
        true,
    );
    crate::settings::connection_event(&root, &Event::ConnectionLost, true);

    // Capturing Target during the outage must start offline so writes cannot proceed.
    let target = Target::capture(&root).unwrap();
    assert!(!target.online());
    let initial_integrations_auth = target.integrations_source().3;
    let initial_provider_auth = target.provider_authority();
    root.settings.shared.borrow_mut().provider_target = Some(target);

    // Native reconnect without ReadingLane (emits NativeStreamStatus(true), no AgentHint(true))
    // must restore Providers online without bumping Integrations' authority.
    crate::settings::connection_event(
        &root,
        &Event::Workspace(WorkspaceEvent::NativeStreamStatus {
            workspace_id: "ws-direct".into(),
            connected: true,
        }),
        true,
    );

    {
        let shared = root.settings.shared.borrow();
        let target = shared.provider_target.as_ref().unwrap();
        assert!(target.online());
        assert_eq!(target.integrations_source().3, initial_integrations_auth);
        assert_ne!(target.provider_authority(), initial_provider_auth);
    }

    // Native drop while Target is already open (NativeStreamStatus(false) + ConnectionLost)
    // must also recover online on NativeStreamStatus(true) without AgentHint(true).
    let auth_before_open_outage = root
        .settings
        .shared
        .borrow()
        .provider_target
        .as_ref()
        .unwrap()
        .provider_authority();
    crate::settings::connection_event(
        &root,
        &Event::Workspace(WorkspaceEvent::NativeStreamStatus {
            workspace_id: "ws-direct".into(),
            connected: false,
        }),
        true,
    );
    crate::settings::connection_event(&root, &Event::ConnectionLost, true);
    assert!(
        !root
            .settings
            .shared
            .borrow()
            .provider_target
            .as_ref()
            .unwrap()
            .online()
    );

    crate::settings::connection_event(
        &root,
        &Event::Workspace(WorkspaceEvent::NativeStreamStatus {
            workspace_id: "ws-direct".into(),
            connected: true,
        }),
        true,
    );
    {
        let shared = root.settings.shared.borrow();
        let target = shared.provider_target.as_ref().unwrap();
        assert!(target.online());
        assert_eq!(target.integrations_source().3, initial_integrations_auth);
        assert_ne!(target.provider_authority(), auth_before_open_outage);
    }

    // Real host SSE ConnectionLost (without a paired NativeStreamStatus(false)) while
    // Preferences is closed must make a newly captured Target start offline until AgentHint(true).
    root.settings.shared.borrow_mut().provider_target = None;
    crate::settings::connection_event(&root, &Event::ConnectionLost, true);
    let host_offline = Target::capture(&root).unwrap();
    assert!(!host_offline.online());
    root.settings.shared.borrow_mut().provider_target = Some(host_offline);
    crate::settings::connection_event(&root, &Event::AgentHint(true), true);
    assert!(
        root.settings
            .shared
            .borrow()
            .provider_target
            .as_ref()
            .unwrap()
            .online()
    );
}
