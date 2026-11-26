use super::*;
use crate::{files::test_http::Http, strings::t};
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
        // Timer crossing 120s MUST signal changed=true at rest and update the rendered a11y label.
        assert!(poll_at(&mut s, 131.0));
        assert!(
            !s.status_services
                .plugins
                .is_install_pending("/repo/a", "@acme/new@1.0.0")
        );

        // Remove consent guard: blocked before 0.6s, signals changed=true at +0.6s, revoked by show(false).
        let removal = s
            .status_services
            .plugins
            .snapshot
            .as_ref()
            .unwrap()
            .removable_for_target("@acme/plugin")[0]
            .clone();
        let mut tx = Tx::default();
        s.status_services.plugins.request_remove_confirm(
            removal.clone(),
            "plugin-remove-global-@acme/plugin".into(),
            &mut tx,
        );
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

        // Re-open, wait 0.7s -> poll returns changed=true and DELETE proceeds with expectedRevision.
        s.status_services.plugins.request_remove_confirm(
            removal,
            "plugin-remove-global-@acme/plugin".into(),
            &mut tx,
        );
        assert!(poll_at(&mut s, 132.7));
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

#[test]
fn reconnect_re_resolves_conversation_location_and_mcp_failed_reconcile_offers_refresh() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/old-wt".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.mcp.expanded = true;
        s.status_services.plugins.expanded = true;
        assert!(poll_at(&mut s, 1.0));

        // Initial reads use the initial bound directory.
        for _ in 0..2 {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/mcp")
            {
                req.reply(
                    200,
                    json!({
                        "location": { "directory": "/repo/old-wt" },
                        "data": [{ "name": "docs", "status": { "status": "connected" } }]
                    }),
                )
                .await;
            } else {
                req.reply(
                    200,
                    sample_controls_snapshot("/repo/old-wt", false, false, Some(REV_A)),
                )
                .await;
            }
        }
        poll_until(&mut s, 1.0, |s| {
            s.status_services.mcp.snapshot.is_some() && s.status_services.plugins.snapshot.is_some()
        });

        // SSE disconnect invalidates Location even if session moved during outage.
        s.status_services.online(false);
        // Reconnect: must resolve via prompt_directory before reading /api/mcp and /plugin-controls.
        s.status_services.online(true);
        assert!(poll_at(&mut s, 2.0));

        let mut saw_new_mcp = false;
        let mut saw_new_plugins = false;
        while !(saw_new_mcp && saw_new_plugins) {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session")
            {
                req.reply(
                    200,
                    json!({ "data": { "id": "session", "location": { "directory": "/repo/new-wt" } } }),
                )
                .await;
            } else if req.header.starts_with(
                "GET /workspaces/owned/instance/api/mcp?location%5Bdirectory%5D=%2Frepo%2Fnew-wt",
            ) {
                saw_new_mcp = true;
                // Simulate failed reconciliation GET while old snapshot is still displayed.
                req.reply(503, json!({ "error": "unavailable" })).await;
            } else if req
                .header
                .starts_with("GET /api/workspaces/owned/plugin-controls?directory=%2Frepo%2Fnew-wt")
            {
                saw_new_plugins = true;
                req.reply(
                    200,
                    sample_controls_snapshot("/repo/new-wt", false, false, Some(REV_B)),
                )
                .await;
            } else {
                panic!("unexpected request using stale worktree: {}", req.header);
            }
        }
        poll_until(&mut s, 2.0, |s| {
            s.status_services.mcp.failed
                && s.status_services
                    .plugins
                    .snapshot
                    .as_ref()
                    .is_some_and(|snap| snap.directory == "/repo/new-wt")
        });

        // Even with a prior MCP snapshot visible, failed reconciliation exposes mcp-refresh.
        layout::with_source_palette(|| {
            let mut rt = Runtime::new(
                s,
                |st, cx| {
                    layout::render(cx, |_| col().full_width().full_height().children(view(st)))
                },
                (340.0, 500.0),
                Env::new(false, 1.0),
            );
            rt.frame(0.0);
            let tree = rt.accessibility_json();
            assert!(node(&tree, "mcp-refresh").is_some(), "{tree}");
            assert!(node(&tree, "mcp-switch-docs").is_some(), "{tree}");
        });
    });
}

#[test]
fn timer_transitions_update_a11y_at_rest_and_escape_restores_focus() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/a".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
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

        // Add source -> enters 120s Installing state.
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/pending@1.0.0");
        s.status_services.plugins.submit_add(&s.wake);
        http.accept()
            .await
            .reply(
                200,
                json!({ "scope": "global", "spec": "@acme/pending@1.0.0", "reloadPending": true }),
            )
            .await;
        poll_until(&mut s, 10.0, |s| s.status_services.plugins.reading());
        let mut with_pending = sample_controls_snapshot("/repo/a", false, false, Some(REV_A));
        with_pending["configured"]["sources"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "target": "@acme/pending@1.0.0",
                "scope": "global",
                "path": "/home/opencode.jsonc",
                "entryIndex": 1,
                "expectedRevision": REV_A
            }));
        http.accept().await.reply(200, with_pending).await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.reading() && !s.status_services.plugins.write_unconfirmed
        });

        layout::with_source_palette(|| {
            let mut rt = Runtime::new(
                s,
                |st, cx| {
                    layout::render(cx, |_| col().full_width().full_height().children(view(st)))
                },
                (360.0, 620.0),
                Env::new(false, 1.0),
            );
            rt.frame(10.0);
            let is_focused = |rt: &Runtime<State>, key: &str| {
                rt.elements()
                    .iter()
                    .any(|e| e.focused && e.key.as_deref() == Some(key))
            };
            let before_modal = rt.accessibility_json();
            let installing = t("instanceServiceStatus.plugins.sources.pendingLabel");
            assert!(
                before_modal.to_string().contains(installing),
                "{before_modal}"
            );

            // Open confirmation from the Remove button via real keyboard Enter.
            rt.update(|_, tx| tx.focus("plugin-remove-global-@acme/plugin", true));
            rt.frame(10.0);
            assert!(is_focused(&rt, "plugin-remove-global-@acme/plugin"));
            rt.key(rune::KeyEvent {
                key: rune::Key::Enter,
                mods: rune::Mods::default(),
            });
            rt.frame(10.0);
            rt.frame(10.0);
            assert!(is_focused(&rt, "plugins-remove-cancel"));
            let is_disabled = |el: &Value| {
                el["states"]
                    .as_array()
                    .is_some_and(|states| states.iter().any(|s| s == "disabled"))
            };
            let before = rt.accessibility_json();
            let confirm_before = node(&before, "plugins-remove-confirm").expect("confirm button");
            assert!(is_disabled(confirm_before), "{before}");

            // Before 0.6s: poll returns false (no unnecessary redraw) and schedules wakeup.
            assert!(!poll_at(&mut rt.state, 10.3));
            // At +0.6s with NO user input: poll reports changed=true and confirm button enables in a11y.
            assert!(poll_at(&mut rt.state, 10.65));
            rt.update(|_, _| {});
            rt.frame(10.65);
            let ready = rt.accessibility_json();
            let confirm_ready = node(&ready, "plugins-remove-confirm").expect("confirm button");
            assert!(!is_disabled(confirm_ready), "{ready}");
            // Subsequent idle poll before expiry does not spin.
            assert!(!poll_at(&mut rt.state, 10.7));

            // Real Escape key closes confirmation and restores keyboard focus to the trigger button.
            rt.key(rune::KeyEvent {
                key: rune::Key::Escape,
                mods: rune::Mods::default(),
            });
            rt.frame(10.7);
            rt.frame(10.7);
            assert!(node(&rt.accessibility_json(), "plugins-remove-dialog").is_none());
            assert!(is_focused(&rt, "plugin-remove-global-@acme/plugin"));

            // At +121s with NO user input: poll reports changed=true and Installing becomes Not confirmed.
            assert!(poll_at(&mut rt.state, 131.0));
            rt.update(|_, _| {});
            rt.frame(131.0);
            let expired = rt.accessibility_json();
            let unconfirmed = t("instanceServiceStatus.plugins.sources.unconfirmedLabel");
            assert!(expired.to_string().contains(unconfirmed), "{expired}");
            assert!(
                node(&expired, "plugin-src-refresh-@acme/pending@1.0.0").is_some(),
                "{expired}"
            );
            assert!(!poll_at(&mut rt.state, 131.5));
        });
    });
}

#[test]
fn managed_reload_pending_detached_native_status_and_multitab_package_fence() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/m".into());

        let managed_snap = |disabled: bool, active: bool| {
            json!({
                "location": { "directory": "/repo/m" },
                "runtime": [{
                    "key": "acme-plugin",
                    "id": "acme-plugin",
                    "source": { "type": "package", "target": "@acme/plugin", "version": "1.0.0", "outdated": true },
                    "features": { "server": true },
                    "state": { "status": "active" }
                }],
                "configured": { "rules": [], "sources": [] },
                "controls": [
                    {
                        "id": "codenomad.memory",
                        "managedBy": "codenomad",
                        "builtin": false,
                        "effective": if disabled { "disabled" } else { "enabled" },
                        "global": "default",
                        "project": if disabled { "disabled" } else { "enabled" },
                        "controllingRule": { "selector": "codenomad.memory", "enabled": !disabled, "scope": "project", "path": "/repo/m/opencode.jsonc" },
                        "runtime": if active {
                            json!({
                                "key": "mem",
                                "id": "codenomad.memory",
                                "managedBy": "codenomad",
                                "source": { "type": "local", "path": "/opt/mem.js" },
                                "features": { "server": true },
                                "state": { "status": "active" }
                            })
                        } else {
                            json!(null)
                        }
                    },
                    {
                        "id": "acme-plugin",
                        "builtin": false,
                        "effective": "enabled",
                        "global": "default",
                        "project": "default",
                        "runtime": {
                            "key": "acme-plugin",
                            "id": "acme-plugin",
                            "source": { "type": "package", "target": "@acme/plugin", "version": "1.0.0", "outdated": true },
                            "features": { "server": true },
                            "state": { "status": "active" }
                        }
                    }
                ],
                "targets": [
                    { "scope": "global", "path": "/home/opencode.jsonc", "exists": true, "expectedRevision": REV_A },
                    { "scope": "project", "path": "/repo/m/opencode.jsonc", "exists": true, "expectedRevision": REV_A }
                ]
            })
        };

        let mut tab_a = crate::init();
        let mut tab_b = crate::init();
        for tab in [&mut tab_a, &mut tab_b] {
            tab.status_services.bind(&backend);
            tab.status_services.online(true);
            tab.status_services.show(true);
            tab.status_services.plugins.expanded = true;
            assert!(poll_at(tab, 1.0));
            http.accept()
                .await
                .reply(200, managed_snap(true, true))
                .await;
            poll_until(tab, 1.0, |s| s.status_services.plugins.snapshot.is_some());
        }

        // Re-enable managed plugin: PATCH returns reloadPending=true with stale active runtime -> stays in attention!
        tab_a.status_services.plugins.toggle_activation(
            "codenomad.memory".into(),
            Scope::Project,
            true,
            true,
            &tab_a.wake,
        );
        let req = http.accept().await;
        assert_eq!(req.body["managedBy"], "codenomad");
        req.reply(
            200,
            json!({
                "snapshot": managed_snap(false, true),
                "changed": true,
                "reloadPending": true
            }),
        )
        .await;
        poll_until(&mut tab_a, 1.0, |s| !s.status_services.plugins.write_active);
        assert!(
            tab_a
                .status_services
                .plugins
                .runtime_unconfirmed
                .contains("codenomad.memory")
        );
        assert_eq!(
            tab_a
                .status_services
                .plugins
                .snapshot
                .as_ref()
                .unwrap()
                .system_attention_entries(&tab_a.status_services.plugins.runtime_unconfirmed)
                .len(),
            1
        );

        // Subsequent fresh GET confirms runtime -> clears runtime_unconfirmed.
        tab_a.status_services.plugins.invalidate(None);
        assert!(poll_at(&mut tab_a, 2.0));
        http.accept()
            .await
            .reply(200, managed_snap(false, true))
            .await;
        poll_until(&mut tab_a, 2.0, |s| !s.status_services.plugins.reading());
        assert!(tab_a.status_services.plugins.runtime_unconfirmed.is_empty());

        // Tab A updates @acme/plugin -> Tab B's stale snapshot CANNOT fire Update before reconciling!
        tab_a
            .status_services
            .plugins
            .run_package("@acme/plugin".into(), true, &tab_a.wake);
        http.accept().await.reply(204, json!(null)).await;
        poll_until(&mut tab_a, 2.0, |s| {
            !s.status_services.plugins.package_busy("@acme/plugin")
                && s.status_services.plugins.reading()
        });
        http.accept()
            .await
            .reply(200, managed_snap(false, true))
            .await;
        poll_until(&mut tab_a, 2.0, |s| !s.status_services.plugins.reading());

        tab_b
            .status_services
            .plugins
            .run_package("@acme/plugin".into(), true, &tab_b.wake);
        http.quiet().await;

        // Detached NativeStreamStatus disconnect revokes consent and locks writes; reconnect requires GET.
        let mut tx = Tx::default();
        tab_a.status_services.plugins.request_remove_confirm(
            codenomad_client::plugins::RemovalTarget {
                scope: Scope::Global,
                target: "@acme/plugin".into(),
                path: None,
                entry_index: Some(0),
                expected_revision: REV_A.into(),
            },
            "plugin-remove-global-@acme/plugin".into(),
            &mut tx,
        );
        assert!(tab_a.status_services.plugins.confirm_remove.is_some());
        tab_a
            .status_services
            .event(&WorkspaceEvent::NativeStreamStatus {
                workspace_id: "owned".into(),
                connected: false,
            });
        assert!(tab_a.status_services.plugins.confirm_remove.is_none());
        assert!(tab_a.status_services.plugins.write_unconfirmed);
        tab_a
            .status_services
            .event(&WorkspaceEvent::NativeStreamStatus {
                workspace_id: "owned".into(),
                connected: true,
            });
        assert!(tab_a.status_services.plugins.write_unconfirmed);
    });
}

#[test]
fn late_patch_after_reconnect_cannot_publish_stale_worktree_or_unlock_writes() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session = "ses-1".into();
        backend.session_directory = Some("/repo/old-wt".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
        assert!(poll_at(&mut s, 1.0));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/old-wt", false, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 1.0, |s| {
            s.status_services.plugins.snapshot.is_some()
        });

        // Launch PATCH in old worktree, then disconnect and reconnect before it replies.
        s.status_services.plugins.toggle_activation(
            "acme-plugin".into(),
            Scope::Project,
            true,
            false,
            &s.wake,
        );
        let patch_req = http.accept().await;
        assert!(
            patch_req
                .header
                .starts_with("PATCH /api/workspaces/owned/plugin-controls")
        );

        s.status_services.online(false);
        s.status_services.online(true);
        assert!(s.status_services.plugins.mutations_locked());

        // Late PATCH reply from old worktree MUST NOT publish or unlock mutations.
        patch_req
            .reply(
                200,
                json!({
                    "snapshot": sample_controls_snapshot("/repo/old-wt", true, false, Some(REV_A)),
                    "changed": true,
                    "reloadPending": false
                }),
            )
            .await;
        poll_until(&mut s, 2.0, |s| {
            !s.status_services.plugins.write_active && s.status_services.plugins.reading()
        });
        assert!(s.status_services.plugins.mutations_locked());
        assert_eq!(
            s.status_services
                .plugins
                .snapshot
                .as_ref()
                .unwrap()
                .controls[0]
                .project,
            ScopeRuleState::Default
        );

        // Second click before reconciliation completes is refused.
        s.status_services.plugins.toggle_activation(
            "acme-plugin".into(),
            Scope::Project,
            true,
            false,
            &s.wake,
        );

        // Fresh reconciliation GET resolves session Location to new worktree before unlocking.
        let dir_req = http.accept().await;
        assert!(
            dir_req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/ses-1 "),
            "{}",
            dir_req.header
        );
        dir_req
            .reply(
                200,
                json!({ "data": { "id": "ses-1", "location": { "directory": "/repo/new-wt" } } }),
            )
            .await;
        let snap_req = http.accept().await;
        assert!(
            snap_req.header.contains("directory=%2Frepo%2Fnew-wt"),
            "{}",
            snap_req.header
        );
        snap_req
            .reply(
                200,
                sample_controls_snapshot("/repo/new-wt", false, false, Some(REV_B)),
            )
            .await;
        poll_until(&mut s, 2.0, |s| {
            !s.status_services.plugins.reading() && !s.status_services.plugins.mutations_locked()
        });
        assert_eq!(
            s.status_services
                .plugins
                .snapshot
                .as_ref()
                .unwrap()
                .directory,
            "/repo/new-wt"
        );
        http.quiet().await;
    });
}

#[test]
fn failed_reconciliation_does_not_auto_retry_until_refresh_and_mcp_uses_neutral_error() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/a".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.mcp.expanded = true;
        s.status_services.plugins.expanded = true;
        assert!(poll_at(&mut s, 1.0));
        let mcp_ok = json!({
            "location": { "directory": "/repo/a" },
            "data": [{ "name": "docs", "status": { "status": "connected" } }]
        });
        for _ in 0..2 {
            let req = http.accept().await;
            if req.header.contains("/instance/api/mcp") {
                req.reply(200, mcp_ok.clone()).await;
            } else {
                req.reply(
                    200,
                    sample_controls_snapshot("/repo/a", false, false, Some(REV_A)),
                )
                .await;
            }
        }
        poll_until(&mut s, 1.0, |s| {
            !s.status_services.mcp.reading() && !s.status_services.plugins.reading()
        });

        // Trigger MCP write failure -> reconciliation GET fails -> must NOT auto-retry in poll loop.
        s.status_services
            .mcp
            .toggle_server("docs".into(), false, &s.wake);
        http.accept()
            .await
            .reply(500, json!({ "error": "boom" }))
            .await;
        poll_until(&mut s, 1.0, |s| s.status_services.mcp.reading());
        http.accept()
            .await
            .reply(500, json!({ "error": "down" }))
            .await;
        poll_until(&mut s, 1.0, |s| {
            !s.status_services.mcp.reading() && s.status_services.mcp.failed
        });
        for step in 0..5 {
            let _ = poll_at(&mut s, 2.0 + step as f64);
        }
        http.quiet().await;

        // MCP error alert uses neutral copy (integrations.line.failed), not plugin copy.
        let mcp_snap = s.status_services.mcp.snapshot.clone();
        layout::with_source_palette(|| {
            let mut rt = Runtime::new(
                crate::init(),
                |st, cx| {
                    layout::render(cx, |_| col().full_width().full_height().children(view(st)))
                },
                (340.0, 500.0),
                Env::new(false, 1.0),
            );
            rt.state.status_services.bind(&backend);
            rt.state.status_services.online(true);
            rt.state.status_services.show(true);
            rt.state.status_services.mcp.expanded = true;
            rt.state.status_services.mcp.failed = true;
            rt.state.status_services.mcp.snapshot = mcp_snap;
            rt.frame(0.0);
            let tree = rt.accessibility_json().to_string();
            assert!(tree.contains(t("integrations.line.failed")), "{tree}");
            assert!(
                !tree.contains(t("instanceServiceStatus.plugins.errors.refresh")),
                "{tree}"
            );
        });

        // Explicit Refresh recovers MCP reconciliation.
        s.status_services.mcp.request_refresh();
        assert!(poll_at(&mut s, 8.0));
        http.accept().await.reply(200, mcp_ok).await;
        poll_until(&mut s, 8.0, |s| {
            !s.status_services.mcp.reading() && !s.status_services.mcp.failed
        });

        // Same no-auto-retry check for Plugins reconciliation GET after a failed write.
        s.status_services.plugins.toggle_activation(
            "acme-plugin".into(),
            Scope::Project,
            true,
            false,
            &s.wake,
        );
        http.accept()
            .await
            .reply(500, json!({ "error": "boom" }))
            .await;
        poll_until(&mut s, 9.0, |s| s.status_services.plugins.reading());
        http.accept()
            .await
            .reply(500, json!({ "error": "down" }))
            .await;
        poll_until(&mut s, 9.0, |s| {
            !s.status_services.plugins.reading() && s.status_services.plugins.failed
        });
        assert!(s.status_services.plugins.mutations_locked());
        for step in 0..5 {
            let _ = poll_at(&mut s, 10.0 + step as f64);
        }
        http.quiet().await;

        // Explicit Refresh reconciles Plugins and unlocks mutations.
        s.status_services.plugins.request_refresh();
        assert!(poll_at(&mut s, 16.0));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", false, false, Some(REV_A)),
            )
            .await;
        poll_until(&mut s, 16.0, |s| {
            !s.status_services.plugins.reading() && !s.status_services.plugins.mutations_locked()
        });
    });
}

#[test]
fn unseen_acknowledged_install_stays_visible_past_120s_until_loaded_or_removed() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/a".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
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

        // POST /plugin-sources succeeds, then reconciliation GET fails (never saw configured_sources).
        s.status_services.plugins.open_add();
        s.status_services.plugins.add_spec = rune::TextEdit::new("@acme/slow@1.0.0");
        s.status_services.plugins.submit_add(&s.wake);
        http.accept()
            .await
            .reply(
                200,
                json!({ "scope": "global", "spec": "@acme/slow@1.0.0", "reloadPending": true }),
            )
            .await;
        poll_until(&mut s, 10.0, |s| s.status_services.plugins.reading());
        http.accept()
            .await
            .reply(500, json!({ "error": "temporary" }))
            .await;
        poll_until(&mut s, 10.0, |s| {
            !s.status_services.plugins.reading() && s.status_services.plugins.failed
        });

        // Crossing 120s MUST keep the unseen install visible as Not confirmed + Refresh.
        assert!(poll_at(&mut s, 131.0));
        let snap = s.status_services.plugins.snapshot.as_ref().unwrap();
        assert_eq!(
            s.status_services.plugins.pending_specs_for(snap),
            vec!["@acme/slow@1.0.0"]
        );
        assert!(
            !s.status_services
                .plugins
                .is_install_pending("/repo/a", "@acme/slow@1.0.0")
        );

        // Once seen in configured_sources, a subsequent GET omitting it prunes it.
        s.status_services.plugins.request_refresh();
        assert!(poll_at(&mut s, 132.0));
        let mut with_slow = sample_controls_snapshot("/repo/a", false, false, Some(REV_A));
        with_slow["configured"]["sources"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "target": "@acme/slow@1.0.0",
                "scope": "global",
                "path": "/home/opencode.jsonc",
                "entryIndex": 1,
                "expectedRevision": REV_A
            }));
        http.accept().await.reply(200, with_slow).await;
        poll_until(&mut s, 132.0, |s| !s.status_services.plugins.reading());
        let snap = s.status_services.plugins.snapshot.as_ref().unwrap();
        assert_eq!(
            s.status_services.plugins.pending_specs_for(snap),
            vec!["@acme/slow@1.0.0"]
        );

        s.status_services.plugins.request_refresh();
        assert!(poll_at(&mut s, 133.0));
        http.accept()
            .await
            .reply(
                200,
                sample_controls_snapshot("/repo/a", false, false, Some(REV_B)),
            )
            .await;
        poll_until(&mut s, 133.0, |s| !s.status_services.plugins.reading());
        let snap = s.status_services.plugins.snapshot.as_ref().unwrap();
        assert!(s.status_services.plugins.pending_specs_for(snap).is_empty());
    });
}

#[test]
fn remove_confirm_modal_traps_focus_has_description_and_restores_focus_on_expiry() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/a".into());

        let mut s = crate::init();
        s.status_services.bind(&backend);
        s.status_services.online(true);
        s.status_services.show(true);
        s.status_services.plugins.expanded = true;
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

        layout::with_source_palette(|| {
            let mut rt = Runtime::new(
                s,
                |st, cx| {
                    layout::render(cx, |_| col().full_width().full_height().children(view(st)))
                },
                (360.0, 620.0),
                Env::new(false, 1.0),
            );
            rt.frame(10.0);
            let is_focused = |rt: &Runtime<State>, key: &str| {
                rt.elements()
                    .iter()
                    .any(|e| e.focused && e.key.as_deref() == Some(key))
            };
            assert!(!super::super::shortcuts::modal_open(&rt.state));

            rt.update(|_, tx| tx.focus("plugin-remove-global-@acme/plugin", true));
            rt.frame(10.0);
            rt.key(rune::KeyEvent {
                key: rune::Key::Enter,
                mods: rune::Mods::default(),
            });
            rt.frame(10.0);
            rt.frame(10.0);
            assert!(super::super::shortcuts::modal_open(&rt.state));
            assert!(is_focused(&rt, "plugins-remove-cancel"));

            // Accessible alertdialog carries the remove warning in its description.
            let tree = rt.accessibility_json();
            let dialog = node(&tree, "plugins-remove-dialog").expect("alertdialog");
            assert_eq!(dialog["role"], "alert-dialog");
            assert!(
                dialog["description"].as_str().is_some_and(
                    |d| d.contains(t("instanceServiceStatus.plugins.sources.removeWarning"))
                ),
                "{dialog}"
            );

            // Enable confirm button at +0.65s, then verify Tab and Shift+Tab trap focus inside the modal.
            assert!(poll_at(&mut rt.state, 10.65));
            rt.update(|_, _| {});
            rt.frame(10.65);

            rt.key(rune::KeyEvent {
                key: rune::Key::Tab,
                mods: rune::Mods::default(),
            });
            rt.frame(10.65);
            assert!(is_focused(&rt, "plugins-remove-confirm"));

            rt.key(rune::KeyEvent {
                key: rune::Key::Tab,
                mods: rune::Mods::default(),
            });
            rt.frame(10.65);
            assert!(is_focused(&rt, "plugins-remove-cancel"));

            rt.key(rune::KeyEvent {
                key: rune::Key::Tab,
                mods: rune::Mods {
                    shift: true,
                    ..rune::Mods::default()
                },
            });
            rt.frame(10.65);
            assert!(is_focused(&rt, "plugins-remove-confirm"));

            // Natural 120s expiry dismisses the dialog and restores focus to the Remove trigger.
            rt.update(|st, tx| {
                assert!(
                    st.status_services
                        .plugins
                        .poll(131.0, &st.reads, &st.wake, tx)
                );
            });
            rt.frame(131.0);
            rt.frame(131.0);
            assert!(!super::super::shortcuts::modal_open(&rt.state));
            assert!(node(&rt.accessibility_json(), "plugins-remove-dialog").is_none());
            assert!(is_focused(&rt, "plugin-remove-global-@acme/plugin"));
        });
    });
}
