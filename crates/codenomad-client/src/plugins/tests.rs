use super::{
    ActionError, Scope, ScopeRuleState, is_route_not_found_body,
    mcp::{McpState, parse_mcp_snapshot},
    parse_snapshot, valid_revision,
};
use serde_json::json;

const REV_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn parses_mcp_snapshot_and_validates_location() {
    let doc = json!({
        "location": { "directory": "/repo/work" },
        "data": [
            { "name": "fs", "status": { "status": "connected" } },
            { "name": "db", "status": { "status": "failed", "error": "connection refused" } },
            { "name": "git", "status": { "status": "disabled" } }
        ]
    });
    let snap = parse_mcp_snapshot(&doc, Some("/repo/work")).unwrap();
    assert_eq!(snap.directory, "/repo/work");
    assert_eq!(snap.servers.len(), 3);
    assert_eq!(snap.servers[0].status, McpState::Running);
    assert_eq!(
        snap.servers[1].status,
        McpState::Error(Some("connection refused".into()))
    );
    assert_eq!(snap.servers[2].status, McpState::Stopped);
    let wsl = parse_mcp_snapshot(&doc, Some(r"\\wsl.localhost\Ubuntu\repo\work")).unwrap();
    assert_eq!(wsl.directory, "/repo/work");
    let no_msg = parse_mcp_snapshot(
        &json!({
            "location": { "directory": "/repo/work" },
            "data": [{ "name": "broken", "status": { "status": "failed" } }]
        }),
        Some("/repo/work"),
    )
    .unwrap();
    assert_eq!(no_msg.servers[0].status, McpState::Error(None));
    assert!(parse_mcp_snapshot(&doc, Some("/repo/other")).is_err());
    assert!(
        parse_mcp_snapshot(
            &json!({"location": {"directory": "relative/path"}, "data": []}),
            None
        )
        .is_err()
    );
}

#[test]
fn parses_plugin_controls_snapshot_and_computes_inheritance_and_removals() {
    let doc = json!({
        "location": { "directory": "/repo" },
        "runtime": [
            {
                "key": "pkg-a",
                "id": "plugin-a",
                "source": { "type": "package", "target": "pkg-a@1.0.0", "version": "1.0.0", "outdated": true },
                "features": { "server": true },
                "state": { "status": "active" }
            },
            {
                "key": "git-b",
                "id": "plugin-b",
                "source": { "type": "package", "target": "github:org/repo", "revision": "abcdef1234567890" },
                "features": { "gui": true },
                "state": { "status": "failed", "error": "boom", "ref": "err-42" }
            }
        ],
        "configured": {
            "rules": [
                { "selector": "orphan-id", "enabled": false, "scope": "global", "path": "/home/opencode.jsonc", "order": 1, "entryIndex": 2 }
            ],
            "sources": [
                {
                    "target": "pkg-a@1.0.0",
                    "scope": "global",
                    "path": "/home/opencode.jsonc",
                    "entryIndex": 0,
                    "hasOptions": false,
                    "pluginId": "plugin-a",
                    "expectedRevision": REV_A
                },
                {
                    "target": "pending-pkg@latest",
                    "scope": "project",
                    "path": "/repo/.opencode/opencode.jsonc",
                    "entryIndex": 0,
                    "hasOptions": false
                }
            ]
        },
        "controls": [
            {
                "id": "opencode.builtin",
                "builtin": true,
                "effective": "enabled",
                "global": "default",
                "project": "default"
            },
            {
                "id": "plugin-a",
                "builtin": false,
                "runtime": {
                    "key": "pkg-a",
                    "id": "plugin-a",
                    "source": { "type": "package", "target": "pkg-a@1.0.0", "version": "1.0.0", "outdated": true },
                    "features": { "server": true },
                    "state": { "status": "active" }
                },
                "effective": "disabled",
                "global": "default",
                "project": "disabled"
            },
            {
                "id": "orphan-id",
                "builtin": false,
                "effective": "disabled",
                "global": "disabled",
                "project": "default",
                "orphan": true
            }
        ],
        "targets": [
            { "scope": "global", "path": "/home/opencode.jsonc", "exists": true, "expectedRevision": REV_A },
            { "scope": "project", "path": "/repo/.opencode/opencode.jsonc", "exists": true, "expectedRevision": REV_A }
        ]
    });

    let snap = parse_snapshot(&doc, "/repo").unwrap();
    assert!(snap.controls_available);
    assert!(snap.project_available());
    assert!(parse_snapshot(&doc, "/other").is_err());

    let visible: Vec<_> = snap.visible_controls().collect();
    assert_eq!(visible.len(), 2);
    let plugin_a = visible[0];
    assert_eq!(plugin_a.global, ScopeRuleState::Default);
    assert!(plugin_a.checked(Scope::Global));
    assert!(!plugin_a.checked(Scope::Project));

    let rem_a = snap.removable_for_control(plugin_a);
    assert_eq!(rem_a.len(), 1);
    assert_eq!(rem_a[0].entry_index, Some(0));
    assert_eq!(rem_a[0].expected_revision, REV_A);

    let orphan = visible[1];
    assert!(!orphan.checked(Scope::Global));
    assert!(!orphan.checked(Scope::Project));
    let rem_orphan = snap.removable_for_control(orphan);
    assert_eq!(rem_orphan.len(), 1);
    assert_eq!(rem_orphan[0].entry_index, None);
    assert_eq!(rem_orphan[0].target, "orphan-id");

    let unmatched_rt: Vec<_> = snap.unmatched_runtime().collect();
    assert_eq!(unmatched_rt.len(), 1);
    assert_eq!(
        unmatched_rt[0].display_version().as_deref(),
        Some("abcdef1")
    );

    let unmatched_src = snap.unmatched_sources();
    assert_eq!(unmatched_src.len(), 1);
    assert_eq!(unmatched_src[0].target, "pending-pkg@latest");
    assert_eq!(snap.removable_for_target("pending-pkg@latest").len(), 1);
}

#[test]
fn distinguishes_route_not_found_from_domain_404_and_maps_error_keys() {
    assert!(is_route_not_found_body("404 Not Found"));
    assert!(is_route_not_found_body(r#"{"message":"Not Found"}"#));
    assert!(is_route_not_found_body(r#"{"error":"Not found"}"#));
    assert!(is_route_not_found_body(
        r#"{"statusCode":404,"error":"Not Found","message":"Route GET:/api/workspaces/ws/plugin-controls not found"}"#
    ));
    assert!(!is_route_not_found_body(
        r#"{"error":"Workspace not found"}"#
    ));
    assert!(!is_route_not_found_body(
        r#"{"message":"Workspace not found"}"#
    ));
    assert!(valid_revision(REV_A));
    assert!(!valid_revision("short"));
    assert!(!valid_revision(&REV_A.to_uppercase()));
    assert_eq!(
        ActionError::Code("duplicate".into()).add_source_i18n_key(),
        "instanceServiceStatus.plugins.sources.errors.duplicate"
    );
    assert_eq!(
        ActionError::Code("stale".into()).remove_source_i18n_key(),
        "instanceServiceStatus.plugins.sources.errors.removeStale"
    );
    assert_eq!(
        ActionError::Conflict.activation_i18n_key(),
        "instanceServiceStatus.plugins.errors.conflict"
    );
}

#[test]
fn excludes_managed_codenomad_plugins_from_ordinary_controls_and_surfaces_attention() {
    let doc = json!({
        "location": { "directory": "/home/u/repo" },
        "runtime": [
            {
                "key": "managed-failed",
                "id": "codenomad.design",
                "managedBy": "codenomad",
                "source": { "type": "local", "path": "/opt/design.js" },
                "features": { "server": true },
                "state": { "status": "failed" }
            }
        ],
        "configured": {
            "rules": [],
            "sources": [
                {
                    "target": "codenomad-managed-pkg",
                    "scope": "global",
                    "path": "/home/opencode.jsonc",
                    "entryIndex": 0,
                    "managedBy": "codenomad",
                    "expectedRevision": REV_A
                }
            ]
        },
        "controls": [
            {
                "id": "codenomad.missions",
                "managedBy": "codenomad",
                "builtin": false,
                "effective": "disabled",
                "global": "disabled",
                "project": "default",
                "controllingRule": {
                    "selector": "codenomad.missions",
                    "enabled": false,
                    "scope": "global",
                    "path": "/home/opencode.jsonc"
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
                    "path": "/home/u/repo/opencode.jsonc"
                }
            }
        ],
        "targets": [
            { "scope": "global", "path": "/home/opencode.jsonc", "exists": true, "expectedRevision": REV_A },
            { "scope": "project", "path": "/home/u/repo/opencode.jsonc", "exists": true, "expectedRevision": REV_A }
        ]
    });
    let snap = parse_snapshot(&doc, r"\\wsl$\Ubuntu\home\u\repo").unwrap();
    assert_eq!(snap.directory, "/home/u/repo");
    assert_eq!(snap.visible_controls().count(), 0);
    assert_eq!(snap.unmatched_runtime().count(), 0);
    assert!(snap.unmatched_sources().is_empty());
    assert!(
        snap.removable_for_target("codenomad-managed-pkg")
            .is_empty()
    );
    assert!(snap.removable_for_control(&snap.controls[1]).is_empty());

    let attention = snap.system_attention_entries(&std::collections::HashSet::new());
    // codenomad.missions disabled explicitly in global is omitted; memory (disabled), design (failed) and source (unconfirmed) appear.
    assert_eq!(attention.len(), 3);
    assert_eq!(attention[0].name, "codenomad.memory");
    assert_eq!(attention[0].kind, super::SystemAttentionKind::Disabled);
    assert_eq!(attention[0].reenable_scope, Some(Scope::Project));
    assert_eq!(attention[1].name, "codenomad.design");
    assert_eq!(attention[1].kind, super::SystemAttentionKind::Failed);
    assert_eq!(attention[2].name, "codenomad-managed-pkg");
    assert_eq!(attention[2].kind, super::SystemAttentionKind::Unconfirmed);

    // An active managed plugin marked runtime_unconfirmed after reloadPending stays visible as Unconfirmed.
    let active_doc = json!({
        "location": { "directory": "/home/u/repo" },
        "runtime": [],
        "configured": { "rules": [], "sources": [] },
        "controls": [{
            "id": "codenomad.memory",
            "managedBy": "codenomad",
            "builtin": false,
            "effective": "enabled",
            "global": "default",
            "project": "enabled",
            "runtime": {
                "key": "mem",
                "id": "codenomad.memory",
                "managedBy": "codenomad",
                "source": { "type": "local", "path": "/opt/mem.js" },
                "features": { "server": true },
                "state": { "status": "active" }
            }
        }],
        "targets": []
    });
    let active_snap = parse_snapshot(&active_doc, "/home/u/repo").unwrap();
    assert!(
        active_snap
            .system_attention_entries(&std::collections::HashSet::new())
            .is_empty()
    );
    let unconfirmed = std::collections::HashSet::from(["codenomad.memory".to_owned()]);
    let kept = active_snap.system_attention_entries(&unconfirmed);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].kind, super::SystemAttentionKind::Unconfirmed);
}

#[test]
fn add_source_timeout_exceeds_server_budget_and_turns_queued_hang_into_uncertain_failure() {
    // Covers two server add turns (20 s + 5 s abort grace each).
    assert!(super::ADD_SOURCE_TIMEOUT >= std::time::Duration::from_secs(50));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            // Hold the queued request open past the client timeout.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        });
        let mut backend =
            crate::backend::Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        backend.workspace = "owned".into();
        let err = super::add_source_with_timeout(
            &backend,
            "/repo",
            Scope::Global,
            "@acme/queued@1.0.0",
            std::time::Duration::from_millis(50),
        )
        .await
        .unwrap_err();
        assert_eq!(err, ActionError::Failed);
        let _ = server.await;
    });
}
