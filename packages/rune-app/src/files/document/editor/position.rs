use rune::TextEdit;
use rune_theme_codenomad::document_reader::editor::{LineAnchor, SourceLayout};
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy, Default)]
pub(in crate::files::document) struct SavedPosition {
    selection: [(usize, usize); 2],
    scroll: ScrollPosition,
}

impl SavedPosition {
    pub(super) fn capture(edit: &TextEdit, scroll: ScrollPosition) -> Self {
        let location = |at: usize| {
            let mut at = at.min(edit.text.len());
            while !edit.text.is_char_boundary(at) {
                at -= 1;
            }
            let prefix = &edit.text[..at];
            let line = prefix.bytes().filter(|&byte| byte == b'\n').count();
            let column = prefix
                .rsplit('\n')
                .next()
                .unwrap_or_default()
                .encode_utf16()
                .count();
            (line, column)
        };
        Self {
            selection: [edit.anchor, edit.focus].map(location),
            scroll,
        }
    }

    pub(super) fn restore_selection(self, edit: &mut TextEdit) {
        let boundary = |(line, column)| {
            let mut offset = 0;
            for (index, value) in edit.text.split('\n').enumerate() {
                if index == line {
                    let mut units = 0;
                    for ch in value.chars() {
                        units += ch.len_utf16();
                        if units > column {
                            break;
                        }
                        offset += ch.len_utf8();
                    }
                    return offset;
                }
                offset += value.len() + 1;
            }
            edit.text.len()
        };
        [edit.anchor, edit.focus] = self.selection.map(boundary);
    }
}

#[derive(Default)]
pub(super) struct Position {
    selection: Option<SavedPosition>,
    pub(super) viewport: Rc<Viewport>,
}

impl Position {
    pub(super) fn new(saved: Option<SavedPosition>) -> Self {
        Self {
            selection: saved,
            viewport: Rc::new(Viewport {
                position: Cell::new(saved.map_or_else(ScrollPosition::default, |view| view.scroll)),
                pending: Cell::new(true),
                mounted: Cell::new(false),
            }),
        }
    }

    pub(super) fn restore_selection(&mut self, edit: &mut TextEdit) -> bool {
        let Some(saved) = self.selection.take() else {
            return false;
        };
        saved.restore_selection(edit);
        true
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct ScrollPosition {
    offset: [f32; 2],
    layout: Option<SourceLayout>,
    anchor: Option<LineAnchor>,
}

#[derive(Default)]
pub(crate) struct Viewport {
    position: Cell<ScrollPosition>,
    pending: Cell<bool>,
    mounted: Cell<bool>,
}

impl Viewport {
    pub(super) fn saved_scroll(&self, text: &str) -> ScrollPosition {
        let mut saved = self.position.get();
        saved.anchor = saved
            .layout
            .and_then(|layout| layout.capture(text, saved.offset[1]));
        saved
    }

    pub(super) fn arm(&self) {
        self.pending.set(true);
    }

    pub(super) fn mounted(&self) -> bool {
        self.mounted.get()
    }

    #[cfg(test)]
    pub(crate) fn captured_scroll(&self) -> [f32; 2] {
        self.position.get().offset
    }

    pub(crate) fn observe(&self, offset: [f32; 2], layout: SourceLayout) {
        let previous = self.position.get();
        if !self.pending.get()
            && previous.layout == Some(layout)
            && offset.iter().all(|value| value.is_finite())
        {
            self.position.set(ScrollPosition {
                offset,
                layout: Some(layout),
                anchor: None,
            });
        }
    }

    pub(crate) fn restore(&self, key: &str, text: &str, layout: SourceLayout, tx: &mut rune::Tx) {
        self.mounted.set(true);
        let old = self.position.get();
        let moved = old.layout != Some(layout);
        if self.pending.replace(false) || moved {
            let [x, mut y] = old.offset;
            if let Some(anchor) = old.anchor.or_else(|| {
                old.layout
                    .filter(|_| moved)
                    .and_then(|layout| layout.capture(text, y))
            }) {
                y = layout.restore(text, anchor).unwrap_or(y);
            }
            self.position.set(ScrollPosition {
                offset: [x, y],
                layout: Some(layout),
                anchor: None,
            });
            tx.scroll_to_instant(key, x, y);
        } else {
            tx.live_only();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_tracks_line_and_utf16_column_when_earlier_lines_change() {
        let mut edit = TextEdit::new("old\né🦀z");
        edit.anchor = "old\né🦀".len();
        edit.focus = "old\n".len();
        let saved = SavedPosition::capture(&edit, ScrollPosition::default());
        let mut changed = TextEdit::new("longer prefix\né🦀z");
        saved.restore_selection(&mut changed);
        assert_eq!(changed.anchor, "longer prefix\né🦀".len());
        assert_eq!(changed.focus, "longer prefix\n".len());
    }
}
