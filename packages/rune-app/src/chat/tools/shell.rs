use super::{Tool, string};

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
