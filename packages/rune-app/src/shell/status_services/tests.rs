use super::*;
use crate::files::test_http::Http;
use codenomad_client::plugins::{Scope, ScopeRuleState, mcp::McpState};
use rune::{Env, Runtime, col};
use rune_theme_codenomad::layout::{self, Layout};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const REV_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn poll_until(s: &mut State, cond: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let _ = s.status_services.mcp.poll(&s.reads, &s.wake);
        let _ = s.status_services.plugins.poll(&s.reads, &s.wake);
        if cond(s) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for status_services state"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn sample_controls_snapshot(dir: &str, project_enabled: bool, outdated: bool, rev: &str) -> Value {
    let runtime_entry = json!({
        "key": "acme-plugin",
        "id": "acme-plugin",
        "source": {
            "type": "package",
            "target": "@acme/plugin",
            "version": "1.0.0",
            "outdated": outdated
        },
        "features": { "server": true },
        "state": { "status": "active" }
    });
    json!({
        "location": { "directory": dir },
        "targets": [
            {
                "scope": "global",
                "path": "/home/u/.config/opencode/opencode.json",
                "exists": true,
                "expectedRevision": rev
            },
            {
                "scope": "project",
                "path": format!("{dir}/opencode.json"),
                "exists": true,
                "expectedRevision": rev
            }
        ],
        "runtime": [runtime_entry],
        "configured": {
            "rules": [],
            "sources": [
                {
                    "scope": "global",
                    "path": "/home/u/.config/opencode/opencode.json",
                    "expectedRevision": rev,
                    "target": "@acme/plugin",
                    "entryIndex": 0,
                    "hasOptions": false,
                    "pluginId": "acme-plugin"
                }
            ]
        },
        "controls": [
            {
                "id": "acme-plugin",
                "builtin": false,
                "orphan": false,
                "effective": "enabled",
                "global": "enabled",
                "project": if project_enabled { "enabled" } else { "default" },
                "runtime": runtime_entry
            }
        ]
    })
}

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
}

#[test]
fn folded_sections_stay_idle_and_expand_fetches_with_location() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/wt1".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        let _ = s.status_services.mcp.poll(&s.reads, &s.wake);
        let _ = s.status_services.plugins.poll(&s.reads, &s.wake);
        http.quiet().await;

        // Expand MCP -> fetches with location[directory].
        s.status_services.mcp.expanded = true;
        s.status_services.mcp.invalidate();
        assert!(s.status_services.mcp.poll(&s.reads, &s.wake));
        let req = http.accept().await;
        assert!(
            req.header.starts_with(
                "GET /workspaces/owned/instance/api/mcp?location%5Bdirectory%5D=%2Frepo%2Fwt1"
            ),
            "{}",
            req.header
        );
        req.reply(
            200,
            json!({
                "location": { "directory": "/repo/wt1" },
                "data": [{ "name": "docs", "status": { "status": "connected" } }]
            }),
        )
        .await;
        poll_until(&mut s, |s| s.status_services.mcp.snapshot.is_some());

        // Expand Plugins -> fetches /plugin-controls?directory=/repo/wt1.
        s.status_services.plugins.expanded = true;
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("GET /api/workspaces/owned/plugin-controls?directory=%2Frepo%2Fwt1"),
            "{}",
            req.header
        );
        req.reply(
            200,
            sample_controls_snapshot("/repo/wt1", false, false, REV_A),
        )
        .await;
        poll_until(&mut s, |s| s.status_services.plugins.snapshot.is_some());

        // Hiding Status cancels an in-flight read cleanly.
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        let inflight = http.accept().await;
        s.status_services.show(false);
        inflight.disconnected().await;

        // Render both themes without panics and verify accessible switches exist.
        s.status_services.show(true);
        for dark in [false, true] {
            let mut render_state = crate::init();
            render_state.status_services.bind(&backend);
            render_state.status_services.online(true);
            render_state.status_services.mcp.expanded = true;
            render_state.status_services.mcp.snapshot = s.status_services.mcp.snapshot.clone();
            render_state.status_services.plugins.expanded = true;
            render_state.status_services.plugins.snapshot =
                s.status_services.plugins.snapshot.clone();
            crate::strings::with_locale("en", || {
                let mut rt = Runtime::new(
                    render_state,
                    |st, cx| {
                        layout::render(cx, |_| col().full_width().full_height().children(view(st)))
                    },
                    (340.0, 500.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let tree = rt.accessibility_json();
                assert!(node(&tree, "mcp-switch-docs").is_some(), "{tree}");
                assert!(
                    node(&tree, "plugin-switch-acme-plugin-global").is_some(),
                    "{tree}"
                );
                assert!(
                    node(&tree, "plugin-switch-acme-plugin-project").is_some(),
                    "{tree}"
                );
            });
        }
    });
}

#[test]
fn mcp_toggle_disconnect_and_501_degradation() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.mcp.expanded = true;
        s.status_services.mcp.invalidate();
        assert!(s.status_services.mcp.poll(&s.reads, &s.wake));
        http.accept()
            .await
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo" },
                    "data": [{ "name": "docs", "status": { "status": "connected" } }]
                }),
            )
            .await;
        poll_until(&mut s, |s| s.status_services.mcp.snapshot.is_some());

        // Toggle connected -> disconnect -> reloads.
        s.status_services
            .mcp
            .toggle_server("docs".into(), false, &s.wake);
        let req = http.accept().await;
        assert!(
            req.header.starts_with(
                "POST /workspaces/owned/instance/api/experimental/mcp/docs/disconnect?location%5Bdirectory%5D=%2Frepo"
            ),
            "{}",
            req.header
        );
        req.reply(204, json!(null)).await;
        poll_until(&mut s, |s| s.status_services.mcp.reading());
        let reload = http.accept().await;
        assert!(
            reload
                .header
                .starts_with("GET /workspaces/owned/instance/api/mcp")
        );
        reload
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo" },
                    "data": [{ "name": "docs", "status": { "status": "disabled" } }]
                }),
            )
            .await;
        poll_until(&mut s, |s| {
            s.status_services
                .mcp
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.servers[0].status == McpState::Stopped)
        });

        // 501 marks MCP writes unsupported cleanly.
        s.status_services
            .mcp
            .toggle_server("docs".into(), true, &s.wake);
        http.accept()
            .await
            .reply(501, json!({ "error": "Not implemented" }))
            .await;
        poll_until(&mut s, |s| s.status_services.mcp.write_unsupported);
    });
}

#[test]
fn plugins_activation_patch_add_remove_and_session_move_revocation() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/a".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", false, false, REV_A),
            )
            .await;
        poll_until(&mut s, |s| s.status_services.plugins.snapshot.is_some());

        // Toggle project activation -> PATCH without expectedRevision, applies returned snapshot.
        s.status_services.plugins.toggle_activation(
            "acme-plugin".into(),
            Scope::Project,
            true,
            false,
            &s.wake,
        );
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("PATCH /api/workspaces/owned/plugin-controls"),
            "{}",
            req.header
        );
        assert_eq!(req.body["pluginId"], "acme-plugin");
        assert_eq!(req.body["scope"], "project");
        assert_eq!(req.body["enabled"], true);
        assert!(req.body.get("expectedRevision").is_none());
        req.reply(
            200,
            json!({
                "snapshot": sample_controls_snapshot("/repo/a", true, false, REV_A),
                "changed": true,
                "reloadPending": true
            }),
        )
        .await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.write_active
                && s.status_services
                    .plugins
                    .snapshot
                    .as_ref()
                    .is_some_and(|snap| snap.controls[0].project == ScopeRuleState::Enabled)
        });

        // Add source -> 409 duplicate keeps form open with mapped error; 200 closes and reloads.
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/new@1.0.0");
        s.status_services.plugins.submit_add(&s.wake);
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("POST /api/workspaces/owned/plugin-sources")
        );
        assert_eq!(req.body["spec"], "@acme/new@1.0.0");
        assert_eq!(req.body["scope"], "global");
        req.reply(
            409,
            json!({ "code": "duplicate", "error": "already exists" }),
        )
        .await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.write_active && s.status_services.plugins.add_error.is_some()
        });
        assert!(s.status_services.plugins.add_open);

        s.status_services.plugins.submit_add(&s.wake);
        http.accept()
            .await
            .reply(
                200,
                json!({ "scope": "global", "spec": "@acme/new@1.0.0", "reloadPending": true }),
            )
            .await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.add_open && s.status_services.plugins.reading()
        });
        let reload = http.accept().await;
        assert!(
            reload
                .header
                .starts_with("GET /api/workspaces/owned/plugin-controls")
        );
        reload
            .reply(200, sample_controls_snapshot("/repo/a", true, false, REV_B))
            .await;
        poll_until(&mut s, |s| {
            s.status_services
                .plugins
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.targets[0].expected_revision.as_deref() == Some(REV_B))
        });

        // Remove source confirmation -> DELETE sends expectedRevision + target + entryIndex.
        let removal = s
            .status_services
            .plugins
            .snapshot
            .as_ref()
            .unwrap()
            .removable_for_target("@acme/plugin")[0]
            .clone();
        s.status_services.plugins.request_remove_confirm(removal);
        assert!(s.status_services.plugins.confirm_remove.is_some());
        s.status_services.plugins.confirm_and_remove(&s.wake);
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("DELETE /api/workspaces/owned/plugin-sources")
        );
        assert_eq!(req.body["expectedRevision"], REV_B);
        assert_eq!(req.body["target"], "@acme/plugin");
        assert_eq!(req.body["entryIndex"], 0);
        req.reply(409, json!({ "code": "stale", "error": "changed" }))
            .await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.write_active
                && s.status_services.plugins.confirm_remove.is_none()
                && s.status_services.plugins.feedback_error.is_some()
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(200, sample_controls_snapshot("/repo/a", true, false, REV_B))
            .await;
        poll_until(&mut s, |s| !s.status_services.plugins.reading());

        // SessionMoved revokes write authority and wipes add draft + remove confirmation.
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/draft");
        let removal = s
            .status_services
            .plugins
            .snapshot
            .as_ref()
            .unwrap()
            .removable_for_target("@acme/plugin")[0]
            .clone();
        s.status_services.plugins.request_remove_confirm(removal);
        s.status_services.location_moved();
        assert!(s.status_services.plugins.write_unconfirmed);
        assert!(!s.status_services.plugins.add_open);
        assert!(s.status_services.plugins.add_spec.text.is_empty());
        assert!(s.status_services.plugins.confirm_remove.is_none());
        let _ = s.status_services.plugins.poll(&s.reads, &s.wake);
        http.quiet().await;
    });
}

#[test]
fn plugins_package_actions_and_fallback_vs_domain_404() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        http.accept()
            .await
            .reply(200, sample_controls_snapshot("/repo", false, true, REV_A))
            .await;
        poll_until(&mut s, |s| s.status_services.plugins.snapshot.is_some());

        // Check action
        s.status_services
            .plugins
            .run_package("@acme/plugin".into(), false, &s.wake);
        let req = http.accept().await;
        assert!(
            req.header.starts_with(
                "POST /workspaces/owned/instance/api/plugin/check?location%5Bdirectory%5D=%2Frepo"
            ),
            "{}",
            req.header
        );
        assert_eq!(req.body["target"], "@acme/plugin");
        req.reply(200, json!({ "outdated": true })).await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.package_busy("@acme/plugin")
                && s.status_services.plugins.reading()
        });
        let reload = http.accept().await;
        assert!(
            reload
                .header
                .starts_with("GET /api/workspaces/owned/plugin-controls")
        );
        reload
            .reply(200, sample_controls_snapshot("/repo", false, true, REV_A))
            .await;
        poll_until(&mut s, |s| !s.status_services.plugins.reading());

        // Update action
        s.status_services
            .plugins
            .run_package("@acme/plugin".into(), true, &s.wake);
        let req = http.accept().await;
        assert!(
            req.header.starts_with(
                "POST /workspaces/owned/instance/api/plugin/update?location%5Bdirectory%5D=%2Frepo"
            ),
            "{}",
            req.header
        );
        assert_eq!(req.body["targets"], json!(["@acme/plugin"]));
        req.reply(204, json!(null)).await;
        poll_until(&mut s, |s| {
            !s.status_services.plugins.package_busy("@acme/plugin")
                && s.status_services.plugins.reading()
        });
        let reload = http.accept().await;
        reload
            .reply(200, sample_controls_snapshot("/repo", false, false, REV_A))
            .await;
        poll_until(&mut s, |s| !s.status_services.plugins.reading());

        // Missing controls route (501) degrades cleanly to read-only /instance/api/plugin inventory.
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        http.accept()
            .await
            .reply(501, json!({ "error": "Not implemented" }))
            .await;
        let fallback = http.accept().await;
        assert!(
            fallback.header.starts_with(
                "GET /workspaces/owned/instance/api/plugin?location%5Bdirectory%5D=%2Frepo"
            ),
            "{}",
            fallback.header
        );
        fallback
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo" },
                    "data": [{
                        "key": "ro-plug",
                        "id": "ro-plug",
                        "source": { "type": "builtin", "target": "ro-plug" },
                        "features": { "server": true },
                        "state": { "status": "active" }
                    }]
                }),
            )
            .await;
        poll_until(&mut s, |s| {
            s.status_services
                .plugins
                .snapshot
                .as_ref()
                .is_some_and(|snap| {
                    !snap.controls_available && snap.runtime[0].id.as_deref() == Some("ro-plug")
                })
        });

        // Domain 404 ({"error":"Workspace not found"}) fails instead of falling back.
        s.status_services.plugins.invalidate(None);
        assert!(s.status_services.plugins.poll(&s.reads, &s.wake));
        http.accept()
            .await
            .reply(404, json!({ "error": "Workspace not found" }))
            .await;
        poll_until(&mut s, |s| s.status_services.plugins.failed);
        http.quiet().await;
    });
}
