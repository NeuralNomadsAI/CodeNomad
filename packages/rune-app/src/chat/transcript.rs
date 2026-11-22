use crate::{State, content::Part, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout};
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
    for (index, part) in m.parts.iter().enumerate() {
        match part {
            Part::Text(body) => {
                view = view.child(prose(format!("part-{}-{index}", m.id), &body.text))
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
                                )
                                .key(format!("toggle-{key}"))
                                .on_press(crate::screen::action(&scope, move |s: &mut State| {
                                    crate::transcript_state::toggle_tool(s, &toggle);
                                })),
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
                                block = block.child(
                                    rune_theme_codenomad::layout::button(
                                        t("messageBlock.hiddenText.showAll"),
                                        false,
                                    )
                                    .key(format!("reveal-{reveal}"))
                                    .on_press(
                                        crate::screen::action(&scope, move |s: &mut State| {
                                            crate::transcript_state::reveal_tool_output(s, &reveal);
                                        }),
                                    ),
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
    view
}
