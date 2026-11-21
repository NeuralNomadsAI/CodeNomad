use crate::{State, content::Part, strings::t, surfaces};
use rune::{El, col, row, text, tok::type_};
fn prose(key: String, body: &str) -> El {
    text(body)
        .key(key)
        .w_full()
        .wrap()
        .font(if body.starts_with("fn ") || body.starts_with("```") {
            type_::BODY.mono()
        } else {
            type_::BODY
        })
        .color(surfaces::get().text)
        .selectable(true)
}
pub fn message(s: &State, i: usize) -> El {
    let m = &s.messages[i];
    let mut view = col()
        .key(m.id.clone())
        .w_full()
        .padding(18.0)
        .gap(8.0)
        .child(
            text(t(if m.role == "user" {
                "user"
            } else {
                "assistant"
            }))
            .font(type_::LABEL)
            .color(surfaces::get().text),
        );
    if m.parts.iter().all(|p| matches!(p, Part::Text(_))) {
        return view.child(prose(format!("body-{}", m.id), &m.body));
    }
    for (index, part) in m.parts.iter().enumerate() {
        match part {
            Part::Text(body) => view = view.child(prose(format!("part-{}-{index}", m.id), body)),
            Part::Tool(tool) => {
                let key = format!("tool-{}-{}", m.id, tool.id);
                let expanded = s.expanded_tools.contains(&key);
                let status = match tool.status.as_str() {
                    "completed" => "tool_done",
                    "error" => "tool_error",
                    "running" => "tool_running",
                    _ => "tool_pending",
                };
                let toggle = key.clone();
                let mut block = col()
                    .key(key.clone())
                    .w_full()
                    .padding(10.0)
                    .gap(8.0)
                    .fill(surfaces::get().control)
                    .child(
                        row()
                            .gap(12.0)
                            .child(text(&tool.name).font(type_::LABEL))
                            .child(text(t(status)))
                            .child(
                                text(t(if expanded { "hide_details" } else { "details" }))
                                    .key(format!("toggle-{key}"))
                                    .role("button")
                                    .focusable(true)
                                    .on_press(move |s: &mut State| {
                                        if !s.expanded_tools.remove(&toggle) {
                                            s.expanded_tools.insert(toggle.clone());
                                        }
                                        s.revision += 1;
                                    }),
                            ),
                    );
                if expanded {
                    for (label, value) in
                        [("tool_input", &tool.input), ("tool_output", &tool.output)]
                    {
                        if !value.is_empty() {
                            let reveal = format!("{key}-full-{label}");
                            let clipped = value.chars().count() > 10_000
                                && !s.expanded_tools.contains(&reveal);
                            let shown = if clipped {
                                value.chars().take(10_000).collect::<String>()
                            } else {
                                value.clone()
                            };
                            block = block
                                .child(text(t(label)).font(type_::LABEL))
                                .child(prose(format!("{key}-{label}"), &shown));
                            if clipped {
                                block = block.child(
                                    text(t("tool_more"))
                                        .key(format!("reveal-{reveal}"))
                                        .role("button")
                                        .focusable(true)
                                        .on_press(move |s: &mut State| {
                                            s.expanded_tools.insert(reveal.clone());
                                            s.revision += 1;
                                        }),
                                );
                            }
                        }
                    }
                    if tool.limited {
                        block = block.child(text(t("tool_limited")));
                    }
                }
                view = view.child(block);
            }
        }
    }
    view
}
