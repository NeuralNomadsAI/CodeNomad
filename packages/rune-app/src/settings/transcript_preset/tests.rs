use super::*;

#[test]
fn presets_resolve_like_solid_including_the_effective_custom_label() {
    assert_eq!(selected(&json!({})), "balanced");
    for preset in PRESETS {
        let mut data = patch(preset);
        assert!(confirmed(preset, &data));
        assert_eq!(selected(&data), preset);
        for row in Row::all() {
            assert_eq!(row.preset_mode(preset), row.mode(&data));
        }
        data["showUsageMetrics"] = json!(preset != "everything");
        assert_eq!(selected(&data), "custom");
        assert!(!confirmed(preset, &data));
    }
    let balanced = patch("balanced");
    assert_eq!(Row::tool("shell").mode(&balanced), "expanded");
    assert_eq!(Row::tool("subagent").mode(&balanced), "expanded");
    assert_eq!(Row::tool("read").mode(&balanced), "collapsed");
    assert_eq!(Row::tool("apply_patch").mode(&balanced), "collapsed");
    assert_eq!(Row::tool("todowrite").mode(&balanced), "collapsed");
    assert_eq!(
        selected(&json!({
            "toolCallExpansionDefaults":{"preset":"balanced","thinking":"expanded"}
        })),
        "balanced",
        "hidden thinking ignores the remembered expansion"
    );
}

#[test]
fn manual_tool_changes_emit_minimal_merge_patches() {
    let saved =
        json!({"toolCallExpansionDefaults":{"preset":"everything", "tools":{"read":"hidden"}}});
    let mut changes = json!({});
    Row::Tool("task").put(&mut changes, &saved, "collapsed", true);
    Row::Tool("execute").put(&mut changes, &saved, "hidden", true);
    assert_eq!(
        changes,
        json!({
            "toolCallExpansionDefaults": {
                "preset": "custom",
                "tools": { "task": "collapsed", "execute": "hidden" }
            }
        })
    );
    assert!(changes.get("showThinkingBlocks").is_none());
    assert!(changes.get("thinkingBlocksExpansion").is_none());
    assert!(changes.get("toolOutputExpansion").is_none());
    assert!(changes.get("toolGroupVisibility").is_none());
    assert!(changes.get("usageMetricsExpansion").is_none());

    let populated = patch("nothing");
    let mut read_only = json!({});
    Row::Tool("read").put(&mut read_only, &populated, "expanded", true);
    assert_eq!(
        read_only,
        json!({"toolCallExpansionDefaults":{"preset":"custom","tools":{"read":"expanded"}}})
    );

    // Editing "other" to a visible mode updates toolOutputExpansion as in Solid.
    let mut other_edit = json!({});
    Row::Tool("other").put(&mut other_edit, &populated, "expanded", true);
    assert_eq!(
        other_edit,
        json!({
            "toolCallExpansionDefaults":{"preset":"custom","tools":{"other":"expanded"}},
            "toolOutputExpansion":"expanded"
        })
    );

    // Against an older apiContract:1 server without settings-atomic-patches (atomic == false),
    // switching from implicit balanced to custom materializes all omitted tool defaults so
    // collapsed/hidden tools never flip to expanded.
    let implicit_balanced = json!({"toolCallExpansionDefaults":{"preset":"balanced"}});
    let mut legacy_read = json!({});
    Row::Tool("read").put(&mut legacy_read, &implicit_balanced, "expanded", false);
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["preset"],
        json!("custom")
    );
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["read"],
        json!("expanded")
    );
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["skill"],
        json!("collapsed")
    );
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["bash"],
        json!("expanded")
    );
    assert_eq!(legacy_read["usageMetricsExpansion"], json!("collapsed"));
}

#[test]
fn retired_detailed_thinking_order_usage_hide_and_strict_confirmation_match_solid() {
    let retired = json!({
        "showUsageMetrics": true,
        "toolCallExpansionDefaults": {
            "preset": "detailed",
            "tools": { "bash": "hidden" }
        }
    });
    assert_eq!(selected(&retired), "custom");
    assert_eq!(Row::Usage.mode(&retired), "expanded");
    assert_eq!(Row::Groups.mode(&retired), "collapsed");
    assert_eq!(Row::Tool("bash").mode(&retired), "hidden");
    assert_eq!(Row::Tool("read").mode(&retired), "collapsed");
    assert_eq!(Row::Tool("skill").mode(&retired), "collapsed");
    assert_eq!(Row::Tool("invalid").mode(&retired), "collapsed");
    assert_eq!(Row::Tool("write").mode(&retired), "expanded");
    assert_eq!(Row::Tool("other").mode(&retired), "expanded");

    // Mutating a detailed profile on a non-atomic server materializes inherited defaults so
    // read/skill/invalid stay collapsed and other unconfigured tools stay expanded.
    let pure_detailed = json!({
        "toolCallExpansionDefaults": { "preset": "detailed" }
    });
    assert!(Row::Tool("write").needs_fresh_snapshot("hidden"));
    assert!(Row::Tool("read").needs_fresh_snapshot("expanded"));
    assert!(Row::Usage.needs_fresh_snapshot("hidden"));
    assert!(!Row::Usage.needs_fresh_snapshot("expanded"));
    let mut legacy_write = json!({});
    Row::Tool("write").put(&mut legacy_write, &pure_detailed, "hidden", false);
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["preset"],
        "custom"
    );
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["tools"]["write"],
        "hidden"
    );
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["tools"]["read"],
        "collapsed"
    );
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["tools"]["skill"],
        "collapsed"
    );
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["tools"]["invalid"],
        "collapsed"
    );
    assert_eq!(
        legacy_write["toolCallExpansionDefaults"]["tools"]["bash"],
        "expanded"
    );
    let mut legacy_read = json!({});
    Row::Tool("read").put(&mut legacy_read, &pure_detailed, "expanded", false);
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["read"],
        "expanded"
    );
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["skill"],
        "collapsed"
    );
    assert_eq!(
        legacy_read["toolCallExpansionDefaults"]["tools"]["invalid"],
        "collapsed"
    );

    // Thinking fallback follows Solid (defaults.thinking -> thinkingBlocksExpansion -> collapsed).
    let everything_collapsed_thinking = json!({
        "showThinkingBlocks": true,
        "thinkingBlocksExpansion": "collapsed",
        "toolCallExpansionDefaults": { "preset": "everything" }
    });
    assert_eq!(
        Row::Thinking.mode(&everything_collapsed_thinking),
        "collapsed"
    );
    let balanced_expanded_thinking = json!({
        "showThinkingBlocks": true,
        "thinkingBlocksExpansion": "expanded",
        "toolCallExpansionDefaults": { "preset": "balanced" }
    });
    assert_eq!(Row::Thinking.mode(&balanced_expanded_thinking), "expanded");

    // Hiding Tokens sends only showUsageMetrics:false on atomic servers so concurrent
    // usageMetricsExpansion survives; legacy servers freeze the pre-hide expansion.
    let mut hidden_usage = json!({});
    Row::Usage.put(&mut hidden_usage, &retired, "hidden", true);
    assert_eq!(hidden_usage, json!({"showUsageMetrics": false}));
    let mut legacy_hidden_usage = json!({});
    Row::Usage.put(&mut legacy_hidden_usage, &retired, "hidden", false);
    assert_eq!(
        legacy_hidden_usage,
        json!({"showUsageMetrics": false, "usageMetricsExpansion": "expanded"})
    );

    let everything = patch("everything");
    let mut hidden_thinking = json!({});
    Row::Thinking.put(&mut hidden_thinking, &everything, "hidden", true);
    assert_eq!(
        hidden_thinking,
        json!({
            "showThinkingBlocks": false,
            "toolCallExpansionDefaults": { "preset": "custom" }
        })
    );

    let mut collapsed_thinking = json!({});
    Row::Thinking.put(&mut collapsed_thinking, &everything, "collapsed", true);
    assert_eq!(
        collapsed_thinking,
        json!({
            "showThinkingBlocks": true,
            "thinkingBlocksExpansion": "collapsed",
            "toolCallExpansionDefaults": { "preset": "custom", "thinking": "collapsed" }
        })
    );

    // Strict confirmation rejects malformed settings, dropped writes, and partial 200 responses.
    assert!(!Row::Diagnostics.confirmed("expanded", &json!(false)));
    assert!(!Row::Diagnostics.confirmed("expanded", &json!({})));
    assert!(Row::Diagnostics.confirmed("expanded", &json!({"diagnosticsExpansion": "expanded"})));
    assert!(!Row::Usage.confirmed("hidden", &json!({})));
    assert!(Row::Usage.confirmed("hidden", &json!({"showUsageMetrics": false})));
    assert!(!Row::Tool("read").confirmed("collapsed", &json!({})));
    assert!(!Row::Tool("read").confirmed(
        "collapsed",
        &json!({"toolCallExpansionDefaults": {"preset": "everything", "tools": {"read": "collapsed"}}})
    ));
    assert!(Row::Tool("read").confirmed(
        "collapsed",
        &json!({"toolCallExpansionDefaults": {"preset": "custom", "tools": {"read": "collapsed"}}})
    ));
    assert!(!Row::Tool("other").confirmed(
        "expanded",
        &json!({"toolCallExpansionDefaults": {"preset": "custom", "tools": {"other": "expanded"}}})
    ));
    assert!(Row::Tool("other").confirmed(
        "expanded",
        &json!({"toolOutputExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "tools": {"other": "expanded"}}})
    ));
    assert!(!Row::Thinking.confirmed(
        "expanded",
        &json!({"showThinkingBlocks": true, "toolCallExpansionDefaults": {"preset": "custom", "thinking": "expanded"}})
    ));
    assert!(Row::Thinking.confirmed(
        "expanded",
        &json!({"showThinkingBlocks": true, "thinkingBlocksExpansion": "expanded", "toolCallExpansionDefaults": {"preset": "custom", "thinking": "expanded"}})
    ));
}
