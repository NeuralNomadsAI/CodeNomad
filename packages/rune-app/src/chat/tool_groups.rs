use super::{actions::Display, tools};
use crate::{
    State,
    content::{Part, Tool},
    screen,
    settings::{TranscriptRow, transcript_mode},
    strings::locale,
};
use rune::{El, col};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Exploration,
    Shell,
}

fn kind(tool: &Tool) -> Option<Kind> {
    match tool.name.as_str() {
        "read" | "glob" | "grep" => Some(Kind::Exploration),
        "bash" | "shell" => Some(Kind::Shell),
        _ => None,
    }
}

pub(super) fn view(
    s: &State,
    message: &str,
    parts: &[Part],
    completed: bool,
) -> Option<(El, usize)> {
    let mode = transcript_mode(s, TranscriptRow::Groups);
    if mode == "hidden" {
        return None;
    }
    let Part::Tool(first) = parts.first()? else {
        return None;
    };
    let group = kind(first)?;
    let mut calls = Vec::new();
    let mut end = 0;
    for (i, part) in parts.iter().enumerate() {
        match part {
            Part::Text(text) if text.text.trim().is_empty() => (),
            Part::Tool(tool) if !tools::visible(s, tool) => (),
            Part::Tool(tool) if kind(tool) == Some(group) => {
                calls.push(tool);
                end = i + 1;
            }
            _ => break,
        }
    }
    if calls.len() < 2 {
        return None;
    }
    let completed = completed
        || calls
            .iter()
            .all(|tool| matches!(tool.status.as_str(), "completed" | "error"));
    let summary = match group {
        Kind::Shell => catalogue::format(
            locale(),
            if completed {
                "messageBlock.shell.completed"
            } else {
                "messageBlock.shell.active"
            },
            &[("count", &calls.len().to_string())],
        ),
        Kind::Exploration => {
            let reads = calls.iter().filter(|tool| tool.name == "read").count();
            let details = [("read", reads), ("search", calls.len() - reads)]
                .into_iter()
                .filter(|(_, count)| *count != 0)
                .map(|(name, count)| {
                    catalogue::format(
                        locale(),
                        &format!(
                            "messageBlock.exploration.{name}.{}",
                            if count == 1 { "one" } else { "other" }
                        ),
                        &[("count", &count.to_string())],
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            catalogue::format(
                locale(),
                if completed {
                    "messageBlock.exploration.completed"
                } else {
                    "messageBlock.exploration.active"
                },
                &[("tools", &details)],
            )
        }
    };
    let key = format!("group-{}", tools::tool_key(message, &first.id));
    let expanded = s.transcript_display.expanded(&key, mode == "expanded");
    let toggle = key.clone();
    let mut view = col()
        .key(key.clone())
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::button(
                &summary,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        );
    if expanded {
        view = view.children(calls.into_iter().map(|tool| tools::view(s, message, tool)));
    }
    Some((view, end))
}
