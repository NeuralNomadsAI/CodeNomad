use super::{Display, TOOL_LIMIT, Tool, window};
use crate::{
    State, screen,
    settings::{TranscriptRow, transcript_mode},
    strings::t,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    markdown,
};
use serde_json::Value;

const SCAN_LIMIT: usize = 10_000;
const ENTRY_LIMIT: usize = 100;

pub(super) fn view(s: &State, key: &str, tool: &Tool) -> Option<El> {
    let mode = transcript_mode(s, TranscriptRow::Diagnostics);
    if mode == "hidden" {
        return None;
    }
    let files = tool.metadata["diagnostics"].as_object()?;
    let preferred = [
        &tool.input["filePath"],
        &tool.metadata["filePath"],
        &tool.metadata["filepath"],
        &tool.input["path"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .filter(|p| !p.is_empty() && p.len() <= 4096)
    .map(|p| p.replace('\\', "/"))
    .collect::<Vec<_>>();
    let selected = preferred
        .iter()
        .find_map(|path| files.get_key_value(path))
        .or_else(|| {
            for suffix in [false, true] {
                for path in &preferred {
                    if let Some(pair) = files.iter().take(SCAN_LIMIT).find(|(candidate, _)| {
                        if candidate.len() > 4096 {
                            return false;
                        }
                        let candidate = candidate.replace('\\', "/");
                        candidate == *path
                            || suffix
                                && candidate
                                    .strip_suffix(path)
                                    .is_some_and(|base| base.ends_with('/'))
                    }) {
                        return Some(pair);
                    }
                }
            }
            None
        });
    let (path, entries) = selected?;
    let entries = entries.as_array()?;
    if !entries
        .iter()
        .take(SCAN_LIMIT)
        .any(|entry| entry["message"].is_string())
    {
        return None;
    }
    let key = format!("{key}-diagnostics");
    let expanded = s.transcript_display.expanded(&key, mode == "expanded");
    let toggle = key.clone();
    let label = t("toolCall.diagnostics.title");
    let mut pane = col()
        .key(key.clone())
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::button(
                label,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        );
    if expanded {
        let rendered = (0..3)
            .flat_map(|rank| {
                entries
                    .iter()
                    .take(SCAN_LIMIT)
                    .filter(move |entry| severity(entry) == rank)
            })
            .filter_map(|entry| Some((entry, entry["message"].as_str()?)))
            .take(ENTRY_LIMIT)
            .enumerate()
            .map(|(i, (entry, message))| {
                let kind = t(match severity(entry) {
                    0 => "toolCall.diagnostics.severity.error.short",
                    1 => "toolCall.diagnostics.severity.warning.short",
                    _ => "toolCall.diagnostics.severity.info.short",
                });
                let start = &entry["range"]["start"];
                let line = start["line"].as_u64().map_or(0, |n| n.saturating_add(1));
                let column = start["character"]
                    .as_u64()
                    .map_or(0, |n| n.saturating_add(1));
                let header = format!("{kind} {path}:{line}:{column}");
                col()
                    .full_width()
                    .child(text(header).wrap().content_direction())
                    .child(window(
                        s,
                        format!("{key}-{i}"),
                        &[message],
                        TOOL_LIMIT,
                        |shown, _| {
                            text(shown)
                                .full_width()
                                .wrap()
                                .content_direction()
                                .selectable(true)
                        },
                    ))
            });
        pane = pane.child(markdown::tool_pane(
            col().full_width().separate(Space::Sm).children(rendered),
            false,
        ));
    }
    Some(pane)
}

fn severity(entry: &Value) -> u8 {
    match entry["severity"].as_u64() {
        Some(1) => 0,
        Some(2) => 1,
        _ => 2,
    }
}
