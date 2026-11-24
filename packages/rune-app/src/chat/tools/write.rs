use super::{Tool, string};
use rune_theme_codenomad::markdown;

pub(super) fn path(tool: &Tool) -> &str {
    string(&tool.input, &["filePath", "path"])
}

pub(super) fn output(tool: &Tool) -> (&str, &str) {
    let content = tool.input["content"]
        .as_str()
        .or_else(|| tool.metadata["content"].as_str())
        .unwrap_or_default();
    (content, markdown::language_for_path(path(tool)))
}
