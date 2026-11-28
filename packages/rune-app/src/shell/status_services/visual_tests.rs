use super::*;
use crate::{files::test_http::Http, strings::t};
use codenomad_client::plugins::mcp::{McpServer, McpSnapshot, McpState};
use rune::{Env, Runtime, Tx, col};
use rune_theme_codenomad::{
    attachment, git_panel,
    layout::{self, Layout},
    settings, shell,
};
use serde_json::json;
use std::time::{Duration, Instant};

fn render_with_refs(s: &State, cx: &mut rune::Cx<State>) -> El {
    layout::render(cx, |_| {
        col()
            .full_width()
            .full_height()
            .children(view(s))
            .child(col().inset_surface().key("ref-inset"))
            .child(col().field_surface().key("ref-field"))
            .child(git_panel::note("ref-muted", "status").key("ref-muted"))
            .child(settings::palette::save_error("ref-error").key("ref-error"))
            .child(shell::panel_title("ref-title").key("ref-title"))
            .child(attachment::status_badge("ref-badge").key("ref-badge"))
    })
}

#[test]
fn status_services_cards_surfaces_geometry_errors_and_tooltips_in_both_themes() {
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut backend = http.backend.clone();
        backend.session_directory = Some("/repo/app".into());

        // Fetch one real Plugins snapshot via HTTP fixture covering control, failed runtime,
        // pending source, and managed system-attention entry.
        let mut loader = crate::init();
        loader.status_services.bind(&backend);
        loader.status_services.online(true);
        loader.status_services.show(true);
        loader.status_services.plugins.expanded = true;
        let mut tx = Tx::default();
        let _ = loader
            .status_services
            .plugins
            .poll(10.0, &loader.reads, &loader.wake, &mut tx);
        let rev = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        http.accept()
            .await
            .reply(
                200,
                json!({
                    "location": { "directory": "/repo/app" },
                    "targets": [
                        { "scope": "global", "path": "/home/u/.config/opencode/opencode.json", "exists": true, "expectedRevision": rev },
                        { "scope": "project", "path": "/repo/app/opencode.json", "exists": true, "expectedRevision": rev }
                    ],
                    "runtime": [
                        {
                            "key": "acme-plugin",
                            "id": "acme-plugin",
                            "source": { "type": "package", "target": "@acme/plugin", "version": "1.2.3", "outdated": false },
                            "features": { "server": true },
                            "state": { "status": "active" }
                        },
                        {
                            "key": "broken-runtime",
                            "id": "broken-runtime",
                            "source": { "type": "local", "path": "/repo/app/plugins/broken.js" },
                            "features": { "server": true },
                            "state": { "status": "failed", "error": "SyntaxError: unexpected token" }
                        }
                    ],
                    "configured": {
                        "rules": [],
                        "sources": [
                            {
                                "scope": "global",
                                "path": "/home/u/.config/opencode/opencode.json",
                                "target": "@acme/plugin",
                                "entryIndex": 0,
                                "hasOptions": false,
                                "pluginId": "acme-plugin",
                                "expectedRevision": rev
                            },
                            {
                                "scope": "global",
                                "path": "/home/u/.config/opencode/opencode.json",
                                "target": "@acme/pending@2.0.0",
                                "entryIndex": 1,
                                "hasOptions": false,
                                "expectedRevision": rev
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
                            "project": "default",
                            "runtime": {
                                "key": "acme-plugin",
                                "id": "acme-plugin",
                                "source": { "type": "package", "target": "@acme/plugin", "version": "1.2.3", "outdated": false },
                                "features": { "server": true },
                                "state": { "status": "active" }
                            }
                        },
                        {
                            "id": "codenomad.memory",
                            "managedBy": "codenomad",
                            "builtin": false,
                            "effective": "disabled",
                            "global": "default",
                            "project": "disabled",
                            "controllingRule": {
                                "selector": "codenomad.memory",
                                "enabled": false,
                                "scope": "project",
                                "path": "/repo/app/opencode.json"
                            }
                        }
                    ]
                }),
            )
            .await;
        let deadline = Instant::now() + Duration::from_secs(3);
        while loader.status_services.plugins.snapshot.is_none() {
            assert!(
                Instant::now() < deadline,
                "timed out loading plugin fixture"
            );
            let _ = loader
                .status_services
                .plugins
                .poll(10.0, &loader.reads, &loader.wake, &mut tx);
            std::thread::sleep(Duration::from_millis(5));
        }
        let plugin_snap = loader.status_services.plugins.snapshot.clone().unwrap();

        let mcp_snap = McpSnapshot {
            directory: "/repo/app".into(),
            servers: vec![
                McpServer {
                    name: "docs-server".into(),
                    status: McpState::Running,
                },
                McpServer {
                    name: "failing-mcp-with-very-long-identifier".into(),
                    status: McpState::Error(Some("connection refused".into())),
                },
            ],
        };

        for dark in [false, true] {
            crate::strings::with_locale("en", || {
                // 1) Empty MCP & empty Plugins states use muted status note.
                let mut empty_state = crate::init();
                empty_state.status_services.bind(&backend);
                empty_state.status_services.online(true);
                empty_state.status_services.mcp.expanded = true;
                empty_state.status_services.mcp.snapshot = Some(McpSnapshot {
                    directory: "/repo/app".into(),
                    servers: Vec::new(),
                });
                empty_state.status_services.plugins.expanded = true;
                empty_state.status_services.plugins.unsupported = true;

                let mut rt = Runtime::new(
                    empty_state,
                    render_with_refs,
                    (340.0, 600.0),
                    Env::new(dark, 1.0),
                );
                rt.frame(0.0);
                let nodes = rt.elements();
                let find = |key: &str| {
                    nodes
                        .iter()
                        .find(|node| node.key.as_deref() == Some(key))
                        .unwrap_or_else(|| panic!("missing `{key}` in dark={dark}"))
                };
                let ref_muted = find("ref-muted");
                assert_eq!(find("mcp-status").role, "status");
                assert_eq!(find("mcp-status").text_color, ref_muted.text_color);
                assert_eq!(find("plugins-status").role, "status");
                assert_eq!(find("plugins-status").text_color, ref_muted.text_color);

                // 2) Populated MCP + Plugins cards, errors, badges, switches, and Add form.
                let mut state = crate::init();
                state.status_services.bind(&backend);
                state.status_services.online(true);
                state.status_services.mcp.expanded = true;
                state.status_services.mcp.failed = true;
                state.status_services.mcp.snapshot = Some(mcp_snap.clone());
                state.status_services.plugins.expanded = true;
                state.status_services.plugins.snapshot = Some(plugin_snap.clone());
                state.status_services.plugins.add_open = true;
                state.status_services.plugins.add_error =
                    Some(t("instanceServiceStatus.plugins.sources.errors.invalidSpec").to_owned());

                let mut rt =
                    Runtime::new(state, render_with_refs, (340.0, 960.0), Env::new(dark, 1.0));
                rt.frame(0.0);
                let nodes = rt.elements();
                let find = |key: &str| {
                    nodes
                        .iter()
                        .find(|node| node.key.as_deref() == Some(key))
                        .unwrap_or_else(|| panic!("missing `{key}` in dark={dark}"))
                };
                let ref_inset = find("ref-inset");
                let ref_field = find("ref-field");
                let ref_error = find("ref-error");
                let ref_title = find("ref-title");
                let ref_badge = find("ref-badge");

                // MCP cards use square inset surface, tooltips, switches, and error tones.
                for key in [
                    "mcp-row-docs-server",
                    "mcp-row-failing-mcp-with-very-long-identifier",
                ] {
                    let card = find(key);
                    assert_eq!(card.fill, ref_inset.fill, "{key} must use inset surface");
                    assert_eq!(card.radius, 0.0, "{key} must keep square corners");
                }
                let failing_row = find("mcp-row-failing-mcp-with-very-long-identifier");
                assert!(
                    failing_row.help.as_deref().is_some_and(|help| {
                        help.contains("failing-mcp-with-very-long-identifier")
                            && help.contains("connection refused")
                    }),
                    "MCP error row tooltip must keep full name and error: {:?}",
                    failing_row.help
                );
                let mcp_err = find("mcp-error-failing-mcp-with-very-long-identifier");
                assert_eq!(mcp_err.role, "alert");
                assert_eq!(mcp_err.text_color, ref_error.text_color);
                assert_eq!(find("mcp-load-error").role, "alert");
                assert_eq!(find("mcp-load-error").text_color, ref_error.text_color);
                assert_eq!(find("mcp-switch-docs-server").role, "switch");

                // Plugins scope labels use muted ink.
                assert_eq!(
                    find("plugins-scope-global").text_color,
                    ref_title.text_color
                );
                assert_eq!(
                    find("plugins-scope-project").text_color,
                    ref_title.text_color
                );

                // Plugins cards (control, failed runtime, pending source, attention, add form)
                // share square inset surface.
                for key in [
                    "plugin-row-acme-plugin",
                    "plugin-rt-broken-runtime",
                    "plugin-src-@acme/pending@2.0.0",
                    "plugins-system-attention",
                    "plugins-add-card",
                ] {
                    let card = find(key);
                    assert_eq!(card.fill, ref_inset.fill, "{key} must use inset surface");
                    assert_eq!(card.radius, 0.0, "{key} must keep square corners");
                }

                // Add form input uses field surface distinct from inset card, and error uses alert ink.
                let spec_input = find("plugins-add-spec");
                assert_eq!(spec_input.fill, ref_field.fill);
                assert_ne!(spec_input.fill, ref_inset.fill);
                assert_eq!(find("plugins-add-error").role, "alert");
                assert_eq!(find("plugins-add-error").text_color, ref_error.text_color);

                // System attention row carries tooltip details.
                let sys_row = find("plugin-sys-id:codenomad.memory");
                assert!(
                    sys_row
                        .help
                        .as_deref()
                        .is_some_and(|help| help.contains("/repo/app/opencode.json")),
                    "system attention row must expose config path tooltip: {:?}",
                    sys_row.help
                );

                // Pending source renders chip-radius status badge.
                let pending_card = find("plugin-src-@acme/pending@2.0.0");
                assert!(
                    nodes.iter().any(|n| {
                        n.path.starts_with(&pending_card.path)
                            && n.role == "status"
                            && n.radius == ref_badge.radius
                            && n.radius > 0.0
                    }),
                    "pending source must render a chip-radius status badge"
                );

                // Failed runtime renders semantic error alert inside its row card.
                let broken_card = find("plugin-rt-broken-runtime");
                assert!(
                    nodes.iter().any(|n| {
                        n.path.starts_with(&broken_card.path)
                            && n.role == "alert"
                            && n.text_color == ref_error.text_color
                    }),
                    "failed runtime row must render error status in semantic error ink"
                );

                // Plugin scope switches expose switch role.
                assert_eq!(find("plugin-switch-acme-plugin-global").role, "switch");
                assert_eq!(find("plugin-switch-acme-plugin-project").role, "switch");
            });
        }
    });
}
