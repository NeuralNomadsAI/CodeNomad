use super::{
    actions::Display,
    document::{HIGHLIGHT_LIMIT, TOOL_LIMIT, window},
    tool_diff,
};
use crate::{
    State,
    content::Tool,
    screen,
    settings::{self, TranscriptRow},
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, ansi,
    layout::{self, Layout},
    markdown,
};
use serde_json::Value;
use std::{io, sync::Arc};
pub(super) mod children;
mod clipboard;
use clipboard::{Section, copy};
mod diagnostics;
mod edit;
mod execute;
mod question;
mod read;
mod search;
mod shell;
mod task;
mod todo;
mod write;

fn string<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .filter_map(|key| value[*key].as_str())
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

fn path(tool: &Tool) -> &str {
    match tool.name.as_str() {
        "read" => read::path(tool),
        "edit" => edit::path(tool),
        _ => write::path(tool),
    }
}

fn bounded_json(value: &Value, limit: usize) -> Option<String> {
    input_json(value, limit, false)
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
    let mut title = if name == "websearch" {
        name.into()
    } else if matches!(name, "bash" | "shell") {
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
        "read" | "edit" | "write" => {
            let path = path(tool);
            path.rsplit(['/', '\\'])
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(path)
        }
        "bash" | "shell" => shell::summary(tool),
        "glob" | "grep" => search::pattern(tool),
        _ => "",
    };
    if !summary.is_empty() {
        title.push(' ');
        title.extend(summary.chars().take(250));
    }
    if name == "websearch" {
        search::web_title(tool, &mut title);
    }
    if task::is_task(tool) {
        let detail = task::detail(tool);
        if !detail.is_empty() {
            if !detail.starts_with('[') {
                title.push(' ');
            }
            title.push_str(&detail);
        }
    }
    match name {
        "read" => read::detail(tool, &mut title),
        "bash" | "shell" => shell::detail(tool, &mut title),
        _ => (),
    }
    title
}

fn error(tool: &Tool) -> &str {
    shell::interrupted(tool).map_or(tool.error.as_str(), |(_, notice)| notice)
}

fn output<'a>(tool: &'a Tool, parts: &mut [&'a str; 4]) -> &'a str {
    let live = string(&tool.metadata, &["output", "preview"]);
    if shell::matches(tool) {
        *parts = shell::output(tool);
        "bash"
    } else if tool.name == "edit" {
        parts[0] = edit::output(tool, live);
        "diff"
    } else if tool.name == "write" {
        let (content, language) = write::output(tool);
        parts[0] = content;
        language
    } else {
        parts[0] = if tool.output.is_empty() && tool.status != "completed" {
            live
        } else {
            &tool.output
        };
        "text"
    }
}

pub(super) fn visible(s: &State, tool: &Tool) -> bool {
    settings::transcript_mode(s, TranscriptRow::tool(&tool.name)) != "hidden"
}

pub(super) fn view(s: &State, message: &str, tool: &Arc<Tool>) -> El {
    let key = tool_key(message, &tool.id);
    if matches!(tool.name.as_str(), "execute" | "question")
        || task::is_task(tool)
        || !tool.pictures.is_empty()
    {
        return render(s, message, tool, &key).key(key);
    }
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
        [
            settings::transcript_mode(s, TranscriptRow::tool(&tool.name)),
            settings::transcript_mode(s, TranscriptRow::Inputs),
            settings::transcript_mode(s, TranscriptRow::Diagnostics),
        ],
        [
            "",
            "-tool_input",
            "-tool_output",
            "-wrap",
            "-error",
            "-diagnostics",
        ]
        .map(|suffix| {
            let section = format!("{key}{suffix}");
            (
                display.expanded(&section, false),
                display.expanded(&section, true),
                display.toggled(&section),
                display.steps(&section),
            )
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
        || s.transcript_display.expanded(
            key,
            tool.status == "error"
                || settings::transcript_mode(s, TranscriptRow::tool(&tool.name)) == "expanded",
        );
    let is_task = task::is_task(tool);
    let nested = message.starts_with("child:");
    let report = is_task.then(|| task::report(s, tool)).flatten();
    let status = task::status(s, tool)
        .filter(|_| is_task)
        .unwrap_or(match tool.status.as_str() {
            "completed" if tool.name == "execute" && tool.metadata["error"] == true => {
                "toolCall.status.error"
            }
            "completed" => "toolCall.status.completed",
            "error" => "toolCall.status.error",
            "running" => "toolCall.status.running",
            "pending" | "streaming" => "toolCall.status.pending",
            _ => "toolCall.status.unknown",
        });
    let title = if tool.name == "execute" {
        execute::title(tool)
    } else if tool.name == "todowrite" {
        todo::title(tool)
    } else if tool.name == "question" {
        question::title(tool).into()
    } else {
        title(tool)
    };
    let toggle = key.to_owned();
    let mut parts = [""; 4];
    let pending = matches!(tool.status.as_str(), "pending" | "streaming");
    let lang = output(tool, &mut parts);
    if is_task {
        parts[0] = task::output(tool, report);
    }
    let has_output = !pending && parts.iter().any(|part| !part.trim().is_empty());
    let mut header = layout::action_row()
        .child(
            layout::button(
                &title,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                    if is_task && expanded {
                        s.transcript_display.children.release(&toggle);
                    }
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        )
        .child(text(t(status)).text_role(TextRole::Label));
    if has_output
        || tool.name == "todowrite"
            && tool.metadata["todos"]
                .as_array()
                .is_some_and(|todos| !todos.is_empty())
    {
        header = header.child(copy(s, message, &tool.id, Section::Output));
    }
    let header = if expanded && is_task && !nested {
        task::observe(s, key, tool, header)
    } else {
        header
    };
    let mut block = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header);
    let diagnostics = || diagnostics::view(s, key, tool);
    if !expanded {
        return block.children(diagnostics());
    }
    let failure = render_error(s, message, key, tool, query);
    if tool.name == "question"
        && let Some(questions) = question::view(s, key, tool)
    {
        return block
            .child(questions)
            .children(super::media::tool(s, key, &tool.pictures))
            .children(diagnostics());
    }
    if pending && tool.name != "todowrite" && tool.input.as_str().is_none_or(str::is_empty) {
        return block
            .child(text(t("toolCall.pending.waitingToRun")))
            .children(diagnostics());
    }
    if tool.name == "todowrite" {
        return block
            .children(failure)
            .child(todo::view(tool))
            .children(super::media::tool(s, key, &tool.pictures))
            .children(diagnostics());
    }
    let task_body = is_task
        .then(|| task::body(s, key, tool, parts[0], !nested))
        .flatten();
    let specialized_task = task_body.is_some();
    let execute_details = (tool.name == "execute")
        .then(|| execute::view(s, key, tool))
        .flatten();
    if let Some(details) = task_body.or(execute_details) {
        block = block.child(details);
    } else if !tool.input.is_null()
        && settings::transcript_mode(s, TranscriptRow::Inputs) != "hidden"
    {
        let input_key = format!("{key}-tool_input");
        let show = s.transcript_display.expanded(
            &input_key,
            settings::transcript_mode(s, TranscriptRow::Inputs) == "expanded",
        );
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
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !show)
                }),
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
    if has_output && !specialized_task {
        let formatted = (tool.name == "execute" && tool.status == "completed")
            .then(|| execute::formatted_output(parts[0]))
            .flatten();
        let (parts, lang) = if let Some(formatted) = formatted.as_deref() {
            ([formatted, "", "", ""], "json")
        } else {
            (parts, lang)
        };
        let terminal = shell::matches(tool) && parts.iter().any(|text| ansi::present(text));
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
                            if tool.status == "running" && shell::matches(tool) {
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
                    matches!(tool.name.as_str(), "edit" | "write"),
                ))
        };
        block = block.child(
            if !active
                && tool.name == "websearch"
                && tool.status == "completed"
                && let Some(results) = search::view(s, parts[0])
            {
                results
            } else if !active && !nested && tool_diff::candidate(tool, parts[0]) {
                tool_diff::body(s, message, key, tool, parts[0], path(tool), fallback)
            } else {
                fallback()
            },
        );
    }
    block = block.children(failure);
    if tool.name == "execute" {
        block = block.children(execute::notice(tool));
    }
    block
        .children(super::media::tool(s, key, &tool.pictures))
        .children(diagnostics())
}

fn render_error(
    s: &State,
    message: &str,
    key: &str,
    tool: &Tool,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> Option<El> {
    let error = error(tool);
    (tool.status == "error" && !error.is_empty()).then(|| {
        col()
            .full_width()
            .separate(Space::Sm)
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
            ))
    })
}

pub(crate) fn tool_key(message: &str, call: &str) -> String {
    let escaped = call.replace('%', "%25").replace('/', "%2F");
    format!("tool-{message}:{}:{escaped}", escaped.len())
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
