use crate::State;
use rune::{El, Tx};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Bookmark {
    Latest,
    Message { id: String, offset: f32 },
}

pub(crate) struct Reading {
    following: bool,
    top: Option<(String, f32)>,
}

impl Default for Reading {
    fn default() -> Self {
        Self {
            following: true,
            top: None,
        }
    }
}

impl Reading {
    pub(super) fn hold(&mut self, message: String) {
        self.following = false;
        self.top = Some((message, 0.0));
    }
    pub(super) fn settle(&mut self, attempted: &str, confirmed: Option<&str>) {
        if let Some((id, offset)) = &self.top
            && id == attempted
        {
            self.top = confirmed.map(|id| (id.into(), *offset));
        }
    }

    pub(crate) fn bookmark(&self, gap: bool) -> Bookmark {
        if (gap || !self.following)
            && let Some((id, offset)) = &self.top
        {
            Bookmark::Message {
                id: id.clone(),
                offset: *offset,
            }
        } else {
            Bookmark::Latest
        }
    }

    pub(crate) fn restore(bookmark: &Bookmark, tx: &mut Tx) {
        match bookmark {
            Bookmark::Latest => tx.scroll_to_bottom_instant("history"),
            Bookmark::Message { id, offset } => tx.scroll_key_to(id, *offset),
        };
    }

    fn record(&mut self, id: &str, top: f32, [_, y, _, height]: [f32; 4]) {
        if height > 0.0 && y <= top && y + height > top {
            self.top = Some((id.into(), y - top));
        }
    }
}

pub(crate) fn viewport(s: &State, history: El) -> El {
    let scope = s.input_scope.clone();
    let layout_scope = scope.clone();
    history
        .on_layout_tx(move |s: &mut State, rect, tx| {
            if s.current_scope(&layout_scope) {
                crate::chat::ToolDiffPreferences::history_layout(s, rect, tx);
                if let Some(reader) = &mut s.reader {
                    reader.renderer_ready(tx);
                }
            }
        })
        .on_at_bottom_if(move |s: &mut State, following| {
            if s.current_scope(&scope) {
                s.transcript_display.reading_mut().following = following;
            }
            false
        })
}

pub(crate) fn restore_position(s: &mut State, tx: &mut Tx) {
    tx.instant();
    let reading = s.transcript_display.reading_mut();
    let bookmark = s.reader.as_ref().map_or_else(
        || reading.bookmark(false),
        |reader| reader.bookmark(reading),
    );
    Reading::restore(&bookmark, tx);
}

pub(super) fn row(s: &State, id: String, view: El) -> El {
    let scope = s.input_scope.clone();
    view.on_drawn_layout_tx(move |s: &mut State, rect, tx| {
        if s.current_scope(&scope) {
            let top = s.tool_diff_preferences.history_bounds.get()[1];
            s.transcript_display.reading_mut().record(&id, top, rect);
        }
        tx.live_only();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bookmark_captures_the_native_row_and_its_signed_viewport_offset() {
        let mut reading = Reading::default();
        reading.following = false;
        reading.record("previous", 100.0, [0.0, 30.0, 500.0, 60.0]);
        reading.record("anchor", 100.0, [0.0, 80.0, 500.0, 60.0]);
        reading.record("next", 100.0, [0.0, 140.0, 500.0, 60.0]);
        assert_eq!(
            reading.bookmark(false),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -20.0
            }
        );
        reading.following = true;
        assert_eq!(reading.bookmark(false), Bookmark::Latest);
        assert_eq!(
            reading.bookmark(true),
            Bookmark::Message {
                id: "anchor".into(),
                offset: -20.0,
            }
        );
    }
}
