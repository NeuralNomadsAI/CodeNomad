use super::format::{error, input_json, output, path, title};
use super::{
    Tool, apply_patch,
    clipboard::{Section, copy},
    diagnostics, execute, question, search, shell, task, todo, tool_key,
};
use crate::chat::{
    actions::Display,
    document::{self, HIGHLIGHT_LIMIT, TOOL_LIMIT, window},
    media, search_hit, tool_diff, tool_patch,
};
use crate::{
    State, screen,
    settings::{self, TranscriptRow},
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, ansi,
    layout::{self, Layout},
    markdown,
    timeline::search::Query,
};
use std::sync::Arc;

pub(in crate::chat) fn view(s: &State, message: &str, tool: &Arc<Tool>) -> El {
    let key = tool_key(message, &tool.id);
    if matches!(
        tool.name.as_str(),
        "apply_patch" | "execute" | "question" | "skill"
    ) || task::is_task(tool)
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
        std::array::from_fn::<_, { tool_patch::FILE_LIMIT }, _>(|index| {
            display.steps(&format!("{key}-patch-{index}"))
        })
    });
    let live_tick = (tool.status == "running" && tool.started.is_some() && tool.ended.is_none())
        .then(|| (display.tool_clock.epoch(), display.tool_clock.generation()));
    let stamp = (
        Arc::as_ptr(tool) as usize,
        std::rc::Rc::as_ptr(&s.input_scope) as usize,
        locale(),
        live_tick,
        display.search_revealed(&key),
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

fn tool_query<'a>(s: &'a State, message: &str, tool: &Tool) -> Option<Query<'a>> {
    search_hit::query(
        s,
        message,
        codenomad_client::search::Kind::Tool,
        tool.part_index,
    )
}

pub(in crate::chat) fn match_hidden_by_inputs(
    s: &State,
    message: &str,
    tool: &Arc<Tool>,
    query: Query<'_>,
) -> bool {
    if settings::transcript_mode(s, TranscriptRow::Inputs) != "hidden" || tool.input.is_null() {
        return false;
    }
    let key = tool_key(message, &tool.id);
    if !tool
        .input
        .as_str()
        .map(std::borrow::Cow::Borrowed)
        .or_else(|| {
            input_json(
                &tool.input,
                document::search_limit_for(s, &key, Some(query)),
                true,
            )
            .map(std::borrow::Cow::Owned)
        })
        .is_some_and(|input| query.matches(&input))
    {
        return false;
    }
    // Use the actual output renderer: shell commands, patches and errors can expose the same hit.
    let claimed = std::cell::Cell::new(false);
    let _ = render_body(
        s,
        message,
        tool,
        &key,
        Some(Query {
            claimed: Some(&claimed),
            ..query
        }),
        true,
    );
    !claimed.get()
}

pub(super) fn render(s: &State, message: &str, tool: &Arc<Tool>, key: &str) -> El {
    let claimed = std::cell::Cell::new(false);
    let query = tool_query(s, message, tool).map(|query| Query {
        claimed: Some(&claimed),
        ..query
    });
    render_body(s, message, tool, key, query, false)
}

fn render_body(
    s: &State,
    message: &str,
    tool: &Arc<Tool>,
    key: &str,
    query: Option<Query<'_>>,
    probe: bool,
) -> El {
    let active = query.is_some_and(|q| q.active);
    let expanded = active
        || s.transcript_display.expanded(
            key,
            tool.status == "error"
                || settings::transcript_mode(s, TranscriptRow::tool(&tool.name)) == "expanded",
        );
    let is_task = task::is_task(tool);
    let nested = message.starts_with("child:");
    let task_delivery = is_task.then(|| task::delivery(s, message, tool)).flatten();
    let status = task_delivery
        .as_ref()
        .map(|d| d.status)
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
    } else if tool.name == "apply_patch" {
        apply_patch::title(tool)
    } else {
        title(tool)
    };
    let toggle = key.to_owned();
    let mut parts = [""; 4];
    let pending = matches!(tool.status.as_str(), "pending" | "streaming");
    let lang = output(tool, &mut parts);
    if is_task {
        parts[0] = task::output(tool, task_delivery.as_ref().and_then(|d| d.report));
    } else if tool.name == "skill" && tool.status != "completed" {
        parts = [""; 4];
    }
    let report_truncated = task_delivery.as_ref().is_some_and(|d| d.report_truncated);
    let has_output = !pending && parts.iter().any(|part| !part.trim().is_empty());
    let skill = tool.name == "skill" && tool.status == "completed" && has_output;
    let result_list =
        (expanded && !active && tool.name == "websearch" && tool.status == "completed")
            .then(|| search::view(s, parts[0]))
            .flatten();
    let rich_diff = !active && !nested && tool_diff::candidate(tool, parts[0]);
    let wrap_key = format!("{key}-wrap");
    let wrap = !s.transcript_display.toggled(&wrap_key);
    let shared_wrap = expanded
        && has_output
        && !is_task
        && !skill
        && !is_patch(tool)
        && result_list.is_none()
        && !rich_diff
        && !matches!(tool.name.as_str(), "question" | "todowrite");
    // Per dev-docs/TRANSCRIPT.md, latestChildState drives both status and end time
    // across every launch/continuation card of the same background child.
    let timing = if let Some(delivery) = &task_delivery {
        if delivery.running {
            tool.started.map(|start| (start, None))
        } else {
            tool.started.zip(delivery.ended.map(Some))
        }
    } else {
        super::duration::tool_timing(tool)
    };
    let status_el = if probe {
        text(t(status)).text_role(TextRole::Label)
    } else {
        super::duration::view(s, key, timing, text(t(status)).text_role(TextRole::Label))
    };
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
        .child(status_el);
    if shared_wrap {
        header = header.child(wrap_control(s, &wrap_key, wrap));
    }
    if (has_output && !report_truncated)
        || !pending && tool.name == "apply_patch" && apply_patch::has_patch(tool)
        || tool.name == "todowrite"
            && tool.metadata["todos"]
                .as_array()
                .is_some_and(|todos| !todos.is_empty())
    {
        header = header.child(copy(s, message, &tool.id, Section::Output));
    }
    let header = if !probe && expanded && is_task && !nested {
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
            .children(media::tool(s, key, &tool.pictures))
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
            .children(media::tool(s, key, &tool.pictures))
            .children(diagnostics());
    }
    let task_body = (is_task && !probe)
        .then(|| {
            task::body(
                s,
                message,
                key,
                tool,
                parts[0],
                report_truncated,
                !nested,
                query,
            )
        })
        .flatten();
    let specialized_task = is_task && (probe || task_body.is_some());
    if probe && is_task {
        if let Some(q) = query
            && let Some(claimed) = q.claimed
            && !claimed.get()
        {
            let prompt = super::string(&tool.input, &["prompt"]);
            if (!prompt.is_empty()
                && document::bounded_prose_matches_for(
                    s,
                    key,
                    &format!("{key}-task-prompt"),
                    prompt,
                    task::PANE_LIMIT,
                    q,
                ))
                || (!parts[0].is_empty()
                    && document::bounded_prose_matches_for(
                        s,
                        key,
                        &format!("{key}-task-output"),
                        parts[0],
                        task::PANE_LIMIT,
                        q,
                    ))
            {
                claimed.set(true);
            }
        }
    }
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
                        input_json(
                            &tool.input,
                            document::search_limit_for(s, key, query),
                            active,
                        )
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
                        document::search_limit_for(s, key, query),
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
    let apply_patch_body = (!pending && query.is_none() && tool.name == "apply_patch")
        .then(|| apply_patch::view(s, message, key, tool))
        .flatten();
    if let Some(patch) = apply_patch_body {
        block = block.child(patch);
    } else {
        if !pending
            && is_patch(tool)
            && let Some(patch) = tool_patch::view(s, tool, key, query)
        {
            block = block.child(patch);
        }
        if skill {
            let output_key = format!("{key}-tool_output");
            if probe {
                if let Some(q) = query
                    && let Some(claimed) = q.claimed
                    && !claimed.get()
                    && document::skill_prose_matches(s, key, &output_key, parts[0], q)
                {
                    claimed.set(true);
                }
            } else {
                block = block.child(markdown::tool_pane(
                    document::prose_search(s, message, key, output_key, parts[0], query),
                    false,
                ));
            }
        } else if has_output && !specialized_task {
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
            let fallback = || {
                col()
                    .full_width()
                    .separate(Space::Sm)
                    .children((!shared_wrap).then(|| {
                        layout::action_row()
                            .child(wrap_control(s, &wrap_key, wrap))
                            .child(text(lang).text_role(TextRole::Label))
                    }))
                    .child(markdown::tool_pane(
                        window(
                            s,
                            output_key,
                            &parts,
                            document::search_limit_for(s, key, query),
                            |shown, units| {
                                if !probe && tool.status == "running" && shell::matches(tool) {
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
            block = block.child(if let Some(results) = result_list {
                results
            } else if rich_diff {
                tool_diff::body(s, message, key, tool, parts[0], path(tool), fallback)
            } else {
                fallback()
            });
        }
    }
    block = block.children(failure);
    if tool.name == "execute" {
        block = block.children(execute::notice(tool));
    }
    block
        .children(media::tool(s, key, &tool.pictures))
        .children(diagnostics())
}

fn wrap_control(s: &State, key: &str, wrap: bool) -> El {
    let key = key.to_owned();
    layout::button(
        t(if wrap {
            "toolCall.diff.disableWordWrap"
        } else {
            "toolCall.diff.enableWordWrap"
        }),
        false,
        screen::action(&s.input_scope, {
            let key = key.clone();
            move |s| Display::toggle(s, &key)
        }),
    )
    .key(key)
    .checked(wrap)
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
                    document::search_limit_for(s, key, query),
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

#[cfg(test)]
mod tests;
