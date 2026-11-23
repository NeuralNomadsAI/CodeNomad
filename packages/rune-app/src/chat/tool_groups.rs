use super::{actions::Display, tools};
use crate::{
    State,
    content::{Part, Tool},
    screen,
    settings::{TranscriptRow, transcript_mode},
    strings::locale,
};
use codenomad_client::search::Kind as SearchKind;
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
    track: &mut impl FnMut(Option<usize>, El) -> El,
    start: usize,
) -> Option<(El, usize)> {
    let (group, calls, end) = members(s, message, parts)?;
    let mode = transcript_mode(s, TranscriptRow::Groups);
    let first = calls.first()?.1;
    let completed = completed
        || calls
            .iter()
            .all(|(_, tool)| matches!(tool.status.as_str(), "completed" | "error"));
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
            let reads = calls.iter().filter(|(_, tool)| tool.name == "read").count();
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
    let key = key(message, first);
    let expanded = expanded(s, message, &key, mode, &calls);
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
        view = view.children(
            calls
                .into_iter()
                .map(|(offset, tool)| track(Some(start + offset), tools::view(s, message, tool))),
        );
    } else {
        view = track(Some(start), view);
    }
    Some((view, end))
}

fn key(message: &str, first: &Tool) -> String {
    format!("group-{}", tools::tool_key(message, &first.id))
}

fn expanded(
    s: &State,
    message: &str,
    key: &str,
    mode: &str,
    calls: &[(usize, &std::sync::Arc<Tool>)],
) -> bool {
    s.transcript_display.expanded(key, mode == "expanded")
        || calls.iter().any(|(_, tool)| {
            super::search_hit::query(s, message, SearchKind::Tool, tool.part_index)
                .is_some_and(|q| q.active)
        })
}

fn members<'a>(
    s: &State,
    message: &str,
    parts: &'a [Part],
) -> Option<(Kind, Vec<(usize, &'a std::sync::Arc<Tool>)>, usize)> {
    if transcript_mode(s, TranscriptRow::Groups) == "hidden" {
        return None;
    }
    let Part::Tool(first) = parts.first()? else {
        return None;
    };
    if !tools::visible(s, message, first) || tools::awaiting_input(s, message, first) {
        return None;
    }
    let group = kind(first)?;
    let mut calls = Vec::new();
    let mut end = 0;
    for (i, part) in parts.iter().enumerate() {
        match part {
            Part::Text(text) if text.text.trim().is_empty() => (),
            Part::Tool(tool) if tools::awaiting_input(s, message, tool) => break,
            Part::Tool(tool) if !tools::visible(s, message, tool) => (),
            Part::Tool(tool) if kind(tool) == Some(group) => {
                calls.push((i, tool));
                end = i + 1;
            }
            _ => break,
        }
    }
    (calls.len() >= 2).then_some((group, calls, end))
}

pub(super) fn anchor(s: &State, message: &str, parts: &[Part], target: usize) -> Option<String> {
    let mode = transcript_mode(s, TranscriptRow::Groups);
    if mode == "hidden" {
        return None;
    }
    let mut start = 0;
    while start <= target {
        if let Some((_, calls, end)) = members(s, message, &parts[start..]) {
            if target < start + end {
                let key = key(message, calls.first()?.1);
                return (!expanded(s, message, &key, mode, &calls)).then_some(key);
            }
            start += end;
        } else {
            start += 1;
        }
    }
    None
}

#[cfg(test)]
#[test]
fn a_pending_tool_stays_out_of_both_collapsed_group_kinds() {
    use serde_json::json;
    crate::platform::block_on(async {
        let mut s = crate::init();
        crate::settings::fixture_transcript(&mut s, json!({"toolGroupVisibility":"collapsed"}));
        let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let mut agent = crate::agent::Ui::new(crate::agent::start(backend, s.wake.clone()));
        agent.permissions = crate::agent_api::permissions(
            &json!({"data":[{
                "id":"permission","sessionID":"session","action":"read","resources":[],
                "source":{"type":"tool","id":"pending","messageID":"step"}
            }]}),
            "session",
        )
        .unwrap();
        s.agent = Some(agent);
        for name in ["bash", "read"] {
            let content = ["a", "b", "pending", "c", "d"].map(|id| {
                json!({"type":"tool","id":id,"name":name,"state":{"status":"completed","input":{}}})
            });
            let message = crate::history::decode_message(
                &json!({"id":"step","type":"assistant","content":content}),
            )
            .unwrap();
            assert_eq!(
                anchor(&s, "step", &message.parts, 0).as_deref(),
                Some("group-tool-step:1:a")
            );
            assert!(anchor(&s, "step", &message.parts, 2).is_none());
            assert_eq!(
                anchor(&s, "step", &message.parts, 4).as_deref(),
                Some("group-tool-step:1:c")
            );
        }
    });
}
