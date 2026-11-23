use rune::TextEdit;
use std::{cell::Cell, rc::Rc};

#[derive(Clone, Copy, Default)]
pub(in crate::files::document) struct SavedPosition {
    selection: [usize; 2],
    scroll: [f32; 2],
}

impl SavedPosition {
    pub(super) fn capture(edit: &TextEdit, scroll: [f32; 2]) -> Self {
        Self {
            selection: [edit.anchor, edit.focus],
            scroll,
        }
    }

    pub(super) fn restore_selection(self, edit: &mut TextEdit) {
        let boundary = |at: usize| {
            let mut at = at.min(edit.text.len());
            while !edit.text.is_char_boundary(at) {
                at -= 1;
            }
            at
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
}

impl Viewport {
    pub(super) fn offset(&self) -> [f32; 2] {
        self.offset.get()
    }

    pub(super) fn arm(&self) {
        self.pending.set(true);
    }

    pub(crate) fn observe(&self, offset: [f32; 2]) {
        if !self.pending.get() && offset.iter().all(|value| value.is_finite()) {
            self.offset.set(offset);
        }
    }

    pub(crate) fn restore(&self, tx: &mut rune::Tx) {
        if self.pending.replace(false) {
            let [x, y] = self.offset.get();
            tx.scroll_to_instant("file-source-scroll", x, y);
        }
    }
}
