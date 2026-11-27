//! Pure unit tests for plugin spec validation, package identity, activation order,
//! JSONC plugins array editing, and discovery loader proofs.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::{
    files::node_path::Style,
    subagent_depth::{document::decode, jsonc},
};

use super::{
    discovery::{
        declared_entrypoint_of, discovery_entrypoint_of, discovery_entrypoint_shape, escapes, file_url_to_path,
        managed_desktop_plugin_for_source, selected_entrypoint,
    },
    doc::{append_plugin_control_rule, remove_plugin_source_entry, replace_plugin_control_rules},
    order::{AppliedEntry, AppliedSequence, defined_before, enabled_through, matches_selector},
    spec::{
        SpecErrorCode, git_plugin_revision, plugin_package_identities, registry_package_name,
        validate_plugin_source_spec,
    },
};

fn doc_for(text: &str, bom: bool) -> crate::subagent_depth::document::Document {
    let mut bytes = Vec::new();
    if bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend_from_slice(text.as_bytes());
    decode("/x/opencode.jsonc".into(), "/x/opencode.jsonc".into(), true, 0o644, &bytes).unwrap()
}

fn parse_text(text: &[u16]) -> Value {
    let s = jsonc::string(text);
    let stripped = s.strip_prefix('\u{feff}').unwrap_or(&s);
    let (v, err) = jsonc::parse(&jsonc::utf16(stripped), true);
    assert!(!err, "invalid JSONC output: {s}");
    super::doc::j_to_json(&v.unwrap())
}

#[test]
fn spec_validation_and_identities_match_typescript() {
    for ok in [
        "foo",
        "@scope/pkg",
        "@scope/pkg@^1.2.0",
        "foo@latest",
        "foo@1.2.3",
        "bar@npm:foo@1",
        "plugin@NPM:other@1",
        "github:user/repo",
        "github:NeuralNomadsAI/opencode-integrations#fixture-v0.1.0::path:/integrations/fixture",
        "user/repo#v1",
        "git+https://github.com/user/repo.git#v1",
        "git+ssh://git@example.com/x.git",
        "foo@>=1 <2",
        "foo@^1 || ^2",
        "pkg@>=1.0.0 ||",
        "pkg@garbage ||",
        "pkg@>=1.0.0 garbage",
        "pkg@1.2.3+build.1",
        "gist:alice/123456",
    ] {
        assert!(validate_plugin_source_spec(ok).is_ok(), "should accept {ok}");
    }

    let long_spec = "x".repeat(513);
    for (bad, code) in [
        ("./plugin", SpecErrorCode::LocalPath),
        ("../plugin", SpecErrorCode::LocalPath),
        ("/abs/plugin", SpecErrorCode::LocalPath),
        ("~/plugin", SpecErrorCode::LocalPath),
        ("C:\\plugin", SpecErrorCode::LocalPath),
        ("\\\\server\\share\\plugin", SpecErrorCode::LocalPath),
        ("file:../plugin", SpecErrorCode::LocalPath),
        ("git+file:///tmp/repo", SpecErrorCode::LocalPath),
        ("plugin.tgz", SpecErrorCode::LocalPath),
        ("foo@plugin.tar.gz", SpecErrorCode::LocalPath),
        ("foo@a/b/c", SpecErrorCode::LocalPath),
        ("plugin@tag%", SpecErrorCode::InvalidSpec),
        ("pkg@1.2.3+%", SpecErrorCode::InvalidSpec),
        ("pkg@V1.2.3 garbage", SpecErrorCode::InvalidSpec),
        ("github:org/repo#main::other", SpecErrorCode::InvalidSpec),
        ("github:org/repo#main::semver:^1.0.0", SpecErrorCode::InvalidSpec),
        ("github:org/repo#path:/a::path:/b", SpecErrorCode::InvalidSpec),
        ("https://example.com/plugin.tgz", SpecErrorCode::InvalidSpec),
        ("foo@{env:VERSION}", SpecErrorCode::InvalidSpec),
        ("{file:./spec}", SpecErrorCode::InvalidSpec),
        ("-foo", SpecErrorCode::PluginId),
        ("foo.*", SpecErrorCode::PluginId),
        ("*", SpecErrorCode::PluginId),
        ("opencode.builtin", SpecErrorCode::PluginId),
        ("foo\x07", SpecErrorCode::InvalidSpec),
        ("foo@1\n", SpecErrorCode::InvalidSpec),
        ("foo@\t1", SpecErrorCode::InvalidSpec),
        (" foo", SpecErrorCode::InvalidSpec),
        ("foo ", SpecErrorCode::InvalidSpec),
        ("a b", SpecErrorCode::InvalidSpec),
        ("foo@1\u{2028}x", SpecErrorCode::InvalidSpec),
        ("github:u/r#v1\u{202e}", SpecErrorCode::InvalidSpec),
        ("foo@1\u{00a0}", SpecErrorCode::InvalidSpec),
        ("plügin", SpecErrorCode::InvalidSpec),
        ("", SpecErrorCode::InvalidSpec),
        (long_spec.as_str(), SpecErrorCode::InvalidSpec),
    ] {
        assert_eq!(validate_plugin_source_spec(bad).map_err(|(c, _)| c), Err(code), "case {bad:?}");
    }

    let same = |a: &str, b: &str| {
        let ka = plugin_package_identities(a);
        let kb = plugin_package_identities(b);
        ka.iter().any(|k| kb.contains(k))
    };
    assert!(same("foo", "foo@1.2.3"));
    assert!(same("foo@^1", "foo@next"));
    assert!(same("Foo", "foo@2"));
    assert!(same("bar@npm:foo@1", "foo"));
    assert!(same("bar@npm:foo@1", "bar@3"));
    assert!(same("plugin@NPM:other@1", "other@2"));
    assert!(same("plugin@NPM:other@1", "plugin"));
    assert!(same("gist:alice/123456", "gist:123456"));
    assert!(same("gist:alice/123456", "https://gist.github.com/alice/123456"));
    assert!(same("pkg@garbage ||", "pkg@1.0.0"));
    assert!(same("pkg@>=1.0.0 garbage", "pkg@1.0.0"));
    assert_eq!(registry_package_name("plugin@NPM:other@1").as_deref(), Some("other"));
    assert_eq!(plugin_package_identities("plugin.tgz"), Vec::<String>::new());
    assert_eq!(plugin_package_identities("pkg@1.2.3+%"), Vec::<String>::new());
    assert_eq!(plugin_package_identities("github:org/repo#main::other"), Vec::<String>::new());
    assert!(same("github:user/repo", "git+https://github.com/user/repo.git#v2"));
    assert!(same("user/repo#main", "git+ssh://git@github.com/user/repo.git"));
    assert!(same("git+https://example.com/a/b.git", "git+ssh://git@example.com:2222/a/b.git#v1"));
    assert!(same("git+https://Example.com/a/b", "git+ssh://git@example.com:a/b.git"));
    assert!(!same("git+https://example.com/a/b.git", "git+https://example.com/a/c.git"));
    assert!(!same("foo", "foobar"));
    assert!(!same("@a/foo", "@b/foo"));
    assert!(plugin_package_identities("./local").is_empty());

    let rev = "a".repeat(40);
    assert_eq!(git_plugin_revision("github:user/repo", Some(&rev)), Some(rev.as_str()));
    assert_eq!(git_plugin_revision("foo@1.2.3", Some(&rev)), None);
    assert_eq!(git_plugin_revision("github:user/repo", Some("1.2.3")), None);
}

#[test]
fn activation_order_matches_opencode_semantics() {
    assert!(matches_selector("*", "acme.demo"));
    assert!(matches_selector("acme.*", "acme.demo"));
    assert!(!matches_selector("acme.*", "acme"));
    assert!(matches_selector("acme.demo", "acme.demo"));

    let seq = AppliedSequence {
        start_ids: HashSet::from(["builtin.one".to_owned()]),
        entries: vec![
            AppliedEntry { document: 0, entry_index: 0, remove: true, target: "pkg.id".into(), plugin_id: None },
            AppliedEntry {
                document: 0,
                entry_index: 1,
                remove: false,
                target: "pkg@1".into(),
                plugin_id: Some("pkg.id".into()),
            },
            AppliedEntry { document: 1, entry_index: 0, remove: true, target: "pkg.*".into(), plugin_id: None },
            AppliedEntry { document: 1, entry_index: 1, remove: false, target: "pkg.id".into(), plugin_id: None },
        ],
    };
    assert!(!defined_before(&seq, "pkg.id", 0, 0, None));
    assert!(defined_before(&seq, "pkg.id", 1, 1, None));
    assert!(!defined_before(&seq, "pkg.id", 1, 1, Some((0, 1))));
    assert!(defined_before(&seq, "opencode.builtin", 0, 0, None));
    assert!(enabled_through(&seq, "pkg.id", 0));
    assert!(enabled_through(&seq, "pkg.id", 1));
    assert!(enabled_through(&seq, "builtin.one", 1));
}

#[test]
fn jsonc_plugin_edits_preserve_comments_bom_crlf_and_compact_arrays() {
    // 1. Append preserves CRLF, BOM, and comments.
    let text = "{\r\n  // keep\r\n  \"plugins\": [\r\n    \"-first\",\r\n    { \"package\": \"obj\", \"options\": { \"a\": 1 } }\r\n  ]\r\n}\r\n";
    let updated = append_plugin_control_rule(&doc_for(text, true), "@scope/new@1").unwrap();
    let out_str = jsonc::string(&updated);
    assert!(out_str.starts_with('\u{feff}'));
    assert!(out_str.contains("// keep"));
    assert!(!out_str.replace("\r\n", "").contains('\n'), "only CRLF expected: {out_str:?}");
    assert_eq!(
        parse_text(&updated)["plugins"],
        json!(["-first", { "package": "obj", "options": { "a": 1 } }, "@scope/new@1"])
    );

    // 2. Append after inline comment inserts comma before comment.
    let inline = "{\n  \"plugins\": [\n    \"a\" // note\n  ]\n}\n";
    let appended = append_plugin_control_rule(&doc_for(inline, false), "b").unwrap();
    let appended_str = jsonc::string(&appended);
    assert!(appended_str.contains("\"a\", // note"), "got: {appended_str}");
    assert_eq!(parse_text(&appended)["plugins"], json!(["a", "b"]));

    // 3. Remove object entry and rules in compact & multiline arrays.
    let compact = "{\"plugins\":[\"keep\",\"p@1\",\"-p.id\",\"p.id\"],\"shell\":\"keep\"}";
    let removed = remove_plugin_source_entry(&doc_for(compact, false), 1, "p@1", &[2, 3], &["p.id", "-p.id"]).unwrap();
    assert_eq!(parse_text(&removed), json!({ "plugins": ["keep"], "shell": "keep" }));

    let solo = "{ \"plugins\": [\"solo\"] }";
    let solo_removed = remove_plugin_source_entry(&doc_for(solo, false), 0, "solo", &[], &[]).unwrap();
    assert_eq!(parse_text(&solo_removed), json!({ "plugins": [] }));

    let with_comment =
        "{\n  \"plugins\": [\n    \"-p.id\", // why\n    \"p@1\",\n    \"keep\",\n    \"p.id\"\n  ]\n}\n";
    let kept =
        remove_plugin_source_entry(&doc_for(with_comment, false), 1, "p@1", &[0, 3], &["p.id", "-p.id"]).unwrap();
    assert_eq!(parse_text(&kept), json!({ "plugins": ["keep"] }));
    assert!(jsonc::string(&kept).contains("// why"));

    // 4. Replace rules atomically.
    let repl = replace_plugin_control_rules(
        &doc_for("{\n  \"plugins\": [\n    \"-a\",\n    \"b\"\n  ]\n}\n", false),
        &[0],
        &["a", "-a"],
        Some("a"),
    )
    .unwrap();
    assert_eq!(parse_text(&repl), json!({ "plugins": ["b", "a"] }));

    // 5. Stale index / changed entry refused as conflict.
    let base = doc_for("{ \"plugins\": [\"a\", \"b\"] }", false);
    assert!(matches!(
        remove_plugin_source_entry(&base, 1, "a", &[], &[]),
        Err(crate::subagent_depth::document::DocError::Conflict(_))
    ));
    assert!(matches!(
        remove_plugin_source_entry(&base, 0, "a", &[0], &["a"]),
        Err(crate::subagent_depth::document::DocError::Conflict(_))
    ));

    // 6. Compact empty array expands via jsonc::modify just like TS `jsonc-parser.modify`.
    let expanded = append_plugin_control_rule(&doc_for("{\"plugins\":[]}", false), "a").unwrap();
    assert_eq!(jsonc::string(&expanded), "{\n  \"plugins\": [\n    \"a\"\n  ]\n}\n");

    // 7. Deeply nested JSONC fails cleanly without stack overflow.
    let deep = format!("{}{}", "[".repeat(1200), "]".repeat(1200));
    let tree = jsonc::parse_tree(&jsonc::utf16(&deep), true);
    assert!(tree.errors > 0);
}

#[test]
fn utf8_prefix_file_url_and_prepared_lock_reverify_guards() {
    // Non-ASCII 5-byte boundary (`abcdé` has byte 5 inside `é`) must never panic.
    assert!(managed_desktop_plugin_for_source(&[], "abcdé", Style::Posix).is_none());

    // Node `fileURLToPath` refuses encoded path separators (`%2F`, and `%5C` on Win32) and malformed `%`.
    assert!(file_url_to_path("file:///tmp/a%2Fb", Style::Posix).is_none());
    assert!(file_url_to_path("file:///tmp/a%2fb", Style::Posix).is_none());
    assert!(file_url_to_path("file:///tmp/a%zzb", Style::Posix).is_none());
    assert!(file_url_to_path("file:///tmp/a%2", Style::Posix).is_none());
    assert_eq!(file_url_to_path("file:///tmp/a%20b", Style::Posix).as_deref(), Some("/tmp/a b"));
    assert!(file_url_to_path("file:///C:/a%5Cb", Style::Win32).is_none());

    // Partial catalog entries (e.g. incomplete `host`) and U+2028 in `displayName` are refused;
    // float `schemaVersion: 1.0` is accepted just like JS `z.literal(1)`.
    assert!(
        super::catalog::parse_catalog_value(&json!({
            "schemaVersion": 1,
            "integrations": [{
                "id": "blender",
                "family": "native",
                "package": "@neuralnomads/opencode-blender",
                "plugin": "neuralnomads.blender",
                "rpc": "neuralnomads.blender",
                "host": { "app": "blender" }
            }]
        }))
        .is_none()
    );
    assert!(super::catalog::parse_catalog_value(&json!({ "schemaVersion": 1.0, "integrations": [] })).is_some());
    assert!(
        super::catalog::parse_catalog_value(&json!({
            "schemaVersion": 1,
            "integrations": [{
                "id": "mail",
                "package": "@neuralnomads/opencode-mail",
                "range": "^0.1.0",
                "displayName": "OpenCode for Mail\u{2028}Next",
                "family": "api",
                "plugin": "neuralnomads.mail",
                "rpc": "neuralnomads.mail",
                "summary": { "en": "Mail integration" },
                "app": { "name": "Mail" },
                "docs": "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/mail",
                "status": "preview"
            }]
        }))
        .is_none()
    );
    assert!(
        super::catalog::parse_catalog_value(&json!({
            "schemaVersion": 1,
            "integrations": [{
                "id": "mail",
                "package": "@neuralnomads/opencode-mail",
                "range": "^0.1.0",
                "displayName": "OpenCode for \u{feff}Mail",
                "family": "api",
                "plugin": "neuralnomads.mail",
                "rpc": "neuralnomads.mail",
                "summary": { "en": "Mail integration" },
                "app": { "name": "Mail" },
                "docs": "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/mail",
                "status": "preview"
            }]
        }))
        .is_none()
    );

    // `Prepared::commit_in_place` re-verifies after `before_commit` and keeps its lock until Drop.
    let dir = std::env::temp_dir().join(format!("cn-prep-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("opencode.jsonc");
    std::fs::write(&file, "{}\n").unwrap();
    let doc = crate::subagent_depth::fs::load(file.to_str().unwrap()).unwrap();
    let mut prep = crate::subagent_depth::fs::prepare(&doc, &jsonc::utf16("{\"plugins\":[\"a\"]}\n")).unwrap();
    let lock_path = format!("{}.codenomad-plugin-controls.lock", doc.write);
    assert!(std::path::Path::new(&lock_path).exists());
    // Mutating the file during `before_commit` must be caught by the post-guard `verify()`.
    let conflict = prep.commit_in_place(
        |e| e,
        || {
            std::fs::write(&file, "{\"changed\":true}\n").unwrap();
            Ok(())
        },
        || Ok(()),
    );
    assert!(matches!(conflict, Err(crate::subagent_depth::document::DocError::Conflict(_))));
    assert!(std::path::Path::new(&lock_path).exists(), "lock stays held until Prepared drops");
    drop(prep);
    assert!(!std::path::Path::new(&lock_path).exists(), "lock released on Drop");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn discovery_entrypoint_selection_handles_server_before_index_and_ambiguity() {
    let dir = std::env::temp_dir().join(format!("cn-plugin-disc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    // Empty dir -> provably skipped (Some(None)).
    assert_eq!(selected_entrypoint(&dir), Some(None));
    assert_eq!(declared_entrypoint_of(&dir), Some(None));

    // Only index.ts -> selects index.ts.
    let index_ts = dir.join("index.ts");
    std::fs::write(&index_ts, "").unwrap();
    assert_eq!(selected_entrypoint(&dir), Some(Some(index_ts.clone())));

    // Adding server.js -> server takes precedence over index.
    let server_js = dir.join("server.js");
    std::fs::write(&server_js, "").unwrap();
    assert_eq!(selected_entrypoint(&dir), Some(Some(server_js.clone())));

    // Adding server.ts alongside server.js -> ambiguous (None).
    let server_ts = dir.join("server.ts");
    std::fs::write(&server_ts, "").unwrap();
    assert_eq!(selected_entrypoint(&dir), None);

    // Direct .ts file child vs .md file child.
    assert_eq!(discovery_entrypoint_of(&server_ts), Some(Some(server_ts.clone())));
    let readme = dir.join("readme.md");
    std::fs::write(&readme, "").unwrap();
    assert_eq!(discovery_entrypoint_of(&readme), Some(None));

    // Shape & escapes checks.
    assert!(discovery_entrypoint_shape(Style::Posix, "/g/plugins/a.ts", "/g/plugins/a.ts"));
    assert!(discovery_entrypoint_shape(Style::Posix, "/g/plugins/dir", "/g/plugins/dir/server.mjs"));
    assert!(!discovery_entrypoint_shape(Style::Posix, "/g/plugins/dir", "/g/plugins/dir/sub/server.mjs"));
    assert!(escapes(Style::Posix, "../outside"));

    let _ = std::fs::remove_dir_all(&dir);
}
