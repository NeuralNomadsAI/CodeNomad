use super::{
    actions::Display,
    document::{HIGHLIGHT_LIMIT, TOOL_LIMIT, window},
    tool_diff,
};
use crate::{
    State,
    content::{Part, Tool},
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, ansi, catalogue,
    layout::{self, Layout},
    markdown,
};
use serde_json::Value;
use std::{io, sync::Arc};

fn string<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .filter_map(|key| value[*key].as_str())
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

fn path(tool: &Tool) -> &str {
    let input = string(
        &tool.input,
        if tool.name == "read" {
            &["filePath", "path", "name", "file"]
        } else {
            &["filePath", "path"]
        },
    );
    if tool.name != "edit" || !input.is_empty() {
        return input;
    }
    let metadata = string(&tool.metadata, &["filePath"]);
    if !metadata.is_empty() {
        metadata
    } else {
        single_diff(tool).map_or("", |file| string(file, &["file"]))
    }
}

fn single_diff(tool: &Tool) -> Option<&Value> {
    let [file] = tool.metadata["files"].as_array()?.as_slice() else {
        return None;
    };
    Some(file)
}

fn input_json(value: &Value, limit: usize, partial: bool) -> Option<String> {
    struct Limited(Vec<u8>, usize);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let count = bytes.len().min(self.1.saturating_sub(self.0.len()));
            if count == 0 && !bytes.is_empty() {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut out = Limited(Vec::new(), limit);
    let serialized = serde_json::to_writer_pretty(&mut out, value);
    if serialized
        .as_ref()
        .is_err_and(|error| error.io_error_kind() != Some(io::ErrorKind::FileTooLarge) || !partial)
    {
        return None;
    }
    if serialized.is_err() {
        if let Err(error) = std::str::from_utf8(&out.0) {
            out.0.drain(error.valid_up_to()..);
        }
        out.0.extend_from_slice("…".as_bytes());
    }
    String::from_utf8(out.0).ok()
}

fn title(tool: &Tool) -> String {
    let name = tool.name.strip_prefix("opencode_").unwrap_or(&tool.name);
    let mut chars = name.chars();
    let mut title = if matches!(name, "bash" | "shell") {
        t("toolCall.renderer.toolName.shell").to_owned()
    } else {
        chars
            .next()
            .into_iter()
            .flat_map(char::to_uppercase)
            .chain(chars)
            .collect()
    };
    let summary = match name {
        "read" | "edit" => path(tool).rsplit(['/', '\\']).next().unwrap_or_default(),
        "bash" | "shell" => string(&tool.input, &["description"]),
        "glob" | "grep" => string(&tool.input, &["pattern"]).trim(),
        _ => "",
    };
    if !summary.is_empty() {
        title.push(' ');
        title.extend(summary.chars().take(250));
    }
    let params: &[(&str, &str, &str)] = match name {
        "read" => &[
            ("offset", "toolCall.renderer.read.detail.offset", "offset"),
            ("limit", "toolCall.renderer.read.detail.limit", "limit"),
        ],
        "bash" | "shell" => &[("timeout", "toolCall.renderer.bash.title.timeout", "timeout")],
        _ => &[],
    };
    for &(field, key, param) in params {
        if let Some(value) = tool.input[field].as_number() {
            let value = if field == "timeout" {
                if value.as_f64().is_none_or(|v| v <= 0.0) {
                    continue;
                }
                format!("{value}ms")
            } else {
                value.to_string()
            };
            title.push_str(" · ");
            title.push_str(&catalogue::format(locale(), key, &[(param, &value)]));
        }
    }
    title
}

fn shell(tool: &Tool) -> bool {
    matches!(tool.name.as_str(), "bash" | "shell")
}

fn interrupted(tool: &Tool) -> Option<(&str, &str)> {
    if !shell(tool) || tool.status != "error" || tool.metadata["interrupted"] != true {
        return None;
    }
    let notice = tool.metadata["notice"]
        .as_str()
        .filter(|notice| !notice.is_empty())?;
    let output = tool.error.strip_suffix(notice)?;
    Some((output.strip_suffix("\n\n").unwrap_or(output), notice))
}

fn error(tool: &Tool) -> &str {
    interrupted(tool).map_or(tool.error.as_str(), |(_, notice)| notice)
}

fn output<'a>(tool: &'a Tool, parts: &mut [&'a str; 4]) -> &'static str {
    let live = string(&tool.metadata, &["output", "preview"]);
    if shell(tool) {
        let command = string(&tool.input, &["command"]);
        let output = interrupted(tool).map_or_else(
            || {
                if tool.status == "completed" {
                    tool.output.as_str()
                } else {
                    live
                }
            },
            |(output, _)| output,
        );
        *parts = [
            if command.is_empty() { "" } else { "$ " },
            command,
            if command.is_empty() || output.is_empty() {
                ""
            } else {
                "\n"
            },
            output,
        ];
        "bash"
    } else if tool.name == "edit" {
        let diff = string(&tool.metadata, &["diff"]);
        let patch = single_diff(tool).map_or("", |file| string(file, &["patch"]));
        parts[0] = [diff, patch, &tool.output, live]
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
            });
        "diff"
    } else {
        parts[0] = if tool.output.is_empty() && tool.status != "completed" {
            live
        } else {
            &tool.output
        };
        "text"
    }
}

pub(super) fn view(s: &State, message: &str, tool: &Arc<Tool>) -> El {
    let key = tool_key(message, &tool.id);
    if tool.name == "edit" {
        let mut parts = [""; 4];
        output(tool, &mut parts);
        if tool_diff::candidate(tool, parts[0]) {
            // DiffView has live selection, modes and a virtual list of its own.
            return render(s, message, tool, &key).key(key);
        }
    }
    let display = &s.transcript_display;
    let patch_steps = is_patch(tool).then(|| {
        std::array::from_fn::<_, { super::tool_patch::FILE_LIMIT }, _>(|index| {
            display.steps(&format!("{key}-patch-{index}"))
        })
    });
    let stamp = (
        Arc::as_ptr(tool) as usize,
        std::rc::Rc::as_ptr(&s.input_scope) as usize,
        locale(),
        display
            .search_highlight
            .as_ref()
            .filter(|hit| hit.message == message),
        patch_steps,
        ["", "-tool_input", "-tool_output", "-wrap", "-error"].map(|suffix| {
            let section = format!("{key}{suffix}");
            (display.toggled(&section), display.steps(&section))
        }),
    );
    markdown::hold_frame(key.clone(), stamp, || render(s, message, tool, &key)).key(key)
}

fn is_patch(tool: &Tool) -> bool {
    matches!(tool.name.as_str(), "apply_patch" | "patch")
}

fn render(s: &State, message: &str, tool: &Arc<Tool>, key: &str) -> El {
    let claimed = std::cell::Cell::new(false);
    let query = super::search_hit::query(
        s,
        message,
        codenomad_client::search::Kind::Tool,
        tool.part_index,
    )
    .map(|query| rune_theme_codenomad::timeline::search::Query {
        claimed: Some(&claimed),
        ..query
    });
    let active = query.is_some_and(|q| q.active);
    let expanded = active
        || (s.transcript_display.toggled(&key)
            ^ matches!(tool.name.as_str(), "bash" | "shell" | "edit"));
    let status = match tool.status.as_str() {
        "completed" => "toolCall.status.completed",
        "error" => "toolCall.status.error",
        "running" => "toolCall.status.running",
        "pending" | "streaming" => "toolCall.status.pending",
        _ => "toolCall.status.unknown",
    };
    let title = title(tool);
    let toggle = message.to_owned();
    let owner = tool.clone();
    let mut parts = [""; 4];
    let pending = matches!(tool.status.as_str(), "pending" | "streaming");
    let lang = output(tool, &mut parts);
    let has_output = !pending && parts.iter().any(|part| !part.trim().is_empty());
    let mut header = layout::action_row()
        .child(
            layout::button(
                &title,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::toggle(s, &tool_key(&toggle, &owner.id))
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        )
        .child(text(t(status)).text_role(TextRole::Label));
    if has_output {
        header = header.child(copy(s, message, &tool.id, Section::Output));
    }
    let mut block = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header);
    if !expanded {
        return block;
    }
    if pending && tool.input.as_str().is_none_or(str::is_empty) {
        return block.child(text(t("toolCall.pending.waitingToRun")));
    }
    if !tool.input.is_null() {
        let input_key = format!("{key}-tool_input");
        let show = s.transcript_display.toggled(&input_key);
        let input = (show || active)
            .then(|| {
                tool.input
                    .as_str()
                    .map(std::borrow::Cow::Borrowed)
                    .or_else(|| {
                        input_json(&tool.input, super::document::search_limit(query), active)
                            .map(std::borrow::Cow::Owned)
                    })
            })
            .flatten();
        let show = show
            || active
                && input
                    .as_deref()
                    .is_some_and(|text| query.is_some_and(|q| q.matches(text)));
        let toggle = input_key.clone();
        block = block.child(
            layout::button(
                t(if show {
                    "toolCall.header.hideInputTitle"
                } else {
                    "toolCall.header.showInputTitle"
                }),
                false,
                screen::action(&s.input_scope, move |s| Display::toggle(s, &toggle)),
            )
            .key(format!("toggle-{input_key}"))
            .expanded(show),
        );
        if show {
            block = block.child(copy(s, message, &tool.id, Section::Input));
            if let Some(input) = input {
                block = block.child(markdown::tool_pane(
                    window(
                        s,
                        input_key,
                        &[&input],
                        super::document::search_limit(query),
                        |shown, units| {
                            markdown::search_code(
                                shown,
                                "json",
                                units <= HIGHLIGHT_LIMIT,
                                true,
                                query,
                            )
                        },
                    ),
                    false,
                ));
            } else {
                block = block.child(text(t("toolCall.output.tooLarge")).key(input_key));
            }
        }
    }
    let lang = if tool.name == "read" {
        markdown::language_for_path(path(tool))
    } else {
        lang
    };
    if !pending
        && is_patch(tool)
        && let Some(patch) = super::tool_patch::view(s, tool, key, query)
    {
        block = block.child(patch);
    }
    if has_output {
        let terminal = shell(tool) && parts.iter().any(|text| ansi::present(text));
        let highlight = tool.status != "running"
            && (lang != "diff"
                || parts
                    .iter()
                    .flat_map(|text| text.encode_utf16())
                    .nth(TOOL_LIMIT)
                    .is_none());
        let output_key = format!("{key}-tool_output");
        let wrap_key = format!("{key}-wrap");
        let wrap = !s.transcript_display.toggled(&wrap_key);
        let fallback = || {
            col()
                .full_width()
                .separate(Space::Sm)
                .child(
                    layout::action_row()
                        .child(
                            layout::button(
                                t(if wrap {
                                    "toolCall.diff.disableWordWrap"
                                } else {
                                    "toolCall.diff.enableWordWrap"
                                }),
                                false,
                                screen::action(&s.input_scope, move |s| {
                                    Display::toggle(s, &wrap_key)
                                }),
                            )
                            .checked(wrap),
                        )
                        .child(text(lang).text_role(TextRole::Label)),
                )
                .child(markdown::tool_pane(
                    window(
                        s,
                        output_key,
                        &parts,
                        super::document::search_limit(query),
                        |shown, units| {
                            if tool.status == "running" && shell(tool) {
                                s.transcript_display.live_ansi(key, shown, wrap, query)
                            } else if terminal {
                                ansi::search_code(shown, wrap, query)
                            } else {
                                markdown::search_code(
                                    shown,
                                    lang,
                                    highlight && units <= HIGHLIGHT_LIMIT,
                                    wrap,
                                    query,
                                )
                            }
                        },
                    ),
                    tool.name == "edit",
                ))
        };
        // The pinned diff renderer has no text-highlight seam. Use the existing raw view
        // for the selected patch, preserving its stored split/unified mode for normal reading.
        block = block.child(if !active && tool_diff::candidate(tool, parts[0]) {
            tool_diff::body(s, message, key, tool, parts[0], path(tool), fallback)
        } else {
            fallback()
        });
    }
    let error = error(tool);
    if !error.is_empty() {
        block = block
            .child(
                layout::action_row()
                    .child(text(t("toolCall.error.label")))
                    .child(copy(s, message, &tool.id, Section::Error)),
            )
            .child(markdown::tool_pane(
                window(
                    s,
                    format!("{key}-error"),
                    &[error],
                    super::document::search_limit(query),
                    |shown, _| {
                        rune_theme_codenomad::timeline::search::ink(text(shown), shown, query)
                            .full_width()
                            .wrap()
                            .content_direction()
                            .selectable(true)
                    },
                ),
                false,
            ));
    }
    block
}

#[derive(Clone, Copy)]
enum Section {
    Input,
    Output,
    Error,
}

pub(super) fn tool_key(message: &str, call: &str) -> String {
    let escaped = call.replace('%', "%25").replace('/', "%2F");
    format!("tool-{message}:{}:{escaped}", escaped.len())
}

fn copy(s: &State, message: &str, call: &str, section: Section) -> El {
    let base = tool_key(message, call);
    let (message, call) = (message.to_owned(), call.to_owned());
    let key = format!(
        "copy-{base}-{}",
        match section {
            Section::Input => "input",
            Section::Output => "output",
            Section::Error => "error",
        }
    );
    markdown::copy_button(
        t(if matches!(section, Section::Input) {
            "toolCall.io.copyInputAriaLabel"
        } else {
            "toolCall.io.copyOutputAriaLabel"
        }),
        screen::action_tx(&s.input_scope, move |s, tx| {
            let Some(tool) = s.messages.iter().find(|m| m.id == message).and_then(|m| {
                m.parts.iter().find_map(|part| match part {
                    Part::Tool(tool) if tool.id == call => Some(tool),
                    _ => None,
                })
            }) else {
                return;
            };
            match section {
                Section::Input => {
                    if let Ok(source) = serde_json::to_string_pretty(&tool.input) {
                        tx.copy(source);
                    }
                }
                Section::Output => {
                    let mut parts = [""; 4];
                    output(tool, &mut parts);
                    tx.copy(parts.concat());
                }
                Section::Error => tx.copy(error(tool)),
            }
        }),
    )
    .key(key)
}

#[cfg(test)]
#[test]
fn nested_tool_arguments_stop_at_the_actual_pretty_json_budget() {
    let mut value = serde_json::json!(vec!["x"; 2300]);
    for _ in 0..100 {
        value = serde_json::Value::Array(vec![value]);
    }
    assert!(value.to_string().len() < TOOL_LIMIT);
    assert!(serde_json::to_string_pretty(&value).unwrap().len() > 400_000);
    assert!(input_json(&value, TOOL_LIMIT, false).is_none());
}
