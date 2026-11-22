use crate::{State, content::Part, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, attachment, layout, layout::Layout, workspace_tree::icons,
};
fn prose(key: String, body: &str) -> El {
    let code = body.starts_with("fn ") || body.starts_with("```");
    let element = text(body)
        .key(key)
        .full_width()
        .wrap()
        .text_role(if code { TextRole::Mono } else { TextRole::Body })
        .selectable(true);
    if code {
        element.literal_direction()
    } else {
        element.content_direction()
    }
}
pub fn message(s: &State, i: usize) -> El {
    let scope = s.input_scope.clone();
    let m = &s.messages[i];
    let mut view = col()
        .key(m.id.clone())
        .full_width()
        .pad(Space::Lg)
        .separate(Space::Sm)
        .child(
            text(t(if m.role == "user" {
                "messageItem.speaker.you"
            } else {
                "messageItem.speaker.assistant"
            }))
            .text_role(TextRole::Label),
        );
    if m.parts.iter().all(|p| matches!(p, Part::Text(_))) {
        return view.child(prose(format!("body-{}", m.id), &m.body));
    }
    if m.role == "user" && !m.body.is_empty() {
        view = view.child(prose(format!("body-{}", m.id), &m.body));
    }
    let mut files = layout::action_row().key("message-attachments");
    let mut has_files = false;
    let steps = |step| format!("attachments-{}-{step}", m.id);
    let shown = 500
        + (0..m.parts.len().div_ceil(1000))
            .take_while(|&step| s.expanded_tools.contains(&steps(step)))
            .count()
            * 1000;
    let hidden = m.parts.len().saturating_sub(shown + 500);
    for (index, part) in m.parts.iter().enumerate() {
        if m.role == "user" && (shown..shown + hidden).contains(&index) {
            if index == shown {
                let count = hidden.min(1000).to_string();
                let label = rune_theme_codenomad::catalogue::format(
                    crate::strings::locale(),
                    "messageBlock.hiddenParts.show",
                    &[("count", &count)],
                );
                let key = steps((shown - 500) / 1000);
                let button = crate::components::button(
                    &key,
                    &label,
                    false,
                    crate::screen::action(&scope, {
                        let key = key.clone();
                        move |s| crate::transcript_state::reveal_tool_output(s, &key)
                    }),
                );
                if matches!(part, Part::File(_)) {
                    has_files = true;
                    files = files.child(button);
                } else {
                    view = view.child(button);
                }
            }
            continue;
        }
        match part {
            Part::Text(body) => {
                if !body.text.is_empty() {
                    view = view.child(prose(format!("part-{}-{index}", m.id), &body.text));
                }
            }
            Part::Skill(skill) => {
                view = view.child(
                    rune::row().full_width().child(
                        attachment::chip(&skill.name, None, None)
                            .key(skill.id.clone())
                            .description_static(t("promptInput.skills.title")),
                    ),
                );
            }
            Part::File(file) => {
                has_files = true;
                let icon = if file.mime.starts_with("image/") {
                    &icons::IMAGE
                } else {
                    &icons::FILE
                };
                let name = file
                    .name
                    .as_deref()
                    .unwrap_or_else(|| t("messageItem.attachment.defaultName"));
                let button = file
                    .reference
                    .clone()
                    .filter(|_| crate::platform::attachment_export_available())
                    .map(|reference| {
                        let label = super::attachments::download_label(name);
                        let name = name.to_owned();
                        crate::components::button(
                            &format!("download-{}", file.id),
                            &label,
                            !s.attachments.available(),
                            crate::screen::action(&scope, move |s| {
                                super::attachments::Reader::request(s, &reference, &name)
                            }),
                        )
                    });
                files =
                    files.child(attachment::chip(name, Some(icon), button).key(file.id.clone()));
            }
            Part::Tool(tool) => {
                let key = format!("tool-{}-{}", m.id, tool.id);
                let expanded = s.expanded_tools.contains(&key);
                let status = match tool.status.as_str() {
                    "completed" => "toolCall.status.completed",
                    "error" => "rune.tool_error",
                    "running" => "toolCall.status.running",
                    _ => "rune.tool_pending",
                };
                let toggle = key.clone();
                let mut block = col()
                    .key(key.clone())
                    .full_width()
                    .pad(Space::Sm)
                    .separate(Space::Sm)
                    .inset_surface()
                    .child(
                        rune_theme_codenomad::layout::action_row()
                            .separate(Space::Md)
                            .child(text(&tool.name).text_role(TextRole::Label))
                            .child(text(t(status)))
                            .child(
                                rune_theme_codenomad::layout::button(
                                    t(if expanded {
                                        "rune.hide_details"
                                    } else {
                                        "rune.details"
                                    }),
                                    false,
                                    crate::screen::action(&scope, move |s: &mut State| {
                                        crate::transcript_state::toggle_tool(s, &toggle);
                                    }),
                                )
                                .key(format!("toggle-{key}")),
                            ),
                    );
                if expanded {
                    for (key_part, label, value) in [
                        ("tool_input", "rune.tool_input", &tool.input),
                        ("tool_output", "toolCall.task.sections.output", &tool.output),
                    ] {
                        if !value.is_empty() {
                            let reveal = format!("{key}-full-{key_part}");
                            let clipped = value.chars().count() > 10_000
                                && !s.expanded_tools.contains(&reveal);
                            let shown = if clipped {
                                value.chars().take(10_000).collect::<String>()
                            } else {
                                value.clone()
                            };
                            block = block
                                .child(text(t(label)).text_role(TextRole::Label))
                                .child(prose(format!("{key}-{key_part}"), &shown));
                            if clipped {
                                let button_key = format!("reveal-{reveal}");
                                block = block.child(
                                    rune_theme_codenomad::layout::button(
                                        t("messageBlock.hiddenText.showAll"),
                                        false,
                                        crate::screen::action(&scope, move |s: &mut State| {
                                            crate::transcript_state::reveal_tool_output(s, &reveal);
                                        }),
                                    )
                                    .key(button_key),
                                );
                            }
                        }
                    }
                    if tool.limited {
                        block = block.child(text(t("rune.tool_limited")));
                    }
                }
                view = view.child(block);
            }
        }
    }
    view.children(has_files.then_some(files))
}
