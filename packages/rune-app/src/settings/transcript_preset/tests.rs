use super::*;

#[test]
fn presets_resolve_like_solid_including_the_effective_custom_label() {
    assert_eq!(selected(&json!({})), "balanced");
    for preset in PRESETS {
        let mut data = patch(preset);
        assert!(confirmed(preset, &data));
        assert_eq!(selected(&data), preset);
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
fn manual_tool_changes_preserve_other_effective_values() {
    let saved =
        json!({"toolCallExpansionDefaults":{"preset":"everything", "tools":{"read":"hidden"}}});
    let mut changes = json!({});
    Row::Tool("task").put(&mut changes, &saved, "collapsed");
    Row::Tool("execute").put(&mut changes, &saved, "hidden");
    assert_eq!(selected(&changes), "custom");
    assert_eq!(Row::tool("subagent").mode(&changes), "collapsed");
    assert_eq!(Row::tool("execute").mode(&changes), "hidden");
    assert_eq!(Row::tool("read").mode(&changes), "hidden");
    assert_eq!(Row::tool("shell").mode(&changes), "expanded");
    assert_eq!(Row::Groups.mode(&changes), "expanded");
    assert_eq!(changes["usageMetricsExpansion"], "expanded");
}
