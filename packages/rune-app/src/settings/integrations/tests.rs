use super::{
    Panel,
    state::{EVENT_COALESCE_SECS, LoadState, PendingConfirm},
    view,
};
use crate::{
    files::test_http::Http,
    settings::providers::Target,
    strings::{t, with_locale},
};
use codenomad_client::settings::integrations::{BindingState, IntegrationScope};
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct Harness {
    panel: Panel,
    target: Option<Target>,
    active: bool,
    locale: &'static str,
    wake: rune::Waker,
}

fn harness_view(s: &Harness, cx: &mut rune::Cx<Harness>) -> rune::El {
    with_locale(s.locale, || {
        rune_theme_codenomad::layout::render(cx, |_| {
            let mut layers = Vec::new();
            let body = view(&s.panel, &mut layers, |s: &mut Harness| Some(&mut s.panel));
            rune_theme_codenomad::layout::with_overlays(body, layers)
        })
    })
}

fn poll_frame(rt: &mut Runtime<Harness>, now: f64) {
    rt.update(|s, tx| {
        with_locale(s.locale, || {
            let wake = s.wake.clone();
            s.panel.poll(s.target.as_ref(), s.active, &wake, now, tx);
        });
    });
    rt.frame(now);
}

fn make_runtime(target: Target) -> Runtime<Harness> {
    let wake: rune::Waker = Arc::new(|| {});
    Runtime::new(
        Harness {
            panel: Panel::default(),
            target: Some(target),
            active: true,
            locale: "en",
            wake,
        },
        harness_view,
        (900.0, 700.0),
        Env::new(false, 1.0),
    )
}

fn session_json(id: &str, dir: &str) -> Value {
    json!({
        "data": {
            "id": id,
            "location": { "directory": dir }
        }
    })
}

fn sample_catalog(dir: &str, host_state: &str, offers: u32) -> Value {
    json!({
        "location": { "directory": dir },
        "catalog": { "state": "fresh", "fetchedAt": "2026-11-24T10:00:00Z" },
        "integrations": [
            {
                "id": "blender",
                "displayName": "OpenCode for Blender",
                "family": "native",
                "summary": { "en": "Control Blender scenes", "fr": "Piloter des scènes Blender" },
                "app": { "name": "Blender", "versions": ">=4.2" },
                "docs": "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender",
                "catalogStatus": "stable",
                "configured": true,
                "plugin": { "declared": true, "runtime": "loaded", "runtimeId": "neuralnomads.blender" },
                "scopes": ["global"],
                "version": "1.2.0",
                "state": "ok",
                "status": {
                    "version": "1.2.0",
                    "host": {
                        "state": host_state,
                        "partVersion": "1.2.0",
                        "action": if host_state == "absent" { Value::String("install".into()) } else { Value::Null }
                    },
                    "connection": { "offers": offers }
                }
            },
            {
                "id": "godot",
                "displayName": "OpenCode for Godot",
                "family": "native",
                "summary": { "en": "Control Godot editor" },
                "app": { "name": "Godot" },
                "docs": "https://evil.example/phish",
                "catalogStatus": "preview",
                "configured": false,
                "plugin": { "declared": false },
                "scopes": [],
                "state": "absent"
            },
            {
                "id": "figma",
                "displayName": "OpenCode for Figma",
                "family": "vendor-mcp",
                "summary": { "en": "Inspect Figma files" },
                "app": { "name": "Figma" },
                "catalogStatus": "stable",
                "configured": false,
                "plugin": { "declared": false },
                "scopes": [],
                "state": "absent"
            }
        ],
        "ambiguousSources": []
    })
}

async fn settle_next(rt: &mut Runtime<Harness>, now: f64) {
    tokio::time::sleep(Duration::from_millis(25)).await;
    poll_frame(rt, now);
}

fn tree_contains_name(node: &Value, needle: &str) -> bool {
    if node["name"]
        .as_str()
        .is_some_and(|name| name.contains(needle))
    {
        return true;
    }
    node["children"].as_array().is_some_and(|children| {
        children
            .iter()
            .any(|child| tree_contains_name(child, needle))
    })
}

#[test]
fn catalog_load_d18_global_only_localized_and_no_polling() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        let req_ses = http.accept().await;
        assert!(
            req_ses
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/ses_1 "),
            "{}",
            req_ses.header
        );
        req_ses.reply(200, session_json("ses_1", "/repo")).await;

        let req_cat = http.accept().await;
        assert!(
            req_cat
                .header
                .starts_with("GET /api/workspaces/owned/integrations?directory=%2Frepo "),
            "{}",
            req_cat.header
        );
        req_cat.reply(200, sample_catalog("/repo", "ok", 0)).await;
        settle_next(&mut rt, 0.05).await;

        let req_bind = http.accept().await;
        assert!(
            req_bind.header.starts_with(
                "GET /api/workspaces/owned/integrations/blender/binding?directory=%2Frepo&sessionID=ses_1 "
            ),
            "{}",
            req_bind.header
        );
        req_bind.reply(200, json!({ "state": "none" })).await;
        settle_next(&mut rt, 0.1).await;

        let (godot, figma) = {
            let LoadState::Ready(snapshot) = &rt.state.panel.load else {
                panic!("expected Ready snapshot");
            };
            assert!(snapshot.integrations[0].docs.is_some());
            assert!(snapshot.integrations[1].docs.is_none());
            (
                snapshot.integrations[1].clone(),
                snapshot.integrations[2].clone(),
            )
        };

        rt.update(|s, _| s.locale = "fr");
        rt.frame(0.12);
        let tree = rt.accessibility_json();
        assert!(tree_contains_name(&tree, "Actualiser"), "{tree}");
        assert!(
            tree_contains_name(&tree, "Ajouter une intégration"),
            "{tree}"
        );
        assert!(tree_contains_name(&tree, "Global uniquement"), "{tree}");
        rt.update(|s, _| s.locale = "en");
        rt.frame(0.14);

        rt.state.panel.set_scope("godot", IntegrationScope::Project);
        assert_eq!(
            rt.state.panel.selected_scope(&godot),
            IntegrationScope::Global
        );
        rt.state.panel.set_scope("figma", IntegrationScope::Project);
        assert_eq!(
            rt.state.panel.selected_scope(&figma),
            IntegrationScope::Project
        );

        rt.state.panel.request_catalog_install("godot");
        assert!(matches!(
            rt.state.panel.confirm,
            Some(PendingConfirm::CatalogInstall {
                scope: IntegrationScope::Global,
                ..
            })
        ));
        rt.state.panel.decide_confirm(true);
        let req_install = http.accept().await;
        assert!(
            req_install.header.starts_with(
                "POST /api/workspaces/owned/integrations/godot/install?directory=%2Frepo "
            ),
            "{}",
            req_install.header
        );
        assert_eq!(req_install.body, json!({ "scope": "global" }));
        req_install
            .reply(
                200,
                json!({
                    "scope": "global",
                    "spec": "@neuralnomads/opencode-godot@^1.0.0",
                    "reloadPending": true
                }),
            )
            .await;
        settle_next(&mut rt, 0.2).await;
        assert_eq!(
            rt.state.panel.notice.as_ref().map(|n| n.text.as_str()),
            Some(with_locale("en", || {
                t("integrations.message.installRequested")
            }))
        );

        let req_refresh = http.accept().await;
        req_refresh
            .reply(200, sample_catalog("/repo", "ok", 0))
            .await;
        settle_next(&mut rt, 0.25).await;
        let req_bind2 = http.accept().await;
        req_bind2.reply(200, json!({ "state": "none" })).await;
        settle_next(&mut rt, 0.3).await;

        poll_frame(&mut rt, 10.0);
        poll_frame(&mut rt, 60.0);
        http.quiet().await;
    });
}

#[test]
fn missing_routes_404_and_501_degrade_cleanly_without_retry_loop() {
    crate::platform::block_on(async {
        for (status, body) in [(404, json!({ "error": "Not found" })), (501, Value::Null)] {
            let http = Http::new().await;
            let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
            let mut rt = make_runtime(target);
            poll_frame(&mut rt, 0.0);

            http.accept()
                .await
                .reply(200, session_json("ses_1", "/repo"))
                .await;
            http.accept().await.reply(status, body).await;
            settle_next(&mut rt, 0.05).await;
            assert!(matches!(rt.state.panel.load, LoadState::Unsupported));

            rt.state
                .target
                .as_mut()
                .unwrap()
                .integrations_hint("owned", None);
            poll_frame(&mut rt, 0.1);
            poll_frame(&mut rt, 1.0);
            http.quiet().await;
        }
    });
}

#[test]
fn host_install_revokes_consent_on_sse_and_handles_unsupported_code() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "absent", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.1).await;

        rt.state.panel.request_host_install("blender");
        assert!(matches!(
            rt.state.panel.confirm,
            Some(PendingConfirm::HostInstall { .. })
        ));
        rt.state
            .target
            .as_mut()
            .unwrap()
            .integrations_hint("owned", None);
        poll_frame(&mut rt, 0.15);
        assert!(rt.state.panel.confirm.is_none());
        rt.state.panel.decide_confirm(true);

        poll_frame(&mut rt, 0.15 + EVENT_COALESCE_SECS + 0.05);
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "absent", 0))
            .await;
        settle_next(&mut rt, 0.55).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.6).await;

        rt.state.panel.request_host_install("blender");
        rt.state.panel.decide_confirm(true);
        let req_host = http.accept().await;
        assert!(
            req_host.header.starts_with(
                "POST /api/workspaces/owned/integrations/blender/install-host?directory=%2Frepo "
            ),
            "{}",
            req_host.header
        );
        assert_eq!(req_host.body, json!({}));
        req_host
            .reply(
                409,
                json!({ "error": "Integration attachment unsupported", "code": "unsupported" }),
            )
            .await;
        settle_next(&mut rt, 0.7).await;
        assert_eq!(
            rt.state.panel.notice.as_ref().map(|n| n.text.as_str()),
            Some(with_locale("en", || {
                t("integrations.installHost.unsupported")
            }))
        );
    });
}

#[test]
fn attach_single_multiple_detach_and_fail_closed_binding() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 2))
            .await;
        settle_next(&mut rt, 0.05).await;

        for _ in 0..2 {
            let req = http.accept().await;
            if req.header.contains("/binding?") {
                req.reply(
                    200,
                    json!({ "state": "attached", "label": "scene.blend", "extra": true }),
                )
                .await;
            } else {
                req.reply(
                    200,
                    json!({
                        "offers": [
                            { "offerID": "offer_111111", "label": "Blender — a.blend", "document": "a.blend", "protocol": "ok" },
                            { "offerID": "offer_222222", "label": "Blender — b.blend", "document": "b.blend", "protocol": "ok" }
                        ]
                    }),
                )
                .await;
            }
        }
        settle_next(&mut rt, 0.1).await;
        assert_eq!(
            rt.state.panel.bindings.get("blender"),
            Some(&BindingState::Unknown)
        );

        rt.state.panel.request_attach("blender", None);
        let probe = http.accept().await;
        assert!(probe.header.contains("/blender/hosts?directory=%2Frepo"));
        probe
            .reply(
                200,
                json!({
                    "offers": [
                        { "offerID": "offer_111111", "label": "Blender — a.blend", "document": "a.blend", "protocol": "ok" },
                        { "offerID": "offer_222222", "label": "Blender — b.blend", "document": "b.blend", "protocol": "ok" }
                    ]
                }),
            )
            .await;
        settle_next(&mut rt, 0.15).await;
        assert_eq!(
            rt.state.panel.chooser.as_ref().map(|c| c.offers.len()),
            Some(2)
        );

        rt.state.panel.choose_offer("offer_222222");
        let req_attach = http.accept().await;
        assert!(
            req_attach.header.starts_with(
                "POST /api/workspaces/owned/integrations/blender/attach?directory=%2Frepo "
            ),
            "{}",
            req_attach.header
        );
        assert_eq!(
            req_attach.body,
            json!({ "sessionID": "ses_1", "offerID": "offer_222222" })
        );
        req_attach
            .reply(200, json!({ "outcome": "attached" }))
            .await;
        settle_next(&mut rt, 0.2).await;

        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 2))
            .await;
        settle_next(&mut rt, 0.25).await;
        for _ in 0..2 {
            let req = http.accept().await;
            if req.header.contains("/binding?") {
                req.reply(
                    200,
                    json!({ "state": "attached", "label": "Blender — b.blend" }),
                )
                .await;
            } else {
                req.reply(200, json!({ "offers": [] })).await;
            }
        }
        settle_next(&mut rt, 0.3).await;
        assert_eq!(
            rt.state.panel.bindings.get("blender"),
            Some(&BindingState::Attached("Blender — b.blend".into()))
        );

        rt.state.panel.request_detach("blender");
        let req_detach = http.accept().await;
        assert!(
            req_detach.header.starts_with(
                "POST /api/workspaces/owned/integrations/blender/detach?directory=%2Frepo "
            ),
            "{}",
            req_detach.header
        );
        assert_eq!(req_detach.body, json!({ "sessionID": "ses_1" }));
        req_detach
            .reply(200, json!({ "outcome": "detached" }))
            .await;
    });
}

#[test]
fn sse_events_coalesce_over_300ms_with_one_trailing_followup() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.1).await;

        rt.state
            .target
            .as_mut()
            .unwrap()
            .integrations_hint("owned", None);
        poll_frame(&mut rt, 0.1);
        rt.state
            .target
            .as_mut()
            .unwrap()
            .integrations_hint("owned", None);
        poll_frame(&mut rt, 0.15);
        poll_frame(&mut rt, 0.35);
        http.quiet().await;

        poll_frame(&mut rt, 0.41);
        let in_flight = http.accept().await;
        rt.state
            .target
            .as_mut()
            .unwrap()
            .integrations_hint("owned", None);
        poll_frame(&mut rt, 0.42);
        in_flight.reply(200, sample_catalog("/repo", "ok", 0)).await;
        settle_next(&mut rt, 0.45).await;
        poll_frame(&mut rt, 0.76);
        let trailing = http.accept().await;
        trailing.reply(200, sample_catalog("/repo", "ok", 0)).await;
        settle_next(&mut rt, 0.8).await;
        let bind = http.accept().await;
        bind.reply(200, json!({ "state": "none" })).await;
        settle_next(&mut rt, 0.85).await;

        poll_frame(&mut rt, 5.0);
        http.quiet().await;
    });
}

#[test]
fn stale_state_blocks_confirm_and_detach_until_reloaded() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "absent", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(
                200,
                json!({ "state": "attached", "label": "Blender — a.blend" }),
            )
            .await;
        settle_next(&mut rt, 0.1).await;
        assert!(rt.state.panel.fresh());

        rt.state
            .target
            .as_mut()
            .unwrap()
            .integrations_hint("owned", None);
        poll_frame(&mut rt, 0.15);
        assert!(rt.state.panel.stale);
        assert!(!rt.state.panel.fresh());
        assert!(rt.state.panel.bindings.is_empty());

        rt.state.panel.request_catalog_install("godot");
        rt.state.panel.request_host_install("blender");
        rt.state.panel.request_detach("blender");
        assert!(rt.state.panel.confirm.is_none());
        assert!(!rt.state.panel.busy());
        http.quiet().await;

        poll_frame(&mut rt, 0.15 + EVENT_COALESCE_SECS + 0.05);
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "absent", 0))
            .await;
        settle_next(&mut rt, 0.55).await;
        http.accept()
            .await
            .reply(
                200,
                json!({ "state": "attached", "label": "Blender — b.blend" }),
            )
            .await;
        settle_next(&mut rt, 0.6).await;
        assert!(rt.state.panel.fresh());
        assert_eq!(
            rt.state.panel.bindings.get("blender"),
            Some(&BindingState::Attached("Blender — b.blend".into()))
        );

        rt.state.panel.request_detach("blender");
        let req_detach = http.accept().await;
        assert!(req_detach.header.starts_with(
            "POST /api/workspaces/owned/integrations/blender/detach?directory=%2Frepo "
        ));
        req_detach
            .reply(200, json!({ "outcome": "detached" }))
            .await;
    });
}

#[test]
fn suspend_and_reenter_keeps_in_flight_mutation_lock_and_reconciles() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.1).await;

        rt.state.panel.request_catalog_install("godot");
        assert!(rt.state.panel.confirm.is_some());
        rt.state.panel.decide_confirm(true);
        let install_req = http.accept().await;
        assert!(rt.state.panel.busy());

        rt.update(|s, _| s.active = false);
        poll_frame(&mut rt, 0.15);
        rt.update(|s, _| s.active = true);
        poll_frame(&mut rt, 0.2);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 0))
            .await;
        settle_next(&mut rt, 0.25).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.3).await;

        assert!(rt.state.panel.busy());
        rt.state.panel.request_catalog_install("godot");
        assert!(rt.state.panel.confirm.is_none());

        install_req.reply(200, json!({ "ok": true })).await;
        settle_next(&mut rt, 0.35).await;
        assert!(!rt.state.panel.busy());
        assert!(rt.state.panel.stale);
        let reconcile = http.accept().await;
        assert!(
            reconcile
                .header
                .starts_with("GET /api/workspaces/owned/integrations?directory=%2Frepo "),
            "{}",
            reconcile.header
        );
        reconcile.reply(200, sample_catalog("/repo", "ok", 0)).await;
        settle_next(&mut rt, 0.4).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.45).await;
        assert!(rt.state.panel.fresh());
    });
}

#[test]
fn simultaneous_workspace_and_session_hints_re_resolve_moved_directory() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo/wt1"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo/wt1", "ok", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.1).await;

        {
            let target = rt.state.target.as_mut().unwrap();
            target.integrations_hint("owned", None);
            target.integrations_hint("owned", Some("ses_1"));
        }
        poll_frame(&mut rt, 0.15);
        poll_frame(&mut rt, 0.15 + EVENT_COALESCE_SECS + 0.05);

        let req_session = http.accept().await;
        assert!(
            req_session
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/ses_1 "),
            "{}",
            req_session.header
        );
        req_session
            .reply(200, session_json("ses_1", "/repo/wt2"))
            .await;
        let req_catalog = http.accept().await;
        assert!(
            req_catalog
                .header
                .starts_with("GET /api/workspaces/owned/integrations?directory=%2Frepo%2Fwt2 "),
            "{}",
            req_catalog.header
        );
        req_catalog
            .reply(200, sample_catalog("/repo/wt2", "ok", 0))
            .await;
        settle_next(&mut rt, 0.55).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.6).await;
        assert!(rt.state.panel.fresh());
    });
}

#[test]
fn unrelated_session_change_does_not_revoke_current_session_confirm() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 0))
            .await;
        settle_next(&mut rt, 0.05).await;
        http.accept()
            .await
            .reply(200, json!({ "state": "none" }))
            .await;
        settle_next(&mut rt, 0.1).await;

        rt.state.panel.request_catalog_install("godot");
        assert!(rt.state.panel.confirm.is_some());

        let mut other = std::collections::HashSet::new();
        other.insert(("owned".to_owned(), "ses_other".to_owned()));
        rt.state.target.as_mut().unwrap().integrations_catalogue(
            &codenomad_client::stream::CatalogueChanges::None,
            &codenomad_client::stream::SessionCatalogueChanges::Sessions(other),
        );
        poll_frame(&mut rt, 0.2);
        assert!(rt.state.panel.confirm.is_some());
        assert!(rt.state.panel.fresh());
        http.quiet().await;

        let mut current = std::collections::HashSet::new();
        current.insert(("owned".to_owned(), "ses_1".to_owned()));
        rt.state.target.as_mut().unwrap().integrations_catalogue(
            &codenomad_client::stream::CatalogueChanges::None,
            &codenomad_client::stream::SessionCatalogueChanges::Sessions(current),
        );
        poll_frame(&mut rt, 0.25);
        assert!(rt.state.panel.confirm.is_none());
        assert!(rt.state.panel.stale);
    });
}

#[test]
fn failed_hosts_detail_read_clears_cached_offers() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let target = Target::fixture(http.backend.clone(), "owned", Some("ses_1"));
        let mut rt = make_runtime(target);
        poll_frame(&mut rt, 0.0);

        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 1))
            .await;
        settle_next(&mut rt, 0.05).await;
        for _ in 0..2 {
            let req = http.accept().await;
            if req.header.contains("/binding?") {
                req.reply(200, json!({ "state": "none" })).await;
            } else {
                req.reply(200, json!({ "offers": [] })).await;
            }
        }
        settle_next(&mut rt, 0.1).await;
        assert_eq!(rt.state.panel.offers.get("blender").map(Vec::len), Some(0));

        rt.state.panel.refresh();
        poll_frame(&mut rt, 0.15);
        http.accept()
            .await
            .reply(200, session_json("ses_1", "/repo"))
            .await;
        http.accept()
            .await
            .reply(200, sample_catalog("/repo", "ok", 1))
            .await;
        settle_next(&mut rt, 0.2).await;
        for _ in 0..2 {
            let req = http.accept().await;
            if req.header.contains("/binding?") {
                req.reply(200, json!({ "state": "none" })).await;
            } else {
                req.reply(500, json!({ "error": "boom" })).await;
            }
        }
        settle_next(&mut rt, 0.25).await;
        assert!(rt.state.panel.offers.get("blender").is_none());

        rt.state.panel.request_attach("blender", None);
        let probe = http.accept().await;
        assert!(probe.header.starts_with(
            "GET /api/workspaces/owned/integrations/blender/hosts?directory=%2Frepo "
        ));
        probe
            .reply(
                200,
                json!({
                    "offers": [
                        { "offerID": "offer_333333", "label": "Blender — c.blend", "document": "c.blend", "protocol": "ok" }
                    ]
                }),
            )
            .await;
        settle_next(&mut rt, 0.3).await;
        let attach = http.accept().await;
        assert!(attach.header.starts_with(
            "POST /api/workspaces/owned/integrations/blender/attach?directory=%2Frepo "
        ));
        attach.reply(200, json!({ "outcome": "attached" })).await;
    });
}
