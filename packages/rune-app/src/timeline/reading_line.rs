use super::Marker;
use crate::State;
use rune::El;
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
};

#[derive(Default)]
pub(super) struct Blocks(RefCell<HashMap<String, Weak<rune_theme_codenomad::layout::DrawnRect>>>);

impl Blocks {
    pub(super) fn first(&self, [_, top, _, h]: [f32; 4]) -> Option<String> {
        // Solid timeline-transcript-blocks.ts:49–65: mounted blocks, in screen order.
        let line = top + 4.0;
        self.0
            .borrow_mut()
            .retain(|_, bounds| bounds.strong_count() > 0);
        self.0
            .borrow()
            .iter()
            .filter_map(|(key, bounds)| {
                let [_, y, _, height] = bounds.upgrade()?.get();
                (height > 0.0 && y + height > line && y < top + h).then_some((key, y))
            })
            .min_by(|(ka, a), (kb, b)| a.total_cmp(b).then_with(|| ka.cmp(kb)))
            .map(|(key, _)| key.clone())
    }
}

pub(crate) fn watch(
    s: &State,
    marker: codenomad_client::timeline::Marker<'_>,
    block: El,
    observe: impl Fn(&mut State, [f32; 4], &mut rune::Tx) + 'static,
) -> El {
    let key = Marker::from(marker).id;
    let bounds = {
        let mut shown = s.transcript_display.timeline.reading_line.0.borrow_mut();
        if let Some(bounds) = shown.get(&key).and_then(Weak::upgrade) {
            bounds
        } else {
            let bounds = Rc::new(rune_theme_codenomad::layout::DrawnRect::new([0.0; 4]));
            shown.insert(key, Rc::downgrade(&bounds));
            bounds
        }
    };
    let scope = s.input_scope.clone();
    block
        .drawn_rect_into(&bounds)
        .on_drawn_layout_tx(move |s: &mut State, rect, tx| {
            observe(s, rect, tx);
            if s.current_scope(&scope) {
                let [_, top, _, height] = s.tool_diff_preferences.history_bounds.get();
                let [_, y, _, h] = rect;
                if h > 0.0 && y + h > top && y < top + height {
                    // Keep the live rectangle owned by the mounted block.
                    let _ = &bounds;
                    (s.wake)();
                }
            }
            tx.live_only();
        })
}
