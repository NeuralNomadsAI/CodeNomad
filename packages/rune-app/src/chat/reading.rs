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
    jump: Option<String>,
    lookup: Option<Jump>,
}

struct Jump {
    scope: std::rc::Rc<()>,
    position: Option<String>,
    result: codenomad_client::Receiver<Option<String>>,
}

impl Default for Reading {
    fn default() -> Self {
        Self {
            following: true,
            top: None,
            jump: None,
            lookup: None,
        }
    }
}

impl Reading {
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
        if self.jump.as_deref() == Some(id) && height > 0.0 && y <= top + 1.0 && y + height > top {
            self.jump = None;
        }
    }
}

fn user_position(s: &State) -> Option<&str> {
    let reading = s.transcript_display.reading();
    reading.jump.as_deref().or_else(|| {
        (!reading.following || s.history_detached).then_some(reading.top.as_ref()?.0.as_str())
    })
}

fn user_target(s: &State, previous: bool) -> Option<String> {
    let current = user_position(s);
    let position = current.and_then(|id| s.messages.iter().position(|row| row.id == id));
    let rows = if previous {
        &s.messages[..position.unwrap_or(s.messages.len())]
    } else {
        &s.messages[position? + 1..]
    };
    let user = |row: &&crate::history::Row| row.role == "user";
    (if previous {
        rows.iter().rev().find(user)
    } else {
        rows.iter().find(user)
    })
    .map(|row| row.id.clone())
}

fn can_read(s: &State) -> bool {
    !s.screen.is_launcher()
        && !crate::git::has_preview(s)
        && !crate::files::has_preview(s)
        && matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming)
}

fn outside_window(s: &State, previous: bool) -> bool {
    s.reader.is_some()
        && if previous {
            s.can_older
        } else {
            s.history_detached
        }
}

pub(crate) fn can_jump_user(s: &State, previous: bool) -> bool {
    can_read(s) && (user_target(s, previous).is_some() || outside_window(s, previous))
}

fn reveal(s: &mut State, id: String, tx: &mut Tx) {
    s.transcript_display.reading_mut().jump = Some(id.clone());
    if s.messages.iter().any(|row| row.id == id) {
        tx.scroll_key_to(id, 0.0);
        tx.instant();
    } else if let Some(reader) = &mut s.reader {
        reader.resume(Bookmark::Message { id, offset: 0.0 });
    }
}

pub(crate) fn jump_user(s: &mut State, previous: bool, tx: &mut Tx) -> bool {
    if !can_jump_user(s, previous) {
        return false;
    }
    s.transcript_display.reading_mut().lookup = None;
    if let Some(id) = user_target(s, previous) {
        reveal(s, id, tx);
        return true;
    }
    let Some(backend) = s.composer.picker.backend().cloned() else {
        return false;
    };
    let current = user_position(s).map(str::to_owned);
    let (send, recv) = codenomad_client::bounded(1);
    let wake = s.wake.clone();
    s.transcript_display.reading_mut().lookup = Some(Jump {
        scope: s.input_scope.clone(),
        position: current.clone(),
        result: recv,
    });
    crate::platform::spawn(async move {
        use codenomad_client::timeline::{Kind, OutlineRevision};
        let revision = OutlineRevision::default();
        let outline =
            codenomad_client::runtime::until_closed(&send, backend.read_outline(&revision)).await;
        let id = if let Some(Ok(outline)) = outline {
            let position = current
                .as_ref()
                .and_then(|id| outline.entries.iter().position(|row| &row.id == id));
            let entries = &outline.entries;
            if previous {
                entries[..position.unwrap_or(entries.len())]
                    .iter()
                    .rev()
                    .find(|row| row.kind == Kind::User)
            } else {
                position.and_then(|i| entries[i + 1..].iter().find(|row| row.kind == Kind::User))
            }
            .map(|row| row.id.clone())
        } else {
            None
        };
        if send.try_send(id).is_ok() {
            wake();
        }
    });
    true
}

pub(crate) fn poll_jump(s: &mut State, tx: &mut Tx) -> bool {
    let reading = s.transcript_display.reading_mut();
    let Some(id) = reading
        .lookup
        .as_ref()
        .and_then(|jump| jump.result.try_recv().ok())
    else {
        return false;
    };
    let Some(jump) = reading.lookup.take() else {
        return false;
    };
    if s.current_scope(&jump.scope)
        && user_position(s) == jump.position.as_deref()
        && can_read(s)
        && let Some(id) = id
    {
        reveal(s, id, tx);
        return true;
    }
    false
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

    #[test]
    fn user_navigation_skips_answers_and_preserves_the_draft() {
        let mut s = crate::init();
        s.messages = [("a", "user"), ("b", "assistant"), ("c", "user")]
            .into_iter()
            .map(|(id, role)| {
                crate::Message {
                    id: id.into(),
                    role: role.into(),
                    body: id.into(),
                    completed: true,
                    parts: Vec::new(),
                }
                .into()
            })
            .collect();
        s.draft = rune::edit::TextEdit::new("draft");
        assert_eq!(user_target(&s, true).as_deref(), Some("c"));
        assert!(user_target(&s, false).is_none());
        let reading = s.transcript_display.reading_mut();
        reading.following = false;
        reading.top = Some(("b".into(), 0.0));
        assert_eq!(user_target(&s, true).as_deref(), Some("a"));
        assert_eq!(user_target(&s, false).as_deref(), Some("c"));
        assert_eq!(s.draft.text, "draft");
    }
}
