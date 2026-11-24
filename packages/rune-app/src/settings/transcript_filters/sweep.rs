use super::TranscriptRow as Row;
use crate::State;
use rune::{El, Tx};
use rune_theme_codenomad::{
    layout::DrawnRect,
    settings::{FilterDrag, filter_drag},
};
use std::collections::BTreeMap;

type Control = (Row, bool);
type Point = [f32; 2];
type Change = (&'static str, &'static str);

pub(super) struct Sweep {
    pub(super) viewport: DrawnRect,
    hits: BTreeMap<Control, DrawnRect>,
    gesture: Option<Gesture>,
    suppress: Option<Control>,
}

struct Gesture {
    origin: Control,
    previous: Point,
    on: bool,
    changes: BTreeMap<Row, Change>,
}

impl Default for Sweep {
    fn default() -> Self {
        Self {
            viewport: DrawnRect::new([0.0; 4]),
            hits: Row::all()
                .flat_map(|row| {
                    [false, true].map(|column| ((row, column), DrawnRect::new([0.0; 4])))
                })
                .collect(),
            gesture: None,
            suppress: None,
        }
    }
}

impl Sweep {
    pub(super) fn mode(&self, row: Row) -> Option<&'static str> {
        self.gesture
            .as_ref()?
            .changes
            .get(&row)
            .map(|change| change.1)
    }

    pub(super) fn control(&self, s: &State, row: Row, column: bool, button: El) -> El {
        let scope = s.input_scope.clone();
        filter_drag(
            button.drawn_rect_into(&self.hits[&(row, column)]),
            move |s: &mut State, drag, tx| {
                if s.current_scope(&scope) && s.settings.transcript_filters.is_open(&scope) {
                    update(s, (row, column), drag, tx);
                }
            },
        )
    }
}

fn update(s: &mut State, origin: Control, drag: FilterDrag, tx: &mut Tx) {
    let filters = &mut s.settings.transcript_filters;
    let sweep = &mut filters.sweep;
    let mut prefs = s.settings.shared.borrow_mut();
    match drag {
        FilterDrag::Start(point) => {
            sweep.suppress = None;
            sweep.gesture = Some(Gesture {
                origin,
                previous: point,
                on: !is_on(prefs.transcript_mode(origin.0, true), origin.1),
                changes: BTreeMap::new(),
            });
        }
        FilterDrag::Move(point) => {
            let Some(gesture) = &mut sweep.gesture else {
                return;
            };
            let own_rect = sweep.hits[&origin].get();
            if gesture.changes.is_empty() && contains(own_rect, point) {
                gesture.previous = point;
                tx.live_only();
                return;
            }
            let previous = std::mem::replace(&mut gesture.previous, point);
            let before = gesture.changes.len();
            let viewport = sweep.viewport.get();
            let [dx, dy] = [point[0] - previous[0], point[1] - previous[1]];
            let steps = ((dx.hypot(dy) / 4.0).ceil() as usize).clamp(1, 256);
            let mut visit = |row| {
                let mode = prefs.transcript_mode(row, true);
                if let Some(next) = desired(
                    mode,
                    origin.1,
                    gesture.on,
                    filters.last_visible.get(&row).copied(),
                ) {
                    gesture.changes.entry(row).or_insert((mode, next));
                }
            };
            visit(origin.0);
            for (&(row, column), area) in &sweep.hits {
                if column == origin.1
                    && (1..=steps).any(|step| {
                        let f = step as f32 / steps as f32;
                        let sample = [previous[0] + f * dx, previous[1] + f * dy];
                        contains(viewport, sample) && contains(area.get(), sample)
                    })
                {
                    visit(row);
                }
            }
            if gesture.changes.len() == before {
                tx.live_only();
            }
            return;
        }
        FilterDrag::Cancel => {
            sweep.gesture = None;
            return;
        }
        FilterDrag::Release(point) => {
            let Some(gesture) = sweep.gesture.take() else {
                return;
            };
            if gesture.changes.is_empty() {
                tx.live_only();
                return;
            }
            if contains(sweep.hits[&gesture.origin].get(), point) {
                // Rune delivers the regular press after drag-up when released over the origin.
                sweep.suppress = Some(gesture.origin);
            }
            for (row, (before, after)) in gesture.changes {
                if after == "hidden" {
                    filters.last_visible.insert(row, before);
                }
                prefs.set_transcript(Some(row), after);
            }
            return;
        }
    }
    tx.live_only();
}

pub(super) fn click(s: &mut State, row: Row, column: bool) {
    let filters = &mut s.settings.transcript_filters;
    if filters.sweep.suppress.take() == Some((row, column)) {
        return;
    }
    let mut prefs = s.settings.shared.borrow_mut();
    let before = prefs.transcript_mode(row, true);
    if let Some(after) = desired(
        before,
        column,
        !is_on(before, column),
        filters.last_visible.get(&row).copied(),
    ) {
        if after == "hidden" {
            filters.last_visible.insert(row, before);
        }
        prefs.set_transcript(Some(row), after);
    }
}

fn desired(
    mode: &'static str,
    expansion: bool,
    on: bool,
    remembered: Option<&'static str>,
) -> Option<&'static str> {
    if expansion && mode == "hidden" || is_on(mode, expansion) == on {
        return None;
    }
    Some(match (expansion, on) {
        (true, true) => "expanded",
        (true, false) => "collapsed",
        (false, true) => remembered.unwrap_or("collapsed"),
        (false, false) => "hidden",
    })
}

fn is_on(mode: &str, expansion: bool) -> bool {
    if expansion {
        mode == "expanded"
    } else {
        mode != "hidden"
    }
}

fn contains([x, y, w, h]: [f32; 4], [px, py]: Point) -> bool {
    px >= x && px < x + w && py >= y && py < y + h
}
