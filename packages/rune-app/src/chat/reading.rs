use crate::State;
use rune::{El, Live, Tx};

pub struct Position {
    viewport: Live<[f32; 4]>,
    anchor: Option<(String, f32)>,
    following: bool,
}
impl Default for Position {
    fn default() -> Self {
        Self {
            viewport: Live::new([0.0; 4]),
            anchor: None,
            following: true,
        }
    }
}
impl Position {
    pub fn restore(&self, tx: &mut Tx) {
        tx.instant();
        if self.following {
            tx.scroll_to_bottom_instant("history");
        } else if let Some((key, offset)) = &self.anchor {
            tx.scroll_key_to(key, *offset);
        }
    }
    fn record(&mut self, key: &str, rect: [f32; 4]) {
        let top = self.viewport.get()[1];
        if rect[3] > 0.0 && rect[1] <= top && rect[1] + rect[3] > top {
            self.anchor = Some((key.into(), rect[1] - top));
        }
    }
}
pub fn row(s: &State, index: usize, row: El) -> El {
    if s.files.is_none() {
        return row;
    }
    let key = s.messages[index].id.clone();
    let scope = s.input_scope.clone();
    row.on_drawn_layout_tx(move |s: &mut State, rect, tx| {
        if s.current_scope(&scope) {
            if let Some(ui) = &mut s.files {
                if ui.reader.target().is_none() {
                    ui.reading.record(&key, rect);
                }
            }
        }
        tx.live_only();
    })
}
pub fn history(s: &State, history: El) -> El {
    let Some(ui) = &s.files else {
        return history;
    };
    let scope = s.input_scope.clone();
    history
        .drawn_rect_into(&ui.reading.viewport)
        .on_at_bottom_if(move |s: &mut State, following| {
            if s.current_scope(&scope) {
                if let Some(ui) = &mut s.files {
                    if ui.reader.target().is_none() {
                        ui.reading.following = following;
                    }
                }
            }
            false
        })
}
