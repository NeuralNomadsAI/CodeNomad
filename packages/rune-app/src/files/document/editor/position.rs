use rune::TextEdit;
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy, Default)]
pub(in crate::files::document) struct SavedPosition {
    selection: [(usize, usize); 2],
    scroll: [f32; 2],
}

impl SavedPosition {
    pub(super) fn capture(edit: &TextEdit, scroll: [f32; 2]) -> Self {
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
                offset: Cell::new(saved.map_or([0.0; 2], |view| view.scroll)),
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

#[derive(Default)]
pub(crate) struct Viewport {
    offset: Cell<[f32; 2]>,
    pending: Cell<bool>,
    mounted: Cell<bool>,
}

impl Viewport {
    pub(super) fn saved_scroll(&self) -> [f32; 2] {
        self.offset.get()
    }

    pub(super) fn arm(&self) {
        self.pending.set(true);
    }

    pub(super) fn mounted(&self) -> bool {
        self.mounted.get()
    }

    pub(crate) fn observe(&self, offset: [f32; 2]) {
        if !self.pending.get() && offset.iter().all(|value| value.is_finite()) {
            self.offset.set(offset);
        }
    }

    pub(crate) fn restore(&self, key: &str, tx: &mut rune::Tx) {
        self.mounted.set(true);
        if self.pending.replace(false) {
            let [x, y] = self.offset.get();
            tx.scroll_to_instant(key, x, y);
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
        let saved = SavedPosition::capture(&edit, [0.0; 2]);
        let mut changed = TextEdit::new("longer prefix\né🦀z");
        saved.restore_selection(&mut changed);
        assert_eq!(changed.anchor, "longer prefix\né🦀".len());
        assert_eq!(changed.focus, "longer prefix\n".len());
    }
}
