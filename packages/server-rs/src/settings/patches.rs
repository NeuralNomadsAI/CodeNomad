use serde_json::{Value, json};

use super::{Failure, document::Doc};

const CONFIGURABLE_TOOLS: [&str; 15] = [
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "webfetch",
    "websearch",
    "glob",
    "grep",
    "task",
    "execute",
    "skill",
    "question",
    "invalid",
    "other",
];

fn tool_default_for_preset(
    preset: Option<&str>,
    tool: &str,
    base_tools: Option<&serde_json::Map<String, Value>>,
    base_tool_output: Option<&str>,
) -> &'static str {
    let other = base_tools.and_then(|t| t.get("other")).and_then(Value::as_str).and_then(|v| match v {
        "hidden" => Some("hidden"),
        "collapsed" => Some("collapsed"),
        "expanded" => Some("expanded"),
        _ => None,
    });
    match preset {
        Some("nothing") => "hidden",
        Some("everything") => "expanded",
        Some("minimal") => "collapsed",
        Some("detailed") => {
            if matches!(tool, "read" | "skill" | "invalid") {
                "collapsed"
            } else {
                other.unwrap_or("expanded")
            }
        }
        Some("custom") => other.unwrap_or_else(|| match base_tool_output {
            Some("collapsed") => "collapsed",
            _ => "expanded",
        }),
        _ => {
            if matches!(tool, "bash" | "write" | "edit" | "patch" | "task" | "execute" | "question") {
                "expanded"
            } else {
                "collapsed"
            }
        }
    }
}

fn transcript_preset_fallbacks(preset: Option<&str>) -> (&'static str, &'static str) {
    let groups = if preset == Some("everything") { "expanded" } else { "collapsed" };
    let usage = if matches!(preset, Some("everything" | "custom" | "detailed")) { "expanded" } else { "collapsed" };
    (groups, usage)
}

fn strip_null_entries_for_new_objects(base: Option<&Doc>, patch: &mut Doc) -> bool {
    let mut changed = false;
    if base.is_none() {
        let before = patch.len();
        patch.retain(|_, value| !value.is_null());
        changed |= patch.len() != before;
    }
    for (key, value) in patch.iter_mut() {
        if let Some(child) = value.as_object_mut() {
            let child_base = base.and_then(|map| map.get(key)).and_then(Value::as_object);
            changed |= strip_null_entries_for_new_objects(child_base, child);
        }
    }
    changed
}

const NOTIFICATION_CATEGORIES: [&str; 9] =
    ["needsInput", "sessionDone", "updates", "files", "projects", "sessions", "opencode", "copy", "settings"];
const NOTIFICATION_DESTINATIONS: [&str; 3] = ["screen", "history", "system"];

fn seed_notification_routing(base: Option<&Doc>, patch_routing: &Doc) -> Doc {
    let os_enabled = base.and_then(|s| s.get("osNotificationsEnabled")) != Some(&json!(false));
    let notify_input = base.and_then(|s| s.get("notifyOnNeedsInput")) != Some(&json!(false));
    let notify_idle = base.and_then(|s| s.get("notifyOnIdle")) != Some(&json!(false));
    let mut seeded = Doc::new();
    for category in NOTIFICATION_CATEGORIES {
        if patch_routing.get(category) == Some(&Value::Null) {
            continue;
        }
        let mut row = patch_routing.get(category).and_then(Value::as_object).cloned().unwrap_or_default();
        let screen = !matches!(category, "needsInput" | "sessionDone");
        let history = matches!(category, "updates" | "files" | "projects" | "opencode");
        let system = matches!(category, "needsInput" | "sessionDone" | "updates")
            && os_enabled
            && match category {
                "needsInput" => notify_input,
                "sessionDone" => notify_idle,
                _ => true,
            };
        for (dest, default) in NOTIFICATION_DESTINATIONS.into_iter().zip([screen, history, system]) {
            row.entry(dest.to_owned()).or_insert_with(|| json!(default));
        }
        seeded.insert(category.into(), Value::Object(row));
    }
    for (key, value) in patch_routing {
        seeded.entry(key.clone()).or_insert_with(|| value.clone());
    }
    seeded
}

pub(super) fn strip_new_object_nulls<'a>(before: Option<&Value>, patch: &'a Value) -> std::borrow::Cow<'a, Value> {
    let Some(changes) = patch.as_object() else {
        return std::borrow::Cow::Borrowed(patch);
    };
    let mut next = changes.clone();
    if strip_null_entries_for_new_objects(before.and_then(Value::as_object), &mut next) {
        std::borrow::Cow::Owned(Value::Object(next))
    } else {
        std::borrow::Cow::Borrowed(patch)
    }
}

pub(super) fn apply_secure_env_vars_mask<'a>(
    before: Option<&Value>,
    patch: &'a Value,
) -> Result<std::borrow::Cow<'a, Value>, Failure> {
    let Some(changes) = patch.as_object() else {
        return Ok(std::borrow::Cow::Borrowed(patch));
    };
    let before_obj = before.and_then(Value::as_object);
    let mut next = changes.clone();
    let mut modified = false;
    if let Some(mask_value) = changes.get("secureEnvVarsMask") {
        let Some(mask) = mask_value.as_object() else {
            return Err(Failure::Invalid("Invalid secureEnvVarsMask".into()));
        };
        if mask.values().any(|value| !value.is_boolean()) {
            return Err(Failure::Invalid("Invalid secureEnvVarsMask".into()));
        }
        next.remove("secureEnvVarsMask");
        modified = true;
        let mut surviving_env_keys: std::collections::HashSet<String> = before_obj
            .and_then(|s| s.get("environmentVariables"))
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, _)| k.clone())
            .collect();
        let mut deleted_env_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Some(env_patch) = changes.get("environmentVariables") {
            if env_patch.is_null() {
                deleted_env_keys.extend(surviving_env_keys.drain());
            } else if let Some(env_obj) = env_patch.as_object() {
                for (k, v) in env_obj {
                    if v.is_null() {
                        surviving_env_keys.remove(k);
                        deleted_env_keys.insert(k.clone());
                    } else {
                        surviving_env_keys.insert(k.clone());
                    }
                }
            }
        }
        let env_key_eq = |a: &str, b: &str| {
            if a.is_ascii() && b.is_ascii() { a.eq_ignore_ascii_case(b) } else { a.to_uppercase() == b.to_uppercase() }
        };
        let has_case_sibling = |name: &str| surviving_env_keys.iter().any(|k| k != name && env_key_eq(k, name));
        let mut masked: Vec<String> = if changes.get("secureEnvVars").is_some_and(Value::is_null) {
            Vec::new()
        } else {
            let source = changes
                .get("secureEnvVars")
                .and_then(Value::as_array)
                .or_else(|| before.and_then(|s| s.get("secureEnvVars")).and_then(Value::as_array));
            source.into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
        };
        let mut entries: Vec<(&String, bool)> =
            mask.iter().filter_map(|(name, value)| value.as_bool().map(|want| (name, want))).collect();
        entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        for (name, want_masked) in &entries {
            if !*want_masked {
                // Deleting one POSIX case-variant must not unmask a surviving sibling with another casing.
                if deleted_env_keys.contains(*name) && has_case_sibling(name) {
                    continue;
                }
                masked.retain(|existing| !env_key_eq(existing, name));
            }
        }
        for (name, want_masked) in &entries {
            if *want_masked {
                masked.retain(|existing| !env_key_eq(existing, name));
                masked.push((*name).clone());
            }
        }
        next.insert("secureEnvVars".into(), json!(masked));
    }
    let stripped = strip_null_entries_for_new_objects(before_obj, &mut next);
    if !modified && !stripped {
        return Ok(std::borrow::Cow::Borrowed(patch));
    }
    Ok(std::borrow::Cow::Owned(Value::Object(next)))
}

/// `preserveLegacyTranscriptDefaults` (`packages/server/src/settings/transcript-preset-defaults.ts`).
pub(super) fn preserve_legacy_transcript_defaults<'a>(
    before: Option<&Value>,
    patch: &'a Value,
) -> std::borrow::Cow<'a, Value> {
    let Some(patch_obj) = patch.as_object() else {
        return std::borrow::Cow::Borrowed(patch);
    };
    let before_obj = before.and_then(Value::as_object);
    let Some(changes) = patch_obj.get("settings").and_then(Value::as_object) else {
        let mut next = patch_obj.clone();
        return if strip_null_entries_for_new_objects(before_obj, &mut next) {
            std::borrow::Cow::Owned(Value::Object(next))
        } else {
            std::borrow::Cow::Borrowed(patch)
        };
    };
    let base = before_obj.and_then(|owner| owner.get("settings")).and_then(Value::as_object);
    let base_defaults = base.and_then(|s| s.get("toolCallExpansionDefaults")).and_then(Value::as_object);
    let base_tools = base_defaults.and_then(|d| d.get("tools")).and_then(Value::as_object);
    let preset = base_defaults.and_then(|d| d.get("preset")).and_then(Value::as_str);
    let (inherited_groups, inherited_usage) = transcript_preset_fallbacks(preset);
    let (custom_groups, custom_usage) = transcript_preset_fallbacks(Some("custom"));
    let mut next_settings = changes.clone();
    let mut modified = false;

    if changes.get("showUsageMetrics").and_then(Value::as_bool) == Some(false)
        && !changes.contains_key("usageMetricsExpansion")
        && !matches!(
            base.and_then(|s| s.get("usageMetricsExpansion")).and_then(Value::as_str),
            Some("collapsed" | "expanded")
        )
    {
        next_settings.insert("usageMetricsExpansion".into(), json!(inherited_usage));
        modified = true;
    }

    if let Some(patch_defaults) = changes.get("toolCallExpansionDefaults").and_then(Value::as_object) {
        let mut next_defaults = patch_defaults.clone();
        let mut defaults_modified = false;
        if patch_defaults.get("preset").and_then(Value::as_str) == Some("custom") {
            for (key, inherited, custom, allow_hidden) in [
                ("toolGroupVisibility", inherited_groups, custom_groups, true),
                ("usageMetricsExpansion", inherited_usage, custom_usage, false),
            ] {
                if inherited == custom || changes.contains_key(key) || next_settings.contains_key(key) {
                    continue;
                }
                let saved = base.and_then(|s| s.get(key)).and_then(Value::as_str);
                if matches!(saved, Some("collapsed" | "expanded")) || (allow_hidden && saved == Some("hidden")) {
                    continue;
                }
                next_settings.insert(key.into(), json!(inherited));
                modified = true;
            }
            let explicit_non_object_tools = patch_defaults.get("tools").is_some_and(|v| !v.is_object());
            let touches_custom = patch_defaults.get("tools").is_some_and(Value::is_object)
                || changes.contains_key("showThinkingBlocks")
                || changes.contains_key("thinkingBlocksExpansion")
                || patch_defaults.contains_key("thinking");
            if touches_custom {
                let base_thinking = base_defaults.and_then(|d| d.get("thinking")).and_then(Value::as_str);
                if !patch_defaults.contains_key("thinking") && !matches!(base_thinking, Some("collapsed" | "expanded"))
                {
                    let source = if changes.contains_key("thinkingBlocksExpansion") {
                        changes.get("thinkingBlocksExpansion")
                    } else {
                        base.and_then(|s| s.get("thinkingBlocksExpansion"))
                    };
                    let legacy = source
                        .and_then(Value::as_str)
                        .filter(|v| matches!(*v, "collapsed" | "expanded"))
                        .unwrap_or("collapsed");
                    next_defaults.insert("thinking".into(), json!(legacy));
                    defaults_modified = true;
                }
            }
            let patch_tools = patch_defaults.get("tools").and_then(Value::as_object);
            let base_tool_output = base.and_then(|s| s.get("toolOutputExpansion")).and_then(Value::as_str);
            let next_other = if let Some(value) = patch_tools.and_then(|t| t.get("other")) {
                value.as_str().filter(|v| matches!(*v, "hidden" | "collapsed" | "expanded"))
            } else {
                base_tools
                    .and_then(|t| t.get("other"))
                    .and_then(Value::as_str)
                    .filter(|v| matches!(*v, "hidden" | "collapsed" | "expanded"))
            };
            let next_tool_output = if let Some(value) = changes.get("toolOutputExpansion") {
                value.as_str().filter(|v| matches!(*v, "collapsed" | "expanded"))
            } else {
                base_tool_output.filter(|v| matches!(*v, "collapsed" | "expanded"))
            };
            let custom_tool_fallback = next_other.or(next_tool_output).unwrap_or("expanded");
            let changes_any_tool = CONFIGURABLE_TOOLS.iter().any(|&tool| {
                let in_patch = patch_tools.is_some_and(|t| t.contains_key(tool));
                let in_base = base_tools
                    .and_then(|t| t.get(tool))
                    .and_then(Value::as_str)
                    .is_some_and(|v| matches!(v, "hidden" | "collapsed" | "expanded"));
                !in_patch
                    && !in_base
                    && tool_default_for_preset(preset, tool, base_tools, base_tool_output) != custom_tool_fallback
            });
            let should_materialize =
                !explicit_non_object_tools && ((preset != Some("custom") && touches_custom) || changes_any_tool);
            if should_materialize {
                let mut next_tools = patch_tools.cloned().unwrap_or_default();
                let mut added_tool = false;
                for tool in CONFIGURABLE_TOOLS {
                    let in_patch = patch_tools.is_some_and(|t| t.contains_key(tool));
                    let in_base = base_tools
                        .and_then(|t| t.get(tool))
                        .and_then(Value::as_str)
                        .is_some_and(|v| matches!(v, "hidden" | "collapsed" | "expanded"));
                    if in_patch || in_base {
                        continue;
                    }
                    next_tools.insert(
                        tool.into(),
                        json!(tool_default_for_preset(preset, tool, base_tools, base_tool_output)),
                    );
                    added_tool = true;
                }
                if added_tool {
                    next_defaults.insert("tools".into(), Value::Object(next_tools));
                    defaults_modified = true;
                }
            }
        }
        if defaults_modified {
            next_settings.insert("toolCallExpansionDefaults".into(), Value::Object(next_defaults));
            modified = true;
        }
    }
    if let Some(patch_routing) = changes.get("notificationRouting").and_then(Value::as_object)
        && base.and_then(|s| s.get("notificationRouting")).and_then(Value::as_object).is_none()
    {
        next_settings
            .insert("notificationRouting".into(), Value::Object(seed_notification_routing(base, patch_routing)));
        modified = true;
    }
    let mut next = patch_obj.clone();
    next.insert("settings".into(), Value::Object(next_settings));
    let stripped = strip_null_entries_for_new_objects(before_obj, &mut next);
    if !modified && !stripped {
        return std::borrow::Cow::Borrowed(patch);
    }
    std::borrow::Cow::Owned(Value::Object(next))
}
