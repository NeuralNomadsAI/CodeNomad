use super::super::*;
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
            location_epoch: 0,
            observed: None,
            authority: 0,
            native_authority: 0,
            online: true,
            native_online: true,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
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
    tick_with_visibility(rt, now, true)
}

fn tick_with_visibility(rt: &mut Runtime<Harness>, now: f64, visible: bool) -> bool {
    let mut changed = false;
    rt.update(|h, tx| {
        changed = h.catalog.poll(
            Some(&h.target),
            now,
            Some(&h.wake),
            tx,
            visible,
            |h: &mut Harness| &mut h.catalog,
        );
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
        post.reply(204, json!({})).await;

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
                "location": { "directory": "/repo/a" },
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
        st1.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "status": "pending" } }),
        )
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
        del.reply(204, json!({})).await;
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
                    "location": { "directory": "/repo/a" },
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
                .starts_with("PATCH /workspaces/ws1/instance/api/credential/cred_1 "),
            "{}",
            patch.header
        );
        assert!(
            patch
                .header
                .to_ascii_lowercase()
                .contains("x-codenomad-location:"),
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
            !h.catalog.manager.catalog_flight_active() && !h.catalog.manager.any_account_busy()
        });

        // Remove active credential -> DELETE /workspaces/ws1/instance/api/credential/cred_1.
        click(&mut rt, "provider-account-remove-openai", 3.0);
        assert!(tick(&mut rt, 3.0));
        let del = http.accept().await;
        assert!(
            del.header
                .starts_with("DELETE /workspaces/ws1/instance/api/credential/cred_1 "),
            "{}",
            del.header
        );
        assert!(
            del.header
                .to_ascii_lowercase()
                .contains("x-codenomad-location:"),
            "{}",
            del.header
        );
        del.reply(200, json!({})).await;
    });
}

#[test]
fn closing_modal_mid_oauth_post_aborts_socket_and_logical_clock_advances_polling() {
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
        assert!(tick(&mut rt, 1.0));
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 1.0, |h| h.catalog.manager.snapshot.is_some());

        // Start OAuth POST, then close the modal BEFORE the POST returns -> HTTP socket aborts immediately.
        click(&mut rt, "providers-connect-button", 1.0);
        click(&mut rt, "provider-auth-continue", 1.0);
        assert!(tick(&mut rt, 1.0));
        let post = http.accept().await;
        assert!(
            post.header
                .starts_with("POST /workspaces/ws1/instance/api/integration/openai/connect/oauth?"),
            "{}",
            post.header
        );
        click(&mut rt, "provider-auth-close", 1.0);
        assert!(rt.state.catalog.manager.connect.is_none());
        post.disconnected().await;

        // Second flow: verify logical-clock polling advances from pending -> second poll at now+1.0 -> completed.
        click(&mut rt, "providers-connect-button", 10.0);
        click(&mut rt, "provider-auth-continue", 10.0);
        assert!(tick(&mut rt, 10.0));
        let post2 = http.accept().await;
        post2
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/a" },
                    "data": {
                        "attemptID": "att_poll",
                        "url": "https://auth.example.test/poll",
                        "instructions": "Wait",
                        "mode": "auto"
                    }
                }),
            )
            .await;
        poll_until(&mut rt, 10.0, |h| {
            h.catalog
                .manager
                .connect
                .as_ref()
                .is_some_and(|f| f.stage == manager::AuthStage::Waiting)
        });
        let st1 = http.accept().await;
        st1.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "status": "pending" } }),
        )
        .await;
        poll_until(&mut rt, 10.0, |h| !h.catalog.manager.poll_flight_active());

        // Before 11.0, no second poll is sent.
        assert!(!tick(&mut rt, 10.5));
        http.quiet().await;

        // At 11.0 (logical clock + 1.0s), second poll fires and settles as completed.
        assert!(tick(&mut rt, 11.0));
        let st2 = http.accept().await;
        assert!(
            st2.header.starts_with(
                "GET /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_poll?"
            ),
            "{}",
            st2.header
        );
        st2.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "status": "complete" } }),
        )
        .await;
        poll_until(&mut rt, 11.0, |h| h.catalog.manager.connect.is_none());
    });
}

#[test]
fn session_move_cancels_stale_location_and_duplicate_labels_and_live_form_visibility_work() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "custom",
                "name": "Custom",
                "methods": [{
                    "type": "key",
                    "label": "API key",
                    "form": [
                        { "key": "tier", "type": "string", "title": "Tier", "required": true },
                        {
                            "key": "endpoint",
                            "type": "string",
                            "title": "Enterprise Endpoint",
                            "required": true,
                            "when": [{ "key": "tier", "op": "eq", "value": "enterprise" }]
                        }
                    ]
                }],
                "connections": []
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": [
                    { "type": "credential", "id": "cred_1", "label": "Work", "method": "key" },
                    { "type": "credential", "id": "cred_2", "label": "Work", "method": "key" },
                    { "type": "credential", "id": "cred_3", "label": "Work (2)", "method": "key" }
                ]
            }
        ]);
        let providers = json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]);
        let selection = json!({ "supported": false, "enabled": false, "logins": {} });

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

        // Dynamic form: typing "enterprise" into `tier` immediately reveals `endpoint` in modal view.
        click(&mut rt, "providers-connect-button", 1.0);
        assert!(node(&rt.accessibility_json(), "provider-form-text-endpoint").is_none());
        rt.update(|h, _| {
            *h.catalog.manager.form_text_edit_mut("tier") = rune::TextEdit::new("enterprise");
        });
        rt.frame(1.0);
        assert!(node(&rt.accessibility_json(), "provider-form-text-endpoint").is_some());
        assert!(!rt.state.catalog.manager.can_submit_auth());

        // Session move bumps target authority, cancels the stale modal, and reloads the moved directory.
        rt.update(|h, _| {
            assert!(h.target.session_moved("ws1", "ses1"));
        });
        assert!(tick(&mut rt, 2.0));
        assert!(rt.state.catalog.manager.connect.is_none());
        let dir2 = "/repo/moved";
        let session = http.accept().await;
        session
            .reply(
                200,
                json!({ "data": { "id": "ses1", "location": { "directory": dir2 } } }),
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
                json!([])
            };
            req.reply(
                200,
                json!({ "location": { "directory": dir2 }, "data": data }),
            )
            .await;
        }
        let meta = http.accept().await;
        meta.reply(200, json!({ "capabilities": ["integrations"] }))
            .await;
        let acc = http.accept().await;
        acc.reply(200, selection).await;
        poll_until(&mut rt, 2.0, |h| {
            h.catalog
                .manager
                .snapshot
                .as_ref()
                .is_some_and(|s| s.directory == dir2)
        });

        // Duplicate display labels ("Work", "Work", "Work (2)"): choosing index 2 activates cred_3, not cred_2!
        click(&mut rt, "provider-account-select-openai-trigger", 2.0);
        let options: Vec<(f32, f32)> = rt
            .elements()
            .iter()
            .filter(|e| e.role == "option")
            .map(|e| (e.rect[0] + e.rect[2] * 0.5, e.rect[1] + e.rect[3] * 0.5))
            .collect();
        assert_eq!(options.len(), 3);
        let (x, y) = options[2];
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(2.0);
        assert!(tick(&mut rt, 2.0));
        let act = http.accept().await;
        assert!(
            act.header
                .starts_with("POST /workspaces/ws1/instance/api/credential/cred_3/activate "),
            "{}",
            act.header
        );
        assert!(
            act.header
                .to_ascii_lowercase()
                .contains("x-codenomad-location:"),
            "{}",
            act.header
        );
        act.reply(200, json!({})).await;
    });
}

#[test]
fn coalesced_location_invalidation_cancels_connect_modal_without_authority_change() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([{
            "id": "custom",
            "name": "Custom",
            "methods": [{ "type": "key", "label": "API key" }],
            "connections": []
        }]);
        let mut rt = make_rt(http.backend.clone());
        assert!(tick(&mut rt, 1.0));
        reply_catalog(&http, integrations, json!([]), json!([]), None).await;
        poll_until(&mut rt, 1.0, |h| h.catalog.manager.snapshot.is_some());

        click(&mut rt, "providers-connect-button", 1.0);
        assert!(rt.state.catalog.manager.connect.is_some());
        let auth_before = rt.state.target.provider_authority();
        rt.update(|h, _| {
            h.target.invalidate_location();
        });
        assert_eq!(rt.state.target.provider_authority(), auth_before);
        assert!(tick(&mut rt, 2.0));
        assert!(rt.state.catalog.manager.connect.is_none());
    });
}

#[test]
fn command_external_snapshotted_methods_and_absent_optional_fields() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "acme",
                "name": "Acme",
                "methods": [
                    { "id": "cli", "type": "command", "label": "CLI", "command": ["acme", "login"] },
                    {
                        "id": "ext",
                        "type": "external",
                        "label": "External",
                        "form": [
                            { "key": "optional_note", "type": "string", "title": "Note" },
                            { "key": "custom_tags", "type": "multiselect", "title": "Tags", "custom": true, "options": [] }
                        ]
                    }
                ],
                "connections": []
            }
        ]);

        let mut rt = make_rt(http.backend.clone());
        assert!(tick(&mut rt, 1.0));
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 1.0, |h| h.catalog.manager.snapshot.is_some());

        // Start command connect flow -> pending status message -> complete.
        click(&mut rt, "providers-connect-button", 1.0);
        click(&mut rt, "provider-auth-continue", 1.0);
        assert!(tick(&mut rt, 1.0));
        let post = http.accept().await;
        assert!(
            post.header
                .starts_with("POST /workspaces/ws1/instance/api/integration/acme/connect/command?"),
            "{}",
            post.header
        );
        assert_eq!(post.body["methodID"], "cli");
        post.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "attemptID": "cmd_1" } }),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| {
            h.catalog
                .manager
                .connect
                .as_ref()
                .is_some_and(|f| f.stage == manager::AuthStage::Waiting)
        });
        let st1 = http.accept().await;
        st1.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "status": "pending", "message": "Waiting for CLI" } }),
        )
        .await;
        poll_until(&mut rt, 1.0, |h| !h.catalog.manager.poll_flight_active());
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Waiting for CLI")
        );

        assert!(tick(&mut rt, 2.0));
        let st2 = http.accept().await;
        st2.reply(
            200,
            json!({ "location": { "directory": "/repo/a" }, "data": { "status": "complete" } }),
        )
        .await;
        poll_until(&mut rt, 2.0, |h| h.catalog.manager.connect.is_none());
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 2.0, |h| !h.catalog.manager.catalog_flight_active());

        // Open modal, select External (index 1), then mutate snapshot to reorder methods:
        // ConnectFlow keeps snapshotted methods and omits untouched optional fields from answer.
        click(&mut rt, "providers-connect-button", 3.0);
        rt.update(|h, _| h.catalog.manager.select_method(1));
        rt.update(|h, _| {
            if let Some(snap) = &mut h.catalog.manager.snapshot
                && let Some(prov) = snap.providers.first_mut()
            {
                prov.methods.reverse();
            }
        });
        rt.frame(3.0);
        click(&mut rt, "provider-auth-continue", 3.0);
        assert!(tick(&mut rt, 3.0));
        let ext = http.accept().await;
        assert!(
            ext.header.starts_with(
                "POST /workspaces/ws1/instance/api/integration/acme/connect/external?"
            ),
            "{}",
            ext.header
        );
        assert_eq!(ext.body["methodID"], "ext");
        assert_eq!(ext.body["answer"], json!({}));
        ext.reply(204, json!({})).await;
        poll_until(&mut rt, 3.0, |h| h.catalog.manager.connect.is_none());
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 3.0, |h| !h.catalog.manager.catalog_flight_active());

        // Typing into optional text and custom multiselect fields then clearing them sends explicit
        // empty values ("" and []), distinguishing cleared edits from untouched optional fields.
        click(&mut rt, "providers-connect-button", 3.5);
        rt.update(|h, _| {
            h.catalog.manager.select_method(1);
            *h.catalog.manager.form_text_edit_mut("optional_note") = rune::TextEdit::new("hello");
            *h.catalog.manager.form_text_edit_mut("optional_note") = rune::TextEdit::new("");
            *h.catalog.manager.form_text_edit_mut("custom_tags") = rune::TextEdit::new("tag1");
            *h.catalog.manager.form_text_edit_mut("custom_tags") = rune::TextEdit::new("");
        });
        rt.frame(3.5);
        click(&mut rt, "provider-auth-continue", 3.5);
        assert!(tick(&mut rt, 3.5));
        let ext_cleared = http.accept().await;
        assert_eq!(ext_cleared.body["methodID"], "ext");
        assert_eq!(
            ext_cleared.body["answer"],
            json!({ "optional_note": "", "custom_tags": [] })
        );
        ext_cleared.reply(204, json!({})).await;
        poll_until(&mut rt, 3.5, |h| h.catalog.manager.connect.is_none());
        reply_catalog(&http, integrations.clone(), json!([]), json!([]), None).await;
        poll_until(&mut rt, 3.5, |h| !h.catalog.manager.catalog_flight_active());

        // Closing the modal while a command POST is in flight aborts the HTTP socket immediately.
        click(&mut rt, "providers-connect-button", 4.0);
        click(&mut rt, "provider-auth-continue", 4.0);
        assert!(tick(&mut rt, 4.0));
        let cmd_post = http.accept().await;
        assert!(
            cmd_post
                .header
                .starts_with("POST /workspaces/ws1/instance/api/integration/acme/connect/command?"),
            "{}",
            cmd_post.header
        );
        click(&mut rt, "provider-auth-close", 4.0);
        assert!(rt.state.catalog.manager.connect.is_none());
        cmd_post.disconnected().await;

        // Already-requested account mutation dispatches even if the tab becomes hidden before poll,
        // and authority revocation while hidden aborts the underlying HTTP socket immediately.
        let http2 = Http::new().await;
        let mut rt2 = make_rt(http2.backend.clone());
        assert!(tick(&mut rt2, 1.0));
        let acc_integrations = json!([
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [{ "type": "key", "label": "API key" }],
                "connections": [
                    { "type": "credential", "id": "cred_1", "label": "Work", "method": "key" }
                ]
            }
        ]);
        let acc_providers =
            json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]);
        reply_catalog(
            &http2,
            acc_integrations.clone(),
            acc_providers.clone(),
            json!([]),
            None,
        )
        .await;
        poll_until(&mut rt2, 1.0, |h| h.catalog.manager.snapshot.is_some());
        click(&mut rt2, "provider-account-remove-openai", 1.0);
        // Hint invalidates the catalog right before the tab becomes hidden: the queued account
        // mutation must trigger a hidden catalog refresh and then dispatch DELETE.
        rt2.update(|h, _| {
            assert!(h.target.hint("ws1"));
        });
        assert!(tick_with_visibility(&mut rt2, 1.0, false));
        reply_catalog(&http2, acc_integrations, acc_providers, json!([]), None).await;
        let deadline_acc = Instant::now() + Duration::from_secs(3);
        while rt2.state.catalog.manager.catalog_flight_active() {
            assert!(
                Instant::now() < deadline_acc,
                "hidden queued account remove catalog refresh did not settle"
            );
            let _ = tick_with_visibility(&mut rt2, 1.0, false);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(rt2.state.catalog.manager.any_account_busy());
        let del_req = http2.accept().await;
        assert!(
            del_req
                .header
                .starts_with("DELETE /workspaces/ws1/instance/api/credential/cred_1 "),
            "{}",
            del_req.header
        );
        let app_state = crate::init();
        rt2.update(|h, _| {
            let moves = codenomad_client::stream::ProviderMoves::Sessions(vec![(
                "ws1".into(),
                "ses1".into(),
            )]);
            let backend = h.target.backend().clone();
            assert!(h.target.validate(
                &app_state,
                Some(&backend),
                &codenomad_client::stream::CatalogueChanges::None,
                &moves,
                &codenomad_client::stream::CatalogueChanges::None,
                None,
            ));
        });
        assert!(tick_with_visibility(&mut rt2, 1.1, false));
        assert!(!rt2.state.catalog.manager.any_account_busy());
        assert!(!rt2.state.catalog.manager.catalog_flight_active());
        del_req.disconnected().await;
    });
}

#[test]
fn catalogue_move_revokes_authority_ready_before_cancel_deletes_and_stable_labels_hold() {
    platform::block_on(async {
        let http = Http::new().await;
        let integrations = json!([
            {
                "id": "openai",
                "name": "OpenAI",
                "methods": [{ "id": "codex", "type": "oauth", "label": "ChatGPT" }],
                "connections": [
                    { "type": "credential", "id": "cred_1", "label": "Work", "method": "key" },
                    { "type": "credential", "id": "cred_2", "label": "Work", "method": "key" },
                    { "type": "credential", "id": "cred_3", "label": "Work (2)", "method": "key" }
                ]
            }
        ]);
        let providers = json!([{ "id": "openai", "integrationID": "openai", "name": "OpenAI" }]);
        let selection = json!({ "supported": false, "enabled": false, "logins": {} });

        // Stable homonym labels keep identical numbering even when cred_2 moves to index 0 (active).
        let before = manager::unique_labels_stable(
            &["Work".into(), "Work".into(), "Work (2)".into()],
            &[
                "credential:cred_1".into(),
                "credential:cred_2".into(),
                "credential:cred_3".into(),
            ],
        );
        let after = manager::unique_labels_stable(
            &["Work".into(), "Work".into(), "Work (2)".into()],
            &[
                "credential:cred_2".into(),
                "credential:cred_1".into(),
                "credential:cred_3".into(),
            ],
        );
        assert_eq!(before, vec!["Work (1)", "Work (3)", "Work (2)"]);
        assert_eq!(after, vec!["Work (3)", "Work (1)", "Work (2)"]);

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

        // Rename click focuses input, and >256-char alias disables Save button.
        click(&mut rt, "provider-account-rename-openai", 1.0);
        rt.frame(1.0);
        assert!(
            rt.elements()
                .iter()
                .any(|e| { e.focused && e.path.contains("provider-account-rename-input-openai") })
        );
        let too_long = "a".repeat(257);
        rt.update(|h, _| {
            *h.catalog.manager.rename_text_mut("openai", "cred_1") = rune::TextEdit::new(too_long);
        });
        rt.frame(1.0);
        let a11y = rt.accessibility_json();
        let save = node(&a11y, "provider-account-rename-save-openai").unwrap();
        assert!(
            save["states"]
                .as_array()
                .is_some_and(|st| st.iter().any(|s| s == "disabled")),
            "{save}"
        );

        // Ready-before-cancel interleaving: deterministically wait until worker writes
        // Ready(OAuthStarted) into AuthHandover BEFORE UI clicks Close -> Close must spawn DELETE!
        click(&mut rt, "provider-account-add-openai", 2.0);
        click(&mut rt, "provider-auth-continue", 2.0);
        assert!(tick(&mut rt, 2.0));
        let post = http.accept().await;
        post.reply(
            200,
            json!({
                "location": { "directory": "/repo/a" },
                "data": {
                    "attemptID": "att_ready_first",
                    "url": "https://auth.example.test/ready",
                    "instructions": "Ready first",
                    "mode": "auto"
                }
            }),
        )
        .await;
        let deadline = Instant::now() + Duration::from_secs(3);
        while !rt.state.catalog.manager.auth_handover_ready() {
            assert!(
                Instant::now() < deadline,
                "worker never populated AuthHandover::Ready"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        click(&mut rt, "provider-auth-close", 2.0);
        let del = http.accept().await;
        assert!(
            del.header.starts_with(
                "DELETE /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_ready_first?"
            ),
            "{}",
            del.header
        );
        del.reply(204, json!({})).await;

        // Invalid OAuth mode on a server reply with a valid attemptID cancels the attempt
        // immediately, and closing the modal while that cleanup DELETE is in flight does not
        // abort the DELETE socket.
        click(&mut rt, "provider-account-add-openai", 2.5);
        click(&mut rt, "provider-auth-continue", 2.5);
        assert!(tick(&mut rt, 2.5));
        let post_bad = http.accept().await;
        post_bad
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/a" },
                    "data": {
                        "attemptID": "att_bad_mode",
                        "url": "https://auth.example.test/bad",
                        "instructions": "Bad mode",
                        "mode": "unknown"
                    }
                }),
            )
            .await;
        let del_bad = http.accept().await;
        assert!(
            del_bad.header.starts_with(
                "DELETE /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_bad_mode?"
            ),
            "{}",
            del_bad.header
        );
        click(&mut rt, "provider-auth-close", 2.5);
        assert!(rt.state.catalog.manager.connect.is_none());
        del_bad.reply(204, json!({})).await;

        // Opening a foreground OAuth popup tab immediately hides the originating tab (visible=false)
        // before the next poll: even if a passive invalidation hint arrives before that poll, the
        // queued OAuth submit must still refresh the catalog and dispatch while hidden; once active,
        // subsequent passive hints stay paused while hidden and ProviderMoves revokes immediately.
        click(&mut rt, "provider-account-add-openai", 3.0);
        click(&mut rt, "provider-auth-continue", 3.0);
        rt.update(|h, _| {
            assert!(h.target.hint("ws1"));
        });
        assert!(tick_with_visibility(&mut rt, 3.0, false));
        reply_catalog(
            &http,
            integrations.clone(),
            providers.clone(),
            json!([]),
            Some(("openai", selection.clone())),
        )
        .await;
        let deadline_reload = Instant::now() + Duration::from_secs(3);
        while rt.state.catalog.manager.catalog_flight_active() {
            assert!(
                Instant::now() < deadline_reload,
                "hidden queued-write catalog refresh did not settle"
            );
            let _ = tick_with_visibility(&mut rt, 3.0, false);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let post_move = http.accept().await;
        post_move
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/a" },
                    "data": {
                        "attemptID": "att_move",
                        "url": "https://auth.example.test/move",
                        "instructions": "Moving",
                        "mode": "auto"
                    }
                }),
            )
            .await;
        let deadline_hidden = Instant::now() + Duration::from_secs(3);
        while !rt
            .state
            .catalog
            .manager
            .connect
            .as_ref()
            .is_some_and(|f| f.stage == manager::AuthStage::Waiting)
        {
            assert!(
                Instant::now() < deadline_hidden,
                "hidden OAuth submit did not enter Waiting"
            );
            let _ = tick_with_visibility(&mut rt, 3.0, false);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let st_move = http.accept().await;
        st_move
            .reply(
                200,
                json!({ "location": { "directory": "/repo/a" }, "data": { "status": "pending" } }),
            )
            .await;
        let deadline_poll = Instant::now() + Duration::from_secs(3);
        while rt.state.catalog.manager.poll_flight_active() {
            assert!(
                Instant::now() < deadline_poll,
                "hidden OAuth status poll did not settle"
            );
            let _ = tick_with_visibility(&mut rt, 3.0, false);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // Passive invalidation while hidden (visible=false) does NOT launch a catalog GET.
        rt.update(|h, _| {
            assert!(h.target.hint("ws1"));
        });
        let _ = tick_with_visibility(&mut rt, 3.2, false);
        assert!(!rt.state.catalog.manager.catalog_flight_active());
        assert!(rt.state.catalog.manager.connect.is_some());
        http.quiet().await;

        // Catalogue ProviderMoves while hidden revokes authority immediately and sends DELETE.
        let app_state = crate::init();
        rt.update(|h, _| {
            let moves = codenomad_client::stream::ProviderMoves::Sessions(vec![(
                "ws1".into(),
                "ses1".into(),
            )]);
            let backend = h.target.backend().clone();
            assert!(h.target.validate(
                &app_state,
                Some(&backend),
                &codenomad_client::stream::CatalogueChanges::None,
                &moves,
                &codenomad_client::stream::CatalogueChanges::None,
                None,
            ));
        });
        assert!(tick_with_visibility(&mut rt, 3.3, false));
        assert!(rt.state.catalog.manager.connect.is_none());
        let del_move = http.accept().await;
        assert!(
            del_move.header.starts_with(
                "DELETE /workspaces/ws1/instance/api/integration/openai/connect/oauth/att_move?"
            ),
            "{}",
            del_move.header
        );
        del_move.reply(204, json!({})).await;
        assert!(!rt.state.catalog.manager.catalog_flight_active());
        http.quiet().await;

        // Returning to visible resumes reload; paired server-rs 404 {"error":"Not found"}
        // surfaces the unsupported alert while keeping Refresh enabled.
        assert!(tick(&mut rt, 4.0));
        let ses = http.accept().await;
        ses.reply(
            200,
            json!({ "data": { "id": "ses1", "location": { "directory": "/repo/b" } } }),
        )
        .await;
        for _ in 0..4 {
            let req = http.accept().await;
            req.reply(404, json!({ "error": "Not found" })).await;
        }
        poll_until(&mut rt, 4.0, |h| h.catalog.manager.load_error.is_some());
        let tree = rt.accessibility_json().to_string();
        assert!(
            tree.contains(t("integrations.connection.unsupported")),
            "{tree}"
        );
        let a11y = rt.accessibility_json();
        let refresh = node(&a11y, "providers-refresh").unwrap();
        assert!(
            !refresh["states"]
                .as_array()
                .is_some_and(|st| st.iter().any(|s| s == "disabled")),
            "{refresh}"
        );
    });
}
