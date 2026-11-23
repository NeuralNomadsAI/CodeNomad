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
            Self::Groups => visibility(&settings[self.key()]).unwrap_or(usage_default(preset)),
            Self::Diagnostics => visibility(&settings[self.key()]).unwrap_or("expanded"),
            Self::Inputs => visibility(&settings[self.key()]).unwrap_or("collapsed"),
            Self::System => visibility(&settings[self.key()]).unwrap_or("hidden"),
        }
    }

    pub(super) fn put(self, patch: &mut Value, saved: &Value, mode: &'static str) {
        match self {
            Self::Usage => {
                // Hide keeps the selected expansion for the next enable.
                patch[self.key()] = json!(mode != "hidden");
                if mode != "hidden" {
                    patch["usageMetricsExpansion"] = json!(mode);
                }
            }
            Self::Thinking | Self::Tool(_) => {
                let mut current = saved.clone();
                // Other rows in the same write may already have adjusted the effective choices.
                overlay(&mut current, patch);
                let mut tools = tools(|id| Self::Tool(id).mode(&current));
                if let Self::Tool(id) = self {
                    tools[id] = json!(mode);
                    if id == "other" && mode != "hidden" {
                        patch["toolOutputExpansion"] = json!(mode);
                    }
                }
                let mut thinking = thinking(&current);
                if self == Self::Thinking {
                    patch[self.key()] = json!(mode != "hidden");
                    if mode != "hidden" {
                        thinking = mode;
                        patch["thinkingBlocksExpansion"] = json!(mode);
                    }
                }
                // Solid derives these from the old preset when absent. Keep that effective
                // state on owners that store merge patches without deriving legacy defaults.
                for row in [Self::Groups, Self::Usage] {
                    let (key, mode) = if row == Self::Groups {
                        (row.key(), row.mode(&current))
                    } else {
                        ("usageMetricsExpansion", usage_expansion(&current))
                    };
                    if current[key].is_null() {
                        patch[key] = json!(mode);
                    }
                }
                patch["toolCallExpansionDefaults"] =
                    json!({"preset":"custom", "thinking":thinking, "tools":tools});
            }
            _ => patch[self.key()] = json!(mode),
        }
    }
}

fn overlay(saved: &mut Value, patch: &Value) {
    if let Some(fields) = patch.as_object() {
        for (key, value) in fields {
            saved[key] = value.clone();
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

fn usage_default(preset: &str) -> &'static str {
    if preset == "everything" {
        "expanded"
    } else {
        "collapsed"
    }
}

fn usage_expansion(settings: &Value) -> &'static str {
    expansion(&settings["usageMetricsExpansion"])
        .unwrap_or_else(|| usage_default(saved_preset(settings)))
}

fn saved_preset(settings: &Value) -> &'static str {
    let name = settings["toolCallExpansionDefaults"]["preset"]
        .as_str()
        .unwrap_or_default();
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
    let expansion = usage_default(preset);
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

#[cfg(test)]
mod tests;
