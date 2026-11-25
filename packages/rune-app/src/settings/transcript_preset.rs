use serde_json::{Value, json};

pub(super) const PRESETS: [&str; 4] = ["nothing", "minimal", "balanced", "everything"];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) enum Row {
    Thinking,
    Diagnostics,
    Inputs,
    Usage,
    System,
    Groups,
    Tool(&'static str),
}

pub(super) const TOOLS: &[&str] = &[
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
const DETAILS: [Row; 6] = [
    Row::Thinking,
    Row::Diagnostics,
    Row::Inputs,
    Row::Usage,
    Row::System,
    Row::Groups,
];
pub(super) const ROW_COUNT: usize = DETAILS.len() + TOOLS.len();

impl Row {
    pub(super) fn control_key(self) -> &'static str {
        self.key()
    }

    pub(super) fn all() -> impl Iterator<Item = Self> {
        DETAILS
            .into_iter()
            .chain(TOOLS.iter().copied().map(Self::Tool))
    }

    fn key(self) -> &'static str {
        match self {
            Self::Thinking => "showThinkingBlocks",
            Self::Diagnostics => "diagnosticsExpansion",
            Self::Inputs => "toolInputsVisibility",
            Self::Usage => "showUsageMetrics",
            Self::System => "systemMessagesVisibility",
            Self::Groups => "toolGroupVisibility",
            Self::Tool(id) => id,
        }
    }

    pub(crate) fn tool(name: &str) -> Self {
        Self::Tool(match name {
            "shell" => "bash",
            "subagent" => "task",
            name => TOOLS
                .iter()
                .copied()
                .find(|id| *id == name)
                .unwrap_or("other"),
        })
    }

    pub(super) fn preset_mode(self, preset: &str) -> &'static str {
        match self {
            Self::Thinking | Self::Usage | Self::System => {
                if preset == "everything" {
                    "expanded"
                } else {
                    "hidden"
                }
            }
            Self::Diagnostics => match preset {
                "nothing" => "hidden",
                "minimal" => "collapsed",
                _ => "expanded",
            },
            Self::Inputs => match preset {
                "nothing" | "minimal" => "hidden",
                "balanced" => "collapsed",
                _ => "expanded",
            },
            Self::Groups => groups_default(preset),
            Self::Tool(id) => tool_default(preset, id),
        }
    }

    pub(super) fn mode(self, settings: &Value) -> &'static str {
        let preset = saved_preset(settings);
        let defaults = &settings["toolCallExpansionDefaults"];
        match self {
            Self::Thinking if settings[self.key()] == true => thinking(settings),
            Self::Usage if settings[self.key()] == true => usage_expansion(settings),
            Self::Thinking | Self::Usage => "hidden",
            Self::Tool(id) => visibility(&defaults["tools"][id])
                .or_else(|| (preset != "custom").then(|| tool_default(preset, id)))
                .or_else(|| {
                    (defaults["preset"] == "detailed" && matches!(id, "read" | "skill" | "invalid"))
                        .then_some("collapsed")
                })
                .or_else(|| visibility(&defaults["tools"]["other"]))
                .unwrap_or_else(|| {
                    if defaults["preset"] == "detailed" {
                        "expanded"
                    } else {
                        expansion(&settings["toolOutputExpansion"]).unwrap_or("expanded")
                    }
                }),
            Self::Groups => visibility(&settings[self.key()]).unwrap_or(groups_default(preset)),
            Self::Diagnostics => visibility(&settings[self.key()]).unwrap_or("expanded"),
            Self::Inputs => visibility(&settings[self.key()]).unwrap_or("collapsed"),
            Self::System => visibility(&settings[self.key()]).unwrap_or("hidden"),
        }
    }

    pub(super) fn needs_fresh_snapshot(self, mode: &str) -> bool {
        matches!(self, Self::Thinking | Self::Tool(_)) || (self == Self::Usage && mode == "hidden")
    }

    pub(super) fn put(self, patch: &mut Value, saved: &Value, mode: &'static str, atomic: bool) {
        let preset = saved_preset(saved);
        match self {
            Self::Usage => {
                // On atomic servers, hiding leaves usageMetricsExpansion untouched so concurrent
                // updates survive; legacy servers without server-side preservation need the
                // pre-hide default materialized in the PATCH.
                patch[self.key()] = json!(mode != "hidden");
                if mode != "hidden" {
                    patch["usageMetricsExpansion"] = json!(mode);
                } else if !atomic && expansion(&saved["usageMetricsExpansion"]).is_none() {
                    patch["usageMetricsExpansion"] = json!(usage_default(preset));
                }
            }
            Self::Thinking => {
                if !atomic {
                    materialize_legacy_custom_defaults(patch, saved, preset, None);
                }
                patch["showThinkingBlocks"] = json!(mode != "hidden");
                patch["toolCallExpansionDefaults"]["preset"] = json!("custom");
                if mode != "hidden" {
                    patch["toolCallExpansionDefaults"]["thinking"] = json!(mode);
                    patch["thinkingBlocksExpansion"] = json!(mode);
                }
            }
            Self::Tool(target) => {
                if !atomic {
                    materialize_legacy_custom_defaults(patch, saved, preset, Some(target));
                }
                patch["toolCallExpansionDefaults"]["preset"] = json!("custom");
                patch["toolCallExpansionDefaults"]["tools"][target] = json!(mode);
                if target == "other" && mode != "hidden" {
                    patch["toolOutputExpansion"] = json!(mode);
                }
            }
            _ => patch[self.key()] = json!(mode),
        }
    }

    pub(super) fn confirmed(self, mode: &str, settings: &Value) -> bool {
        if !settings.is_object() {
            return false;
        }
        match self {
            Self::Usage => {
                if mode == "hidden" {
                    settings["showUsageMetrics"] == false
                } else {
                    settings["showUsageMetrics"] == true
                        && expansion(&settings["usageMetricsExpansion"]) == Some(mode)
                }
            }
            Self::Thinking => {
                if settings["toolCallExpansionDefaults"]["preset"] != "custom" {
                    return false;
                }
                if mode == "hidden" {
                    settings["showThinkingBlocks"] == false
                } else {
                    settings["showThinkingBlocks"] == true
                        && expansion(&settings["toolCallExpansionDefaults"]["thinking"])
                            == Some(mode)
                        && expansion(&settings["thinkingBlocksExpansion"]) == Some(mode)
                }
            }
            Self::Tool(id) => {
                settings["toolCallExpansionDefaults"]["preset"] == "custom"
                    && visibility(&settings["toolCallExpansionDefaults"]["tools"][id]) == Some(mode)
                    && (id != "other"
                        || mode == "hidden"
                        || expansion(&settings["toolOutputExpansion"]) == Some(mode))
            }
            _ => visibility(&settings[self.key()]) == Some(mode),
        }
    }
}

fn materialize_legacy_custom_defaults(
    patch: &mut Value,
    saved: &Value,
    preset: &str,
    target_tool: Option<&str>,
) {
    let switching_to_custom = raw_preset(saved) != Some("custom");
    let hiding_other_on_custom = !switching_to_custom && target_tool == Some("other");
    if switching_to_custom {
        if visibility(&saved["toolGroupVisibility"]).is_none()
            && patch.get("toolGroupVisibility").is_none()
            && groups_default(preset) != groups_default("custom")
        {
            patch["toolGroupVisibility"] = json!(groups_default(preset));
        }
        if expansion(&saved["usageMetricsExpansion"]).is_none()
            && patch.get("usageMetricsExpansion").is_none()
            && usage_default(preset) != usage_default("custom")
        {
            patch["usageMetricsExpansion"] = json!(usage_default(preset));
        }
        if expansion(&saved["toolCallExpansionDefaults"]["thinking"]).is_none()
            && patch["toolCallExpansionDefaults"].get("thinking").is_none()
        {
            patch["toolCallExpansionDefaults"]["thinking"] = json!(thinking(saved));
        }
    }
    if switching_to_custom || hiding_other_on_custom {
        for &tool in TOOLS {
            if Some(tool) == target_tool
                || patch["toolCallExpansionDefaults"]["tools"]
                    .get(tool)
                    .is_some()
                || visibility(&saved["toolCallExpansionDefaults"]["tools"][tool]).is_some()
            {
                continue;
            }
            patch["toolCallExpansionDefaults"]["tools"][tool] = json!(Row::Tool(tool).mode(saved));
        }
    }
}

fn visibility(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "hidden" => Some("hidden"),
        "collapsed" => Some("collapsed"),
        "expanded" => Some("expanded"),
        _ => None,
    }
}

fn expansion(value: &Value) -> Option<&'static str> {
    visibility(value).filter(|mode| *mode != "hidden")
}

fn thinking(settings: &Value) -> &'static str {
    expansion(&settings["toolCallExpansionDefaults"]["thinking"])
        .or_else(|| expansion(&settings["thinkingBlocksExpansion"]))
        .unwrap_or("collapsed")
}

fn groups_default(preset: &str) -> &'static str {
    if preset == "everything" {
        "expanded"
    } else {
        "collapsed"
    }
}

pub(super) fn usage_default(preset: &str) -> &'static str {
    if matches!(preset, "everything" | "custom" | "detailed") {
        "expanded"
    } else {
        "collapsed"
    }
}

pub(super) fn usage_expansion(settings: &Value) -> &'static str {
    expansion(&settings["usageMetricsExpansion"])
        .unwrap_or_else(|| usage_default(saved_preset(settings)))
}

fn raw_preset(settings: &Value) -> Option<&str> {
    settings["toolCallExpansionDefaults"]["preset"].as_str()
}

pub(super) fn saved_preset(settings: &Value) -> &'static str {
    let name = raw_preset(settings).unwrap_or_default();
    match name {
        "custom" | "detailed" => "custom",
        _ => PRESETS
            .into_iter()
            .find(|preset| *preset == name)
            .unwrap_or("balanced"),
    }
}

fn tool_default(preset: &str, tool: &str) -> &'static str {
    match preset {
        "nothing" => "hidden",
        "everything" => "expanded",
        "balanced"
            if matches!(
                tool,
                "bash" | "write" | "edit" | "patch" | "task" | "execute" | "question"
            ) =>
        {
            "expanded"
        }
        _ => "collapsed",
    }
}

fn tools(mode: impl Fn(&'static str) -> &'static str) -> Value {
    Value::Object(
        TOOLS
            .iter()
            .map(|&id| (id.to_owned(), json!(mode(id))))
            .collect(),
    )
}

pub(super) fn patch(preset: &str) -> Value {
    let all = preset == "everything";
    let expansion = groups_default(preset);
    json!({
        "toolGroupVisibility": expansion,
        "systemMessagesVisibility": if all { "expanded" } else { "hidden" },
        "showThinkingBlocks": all,
        "diagnosticsExpansion": match preset { "nothing" => "hidden", "minimal" => "collapsed", _ => "expanded" },
        "toolInputsVisibility": match preset { "nothing" | "minimal" => "hidden", "balanced" => "collapsed", _ => "expanded" },
        "showUsageMetrics": all,
        "usageMetricsExpansion": expansion,
        "toolCallExpansionDefaults": { "preset":preset, "thinking":expansion, "tools":tools(|id| tool_default(preset, id)) },
        "thinkingBlocksExpansion": expansion,
        "toolOutputExpansion": expansion,
    })
}

pub(super) fn confirmed(preset: &str, settings: &Value) -> bool {
    fn contains(expected: &Value, actual: &Value) -> bool {
        expected.as_object().map_or_else(
            || expected == actual,
            |fields| {
                fields
                    .iter()
                    .all(|(key, value)| contains(value, &actual[key]))
            },
        )
    }
    contains(&patch(preset), settings)
}

pub(super) fn selected(settings: &Value) -> &'static str {
    let preset = saved_preset(settings);
    if preset != "custom" {
        let expected = patch(preset);
        if DETAILS
            .into_iter()
            .all(|row| row.mode(settings) == row.mode(&expected))
            && usage_expansion(settings) == usage_expansion(&expected)
        {
            return preset;
        }
    }
    "custom"
}

pub(super) fn matches_named_details(
    preset: &str,
    mode: impl Fn(Row) -> &'static str,
    usage_expansion: &'static str,
) -> bool {
    DETAILS
        .into_iter()
        .all(|row| mode(row) == row.preset_mode(preset))
        && usage_expansion == usage_default(preset)
}

#[cfg(test)]
mod tests;
