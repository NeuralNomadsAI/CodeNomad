use super::{TOOL_LIMIT, Tool, string, tool_diff};
use serde_json::Value;

pub(super) fn path(tool: &Tool) -> &str {
    let input = string(&tool.input, &["filePath", "path"]);
    let metadata = string(&tool.metadata, &["filePath"]);
    [
        input,
        metadata,
        single_diff(tool).map_or("", |file| string(file, &["file"])),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or_default()
}

pub(super) fn output<'a>(tool: &'a Tool, live: &'a str) -> &'a str {
    let diff = string(&tool.metadata, &["diff"]);
    let patch = single_diff(tool).map_or("", |file| string(file, &["patch"]));
    [diff, patch, &tool.output, live]
        .into_iter()
        .find(|text| {
            let bytes = text
                .chars()
                .scan(TOOL_LIMIT, |left, c| {
                    *left = left.checked_sub(c.len_utf16())?;
                    Some(c.len_utf8())
                })
                .sum::<usize>();
            text[..bytes].lines().any(tool_diff::is_hunk)
        })
        .unwrap_or_else(|| {
            [diff, patch, &tool.output]
                .into_iter()
                .find(|text| !text.trim().is_empty())
                .unwrap_or_default()
        })
}

fn single_diff(tool: &Tool) -> Option<&Value> {
    let [file] = tool.metadata["files"].as_array()?.as_slice() else {
        return None;
    };
    Some(file)
}
