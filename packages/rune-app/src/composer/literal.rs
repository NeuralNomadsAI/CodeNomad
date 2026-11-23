use rune::edit::{Mark, MarkRange, TextEdit};
use std::ops::Range;

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn paste(edit: &mut TextEdit, text: &str) {
    edit.undo_group(|edit| {
        let (start, _) = edit.range();
        edit.paste(text);
        let (end, _) = edit.range();
        if start < end {
            edit.set_selection(start, end);
            // Reuse the editor's code span so provenance follows edits and undo.
            edit.set_mark(Mark::Code);
            edit.set_caret(end);
        }
    });
}

pub(crate) fn ranges(edit: &TextEdit) -> impl Iterator<Item = Range<usize>> + '_ {
    edit.marks()
        .iter()
        .filter(|span| span.mark == Mark::Code)
        .map(MarkRange::range)
}

pub(crate) fn restore(edit: &mut TextEdit, spans: &[Range<usize>]) {
    edit.set_marks(
        spans
            .iter()
            .filter(|span| edit.text.get((*span).clone()).is_some())
            .map(|span| MarkRange::new(span.clone(), Mark::Code))
            .collect(),
    );
}
