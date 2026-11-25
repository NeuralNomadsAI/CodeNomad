use super::{Tool, string};
use crate::strings::locale;
use rune_theme_codenomad::catalogue;

pub(super) fn summary(tool: &Tool) -> &str {
    string(&tool.input, &["description"])
}

pub(super) fn detail(tool: &Tool, title: &mut String) {
    if let Some(timeout) = tool.input["timeout"]
        .as_number()
        .filter(|n| n.as_f64().is_some_and(|v| v > 0.0))
    {
        title.push_str(" · ");
        title.push_str(&catalogue::format(
            locale(),
            "toolCall.renderer.bash.title.timeout",
            &[("timeout", &format!("{timeout}ms"))],
        ));
    }
}

pub(super) fn matches(tool: &Tool) -> bool {
    matches!(tool.name.as_str(), "bash" | "shell")
}

pub(super) fn interrupted(tool: &Tool) -> Option<(&str, &str)> {
    if !matches(tool) || tool.status != "error" || tool.metadata["interrupted"] != true {
        return None;
    }
    let notice = tool.metadata["notice"]
        .as_str()
        .filter(|notice| !notice.is_empty())?;
    let output = tool.error.strip_suffix(notice)?;
    Some((output.strip_suffix("\n\n").unwrap_or(output), notice))
}

pub(super) fn output(tool: &Tool) -> [&str; 4] {
    let command = string(&tool.input, &["command"]);
    let output = interrupted(tool).map_or_else(
        || match tool.status.as_str() {
            "completed" => tool.output.as_str(),
            "running" | "error" => string(&tool.metadata, &["output"]),
            _ => "",
        },
        |(output, _)| output,
    );
    [
        if command.is_empty() { "" } else { "$ " },
        command,
        if command.is_empty() || output.is_empty() {
            ""
        } else {
            "\n"
        },
        output,
    ]
}
