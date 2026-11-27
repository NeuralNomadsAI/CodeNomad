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
const FILE_LIMIT: usize = 20;

pub(super) fn view(s: &State, key: &str, tool: &Tool) -> Option<El> {
    let mode = transcript_mode(s, TranscriptRow::Diagnostics);
    if mode == "hidden" {
        return None;
    }
    let files = tool.metadata["diagnostics"].as_object()?;
    let mut preferred: Vec<String> = [
        &tool.input["filePath"],
        &tool.metadata["filePath"],
        &tool.metadata["filepath"],
        &tool.input["path"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .filter(|p| !p.is_empty() && p.len() <= 4096)
    .map(|p| p.replace('\\', "/"))
    .collect();
    let multi_file = tool.name == "apply_patch";
    if let Some(patch_files) = tool.metadata["files"].as_array() {
        for file in patch_files.iter().take(FILE_LIMIT) {
            for field in ["filePath", "relativePath", "file", "path"] {
                if let Some(p) = file[field]
                    .as_str()
                    .filter(|p| !p.is_empty() && p.len() <= 4096)
                {
                    let norm = p.replace('\\', "/");
                    if !preferred.contains(&norm) && preferred.len() < FILE_LIMIT * 2 {
                        preferred.push(norm);
                    }
                }
            }
        }
    }
    let normalized_keys: Vec<(&String, &Value, String)> = files
        .iter()
        .take(SCAN_LIMIT)
        .filter(|(candidate, _)| candidate.len() <= 4096)
        .map(|(candidate, value)| (candidate, value, candidate.replace('\\', "/")))
        .collect();
    let mut selected: Vec<(&String, &Vec<Value>)> = Vec::new();
    for path in &preferred {
        if !multi_file && !selected.is_empty() {
            break;
        }
        if selected.len() >= FILE_LIMIT {
            break;
        }
        let matched = files
            .get_key_value(path)
            .or_else(|| {
                normalized_keys
                    .iter()
                    .find(|(_, _, norm)| norm == path)
                    .map(|(candidate, value, _)| (*candidate, *value))
            })
            .or_else(|| {
                normalized_keys
                    .iter()
                    .find(|(_, _, norm)| {
                        norm.strip_suffix(path)
                            .is_some_and(|base| base.ends_with('/'))
                    })
                    .map(|(candidate, value, _)| (*candidate, *value))
            });
        if let Some((candidate, value)) = matched
            && let Some(entries) = value.as_array()
            && !selected.iter().any(|(existing, _)| *existing == candidate)
        {
            selected.push((candidate, entries));
        }
    }
    let mut truncated = false;
    let mut scanned = 0usize;
    if multi_file {
        for (candidate, value, _) in &normalized_keys {
            if selected.len() >= FILE_LIMIT || scanned >= SCAN_LIMIT {
                if scanned >= SCAN_LIMIT {
                    truncated = true;
                }
                break;
            }
            if selected.iter().any(|(existing, _)| *existing == *candidate) {
                continue;
            }
            if let Some(entries) = value.as_array() {
                let mut has_message = false;
                for entry in entries {
                    if scanned >= SCAN_LIMIT {
                        truncated = true;
                        break;
                    }
                    scanned += 1;
                    if entry["message"].is_string() {
                        has_message = true;
                        break;
                    }
                }
                if has_message {
                    selected.push((*candidate, entries));
                }
            }
        }
    }
    let mut flat: Vec<(&str, &Value, &str)> = Vec::new();
    for (path, entries) in &selected {
        for entry in entries.iter() {
            if scanned >= SCAN_LIMIT {
                truncated = true;
                break;
            }
            scanned += 1;
            if let Some(message) = entry["message"].as_str() {
                flat.push((path.as_str(), entry, message));
            }
        }
        if scanned >= SCAN_LIMIT {
            break;
        }
    }
    let mut has_any_message = !flat.is_empty();
    let mut scanned_keys = 0usize;
    for (candidate, value) in files.iter() {
        scanned_keys += 1;
        if scanned_keys > SCAN_LIMIT {
            truncated = true;
            break;
        }
        if selected.iter().any(|(p, _)| *p == candidate) {
            continue;
        }
        let Some(entries) = value.as_array() else {
            continue;
        };
        for entry in entries.iter() {
            if scanned >= SCAN_LIMIT {
                truncated = true;
                break;
            }
            scanned += 1;
            if entry["message"].is_string() {
                has_any_message = true;
                truncated = true;
                break;
            }
        }
        if truncated && has_any_message {
            break;
        }
    }
    if !has_any_message {
        return None;
    }
    truncated |= flat.len() > ENTRY_LIMIT;
    let key = format!("{key}-diagnostics");
    let expanded = s.transcript_display.expanded(&key, mode == "expanded");
    let toggle = key.clone();
    let label = t("toolCall.diagnostics.title");
    let mut header = layout::action_row().child(
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
    if truncated {
        header = header.child(text(t("toolCall.output.truncated")).role("status"));
    }
    let mut pane = col()
        .key(key.clone())
        .full_width()
        .separate(Space::Sm)
        .child(header);
    if expanded {
        let payload = tool.metadata["diagnostics"].clone();
        let copy_row = layout::action_row()
            .child(
                text(t(if truncated {
                    "toolCall.output.truncated"
                } else {
                    "toolCall.diagnostics.title"
                }))
                .role("status"),
            )
            .child(
                markdown::copy_button(
                    t("toolCall.io.copyOutputAriaLabel"),
                    screen::action_tx(&s.input_scope, move |s, tx| {
                        s.transcript_display.children.cancel_copy();
                        if let Some(source) =
                            super::format::bounded_json(&payload, super::children::MAX_COPY_BYTES)
                        {
                            tx.copy(source);
                        } else {
                            crate::shell::notifications::emit_outcome(
                                s,
                                crate::shell::notifications::Category::Sessions,
                                None,
                                t("messageSection.quote.copyFailed"),
                                true,
                            );
                        }
                    }),
                )
                .key(format!("copy-{key}")),
            );
        pane = pane
            .child(copy_row)
            .child(render_entries(s, &key, &flat, ENTRY_LIMIT));
    }
    Some(pane)
}

pub(super) fn inline_for_file(
    s: &State,
    key: &str,
    tool: &Tool,
    candidates: &[&str],
    remaining_entries: &mut usize,
    scanned: &mut usize,
    matched_keys: &mut Vec<String>,
) -> Option<El> {
    if transcript_mode(s, TranscriptRow::Diagnostics) == "hidden"
        || *remaining_entries == 0
        || *scanned >= SCAN_LIMIT
    {
        return None;
    }
    let files = tool.metadata["diagnostics"].as_object()?;
    let mut matched: Option<(&String, &Vec<Value>)> = None;
    for raw in candidates {
        if raw.is_empty() || raw.len() > 4096 {
            continue;
        }
        let norm = raw.replace('\\', "/");
        if let Some((candidate, value)) = files.get_key_value(*raw)
            && !matched_keys.iter().any(|used| used == candidate)
            && let Some(entries) = value.as_array()
        {
            matched = Some((candidate, entries));
            break;
        }
        let mut found = None;
        for (candidate, value) in files.iter() {
            if *scanned >= SCAN_LIMIT {
                break;
            }
            *scanned += 1;
            if candidate.len() > 4096 || matched_keys.iter().any(|used| used == candidate) {
                continue;
            }
            let cand_norm = candidate.replace('\\', "/");
            let same = cand_norm == norm
                || cand_norm
                    .strip_suffix(&norm)
                    .is_some_and(|base| base.ends_with('/'))
                || norm
                    .strip_suffix(&cand_norm)
                    .is_some_and(|base| base.ends_with('/'));
            if same && let Some(entries) = value.as_array() {
                found = Some((candidate, entries));
                break;
            }
        }
        if found.is_some() {
            matched = found;
            break;
        }
    }
    let (diag_key, entries) = matched?;
    matched_keys.push(diag_key.clone());
    let mut flat: Vec<(&str, &Value, &str)> = Vec::new();
    for entry in entries {
        if *scanned >= SCAN_LIMIT {
            break;
        }
        *scanned += 1;
        if let Some(message) = entry["message"].as_str() {
            flat.push((diag_key.as_str(), entry, message));
        }
    }
    if flat.is_empty() {
        return None;
    }
    let take = (*remaining_entries).min(flat.len());
    *remaining_entries = remaining_entries.saturating_sub(take);
    Some(render_entries(s, &format!("{key}-diag"), &flat, take))
}

fn render_entries(s: &State, key: &str, flat: &[(&str, &Value, &str)], limit: usize) -> El {
    let rendered = (0..3)
        .flat_map(|rank| {
            flat.iter()
                .copied()
                .filter(move |(_, entry, _)| severity(entry) == rank)
        })
        .take(limit)
        .enumerate()
        .map(|(i, (path, entry, message))| {
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
    crate::chat::reading::inner_scroller(
        markdown::tool_pane(
            col().full_width().separate(Space::Sm).children(rendered),
            false,
        ),
        false,
    )
}

fn severity(entry: &Value) -> u8 {
    match entry["severity"].as_u64() {
        Some(1) => 0,
        Some(2) => 1,
        _ => 2,
    }
}
