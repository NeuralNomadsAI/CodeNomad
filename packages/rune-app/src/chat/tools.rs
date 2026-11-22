use super::{
    actions::Display,
    document::{HIGHLIGHT_LIMIT, TOOL_LIMIT, window},
};
use crate::{
    State,
    content::{Part, Tool},
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
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
    string(
        &tool.input,
        if tool.name == "read" {
            &["filePath", "path", "name", "file"]
        } else {
            &["filePath", "path"]
        },
    )
}

fn input_json(value: &Value) -> Option<String> {
    #[derive(Default)]
    struct Limited(Vec<u8>);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > TOOL_LIMIT.saturating_sub(self.0.len()) {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut out = Limited::default();
    serde_json::to_writer_pretty(&mut out, value).ok()?;
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
        let patch = tool.metadata["files"]
            .as_array()
            .filter(|files| files.len() == 1)
            .and_then(|files| files.first())
            .map(|file| string(file, &["patch"]))
            .unwrap_or_default();
        parts[0] = [diff, patch, &tool.output, live]
            .into_iter()
            .find(|text| {
                text.get(..text.floor_char_boundary(text.len().min(TOOL_LIMIT)))
                    .is_some_and(|prefix| prefix.lines().any(|line| line.starts_with("@@ ")))
            })
            .unwrap_or_else(|| {
                [diff, &tool.output]
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
    let display = &s.transcript_display;
    let stamp = (
        Arc::as_ptr(tool) as usize,
        std::rc::Rc::as_ptr(&s.input_scope) as usize,
        locale(),
        ["", "-tool_input", "-tool_output", "-wrap", "-error"].map(|suffix| {
            let section = format!("{key}{suffix}");
            (display.toggled(&section), display.steps(&section))
        }),
    );
    markdown::hold_frame(key.clone(), stamp, || render(s, message, tool, &key)).key(key)
}

fn render(s: &State, message: &str, tool: &Arc<Tool>, key: &str) -> El {
    let expanded = s.transcript_display.toggled(&key)
        ^ matches!(tool.name.as_str(), "bash" | "shell" | "edit");
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
    if pending {
        return block.child(text(t("toolCall.pending.waitingToRun")));
    }
    if !tool.input.is_null() {
        let input_key = format!("{key}-tool_input");
        let show = s.transcript_display.toggled(&input_key);
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
            let input = tool
                .input
                .as_str()
                .map(std::borrow::Cow::Borrowed)
                .or_else(|| input_json(&tool.input).map(std::borrow::Cow::Owned));
            if let Some(input) = input {
                block = block.child(markdown::tool_pane(
                    window(s, input_key, &[&input], TOOL_LIMIT, |shown, _| {
                        markdown::code(shown, "json", true, true)
                    }),
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
    if has_output {
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
        block = block
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
                            screen::action(&s.input_scope, move |s| Display::toggle(s, &wrap_key)),
                        )
                        .checked(wrap),
                    )
                    .child(text(lang).text_role(TextRole::Label)),
            )
            .child(markdown::tool_pane(
                window(s, output_key, &parts, TOOL_LIMIT, |shown, units| {
                    markdown::code(shown, lang, highlight && units <= HIGHLIGHT_LIMIT, wrap)
                }),
                tool.name == "edit",
            ));
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
                    TOOL_LIMIT,
                    |shown, _| {
                        text(shown)
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

fn tool_key(message: &str, call: &str) -> String {
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
    assert!(input_json(&value).is_none());
}
