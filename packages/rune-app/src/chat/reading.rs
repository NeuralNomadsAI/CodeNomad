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
    passage: Option<Passage>,
}

struct Passage {
    message: String,
    key: String,
    offset: f32,
    mode: Option<crate::settings::TranscriptRow>,
}

impl Default for Reading {
    fn default() -> Self {
        Self {
            following: true,
            top: None,
            passage: None,
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
        tx.instant();
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

    pub(crate) fn keep_passage(
        &self,
        tx: &mut Tx,
        visible: impl Fn(crate::settings::TranscriptRow) -> bool,
    ) {
        if !self.following
            && let (Some((message, _)), Some(passage)) = (&self.top, &self.passage)
            && *message == passage.message
            && passage.mode.is_none_or(visible)
        {
            tx.scroll_key_to(format!("{message}/{}", passage.key), passage.offset);
        }
    }
}

pub(super) fn passage(
    s: &State,
    body: El,
    message: &str,
    key: String,
    mode: Option<crate::settings::TranscriptRow>,
) -> El {
    let scope = s.input_scope.clone();
    let message = message.to_owned();
    body.key(key.clone())
        .on_drawn_layout_tx(move |s: &mut State, [_, y, _, height], tx| {
            if s.current_scope(&scope) {
                let [_, top, _, viewport] = s.tool_diff_preferences.history_bounds.get();
                let reading = s.transcript_display.reading_mut();
                if viewport > 0.0 && y <= top && y + height > top {
                    reading.passage = Some(Passage {
                        message: message.clone(),
                        key: key.clone(),
                        offset: y - top,
                        mode,
                    });
                } else if reading
                    .passage
                    .as_ref()
                    .is_some_and(|old| old.message == message && old.key == key)
                {
                    reading.passage = None;
                }
            }
            tx.live_only();
        })
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
    let lease = super::receipts::Receipts::lease(s, &id);
    let receipt = super::receipts::for_message(s, &id);
    view.children(receipt)
        .on_drawn_layout_tx(move |s: &mut State, rect, tx| {
            if s.current_scope(&scope) {
                let [_, top, _, height] = s.tool_diff_preferences.history_bounds.get();
                s.transcript_display.reading_mut().record(&id, top, rect);
                let visible = height > 0.0
                    && rect[3] > 0.0
                    && rect[1] < top + height
                    && rect[1] + rect[3] > top;
                if super::receipts::Receipts::demand(s, &id, visible, &lease) {
                    tx.wake_after(std::time::Duration::ZERO);
                }
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
