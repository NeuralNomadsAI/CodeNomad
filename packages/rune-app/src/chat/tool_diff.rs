use super::document::TOOL_LIMIT;
use crate::{
    State,
    components::diff::{self, DiffMode, DiffState},
    content::Tool,
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};
use std::{collections::VecDeque, sync::Arc};

const RETAINED: usize = 32;

struct Entry {
    key: String,
    tool: Arc<Tool>,
    state: DiffState,
    lines: usize,
}

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    detached: DiffState,
}

impl Cache {
    fn read(&self, key: &str) -> &DiffState {
        self.entries
            .iter()
            .find(|entry| entry.key == key)
            .map_or(&self.detached, |entry| &entry.state)
    }

    fn edit(&mut self, key: &str) -> &mut DiffState {
        self.entries
            .iter_mut()
            .find(|entry| entry.key == key)
            .map_or(&mut self.detached, |entry| &mut entry.state)
    }

    fn load(&mut self, key: &str, tool: Arc<Tool>, patch: &str, path: &str, width: f32) -> bool {
        let former = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .and_then(|index| self.entries.remove(index));
        if former
            .as_ref()
            .is_some_and(|entry| Arc::ptr_eq(&entry.tool, &tool))
        {
            self.entries.extend(former);
            return false;
        }
        let files = if patch.trim_start().starts_with("@@ ")
            && !path.contains(['\r', '\n'])
            && !path.is_empty()
        {
            diff::parse(&format!(
                "--- a/{path}\n+++ b/{path}\n{}",
                patch.trim_start()
            ))
        } else {
            diff::parse(patch)
        };
        let lines = files
            .iter()
            .map(|file| {
                2 + file
                    .hunks
                    .iter()
                    .map(|hunk| 1 + hunk.lines.len())
                    .sum::<usize>()
            })
            .sum();
        let mut state = DiffState::new(files);
        state.set_wrap(former.as_ref().is_none_or(|entry| entry.state.wrap()));
        state.set_mode(former.as_ref().map_or(
            if width > 640.0 {
                DiffMode::Split
            } else {
                DiffMode::Unified
            },
            |entry| entry.state.mode(),
        ));
        if self.entries.len() >= RETAINED {
            self.entries.pop_front();
        }
        self.entries.push_back(Entry {
            key: key.into(),
            tool,
            state,
            lines,
        });
        true
    }
}

pub(super) fn candidate(tool: &Tool, patch: &str) -> bool {
    tool.name == "edit"
        && tool.status == "completed"
        && patch.encode_utf16().nth(TOOL_LIMIT).is_none()
        && patch.lines().any(|line| line.starts_with("@@ "))
}

pub(super) fn body(
    s: &State,
    key: &str,
    tool: &Arc<Tool>,
    patch: &str,
    path: &str,
    fallback: impl FnOnce() -> El,
) -> El {
    if let Some(entry) = s
        .transcript_display
        .diffs
        .entries
        .iter()
        .find(|entry| entry.key == key && Arc::ptr_eq(&entry.tool, tool))
    {
        if entry.state.files().iter().all(|file| file.hunks.is_empty()) {
            return fallback();
        }
        return view(s, key, entry, path);
    }
    let scope = s.input_scope.clone();
    let key = key.to_owned();
    let patch = patch.to_owned();
    let path = path.to_owned();
    let tool = tool.clone();
    markdown::on_visible_width(
        col()
            .full_width()
            .key(format!("{key}-load-{:p}", Arc::as_ptr(&tool)))
            .child(fallback()),
        move |s: &mut State, width, tx| {
            if s.current_scope(&scope)
                && s.messages.iter().flat_map(|row| &row.parts).any(|part|
                    matches!(part, crate::content::Part::Tool(current) if Arc::ptr_eq(current, &tool)))
                && s.transcript_display
                    .diffs
                    .load(&key, tool.clone(), &patch, &path, width)
            {
                s.revision += 1;
            } else {
                tx.live_only();
            }
        },
    )
}

fn view(s: &State, key: &str, entry: &Entry, path: &str) -> El {
    let split = entry.state.mode() == DiffMode::Split;
    let wrapped = entry.state.wrap();
    let file = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let title = if file.is_empty() {
        t("toolCall.diff.label").into()
    } else {
        catalogue::format(locale(), "toolCall.diff.label.withPath", &[("path", file)])
    };
    let mode_key = key.to_owned();
    let wrap_key = key.to_owned();
    let (read, write) = (key.to_owned(), key.to_owned());
    col()
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::action_row()
                .label(t("toolCall.diff.viewMode.ariaLabel"))
                .child(text(title))
                .child(
                    layout::button(
                        t(if split {
                            "toolCall.diff.switchToUnified"
                        } else {
                            "toolCall.diff.switchToSplit"
                        }),
                        false,
                        screen::action(&s.input_scope, move |s| {
                            s.transcript_display
                                .diffs
                                .edit(&mode_key)
                                .set_mode(if split {
                                    DiffMode::Unified
                                } else {
                                    DiffMode::Split
                                });
                            s.revision += 1;
                        }),
                    )
                    .key(format!("{key}-mode"))
                    .checked(split),
                )
                .child(
                    layout::button(
                        t(if wrapped {
                            "toolCall.diff.disableWordWrap"
                        } else {
                            "toolCall.diff.enableWordWrap"
                        }),
                        false,
                        screen::action(&s.input_scope, move |s| {
                            s.transcript_display
                                .diffs
                                .edit(&wrap_key)
                                .set_wrap(!wrapped);
                            s.revision += 1;
                        }),
                    )
                    .key(format!("{key}-wrap"))
                    .checked(wrapped),
                ),
        )
        .child(markdown::diff_pane(
            diff::view(
                s,
                format!("{key}-diff"),
                move |s| s.transcript_display.diffs.read(&read),
                move |s| s.transcript_display.diffs.edit(&write),
                None,
            ),
            entry.lines,
        ))
}
