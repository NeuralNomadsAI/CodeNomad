use super::*;
use crate::{files::test_http::Http, platform, strings::t};
use rune::{Env, Key, KeyEvent, Mods, Runtime, col};
use rune_theme_codenomad::layout::{self, Layout};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct Harness {
    target: Target,
    catalog: Catalog,
    wake: rune::Waker,
}

impl Harness {
    fn new(backend: Backend) -> Self {
        let mut s = crate::init();
        let mut b = backend;
        b.workspace = "ws1".into();
        b.session = "ses1".into();
        let target = Target {
            backend: b,
            workspace: "ws1".into(),
            session: Some("ses1".into()),
            owned_tab: false,
            revision: 0,
            observed: None,
            authority: 0,
            online: true,
            stats: [0; 2],
            stats_status: None,
        };
        let wake = std::mem::replace(&mut s.wake, Arc::new(|| {}));
        Self {
            target,
            catalog: Catalog::default(),
            wake,
        }
    }
}

fn harness_view(h: &Harness, cx: &mut rune::Cx<Harness>) -> El {
    layout::with_source_palette(|| {
        layout::render(cx, |_| {
            let mut layers = Vec::new();
            let body = content(
                &h.catalog,
                h.target.online(),
                &mut layers,
                |h: &mut Harness| &mut h.catalog,
            );
            col()
                .full_width()
                .full_height()
                .child(body)
                .children(layers)
        })
    })
}

fn make_rt(backend: Backend) -> Runtime<Harness> {
    let mut rt = Runtime::new(
        Harness::new(backend),
        harness_view,
        (760.0, 960.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt
}

fn tick(rt: &mut Runtime<Harness>, now: f64) -> bool {
    let mut changed = false;
    rt.update(|h, tx| {
        changed = h.catalog.poll(Some(&h.target), now, Some(&h.wake), tx);
    });
    rt.frame(now);
    changed
}

fn click(rt: &mut Runtime<Harness>, key: &str, now: f64) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing element {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(now);
}

fn is_focused(rt: &Runtime<Harness>, key: &str) -> bool {
    rt.elements()
        .iter()
        .any(|e| e.focused && e.key.as_deref() == Some(key))
}

fn has_focused_descendant(node: &Value) -> bool {
    if node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|s| s == "focused"))
    {
        return true;
    }
    node["children"]
        .as_array()
        .is_some_and(|children| children.iter().any(has_focused_descendant))
}

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"].as_str() == Some(key) {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
}

fn poll_until(rt: &mut Runtime<Harness>, now: f64, cond: impl Fn(&Harness) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let _ = tick(rt, now);
        if cond(&rt.state) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for manager");
        std::thread::sleep(Duration::from_millis(5));
    }
}

async fn reply_catalog(
    http: &Http,
    integrations: Value,
    providers: Value,
    models: Value,
    account_selection: Option<(&str, Value)>,
) {
    let dir = "/repo/a";
    let session = http.accept().await;
    assert!(
        session
            .header
            .starts_with("GET /workspaces/ws1/instance/api/session/ses1 "),
        "{}",
        session.header
    );
    session
        .reply(
            200,
            json!({ "data": { "id": "ses1", "location": { "directory": dir } } }),
        )
        .await;

    for _ in 0..4 {
        let req = http.accept().await;
        let path = req.header.split_whitespace().nth(1).unwrap();
        let data = if path.contains("/websearch/provider?") {
            json!([])
        } else if path.contains("/integration?") {
            integrations.clone()
        } else if path.contains("/provider?") {
            providers.clone()
        } else {
            assert!(path.contains("/model?"), "{path}");
            models.clone()
        };
        req.reply(
            200,
            json!({ "location": { "directory": dir }, "data": data }),
        )
        .await;
    }

    if let Some((expected_integration, selection)) = account_selection {
        let meta = http.accept().await;
        assert!(meta.header.starts_with("GET /api/meta "), "{}", meta.header);
        meta.reply(200, json!({ "capabilities": ["integrations"] }))
            .await;
        let acc = http.accept().await;
        assert!(
            acc.header.starts_with(&format!(
                "GET /api/workspaces/ws1/provider-accounts/{expected_integration}?"
            )),
            "{}",
            acc.header
        );
        acc.reply(200, selection).await;
    }
}

#[test]
fn api_key_connect_modal_traps_focus_restores_on_escape_and_wipes_secret() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "anthropic",
                "name": "Anthropic",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": []
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": [{ "type": "credential", "id": "cred_1", "label": "Primary", "method": "key" }]
            }
        ]);
        let providers = json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]);
        let models = json!([{ "id": "gpt-5", "providerID": "openai" }]);

        let mut rt = make_rt(http.backend.clone());
        assert!(tick(&mut rt, 1.0));
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            models.clone(),
            None,
        )
        .await;
        poll_until(&mut rt, 1.0, |h| h.catalog.manager.snapshot.is_some());

        // Focus Connect button and open modal via click.
        rt.update(|_, tx| tx.focus("providers-connect-button", true));
        rt.frame(1.0);
        click(&mut rt, "providers-connect-button", 1.0);
        rt.frame(1.0);
        let tree = rt.accessibility_json();
        let dialog = node(&tree, "provider-auth-dialog").expect("connect modal");
        assert_eq!(dialog["role"], "dialog");
        assert!(is_focused(&rt, "provider-auth-close"));

        // Tab stays trapped inside the modal (never reaches providers-search outside).
        for _ in 0..4 {
            rt.key(KeyEvent {
                key: Key::Tab,
                mods: Mods::default(),
            });
            rt.frame(1.0);
            let cur_tree = rt.accessibility_json();
            let cur_dialog = node(&cur_tree, "provider-auth-dialog").expect("modal still open");
            assert!(has_focused_descendant(cur_dialog));
            assert!(!is_focused(&rt, "providers-search"));
        }

        // Escape closes modal and restores focus to Connect button.
        rt.key(KeyEvent {
            key: Key::Escape,
            mods: Mods::default(),
        });
        rt.frame(1.0);
        rt.frame(1.0);
        assert!(node(&rt.accessibility_json(), "provider-auth-dialog").is_none());
        assert!(is_focused(&rt, "providers-connect-button"));

        // Reopen, fill API key, submit -> POST connect/key, closes modal, wipes secret, refreshes.
        click(&mut rt, "providers-connect-button", 1.0);
        rt.update(|h, _| {
            h.catalog.manager.connect.as_mut().unwrap().api_key =
                rune::TextEdit::new("sk-ant-secret-123");
        });
        rt.frame(1.0);
        click(&mut rt, "provider-auth-continue", 1.0);
        assert!(tick(&mut rt, 1.0));

        let post = http.accept().await;
        assert!(
            post.header.starts_with(
                "POST /workspaces/ws1/instance/api/integration/anthropic/connect/key?location%5Bdirectory%5D=%2Frepo%2Fa "
            ),
            "{}",
            post.header
        );
        assert_eq!(post.body["key"], "sk-ant-secret-123");
        post.reply(200, json!({})).await;

        poll_until(&mut rt, 1.0, |h| h.catalog.manager.connect.is_none());
        let next_integrations = json!([
            {
                "id": "anthropic",
                "name": "Anthropic",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": [{ "type": "credential", "id": "cred_a", "label": "default", "method": "key" }]
            }
        ]);
        reply_catalog(
            &http,
            next_integrations,
            json!([{ "id": "anthropic", "integrationID": "anthropic", "name": "Anthropic" }]),
            json!([]),
            Some((
                "anthropic",
                json!({ "supported": false, "enabled": false, "logins": {} }),
            )),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| {
            h.catalog.manager.snapshot.as_ref().is_some_and(|s| {
                s.providers
                    .iter()
                    .any(|p| p.id == "anthropic" && p.is_configured())
            })
        });
    });
}

#[test]
fn oauth_auto_polling_opens_url_completes_and_cancel_sends_delete() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [
                    { "id": "codex", "type": "oauth", "label": "ChatGPT" }
                ],
                "connections": []
            }
        ]);

        let mut rt = make_rt(http.backend.clone());
        assert!(tick(&mut rt, 10.0));
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 10.0, |h| h.catalog.manager.snapshot.is_some());

        // Start OAuth auto flow.
        click(&mut rt, "providers-connect-button", 10.0);
        click(&mut rt, "provider-auth-continue", 10.0);
        assert!(tick(&mut rt, 10.0));
        let post = http.accept().await;
        assert!(
            post.header
                .starts_with("POST /workspaces/ws1/instance/api/integration/openai/connect/oauth?"),
            "{}",
            post.header
        );
        assert_eq!(post.body["methodID"], "codex");
        post.reply(
            200,
            json!({
                "data": {
                    "attemptID": "att_1",
                    "url": "https://auth.example.test/start",
                    "instructions": "Finish in browser",
                    "mode": "auto"
                }
            }),
        )
        .await;

        // First poll opens external URL via Tx and immediately issues first status GET.
        poll_until(&mut rt, 10.0, |h| {
            h.catalog
                .manager
                .connect
                .as_ref()
                .is_some_and(|f| f.stage == manager::AuthStage::Waiting)
        });
        assert_eq!(rt.take_url_requests(), ["https://auth.example.test/start"]);

        let st1 = http.accept().await;
        assert!(
            st1.header.starts_with(
                "GET /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_1?"
            ),
            "{}",
            st1.header
        );
        st1.reply(200, json!({ "data": { "status": "pending" } }))
            .await;
        poll_until(&mut rt, 10.0, |h| !h.catalog.manager.poll_flight_active());

        // Cancel sends DELETE and returns to Prompts.
        click(&mut rt, "provider-auth-cancel-wait", 10.5);
        let del = http.accept().await;
        assert!(
            del.header.starts_with(
                "DELETE /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_1?"
            ),
            "{}",
            del.header
        );
        del.reply(200, json!({})).await;
        assert_eq!(
            rt.state.catalog.manager.connect.as_ref().unwrap().stage,
            manager::AuthStage::Prompts
        );

        // Now test OAuth code flow.
        click(&mut rt, "provider-auth-continue", 11.0);
        assert!(tick(&mut rt, 11.0));
        let post2 = http.accept().await;
        post2
            .reply(
                200,
                json!({
                    "data": {
                        "attemptID": "att_2",
                        "url": "https://auth.example.test/code",
                        "instructions": "Paste code",
                        "mode": "code"
                    }
                }),
            )
            .await;
        poll_until(&mut rt, 11.0, |h| {
            h.catalog
                .manager
                .connect
                .as_ref()
                .is_some_and(|f| f.stage == manager::AuthStage::Code)
        });
        assert_eq!(rt.take_url_requests(), ["https://auth.example.test/code"]);

        rt.update(|h, _| {
            h.catalog.manager.connect.as_mut().unwrap().oauth_code =
                rune::TextEdit::new("CODE-999");
        });
        rt.frame(11.0);
        click(&mut rt, "provider-auth-submit-code", 11.0);
        assert!(tick(&mut rt, 11.0));
        let complete = http.accept().await;
        assert!(
            complete.header.starts_with(
                "POST /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_2/complete?"
            ),
            "{}",
            complete.header
        );
        assert_eq!(complete.body["code"], "CODE-999");
        complete.reply(200, json!({})).await;
        poll_until(&mut rt, 11.0, |h| h.catalog.manager.connect.is_none());
    });
}

#[test]
fn accounts_rename_survives_refresh_and_failure_and_501_degrades_gracefully() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": [
                    { "type": "credential", "id": "cred_1", "label": "default", "method": "oauth" },
                    { "type": "credential", "id": "cred_2", "label": "Work", "method": "key" }
                ]
            }
        ]);
        let providers = json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]);
        let selection = json!({
            "supported": true,
            "enabled": false,
            "logins": { "cred_1": "alice@example.test" }
        });

        let mut rt = make_rt(http.backend.clone());
        assert!(tick(&mut rt, 1.0));
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            json!([]),
            Some(("openai", selection.clone())),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| h.catalog.manager.snapshot.is_some());

        // Sanitized login email is displayed for default credential.
        let tree_text = rt.accessibility_json().to_string();
        assert!(tree_text.contains("alice@example.test"), "{tree_text}");

        // Open Rename, type draft, trigger refresh -> draft MUST survive refresh!
        click(&mut rt, "provider-account-rename-openai", 1.0);
        rt.update(|h, _| {
            *h.catalog.manager.rename_text_mut("openai", "cred_1") =
                rune::TextEdit::new("Personal");
        });
        rt.frame(1.0);
        click(&mut rt, "providers-refresh", 1.0);
        assert!(tick(&mut rt, 1.0));
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            json!([]),
            Some(("openai", selection.clone())),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| !h.catalog.manager.catalog_flight_active());
        assert_eq!(
            rt.state
                .catalog
                .manager
                .rename_draft("openai", "cred_1")
                .unwrap()
                .text
                .text,
            "Personal"
        );

        // Submit Rename against a 501 Not Implemented (server-rs fallback) -> degrades cleanly & keeps draft!
        click(&mut rt, "provider-account-rename-save-openai", 1.0);
        assert!(tick(&mut rt, 1.0));
        let patch = http.accept().await;
        assert!(
            patch
                .header
                .starts_with("PATCH /workspaces/ws1/instance/api/credential/cred_1?"),
            "{}",
            patch.header
        );
        assert_eq!(patch.body["label"], "Personal");
        patch
            .reply(501, json!({ "error": "Not implemented" }))
            .await;

        poll_until(&mut rt, 1.0, |h| {
            h.catalog.manager.account_errors.contains_key("openai")
        });
        assert_eq!(
            rt.state.catalog.manager.account_errors["openai"].as_str(),
            t("integrations.connection.unsupported")
        );
        assert_eq!(
            rt.state
                .catalog
                .manager
                .rename_draft("openai", "cred_1")
                .unwrap()
                .text
                .text,
            "Personal"
        );
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            json!([]),
            Some(("openai", selection.clone())),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| !h.catalog.manager.catalog_flight_active());

        // Toggle Auto-select -> PUT /api/workspaces/ws1/provider-accounts/openai.
        click(&mut rt, "provider-account-auto-openai", 2.0);
        assert!(tick(&mut rt, 2.0));
        let put = http.accept().await;
        assert!(
            put.header
                .starts_with("PUT /api/workspaces/ws1/provider-accounts/openai "),
            "{}",
            put.header
        );
        assert_eq!(put.body["directory"], "/repo/a");
        assert_eq!(put.body["enabled"], true);
        put.reply(
            200,
            json!({ "supported": true, "enabled": true, "logins": { "cred_1": "alice@example.test" } }),
        )
        .await;
        poll_until(&mut rt, 2.0, |h| {
            h.catalog.manager.snapshot.as_ref().unwrap().providers[0]
                .account_selection
                .enabled
        });
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            json!([]),
            Some((
                "openai",
                json!({ "supported": true, "enabled": true, "logins": { "cred_1": "alice@example.test" } }),
            )),
        )
        .await;
        poll_until(&mut rt, 2.0, |h| {
            !h.catalog.manager.catalog_flight_active() && !h.catalog.manager.account_busy("openai")
        });

        // Remove active credential -> DELETE /workspaces/ws1/instance/api/credential/cred_1.
        click(&mut rt, "provider-account-remove-openai", 3.0);
        assert!(tick(&mut rt, 3.0));
        let del = http.accept().await;
        assert!(
            del.header
                .starts_with("DELETE /workspaces/ws1/instance/api/credential/cred_1?"),
            "{}",
            del.header
        );
        del.reply(200, json!({})).await;
    });
}
