use super::{Tool, string};
use crate::strings::locale;
use rune_theme_codenomad::catalogue;

pub(super) fn path(tool: &Tool) -> &str {
    string(&tool.input, &["filePath", "path", "name", "file"])
}

pub(super) fn detail(tool: &Tool, title: &mut String) {
    for (field, key) in [
        ("offset", "toolCall.renderer.read.detail.offset"),
        ("limit", "toolCall.renderer.read.detail.limit"),
    ] {
        if let Some(value) = tool.input[field].as_number() {
            title.push_str(" · ");
            title.push_str(&catalogue::format(
                locale(),
                key,
                &[(field, &value.to_string())],
            ));
        }
    }
}
