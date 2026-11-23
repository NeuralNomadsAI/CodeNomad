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
use std::{collections::HashMap, rc::Rc};

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
pub(super) struct Groups(HashMap<(usize, usize), Chunk>);

impl Groups {
    pub(super) fn project(s: &State) -> Self {
        let mut index = Self::default();
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
                    Part::Tool(tool) if !tools::visible(s, tool) => (),
                    Part::Tool(tool) if let Some(kind) = kind(tool) => {
                        if run.as_ref().is_some_and(|run| run.summary.kind != kind) {
                            index.finish(run.take(), true);
                        }
                        let run = run.get_or_insert_with(|| Run {
                            summary: Summary {
                                key: format!("group-{}", tools::tool_key(&message.id, &tool.id)),
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
            self.0.insert(
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
        self.0.get(&(row, start))
    }
}

impl Chunk {
    pub(super) fn view(&self, s: &State, message: &str, parts: &[Part]) -> Option<El> {
        let summary = &self.summary;
        let key = &summary.key;
        let expanded = s
            .transcript_display
            .expanded(key, transcript_mode(s, TranscriptRow::Groups) == "expanded");
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
