use super::*;
use crate::files::test_http::Http;
use codenomad_client::plugins::{Scope, ScopeRuleState, mcp::McpState};
use rune::{Env, Runtime, Tx, col};
use rune_theme_codenomad::layout::{self, Layout};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const REV_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REV_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn poll_at(s: &mut State, now: f64) -> bool {
    let mut tx = Tx::default();
    let mcp = s.status_services.mcp.poll(&s.reads, &s.wake);
    let plugins = s
        .status_services
        .plugins
        .poll(now, &s.reads, &s.wake, &mut tx);
    mcp || plugins
}

fn poll_until(s: &mut State, now: f64, cond: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let _ = poll_at(s, now);
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

fn sample_controls_snapshot(
    dir: &str,
    project_enabled: bool,
    outdated: bool,
    rev: Option<&str>,
) -> Value {
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
    let target = |scope: &str, path: String| {
        let mut obj = json!({ "scope": scope, "path": path, "exists": true });
        if let Some(r) = rev {
            obj["expectedRevision"] = json!(r);
        }
        obj
    };
    let mut src = json!({
        "scope": "global",
        "path": "/home/u/.config/opencode/opencode.json",
        "target": "@acme/plugin",
        "entryIndex": 0,
        "hasOptions": false,
        "pluginId": "acme-plugin"
    });
    if let Some(r) = rev {
        src["expectedRevision"] = json!(r);
    }
    json!({
        "location": { "directory": dir },
        "targets": [
            target("global", "/home/u/.config/opencode/opencode.json".into()),
            target("project", format!("{dir}/opencode.json"))
        ],
        "runtime": [runtime_entry],
        "configured": { "rules": [], "sources": [src] },
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
        let _ = poll_at(&mut s, 1.0);
        http.quiet().await;

        s.status_services.mcp.expanded = true;
        s.status_services.mcp.invalidate();
        assert!(poll_at(&mut s, 1.0));
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
        poll_until(&mut s, 1.0, |s| s.status_services.mcp.snapshot.is_some());

        s.status_services.plugins.expanded = true;
        s.status_services.plugins.invalidate(None);
        assert!(poll_at(&mut s, 1.0));
        let req = http.accept().await;
        assert!(
            req.header
                .starts_with("GET /api/workspaces/owned/plugin-controls?directory=%2Frepo%2Fwt1"),
            "{}",
            req.header
        );
        req.reply(
            200,
            sample_controls_snapshot("/repo/wt1", false, false, Some(REV_A)),
        )
        .await;
        poll_until(&mut s, 1.0, |s| {
            s.status_services.plugins.snapshot.is_some()
        });

        // Hiding Status cancels an in-flight read cleanly.
        s.status_services.plugins.invalidate(None);
        assert!(poll_at(&mut s, 1.0));
        let inflight = http.accept().await;
        s.status_services.show(false);
        inflight.disconnected().await;

        // Render both themes without panics and verify accessible controls + keyboard info tips.
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
                assert!(node(&tree, "plugin-info-acme-plugin").is_some(), "{tree}");
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
fn mcp_resolves_conversation_location_and_enforces_multitab_generation_barrier() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        // Conversation bound WITHOUT cached session_directory: must resolve via prompt_directory first.
        let mut backend = http.backend.clone();
        backend.session_directory = None;

        let mut tab_a = crate::init();
        tab_a.status_services.bind(&backend);
        tab_a.status_services.online(true);
        tab_a.status_services.show(true);
        tab_a.status_services.mcp.expanded = true;
        tab_a.status_services.mcp.invalidate();
        assert!(poll_at(&mut tab_a, 1.0));

        // Expect session lookup first, never a root GET /api/mcp without location[directory].
        let dir_req = http.accept().await;
        assert!(
            dir_req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session"),
            "{}",
            dir_req.header
        );
        dir_req
            .reply(
                200,
                json!({ "data": { "id": "session", "location": { "directory": "/repo/wt-conv" } } }),
            )
            .await;

        let mcp_req = http.accept().await;
        assert!(
            mcp_req.header.starts_with(
                "GET /workspaces/owned/instance/api/mcp?location%5Bdirectory%5D=%2Frepo%2Fwt-conv"
            ),
            "{}",
            mcp_req.header
        );
        mcp_req
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/wt-conv" },
                    "data": [{ "name": "docs", "status": { "status": "connected" } }]
                }),
            )
            .await;
        poll_until(&mut tab_a, 1.0, |s| {
            s.status_services.mcp.snapshot.is_some()
        });

        // Second tab on same backend loads the same generation.
        let mut tab_b = crate::init();
        let mut backend_b = http.backend.clone();
        backend_b.session_directory = Some("/repo/wt-conv".into());
        tab_b.status_services.bind(&backend_b);
        tab_b.status_services.online(true);
        tab_b.status_services.show(true);
        tab_b.status_services.mcp.expanded = true;
        tab_b.status_services.mcp.invalidate();
        assert!(poll_at(&mut tab_b, 1.0));
        http.accept()
            .await
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/wt-conv" },
                    "data": [{ "name": "docs", "status": { "status": "connected" } }]
                }),
            )
            .await;
        poll_until(&mut tab_b, 1.0, |s| {
            s.status_services.mcp.snapshot.is_some()
        });

        // Tab A disconnects docs -> barrier generation advances.
        tab_a
            .status_services
            .mcp
            .toggle_server("docs".into(), false, &tab_a.wake);
        let req = http.accept().await;
        assert!(
            req.header.starts_with(
                "POST /workspaces/owned/instance/api/experimental/mcp/docs/disconnect?location%5Bdirectory%5D=%2Frepo%2Fwt-conv"
            ),
            "{}",
            req.header
        );
        req.reply(204, json!(null)).await;
        poll_until(&mut tab_a, 1.0, |s| s.status_services.mcp.reading());
        let dir_req2 = http.accept().await;
        assert!(
            dir_req2
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session"),
            "{}",
            dir_req2.header
        );
        dir_req2
            .reply(
                200,
                json!({ "data": { "id": "session", "location": { "directory": "/repo/wt-conv" } } }),
            )
            .await;
        http.accept()
            .await
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/wt-conv" },
                    "data": [{ "name": "docs", "status": { "status": "disabled" } }]
                }),
            )
            .await;
        poll_until(&mut tab_a, 1.0, |s| {
            s.status_services
                .mcp
                .snapshot
                .as_ref()
                .is_some_and(|snap| snap.servers[0].status == McpState::Stopped)
        });

        // Tab B tries to toggle on stale generation BEFORE reconciling -> refused, triggers refresh instead!
        tab_b
            .status_services
            .mcp
            .toggle_server("docs".into(), false, &tab_b.wake);
        http.quiet().await;

        // Remote policy 404 {"error":"Not found"} marks MCP writes unsupported cleanly.
        tab_a
            .status_services
            .mcp
            .toggle_server("docs".into(), true, &tab_a.wake);
        http.accept()
            .await
            .reply(404, json!({ "error": "Not found" }))
            .await;
        poll_until(&mut tab_a, 1.0, |s| tab_a_write_unsupported(s));
    });
}

fn tab_a_write_unsupported(s: &State) -> bool {
    s.status_services.mcp.write_unsupported
}

#[test]
fn plugins_consent_guard_install_cycle_uncertain_add_and_patch_revision_refresh() {
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
        assert!(poll_at(&mut s, 10.0));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", false, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 10.0, |s| {
            s.status_services.plugins.snapshot.is_some()
        });

        // PATCH returns snapshot without expectedRevision on existing target -> schedules passive GET.
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
                .starts_with("PATCH /api/workspaces/owned/plugin-controls")
        );
        assert!(req.body.get("expectedRevision").is_none());
        req.reply(
            200,
            json!({
                "snapshot": sample_controls_snapshot("/repo/a", true, false, None),
                "changed": true,
                "reloadPending": true
            }),
        )
        .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.write_active
                && s.status_services.plugins.reading()
                && s.status_services
                    .plugins
                    .snapshot
                    .as_ref()
                    .is_some_and(|snap| snap.controls[0].project == ScopeRuleState::Enabled)
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", true, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 10.0, |s| !s.status_services.plugins.reading());

        // Uncertain add failure (503) locks writes until reconciliation GET completes.
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/new@1.0.0");
        s.status_services.plugins.submit_add(&s.wake);
        http.accept()
            .await
            .reply(503, json!({ "error": "upstream timeout" }))
            .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.write_active
                && s.status_services.plugins.write_unconfirmed
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", true, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.write_unconfirmed && !s.status_services.plugins.reading()
        });

        // Add succeeds -> enters 120s Installing pending cycle, then Not confirmed after 120s.
        s.status_services.plugins.submit_add(&s.wake);
        http.accept()
            .await
            .reply(
                200,
                json!({ "scope": "global", "spec": "@acme/new@1.0.0", "reloadPending": true }),
            )
            .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.add_open && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", true, false, Some(REV_B)),
            )
            .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.reading() && !s.status_services.plugins.write_unconfirmed
        });
        assert!(
            s.status_services
                .plugins
                .is_install_pending("/repo/a", "@acme/new@1.0.0")
        );
        let _ = poll_at(&mut s, 131.0);
        assert!(
            !s.status_services
                .plugins
                .is_install_pending("/repo/a", "@acme/new@1.0.0")
        );

        // Remove consent guard: blocked before 0.6s, allowed at +0.7s, revoked by show(false).
        let removal = s
            .status_services
            .plugins
            .snapshot
            .as_ref()
            .unwrap()
            .removable_for_target("@acme/plugin")[0]
            .clone();
        let mut tx = Tx::default();
        s.status_services
            .plugins
            .request_remove_confirm(removal.clone(), &mut tx);
        assert!(s.status_services.plugins.confirm_remove.is_some());
        assert!(!s.status_services.plugins.remove_ready());
        s.status_services.plugins.confirm_and_remove(&s.wake);
        http.quiet().await;

        // Revoked on tab hide / show(false).
        s.status_services.show(false);
        assert!(s.status_services.plugins.confirm_remove.is_none());
        s.status_services.show(true);
        let _ = poll_at(&mut s, 132.0);
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", true, false, Some(REV_B)),
            )
            .await;
        poll_until(&mut s, 132.0, |s| !s.status_services.plugins.reading());

        // Re-open, wait 0.7s -> DELETE proceeds with expectedRevision.
        s.status_services
            .plugins
            .request_remove_confirm(removal, &mut tx);
        let _ = poll_at(&mut s, 132.7);
        assert!(s.status_services.plugins.remove_ready());
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
        poll_until(&mut s, 132.7, |s| {
            !s.status_services.plugins.write_active
                && s.status_services.plugins.feedback_error.is_some()
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", true, false, Some(REV_B)),
            )
            .await;
        poll_until(&mut s, 132.7, |s| !s.status_services.plugins.reading());

        // SessionMoved revokes write authority and clears add draft + confirm_remove.
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/draft");
        s.status_services.location_moved();
        assert!(s.status_services.plugins.write_unconfirmed);
        assert!(!s.status_services.plugins.add_open);
        assert!(s.status_services.plugins.add_spec.text.is_empty());
        let _ = poll_at(&mut s, 133.0);
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
        assert!(poll_at(&mut s, 1.0));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo", false, true, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 1.0, |s| {
            s.status_services.plugins.snapshot.is_some()
        });

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
        poll_until(&mut s, 1.0, |s| {
            !s.status_services.plugins.package_busy("@acme/plugin")
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo", false, true, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 1.0, |s| !s.status_services.plugins.reading());

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
        poll_until(&mut s, 1.0, |s| {
            !s.status_services.plugins.package_busy("@acme/plugin")
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo", false, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 1.0, |s| !s.status_services.plugins.reading());

        // Remote policy 404 {"error":"Not found"} falls back to read-only inventory.
        s.status_services.plugins.invalidate(None);
        assert!(poll_at(&mut s, 1.0));
        http.accept()
            .await
            .reply(404, json!({ "error": "Not found" }))
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
        poll_until(&mut s, 1.0, |s| {
            s.status_services
                .plugins
                .snapshot
                .as_ref()
                .is_some_and(|snap| {
                    !snap.controls_available && snap.runtime[0].id.as_deref() == Some("ro-plug")
                })
        });

        // Domain 404 fails instead of falling back.
        s.status_services.plugins.invalidate(None);
        assert!(poll_at(&mut s, 1.0));
        http.accept()
            .await
            .reply(404, json!({ "error": "Workspace not found" }))
            .await;
        poll_until(&mut s, 1.0, |s| s.status_services.plugins.failed);
        http.quiet().await;
    });
}
