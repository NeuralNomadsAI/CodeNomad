use super::document::TOOL_LIMIT;
use crate::{
    State,
    components::diff::{self, DiffMode, DiffState},
    content::Tool,
    screen,
    strings::{locale, t},
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};
use std::{
    cell::Cell,
    collections::VecDeque,
    rc::{Rc, Weak},
    sync::Arc,
};

const RETAINED: usize = 32;

pub(crate) struct Preferences {
    mode: DiffMode,
    compact: bool,
    compact_mode: Option<DiffMode>,
    wrap: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: DiffMode::Split,
            compact: false,
            compact_mode: None,
            wrap: true,
        }
    }
}

impl Preferences {
    fn effective_mode(&self) -> DiffMode {
        if self.compact {
            self.compact_mode.unwrap_or(DiffMode::Unified)
        } else {
            self.mode
        }
    }

    pub(crate) fn layout(s: &mut State, [_, _, width, _]: [f32; 4], tx: &mut Tx) {
        let compact = width <= 640.0;
        if compact == s.tool_diff_preferences.compact {
            tx.live_only();
            return;
        }
        s.tool_diff_preferences.compact = compact;
        s.tool_diff_preferences.compact_mode = None;
        Self::sync(s);
        s.revision += 1;
    }

    pub(crate) fn sync(s: &mut State) {
        for entry in &mut s.transcript_display.diffs.entries {
            s.tool_diff_preferences.apply(&mut entry.state);
        }
    }

    fn apply(&self, state: &mut DiffState) {
        if state.mode() != self.effective_mode() {
            state.set_mode(self.effective_mode());
        }
        if state.wrap() != self.wrap {
            state.set_wrap(self.wrap);
        }
    }
}

struct Entry {
    key: String,
    // Unmounting silently drops Rune's visibility handler, even without a false event.
    visible: Weak<Cell<bool>>,
    patch: String,
    file: String,
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

    fn load(
        &mut self,
        key: &str,
        patch: &str,
        path: &str,
        visible: &Rc<Cell<bool>>,
        preferences: &Preferences,
    ) -> bool {
        let former = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .and_then(|index| self.entries.remove(index));
        if former
            .as_ref()
            .is_some_and(|entry| entry.patch == patch && entry.file == path)
        {
            self.entries.extend(former.map(|mut entry| {
                entry.visible = Rc::downgrade(visible);
                entry
            }));
            return false;
        }
        if self.entries.len() >= RETAINED {
            let Some(index) = self
                .entries
                .iter()
                .position(|entry| entry.visible.upgrade().is_none_or(|visible| !visible.get()))
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
            .filter(|file| !file.hunks.is_empty())
            .map(|file| {
                2 + file
                    .hunks
                    .iter()
                    .map(|hunk| 1 + hunk.lines.len())
                    .sum::<usize>()
            })
            .sum();
        let mut state = DiffState::new(files);
        preferences.apply(&mut state);
        self.entries.push_back(Entry {
            key: key.into(),
            visible: Rc::downgrade(visible),
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
    let entry = s
        .transcript_display
        .diffs
        .entries
        .iter()
        .find(|entry| entry.key == key && entry.patch == patch && entry.file == path);
    let visible = entry
        .and_then(|entry| entry.visible.upgrade())
        .unwrap_or_default();
    let content = match entry {
        Some(entry) if entry.lines > 0 => view(s, key, entry, path),
        _ => fallback(),
    };
    let scope = s.input_scope.clone();
    let message = message.to_owned();
    let key = key.to_owned();
    let patch = patch.to_owned();
    let path = path.to_owned();
    let tool = tool.clone();
    col()
        .full_width()
        .key(format!("{key}-card-{:p}-{:p}", Rc::as_ptr(&scope), Arc::as_ptr(&tool)))
        .child(content)
        .on_visible(move |s: &mut State, on, tx| {
            visible.set(on);
            if on && s.current_scope(&scope)
                && s.messages.iter().find(|row| row.id == message).into_iter().flat_map(|row| &row.parts).any(|part|
                    matches!(part, crate::content::Part::Tool(current) if Arc::ptr_eq(current, &tool)))
                && s.transcript_display
                    .diffs
                    .load(&key, &patch, &path, &visible, &s.tool_diff_preferences)
            {
                s.revision += 1;
            } else {
                tx.live_only();
            }
        })
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
                            let mode = if split {
                                DiffMode::Unified
                            } else {
                                DiffMode::Split
                            };
                            s.tool_diff_preferences.mode = mode;
                            if s.tool_diff_preferences.compact {
                                s.tool_diff_preferences.compact_mode = Some(mode);
                            }
                            Preferences::sync(s);
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
                            s.tool_diff_preferences.wrap = !wrapped;
                            Preferences::sync(s);
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
    let preferences = Preferences::default();
    let patch = "@@ -1 +1 @@\n-A\n+B";
    let cards: Vec<_> = (0..RETAINED).map(|_| Rc::new(Cell::new(true))).collect();
    for (i, visible) in cards.iter().enumerate() {
        assert!(cache.load(&i.to_string(), patch, "file.rs", visible, &preferences));
    }
    let next = Rc::new(Cell::new(true));
    for _ in 0..3 {
        assert!(!cache.load("next", patch, "file.rs", &next, &preferences));
        assert!(cache.entries.iter().any(|entry| entry.key == "0"));
    }
    cards[0].set(false);
    assert!(cache.load("next", patch, "file.rs", &next, &preferences));
    assert!(!cache.entries.iter().any(|entry| entry.key == "0"));
    assert_eq!(cache.entries.len(), RETAINED);
}
