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
            "-tool_output_section",
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

pub(super) fn nested_card_expanded(s: &State, owner: &str, tool: &Tool, key: &str) -> bool {
    tool_query(s, owner, tool).is_some_and(|q| q.active)
        || s.transcript_display.expanded(key, false)
}

fn has_tool_input(tool: &Tool) -> bool {
    match &tool.input {
        serde_json::Value::Null => false,
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Object(map) => !map.is_empty(),
        serde_json::Value::Array(arr) => !arr.is_empty(),
        _ => true,
    }
}

pub(in crate::chat) fn match_hidden_by_inputs(
    s: &State,
    message: &str,
    tool: &Arc<Tool>,
    query: Query<'_>,
) -> bool {
    let key = tool_key(message, &tool.id);
    if settings::transcript_mode(s, TranscriptRow::Inputs) != "hidden"
        || !has_tool_input(tool)
        || s.transcript_display
            .expanded(&format!("{key}-tool_input"), false)
    {
        return false;
    }
    if !tool
        .input
        .as_str()
        .map(std::borrow::Cow::Borrowed)
        .or_else(|| {
            input_json(&tool.input, document::search_limit(Some(query)), true)
                .map(std::borrow::Cow::Owned)
        })
        .is_some_and(|input| query.matches(&input))
    {
        return false;
    }
    // Use the actual output renderer: shell commands, patches and errors can expose the same hit.
    let claimed = std::cell::Cell::new(false);
    let mut budget = super::children::STEP_LIMIT;
    let _ = render_body(
        s,
        message,
        tool,
        &key,
        &[],
        &mut budget,
        Some(Query {
            claimed: Some(&claimed),
            ..query
        }),
        true,
    );
    !claimed.get()
}

pub(super) fn render(s: &State, message: &str, tool: &Arc<Tool>, key: &str) -> El {
    let mut budget = super::children::STEP_LIMIT * 3;
    render_nested(s, message, tool, key, &[], &mut budget)
}

pub(super) fn render_nested(
    s: &State,
    message: &str,
    tool: &Arc<Tool>,
    key: &str,
    ancestors: &[&str],
    budget: &mut usize,
) -> El {
    let claimed = std::cell::Cell::new(false);
    let query = tool_query(s, message, tool).map(|query| Query {
        claimed: Some(&claimed),
        ..query
    });
    render_body(s, message, tool, key, ancestors, budget, query, false)
}

#[allow(clippy::too_many_arguments)]
fn render_body(
    s: &State,
    message: &str,
    tool: &Arc<Tool>,
    key: &str,
    ancestors: &[&str],
    budget: &mut usize,
    query: Option<Query<'_>>,
    probe: bool,
) -> El {
    let active = query.is_some_and(|q| q.active);
    let nested = !ancestors.is_empty() || message.starts_with("child:");
    let expanded = active
        || s.transcript_display.expanded(
            key,
            !nested
                && (tool.status == "error"
                    || settings::transcript_mode(s, TranscriptRow::tool(&tool.name)) == "expanded"),
        );
    let is_task = task::is_task(tool);
    let can_watch_child = is_task
        && ancestors.len() < task::MAX_DEPTH
        && task::watched_child(tool).is_some_and(|cid| !ancestors.contains(&cid));
    let task_delivery = is_task
        .then(|| task::delivery(s, message, tool, ancestors))
        .flatten();
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
    let structured = super::format::structured_output(tool);
    let has_output =
        !pending && (structured.is_some() || parts.iter().any(|part| !part.trim().is_empty()));
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
        && (tool.name != "apply_patch" || !apply_patch::has_patch(tool))
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
        text(t(status)).text_role(TextRole::Label).role("status")
    } else {
        super::duration::view(
            s,
            key,
            timing,
            text(t(status)).text_role(TextRole::Label).role("status"),
        )
    };
    let mut header = layout::action_row()
        .child(
            layout::button(
                &title,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                    if is_task && expanded {
                        super::children::Children::release(s, &toggle);
                        s.transcript_display.clear_step_anchors(&toggle);
                    }
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        )
        .child(status_el);
    if is_task
        && let Some(child_id) = task::watched_child(tool)
        && crate::workspace::active_session(s) != Some(child_id)
    {
        let parent_ref = task::parent_child(message);
        let unavailable = !s
            .transcript_display
            .children
            .has_open_tab_fallback(s, child_id)
            && s.transcript_display
                .children
                .unavailable(parent_ref, child_id);
        let parent = parent_ref.map(str::to_owned);
        let target = child_id.to_owned();
        header = header.child(
            layout::button_tx(
                t("messageBlock.tool.goToSession.label"),
                false,
                screen::action_tx(&s.input_scope, move |s, tx| {
                    super::children::Children::open_child(s, parent.as_deref(), &target, tx);
                }),
            )
            .key(format!("goto-{key}"))
            .disabled(unavailable || !crate::launcher::can_open_child_session(s)),
        );
    }
    let owner_parent = ancestors.len().checked_sub(2).map(|i| ancestors[i]);
    let owner_conversation = if let Some(child_id) = ancestors.last().copied() {
        document::Conversation::Child {
            parent: owner_parent,
            id: child_id,
        }
    } else {
        document::Conversation::Root
    };
    let tool_expand_key = message
        .strip_prefix("child:")
        .and_then(|v| v.split_once(':'))
        .and_then(|(child, row_id)| {
            s.transcript_display
                .children
                .tool_truncated(owner_parent, child, row_id, &tool.id)
                .then(|| super::children::ToolCopyKey {
                    key: format!("copy-{key}-output"),
                    parent: owner_parent.map(str::to_owned),
                    child: child.to_owned(),
                    row_id: row_id.to_owned(),
                    call: tool.id.clone(),
                    section: 1,
                })
        });
    let expanded_tool_output = tool_expand_key
        .as_ref()
        .and_then(|k| s.transcript_display.children.loaded_tool_output(k));
    let is_tool_truncated = tool_expand_key.is_some();
    let backgroundable = !nested
        && tool.status == "running"
        && matches!(
            tool.name.to_ascii_lowercase().as_str(),
            "bash" | "shell" | "task" | "subagent"
        );
    if backgroundable {
        header = header.child(
            layout::button(
                t("promptInput.background.title"),
                false,
                screen::action(&s.input_scope, |s| {
                    super::children::Children::background_session(s);
                }),
            )
            .key(format!("background-{key}")),
        );
    }
    if shared_wrap {
        header = header.child(wrap_control(s, &wrap_key, wrap));
    }
    if has_output
        || report_truncated
        || is_tool_truncated
        || !pending
            && matches!(tool.name.as_str(), "apply_patch" | "patch")
            && apply_patch::has_patch(tool)
        || tool.name == "todowrite"
            && tool.metadata["todos"]
                .as_array()
                .is_some_and(|todos| !todos.is_empty())
    {
        header = header.child(copy(s, message, key, &tool.id, Section::Output, ancestors));
    }
    let input_key = format!("{key}-tool_input");
    if !expanded && has_tool_input(tool) {
        let open_card = key.to_owned();
        let open_input = input_key.clone();
        header = header.child(
            layout::button(
                t("toolCall.header.showInputTitle"),
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &open_card, true);
                    Display::set_expanded(s, &open_input, true);
                }),
            )
            .key(format!("header-input-{key}")),
        );
    }
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
    let failure = render_error(s, message, key, tool, ancestors, query);
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
                task_delivery.as_ref().and_then(|d| d.report_location),
                report_truncated,
                ancestors,
                budget,
                query,
            )
        })
        .flatten();
    let specialized_task = is_task && (probe || task_body.is_some());
    // Specialized task prompts and execute scripts render inside the card body even when
    // generic tool inputs are hidden, matching Solid's tool-call.tsx.
    if probe && is_task {
        if let Some(q) = query
            && let Some(claimed) = q.claimed
            && !claimed.get()
        {
            let prompt = super::string(&tool.input, &["prompt"]);
            let output_conversation = (ancestors.len() < task::MAX_DEPTH)
                .then(|| task::watched_child(tool))
                .flatten()
                .filter(|id| !ancestors.contains(id))
                .map_or(document::Conversation::None, |id| {
                    document::Conversation::Child {
                        parent: task::parent_child(message),
                        id,
                    }
                });
            if (!prompt.is_empty()
                && document::bounded_prose_matches_for(
                    s,
                    key,
                    &format!("{key}-task-prompt"),
                    prompt,
                    task::PANE_LIMIT,
                    owner_conversation,
                    q,
                ))
                || (!parts[0].is_empty()
                    && document::bounded_prose_matches_for(
                        s,
                        key,
                        &format!("{key}-task-output"),
                        parts[0],
                        task::PANE_LIMIT,
                        output_conversation,
                        q,
                    ))
            {
                claimed.set(true);
            }
        }
    }
    let execute_details = (tool.name == "execute")
        .then(|| execute::view(s, key, tool, query))
        .flatten();
    let mut input_visible = false;
    if has_tool_input(tool) {
        let input_mode = settings::transcript_mode(s, TranscriptRow::Inputs);
        let show = s
            .transcript_display
            .expanded(&input_key, input_mode == "expanded");
        let allow_search_reveal = input_mode != "hidden";
        let input = (show || (active && allow_search_reveal))
            .then(|| {
                if let Some(raw) = tool.input.as_str() {
                    return Some((std::borrow::Cow::Borrowed(raw), false));
                }
                if let Some(small) = input_json(&tool.input, TOOL_LIMIT, false) {
                    return Some((std::borrow::Cow::Owned(small), false));
                }
                if active && allow_search_reveal {
                    let expanded = input_json(&tool.input, document::search_limit(query), true)?;
                    if query.is_some_and(|q| q.matches(&expanded)) {
                        return Some((std::borrow::Cow::Owned(expanded), true));
                    }
                }
                None
            })
            .flatten();
        let (input, input_matched) = match input {
            Some((text, matched)) => {
                let matched = matched
                    || (active && allow_search_reveal && query.is_some_and(|q| q.matches(&text)));
                (Some(text), matched)
            }
            None => (None, false),
        };
        let show = show || input_matched;
        input_visible = show;
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
            block = block.child(copy(s, message, key, &tool.id, Section::Input, ancestors));
            if let Some(input) = input {
                let limit = if input_matched {
                    document::search_limit(query)
                } else {
                    TOOL_LIMIT
                };
                block = block.child(markdown::tool_pane(
                    window(s, input_key, &[&input], limit, |shown, units| {
                        markdown::search_code(shown, "json", units <= HIGHLIGHT_LIMIT, true, query)
                    }),
                    false,
                ));
            } else {
                block = block.child(text(t("toolCall.output.tooLarge")).key(input_key));
            }
        }
    }
    if let Some(details) = task_body.or(execute_details) {
        block = block.child(details);
    }
    let lang = if tool.name == "read" {
        markdown::language_for_path(path(tool))
    } else {
        lang
    };
    let apply_patch_body = (!pending && tool.name == "apply_patch")
        .then(|| apply_patch::view(s, message, key, tool, query))
        .flatten();
    let has_apply_patch_body = apply_patch_body.is_some();
    let patch_native_fallback = has_apply_patch_body
        && tool.status == "completed"
        && !apply_patch::has_patch(tool)
        && !parts[0].trim().is_empty();
    let has_collapsible_output =
        has_apply_patch_body || skill || ((has_output || is_tool_truncated) && !specialized_task);
    let output_section_key = format!("{key}-tool_output_section");
    let output_expanded = if input_visible && has_collapsible_output && !active {
        let expanded = s.transcript_display.expanded(&output_section_key, true);
        let toggle = output_section_key.clone();
        block = block.child(
            layout::button(
                t("toolCall.io.output"),
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{key}-tool_output"))
            .expanded(expanded),
        );
        expanded
    } else {
        true
    };
    if output_expanded {
        if let Some(patch) = apply_patch_body {
            block = block.child(patch);
        }
        if patch_native_fallback || !has_apply_patch_body {
            if !patch_native_fallback
                && !pending
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
                        && document::skill_prose_matches(
                            s,
                            key,
                            &output_key,
                            parts[0],
                            owner_conversation,
                            q,
                        )
                    {
                        claimed.set(true);
                    }
                } else {
                    let clip_key = format!("{output_key}-pane");
                    block = block.child(document::clipped_tool_pane(s, &clip_key, false, || {
                        document::prose_search(
                            s,
                            message,
                            key,
                            output_key,
                            parts[0],
                            owner_conversation,
                            query,
                        )
                    }));
                }
            } else if tool.name == "apply_patch" && has_output && !is_tool_truncated {
                let output_key = format!("{key}-tool_output");
                if probe {
                    if let Some(q) = query
                        && let Some(claimed) = q.claimed
                        && !claimed.get()
                        && document::bounded_prose_matches_for(
                            s,
                            key,
                            &output_key,
                            parts[0],
                            TOOL_LIMIT,
                            owner_conversation,
                            q,
                        )
                    {
                        claimed.set(true);
                    }
                } else {
                    let clip_key = format!("{output_key}-pane");
                    block = block.child(document::clipped_tool_pane(s, &clip_key, false, || {
                        document::prose_pane_search(
                            s,
                            message,
                            key,
                            output_key,
                            parts[0],
                            tool.status == "running",
                            TOOL_LIMIT,
                            owner_conversation,
                            query,
                        )
                    }));
                }
            } else if (has_output || is_tool_truncated) && !specialized_task {
                let structured_out = if expanded_tool_output.is_some() {
                    None
                } else {
                    structured.map(|value| super::format::format_unknown(value, Some(TOOL_LIMIT)))
                };
                if matches!(structured_out, Some(super::format::Formatted::TooLarge)) {
                    block = block.child(text(t("toolCall.output.tooLarge")));
                } else if !matches!(structured_out, Some(super::format::Formatted::Empty)) {
                    let (formatted, formatted_lang) =
                        if let Some(super::format::Formatted::Text(text, lang)) = structured_out {
                            (Some(text), lang)
                        } else {
                            (
                                (tool.name == "execute"
                                    && tool.status == "completed"
                                    && expanded_tool_output.is_none())
                                .then(|| execute::formatted_output(parts[0]))
                                .flatten(),
                                "json",
                            )
                        };
                    let (parts, lang) = if let Some(full) = expanded_tool_output {
                        (
                            [full, "", "", ""],
                            if tool.name == "apply_patch" {
                                "diff"
                            } else {
                                lang
                            },
                        )
                    } else if let Some(formatted) = formatted.as_deref() {
                        ([formatted, "", "", ""], formatted_lang)
                    } else {
                        (parts, lang)
                    };
                    let output_key = format!("{key}-tool_output");
                    if has_output || expanded_tool_output.is_some() {
                        let terminal =
                            shell::matches(tool) && parts.iter().any(|text| ansi::present(text));
                        let highlight = tool.status != "running"
                            && (lang != "diff"
                                || parts
                                    .iter()
                                    .flat_map(|text| text.encode_utf16())
                                    .nth(TOOL_LIMIT)
                                    .is_none());
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
                                        output_key.clone(),
                                        &parts,
                                        document::search_limit_for(s, key, query),
                                        |shown, units| {
                                            if !probe
                                                && tool.status == "running"
                                                && shell::matches(tool)
                                            {
                                                s.transcript_display
                                                    .live_ansi(key, shown, wrap, query)
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
                    if let Some(expand_key) = tool_expand_key {
                        let copy_target = super::children::CopyKey::ToolSection(expand_key.clone());
                        if expanded_tool_output.is_none() {
                            let failed = s
                                .transcript_display
                                .children
                                .expand_tool_failed(&expand_key);
                            let reveal_key = output_key;
                            block = block.child(
                                layout::action_row()
                                    .child(text(t("toolCall.output.tooLarge")).role("status"))
                                    .child(
                                        layout::button(
                                            t("messageBlock.hiddenText.showAll"),
                                            false,
                                            screen::action(&s.input_scope, move |s| {
                                                super::children::Children::expand_tool_output(
                                                    s,
                                                    expand_key.clone(),
                                                );
                                                Display::reveal_next(s, &reveal_key);
                                            }),
                                        )
                                        .key(format!("expand-{key}-output")),
                                    ),
                            );
                            if failed {
                                block = block
                                    .child(text(t("sessionList.loadError.retry")).role("status"));
                            }
                        }
                        if s.transcript_display.children.copy_failed(&copy_target) {
                            block = block
                                .child(text(t("messageSection.quote.copyFailed")).role("status"));
                        } else if s.transcript_display.children.copy_copied(&copy_target) {
                            block = block
                                .child(text(t("markdown.codeBlock.copy.copied")).role("status"));
                        } else if s.transcript_display.children.copy_ready(&copy_target) {
                            block = block
                                .child(text(t("toolCall.io.copyOutputAriaLabel")).role("status"));
                        }
                    }
                }
            }
        }
    }
    block = block.children(failure);
    if tool.name == "execute" {
        block = block.children(execute::notice(tool));
    }
    let block = block
        .children(media::tool(s, key, &tool.pictures))
        .children(diagnostics());
    if !probe && can_watch_child {
        task::observe(s, key, task::parent_child(message), tool, block)
    } else {
        block
    }
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
    ancestors: &[&str],
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
                    .child(copy(s, message, key, &tool.id, Section::Error, ancestors)),
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
