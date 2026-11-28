//! Search display of apply_patch's per-file native diffs.
use super::document::{TOOL_LIMIT, search_limit, window};
use crate::{
    State,
    content::Tool,
    strings::{locale, t},
};
use rune::El;
use rune_theme_codenomad::{catalogue, layout::Layout, markdown, timeline::search::Query};

pub(super) const FILE_LIMIT: usize = 20;

pub(super) fn view(s: &State, tool: &Tool, key: &str, query: Option<Query<'_>>) -> Option<El> {
    let files = tool.metadata["files"].as_array()?;
    let mut rendered = 0;
    let mut remaining = search_limit(query);
    let mut truncated = files.len() > FILE_LIMIT;
    let mut block = rune::col().full_width();
    let patches = files
        .iter()
        .take(FILE_LIMIT)
        .enumerate()
        .filter_map(|(i, file)| {
            let patch = file["diff"].as_str().or_else(|| file["patch"].as_str())?;
            (!patch.is_empty()).then_some((i, file, patch))
        });
    for (index, file, patch) in patches {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let title = file["relativePath"]
            .as_str()
            .or_else(|| file["filePath"].as_str())
            .or_else(|| file["file"].as_str());
        let label = title.map_or_else(
            || {
                catalogue::format(
                    locale(),
                    "toolCall.applyPatch.fileFallback",
                    &[("number", &(index + 1).to_string())],
                )
            },
            |title| title.chars().take(250).collect(),
        );
        let limit = remaining;
        let used: usize = patch
            .chars()
            .scan(limit, |left, ch| {
                *left = left.checked_sub(ch.len_utf16())?;
                Some(ch.len_utf16())
            })
            .sum();
        block = block
            .child(rune::text(label))
            .child(crate::chat::reading::inner_scroller(
                markdown::tool_pane(
                    window(
                        s,
                        format!("{key}-patch-{index}"),
                        &[patch],
                        limit,
                        |shown, units| {
                            markdown::search_code(shown, "diff", units <= TOOL_LIMIT, true, query)
                        },
                    ),
                    true,
                ),
                false,
            ));
        remaining -= used;
        rendered += 1;
    }
    if rendered > 0 && truncated {
        block = block.child(rune::text(t("toolCall.output.tooLarge")).role("status"));
    }
    (rendered > 0).then_some(block)
}
