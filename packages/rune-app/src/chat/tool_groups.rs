use super::{actions::Display, tools};
use crate::{
    State,
    content::{Part, Tool},
    screen,
    settings::{TranscriptRow, transcript_mode},
    strings::locale,
};
use rune::El;
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
};
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
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

struct Summary {
    key: String,
    message: String,
    kind: Kind,
    count: usize,
    reads: usize,
    completed: bool,
}

struct Run {
    summary: Summary,
    chunks: Vec<(usize, std::ops::Range<usize>)>,
}

pub(super) struct Chunk {
    summary: Rc<Summary>,
    pub(super) end: usize,
    first: bool,
}

#[derive(Default)]
pub(super) struct Groups {
    chunks: HashMap<(usize, usize), Chunk>,
    waiting: HashMap<String, HashSet<String>>,
}

impl Groups {
    pub(super) fn project(s: &State) -> Self {
        let mut index = Self {
            waiting: waiting(s),
            ..Self::default()
        };
        if transcript_mode(s, TranscriptRow::Groups) == "hidden" {
            return index;
        }
        let mut run: Option<Run> = None;
        for (row, message) in s.messages.iter().enumerate() {
            if message.role != "assistant"
                || message.parts.is_empty() && !message.body.trim().is_empty()
            {
                index.finish(run.take(), true);
                continue;
            }
            let (head, tail) = super::transcript::part_window(
                message.parts.len(),
                s.transcript_display
                    .steps(&format!("parts-gap-{}", message.id)),
            );
            for (part, content) in message.parts.iter().enumerate() {
                if part >= head && part < tail {
                    index.finish(run.take(), true);
                    continue;
                }
                match content {
                    Part::Text(text) if text.text.trim().is_empty() => (),
                    Part::Tool(tool) if index.awaiting(&message.id, &tool.id) => {
                        index.finish(run.take(), true)
                    }
                    Part::Tool(tool) if !tools::visible(s, tool) => (),
                    Part::Tool(tool) if let Some(kind) = kind(tool) => {
                        if run.as_ref().is_some_and(|run| run.summary.kind != kind) {
                            index.finish(run.take(), true);
                        }
                        let run = run.get_or_insert_with(|| Run {
                            summary: Summary {
                                key: format!("group-{}", tools::tool_key(&message.id, &tool.id)),
                                message: message.id.clone(),
                                kind,
                                count: 0,
                                reads: 0,
                                completed: false,
                            },
                            chunks: Vec::new(),
                        });
                        run.summary.count += 1;
                        run.summary.reads += usize::from(tool.name == "read");
                        run.summary.completed = message.completed;
                        match run.chunks.last_mut() {
                            Some((last, range)) if *last == row => range.end = part + 1,
                            _ => run.chunks.push((row, part..part + 1)),
                        }
                    }
                    _ => index.finish(run.take(), true),
                }
            }
        }
        index.finish(run, false);
        index
    }

    fn finish(&mut self, run: Option<Run>, closed: bool) {
        let Some(Run {
            mut summary,
            chunks,
        }) = run.filter(|run| run.summary.count > 1)
        else {
            return;
        };
        summary.completed |= closed;
        let summary = Rc::new(summary);
        for (i, (row, range)) in chunks.into_iter().enumerate() {
            self.chunks.insert(
                (row, range.start),
                Chunk {
                    summary: summary.clone(),
                    end: range.end,
                    first: i == 0,
                },
            );
        }
    }

    pub(super) fn get(&self, row: usize, start: usize) -> Option<&Chunk> {
        self.chunks.get(&(row, start))
    }

    pub(super) fn awaiting(&self, message: &str, call: &str) -> bool {
        self.waiting
            .get(message)
            .is_some_and(|calls| calls.contains(call))
    }

    pub(super) fn collapsed_anchor(&self, s: &State, message: &str, key: &str) -> Option<String> {
        let (row, current) = s
            .messages
            .iter()
            .enumerate()
            .find(|(_, row)| row.id == message)?;
        let part = current.parts.iter().position(|part| matches!(part,
            Part::Tool(tool) if tools::visible(s, tool) && tools::tool_key(message, &tool.id) == key))?;
        let (_, chunk) = self
            .chunks
            .iter()
            .find(|((owner, start), chunk)| *owner == row && *start <= part && part < chunk.end)?;
        (!chunk.expanded(s)).then(|| format!("{}/{}", chunk.summary.message, chunk.summary.key))
    }
}

fn waiting(s: &State) -> HashMap<String, HashSet<String>> {
    let Some(agent) = &s.agent else {
        return HashMap::new();
    };
    let mut waiting: HashMap<String, HashSet<String>> = HashMap::new();
    for target in agent
        .permissions
        .iter()
        .filter_map(|req| req.tool.as_ref())
        .chain(agent.forms.iter().filter_map(|req| req.tool.as_ref()))
    {
        waiting
            .entry(target.message.clone())
            .or_default()
            .insert(target.call.clone());
    }
    if agent.forms.iter().any(|form| form.infer_websearch)
        && let Some((message, call)) = s.messages.iter().rev().find_map(|message| {
            message.parts.iter().rev().find_map(|part| match part {
                Part::Tool(tool) if tool.name == "websearch" => Some((&message.id, &tool.id)),
                _ => None,
            })
        })
    {
        waiting
            .entry(message.clone())
            .or_default()
            .insert(call.clone());
    }
    waiting
}

impl Chunk {
    fn expanded(&self, s: &State) -> bool {
        s.transcript_display.expanded(
            &self.summary.key,
            transcript_mode(s, TranscriptRow::Groups) == "expanded",
        )
    }

    pub(super) fn view(&self, s: &State, message: &str, parts: &[Part]) -> Option<El> {
        let summary = &self.summary;
        let key = &summary.key;
        let expanded = self.expanded(s);
        if !self.first && !expanded {
            return None;
        }
        let toggle = key.clone();
        let header = self.first.then(|| {
            layout::button(
                &summary.label(),
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::set_expanded(s, &toggle, !expanded);
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded)
        });
        let mut body = rune::col()
            .full_width()
            .separate(Space::Sm)
            .children(header);
        if expanded {
            body = body.children(parts.iter().filter_map(|part| match part {
                Part::Tool(tool) if tools::visible(s, tool) => Some(super::reading::passage(
                    s,
                    tools::view(s, message, tool),
                    message,
                    tools::tool_key(message, &tool.id),
                    Some(TranscriptRow::tool(&tool.name)),
                )),
                _ => None,
            }));
        }
        if self.first {
            body =
                super::reading::passage(s, body, message, key.clone(), Some(TranscriptRow::Groups));
        }
        Some(body)
    }
}

impl Summary {
    fn label(&self) -> String {
        if self.kind == Kind::Shell {
            return catalogue::format(
                locale(),
                if self.completed {
                    "messageBlock.shell.completed"
                } else {
                    "messageBlock.shell.active"
                },
                &[("count", &self.count.to_string())],
            );
        }
        let details = [("read", self.reads), ("search", self.count - self.reads)]
            .into_iter()
            .filter(|(_, count)| *count > 0)
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
            if self.completed {
                "messageBlock.exploration.completed"
            } else {
                "messageBlock.exploration.active"
            },
            &[("tools", &details)],
        )
    }
}
