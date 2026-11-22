use super::{actions::Display, document::TOOL_LIMIT};
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
    layout::{self, DrawnRect, Layout},
    markdown,
};
use std::{
    collections::VecDeque,
    rc::{Rc, Weak},
    sync::Arc,
};

const RETAINED: usize = 32;

pub(crate) struct Preferences {
    mode: DiffMode,
    compact: bool,
    layout_epoch: u64,
    history_size: [f32; 2],
    history_epoch: u64,
    pub(crate) history_bounds: DrawnRect,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mode: DiffMode::Split,
            compact: false,
            layout_epoch: 0,
            history_size: [0.0; 2],
            history_epoch: 0,
            history_bounds: DrawnRect::new([0.0; 4]),
        }
    }
}

impl Preferences {
    fn effective_mode(&self, compact_split: bool) -> DiffMode {
        match (self.compact, compact_split) {
            (true, true) => DiffMode::Split,
            (true, false) => DiffMode::Unified,
            (false, _) => self.mode,
        }
    }

    pub(crate) fn layout(s: &mut State, [_, _, width, _]: [f32; 4], tx: &mut Tx) {
        let compact = width <= 640.0;
        if compact == s.tool_diff_preferences.compact {
            tx.live_only();
            return;
        }
        s.tool_diff_preferences.compact = compact;
        s.tool_diff_preferences.layout_epoch += 1;
        Self::sync(s);
        s.revision += 1;
    }

    pub(crate) fn sync(s: &mut State) {
        let p = &s.tool_diff_preferences;
        s.transcript_display
            .sync_diff_modes(p.layout_epoch, |split| p.effective_mode(split));
    }

    pub(crate) fn history_layout(s: &mut State, [_, _, w, h]: [f32; 4], tx: &mut Tx) {
        let p = &mut s.tool_diff_preferences;
        if p.history_size == [w, h] {
            tx.live_only();
        } else {
            p.history_size = [w, h];
            p.history_epoch += 1;
            s.revision += 1;
        }
    }
}

fn intersects([x, y, w, h]: [f32; 4], [left, top, width, height]: [f32; 4]) -> bool {
    w > 0.0
        && h > 0.0
        && width > 0.0
        && height > 0.0
        && x < left + width
        && left < x + w
        && y < top + height
        && top < y + h
}

struct Entry {
    key: String,
    bounds: Weak<DrawnRect>,
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
    pub(super) fn sync(&mut self, mode: impl Fn(&str) -> DiffMode) {
        for entry in &mut self.entries {
            entry.state.set_mode(mode(&entry.key));
        }
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

    fn load(
        &mut self,
        key: &str,
        patch: &str,
        path: &str,
        bounds: &Rc<DrawnRect>,
        preferences: &Preferences,
        (mode, wrap): (DiffMode, bool),
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
                entry.bounds = Rc::downgrade(bounds);
                entry
            }));
            return false;
        }
        if self.entries.len() >= RETAINED {
            let Some(index) = self.entries.iter().position(|entry| {
                entry.bounds.upgrade().is_none_or(|bounds| {
                    !intersects(bounds.get(), preferences.history_bounds.get())
                })
            }) else {
                return false;
            };
            self.entries.remove(index);
        }
        let mut files = parse_patch(patch, path);
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
        state.set_mode(mode);
        state.set_wrap(wrap);
        self.entries.push_back(Entry {
            key: key.into(),
            bounds: Rc::downgrade(bounds),
            patch: patch.into(),
            file: path.into(),
            state,
            lines,
        });
        true
    }
}

fn parse_patch(patch: &str, path: &str) -> Vec<diff::FileDiff> {
    let mut patch = patch.trim_start();
    if let Some((fence, body)) = patch.split_once('\n')
        && fence.starts_with("```")
        && let Some((body, end)) = body.trim_end().rsplit_once('\n')
        && end.starts_with("```")
    {
        patch = body;
    }
    let mut lines = patch.lines().peekable();
    if lines.peek() == Some(&"*** Begin Patch") {
        lines.next();
        while lines.next_if(|line| line.trim().is_empty()).is_some() {}
    }
    if lines
        .peek()
        .is_some_and(|line| line.starts_with("*** Update File: "))
    {
        let mut unified = String::new();
        let (mut old, mut new) = (1, 1);
        while let Some(line) = lines.next() {
            if let Some(path) = line.strip_prefix("*** Update File: ") {
                let path = path.trim();
                if path.is_empty() {
                    return vec![];
                }
                unified.push_str(&format!(
                    "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
                ));
                (old, new) = (1, 1);
            } else if is_hunk(line) && !line.starts_with("@@ -") {
                // Unnumbered historical hunks have only the shown context and changes.
                let offset = unified.len();
                let (mut removed, mut added) = (0, 0);
                while let Some(body) = lines.next_if(|line| line.starts_with([' ', '+', '-', '\\']))
                {
                    removed += usize::from(body.starts_with([' ', '-']));
                    added += usize::from(body.starts_with([' ', '+']));
                    unified.push_str(body);
                    unified.push('\n');
                }
                let a = old - usize::from(removed == 0);
                let b = new - usize::from(added == 0);
                unified.insert_str(offset, &format!("@@ -{a},{removed} +{b},{added} @@\n"));
                (old, new) = (old + removed, new + added);
            } else if line != "*** End Patch" {
                unified.push_str(line);
                unified.push('\n');
            }
        }
        parse_complete(&unified)
    } else if patch.starts_with("@@ ") && !path.contains(['\r', '\n']) && !path.is_empty() {
        parse_complete(&format!("--- a/{path}\n+++ b/{path}\n{patch}"))
    } else {
        parse_complete(patch)
    }
}

fn parse_complete(patch: &str) -> Vec<diff::FileDiff> {
    let files = diff::parse(patch);
    let expected = patch.lines().filter(|line| is_hunk(line)).count();
    if files.iter().map(|file| file.hunks.len()).sum::<usize>() == expected {
        files
    } else {
        vec![]
    }
}

pub(super) fn is_hunk(line: &str) -> bool {
    line == "@@" || line.starts_with("@@ ")
}

pub(super) fn candidate(tool: &Tool, patch: &str) -> bool {
    tool.name == "edit"
        && tool.status == "completed"
        && patch.encode_utf16().nth(TOOL_LIMIT).is_none()
        && patch.lines().any(is_hunk)
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
    let bounds = entry
        .and_then(|entry| entry.bounds.upgrade())
        .unwrap_or_else(|| Rc::new(DrawnRect::new([0.0; 4])));
    let wrap_key = format!("{key}-wrap");
    let content = match entry {
        Some(entry) if entry.lines > 0 => view(s, key, entry, path),
        _ => {
            let stamp = (
                Arc::as_ptr(tool) as usize,
                Rc::as_ptr(&s.input_scope) as usize,
                locale(),
                layout::dark(),
                s.transcript_display.toggled(&wrap_key),
            );
            markdown::hold_frame(format!("{key}-diff-fallback"), stamp, fallback)
        }
    };
    let scope = s.input_scope.clone();
    let message = message.to_owned();
    let key = key.to_owned();
    let patch = patch.to_owned();
    let path = path.to_owned();
    let tool = tool.clone();
    // Retry uncached cards when the viewport changes but their drawn rect does not.
    let retry = entry
        .is_none()
        .then_some(s.tool_diff_preferences.history_epoch);
    let card_key = format!(
        "{key}-card-{:p}-{:p}-{retry:?}",
        Rc::as_ptr(&scope),
        Arc::as_ptr(&tool)
    );
    let drawn = bounds.clone();
    let admit = Rc::new(move |s: &mut State, tx: &mut Tx| {
        let wrap = !s.transcript_display.toggled(&wrap_key);
        let p = &s.tool_diff_preferences;
        let mode = p.effective_mode(s.transcript_display.compact_split(p.layout_epoch, &key));
        if intersects(bounds.get(), s.tool_diff_preferences.history_bounds.get())
            && s.current_scope(&scope)
            && s.messages.iter().find(|row| row.id == message).into_iter().flat_map(|row| &row.parts).any(|part|
                matches!(part, crate::content::Part::Tool(current) if Arc::ptr_eq(current, &tool)))
            && s.transcript_display
                .diffs
                .load(&key, &patch, &path, &bounds, p, (mode, wrap))
        {
            s.revision += 1;
        } else {
            tx.live_only();
        }
    });
    let enter = admit.clone();
    col()
        .full_width()
        .key(card_key)
        .child(content)
        .drawn_rect_into(&drawn)
        .on_drawn_layout_tx(move |s: &mut State, _, tx| admit(s, tx))
        .on_visible(move |s: &mut State, visible, tx| {
            if visible {
                enter(s, tx)
            } else {
                tx.live_only()
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
    let mode_key = key.to_owned();
    let wrap_card = key.to_owned();
    let wrap_key = format!("{key}-wrap");
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
                                s.transcript_display.set_compact_split(
                                    s.tool_diff_preferences.layout_epoch,
                                    &mode_key,
                                    !split,
                                );
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
                            Display::toggle(s, &wrap_key);
                            s.transcript_display
                                .diffs
                                .edit(&wrap_card)
                                .set_wrap(!wrapped);
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
    preferences.history_bounds.set([0.0, 0.0, 100.0, 100.0]);
    let patch = "@@ -1 +1 @@\n-A\n+B";
    let cards: Vec<_> = (0..RETAINED)
        .map(|_| Rc::new(DrawnRect::new([5.0, 5.0, 10.0, 10.0])))
        .collect();
    for (i, visible) in cards.iter().enumerate() {
        assert!(cache.load(
            &i.to_string(),
            patch,
            "file.rs",
            visible,
            &preferences,
            (DiffMode::Split, true)
        ));
    }
    let next = Rc::new(DrawnRect::new([5.0, 5.0, 10.0, 10.0]));
    for _ in 0..3 {
        assert!(!cache.load(
            "next",
            patch,
            "file.rs",
            &next,
            &preferences,
            (DiffMode::Split, true)
        ));
        assert!(cache.entries.iter().any(|entry| entry.key == "0"));
    }
    cards[0].set([5.0, 150.0, 10.0, 10.0]);
    assert!(cache.load(
        "next",
        patch,
        "file.rs",
        &next,
        &preferences,
        (DiffMode::Split, true)
    ));
    assert!(!cache.entries.iter().any(|entry| entry.key == "0"));
    assert_eq!(cache.entries.len(), RETAINED);
}

#[cfg(test)]
#[test]
fn a_partial_parse_never_replaces_the_raw_patch() {
    let patch = "@@ -1 +1 @@\n-A\n+B\n@@ -4294967296 +4294967296 @@\n-C\n+D";
    assert!(parse_patch(patch, "file.rs").is_empty());
}
