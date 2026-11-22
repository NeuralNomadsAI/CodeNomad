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
use std::{
    collections::{HashSet, VecDeque},
    ops::Range,
    sync::Arc,
};

const RETAINED: usize = 32;

struct Entry {
    key: String,
    message: String,
    patch: String,
    file: String,
    state: DiffState,
    lines: usize,
}

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    visible: HashSet<String>,
    detached: DiffState,
}

impl Cache {
    pub(super) fn visible_rows(s: &mut State, range: Range<usize>) -> bool {
        let cache = &mut s.transcript_display.diffs;
        cache.visible.clear();
        if let Some(rows) = s.messages.get(range) {
            cache.visible.extend(rows.iter().map(|row| row.id.clone()));
        }
        false
    }

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

    fn load(&mut self, message: &str, key: &str, patch: &str, path: &str, width: f32) -> bool {
        let former = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .and_then(|index| self.entries.remove(index));
        if former
            .as_ref()
            .is_some_and(|entry| entry.patch == patch && entry.file == path)
        {
            self.entries.extend(former);
            return false;
        }
        if self.entries.len() >= RETAINED {
            let Some(index) = self
                .entries
                .iter()
                .position(|entry| !self.visible.contains(&entry.message))
            else {
                return false;
            };
            self.entries.remove(index);
        }
        let mut files = if patch.trim_start().starts_with("@@ ")
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
        // Chunked highlighting in the pinned Kit requires the next 128-line boundary to fit.
        let max_line = u32::MAX - 127;
        if files.iter().flat_map(|file| &file.hunks).any(|hunk| {
            [
                (hunk.old_start, hunk.old_count),
                (hunk.new_start, hunk.new_count),
            ]
            .into_iter()
            .any(|(start, count)| start.saturating_add(count) > max_line)
        }) {
            files.clear();
        }
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
        self.entries.push_back(Entry {
            key: key.into(),
            message: message.into(),
            patch: patch.into(),
            file: path.into(),
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
    message: &str,
    key: &str,
    tool: &Arc<Tool>,
    patch: &str,
    path: &str,
    fallback: impl FnOnce() -> El,
) -> El {
    let path = &path[..path.floor_char_boundary(path.len().min(4096))];
    if let Some(entry) = s
        .transcript_display
        .diffs
        .entries
        .iter()
        .find(|entry| entry.key == key && entry.patch == patch && entry.file == path)
    {
        if entry.state.files().iter().all(|file| file.hunks.is_empty()) {
            return fallback();
        }
        return view(s, key, entry, path);
    }
    let scope = s.input_scope.clone();
    let message = message.to_owned();
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
                && s.messages.iter().find(|row| row.id == message).into_iter().flat_map(|row| &row.parts).any(|part|
                    matches!(part, crate::content::Part::Tool(current) if Arc::ptr_eq(current, &tool)))
                && s.transcript_display
                    .diffs
                    .load(&message, &key, &patch, &path, width)
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
    let file = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .take(250)
        .collect::<String>();
    let title = if file.is_empty() {
        t("toolCall.diff.label").into()
    } else {
        catalogue::format(locale(), "toolCall.diff.label.withPath", &[("path", &file)])
    };
    let mode_key = key.to_owned();
    let wrap_key = key.to_owned();
    let (read, write) = (key.to_owned(), key.to_owned());
    let patch = entry.patch.clone();
    col()
        .full_width()
        .separate(Space::Sm)
        .child(
            layout::action_row()
                .label(t("toolCall.diff.viewMode.ariaLabel"))
                .child(text(title))
                .child(
                    markdown::copy_button(
                        t("toolCall.diff.copyPatch"),
                        screen::action_tx(&s.input_scope, move |_, tx| tx.copy(patch.as_str())),
                    )
                    .key(format!("{key}-copy-patch")),
                )
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
                        t(if wrapped || split {
                            "toolCall.diff.disableWordWrap"
                        } else {
                            "toolCall.diff.enableWordWrap"
                        }),
                        split,
                        screen::action(&s.input_scope, move |s| {
                            s.transcript_display
                                .diffs
                                .edit(&wrap_key)
                                .set_wrap(!wrapped);
                            s.revision += 1;
                        }),
                    )
                    .key(format!("{key}-wrap"))
                    .checked(wrapped || split),
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

#[cfg(test)]
#[test]
fn admission_never_evicts_a_still_visible_diff() {
    let mut cache = Cache::default();
    let patch = "@@ -1 +1 @@\n-A\n+B";
    for i in 0..RETAINED {
        let message = i.to_string();
        assert!(cache.load(&message, &message, patch, "file.rs", 960.0));
        cache.visible.insert(message);
    }
    for _ in 0..3 {
        assert!(!cache.load("next", "next", patch, "file.rs", 960.0));
        assert!(cache.entries.iter().any(|entry| entry.message == "0"));
    }
    cache.visible.remove("0");
    assert!(cache.load("next", "next", patch, "file.rs", 960.0));
    assert!(!cache.entries.iter().any(|entry| entry.message == "0"));
    assert_eq!(cache.entries.len(), RETAINED);
}
