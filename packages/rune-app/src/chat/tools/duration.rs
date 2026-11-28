use super::Tool;
use crate::{Phase, State, platform::storage::unix_millis, strings::locale};
use rune::{El, Tx, row, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{DrawnRect, Layout},
    usage::numbers,
};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::{Rc, Weak},
    time::Duration,
};

pub(in crate::chat) struct ActiveClip(Option<Rc<Clip>>);

impl ActiveClip {
    pub(in crate::chat) fn is_clipped(&self) -> bool {
        self.0.is_some()
    }
}

impl Clone for ActiveClip {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

struct Clip {
    rect: Rc<DrawnRect>,
    parent: Option<Rc<Clip>>,
}

pub(crate) struct Clock {
    visible: HashMap<String, (Weak<Cell<bool>>, Rc<DrawnRect>, Option<Rc<Clip>>)>,
    offscreen: HashSet<String>,
    shown: RefCell<HashMap<String, u64>>,
    clips: RefCell<HashMap<String, Weak<DrawnRect>>>,
    active_clip: RefCell<Option<Rc<Clip>>>,
    stack_bounds: DrawnRect,
    next: Option<f64>,
    frozen_at: Option<u64>,
    epoch: u64,
    generation: u64,
    paused: bool,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            visible: HashMap::new(),
            offscreen: HashSet::new(),
            shown: RefCell::new(HashMap::new()),
            clips: RefCell::new(HashMap::new()),
            active_clip: RefCell::new(None),
            stack_bounds: DrawnRect::new([0.0; 4]),
            next: None,
            frozen_at: None,
            epoch: 0,
            generation: 0,
            paused: false,
        }
    }
}

fn intersect(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = (a[0] + a[2]).min(b[0] + b[2]);
    let y1 = (a[1] + a[3]).min(b[1] + b[3]);
    [x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0)]
}

fn in_bounds(rect: [f32; 4], bounds: [f32; 4], stack: [f32; 4], mut clip: Option<&Clip>) -> bool {
    if rect[2] <= 0.0 || rect[3] <= 0.0 {
        return false;
    }
    let mut visible = rect;
    if bounds[2] > 0.0 && bounds[3] > 0.0 {
        visible = intersect(visible, bounds);
    }
    if stack[2] > 0.0 && stack[3] > 0.0 {
        visible = intersect(visible, stack);
    }
    while let Some(node) = clip {
        let clip_rect = node.rect.get();
        if clip_rect[2] > 0.0 && clip_rect[3] > 0.0 {
            visible = intersect(visible, clip_rect);
        }
        clip = node.parent.as_deref();
    }
    visible[2] > 0.0 && visible[3] > 0.0
}

fn online(phase: &Phase) -> bool {
    matches!(phase, Phase::Ready | Phase::Streaming)
}

impl Clock {
    pub(super) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(in crate::chat) fn stack_bounds(&self) -> &DrawnRect {
        &self.stack_bounds
    }

    pub(in crate::chat) fn current_clip(&self) -> ActiveClip {
        ActiveClip(self.active_clip.borrow().clone())
    }

    pub(in crate::chat) fn extend_clip(&self, clip: &Rc<DrawnRect>) -> ActiveClip {
        ActiveClip(Some(Rc::new(Clip {
            rect: clip.clone(),
            parent: self.active_clip.borrow().clone(),
        })))
    }

    pub(in crate::chat) fn with_active_clip<T>(
        &self,
        clip: &ActiveClip,
        render: impl FnOnce() -> T,
    ) -> T {
        struct Restore<'a>(&'a RefCell<Option<Rc<Clip>>>, Option<Rc<Clip>>);
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                *self.0.borrow_mut() = self.1.take();
            }
        }
        let prev = std::mem::replace(&mut *self.active_clip.borrow_mut(), clip.0.clone());
        let _restore = Restore(&self.active_clip, prev);
        render()
    }

    pub(in crate::chat) fn rect_in_view(
        &self,
        rect: [f32; 4],
        bounds: [f32; 4],
        clip: &ActiveClip,
    ) -> bool {
        in_bounds(rect, bounds, self.stack_bounds.get(), clip.0.as_deref())
    }

    pub(in crate::chat) fn clip_rect(&self, key: &str) -> Rc<DrawnRect> {
        let mut clips = self.clips.borrow_mut();
        clips.retain(|_, rect| rect.strong_count() > 0);
        if let Some(rect) = clips.get(key).and_then(Weak::upgrade) {
            return rect;
        }
        let rect = Rc::new(DrawnRect::new([0.0; 4]));
        clips.insert(key.into(), Rc::downgrade(&rect));
        rect
    }

    #[cfg(test)]
    pub(in crate::chat) fn with_clip<T>(
        &self,
        clip: &Rc<DrawnRect>,
        render: impl FnOnce() -> T,
    ) -> T {
        self.with_active_clip(&self.extend_clip(clip), render)
    }

    pub(crate) fn pause(&mut self) {
        if !self.paused {
            self.paused = true;
            self.frozen_at = Some(unix_millis());
        }
        self.next = None;
    }

    pub(crate) fn resume(&mut self) {
        self.paused = false;
        self.frozen_at = None;
    }

    pub(crate) fn reset(&mut self) {
        self.visible.clear();
        self.offscreen.clear();
        self.shown.get_mut().clear();
        self.clips.get_mut().clear();
        self.stack_bounds.set([0.0; 4]);
        self.next = None;
        self.frozen_at = None;
        self.paused = false;
        self.generation = self.generation.wrapping_add(1);
    }

    fn has_visible_in_bounds(&self, bounds: [f32; 4]) -> bool {
        let stack = self.stack_bounds.get();
        self.visible.values().any(|(lease, rect, clip)| {
            lease.upgrade().is_some_and(|active| active.get())
                && in_bounds(rect.get(), bounds, stack, clip.as_deref())
        })
    }

    pub(crate) fn poll(&mut self, now: f64, bounds: [f32; 4], tx: &mut Tx) -> bool {
        self.visible
            .retain(|_, (lease, _, _)| lease.upgrade().is_some_and(|active| active.get()));
        if self.paused {
            self.next = None;
            return false;
        }
        if !self.has_visible_in_bounds(bounds) {
            self.next = None;
            return false;
        }
        let Some(next) = self.next else {
            let due = now + 1.0;
            self.next = Some(due);
            tx.wake_at(due);
            return false;
        };
        let tick = now >= next;
        if tick {
            self.next = Some(now + 1.0);
            self.epoch = self.epoch.wrapping_add(1);
        }
        if let Some(due) = self.next {
            tx.wake_at(due);
        }
        tick
    }
}

pub(in crate::chat) fn observe_clip(s: &State, el: El) -> El {
    let scope = s.input_scope.clone();
    el.on_drawn_layout_tx(move |s: &mut State, _, tx| {
        let clock = &s.transcript_display.tool_clock;
        if s.current_scope(&scope)
            && !s.history_detached
            && online(&s.phase)
            && !clock.paused
            && clock.next.is_none()
            && clock.has_visible_in_bounds(s.tool_diff_preferences.history_bounds.get())
        {
            tx.wake_after(Duration::ZERO);
        }
        tx.live_only();
    })
}

pub(super) fn tool_timing(tool: &Tool) -> Option<(u64, Option<u64>)> {
    match tool.status.as_str() {
        "running" => tool.started.map(|start| (start, tool.ended)),
        "completed" | "error" => tool.started.zip(tool.ended.map(Some)),
        _ => None,
    }
}

pub(in crate::chat) fn view(
    s: &State,
    key: &str,
    timing: Option<(u64, Option<u64>)>,
    status: El,
) -> El {
    let entry_key = format!("{key}-duration");
    let retire = || {
        let clock = &s.transcript_display.tool_clock;
        if let Some(active) = clock
            .visible
            .get(&entry_key)
            .and_then(|(lease, _, _)| lease.upgrade())
        {
            active.set(false);
        }
        clock.shown.borrow_mut().remove(&entry_key);
    };
    let Some((start, end)) = timing else {
        retire();
        return status;
    };
    let clock = &s.transcript_display.tool_clock;
    let now = end.unwrap_or_else(|| {
        let paused = clock.paused || s.history_detached || !online(&s.phase);
        let bounds = s.tool_diff_preferences.history_bounds.get();
        let stack = clock.stack_bounds.get();
        let offscreen = clock.offscreen.contains(&entry_key)
            || clock
                .visible
                .get(&entry_key)
                .is_some_and(|(_, rect, clip)| {
                    let r = rect.get();
                    r[2] > 0.0 && r[3] > 0.0 && !in_bounds(r, bounds, stack, clip.as_deref())
                });
        if paused {
            let cached = clock
                .frozen_at
                .or_else(|| clock.shown.borrow().get(&entry_key).copied());
            cached.unwrap_or_else(|| {
                let ts = unix_millis();
                let mut shown = clock.shown.borrow_mut();
                if shown.len() >= 256 && !shown.contains_key(&entry_key) {
                    shown.retain(|k, _| clock.visible.contains_key(k));
                }
                shown.insert(entry_key.clone(), ts);
                ts
            })
        } else if offscreen {
            let cached = clock.shown.borrow().get(&entry_key).copied();
            cached.unwrap_or_else(|| {
                let ts = unix_millis();
                let mut shown = clock.shown.borrow_mut();
                if shown.len() >= 256 && !shown.contains_key(&entry_key) {
                    shown.retain(|k, _| clock.visible.contains_key(k));
                }
                shown.insert(entry_key.clone(), ts);
                ts
            })
        } else {
            let ts = unix_millis();
            let mut shown = clock.shown.borrow_mut();
            if shown.len() >= 256 && !shown.contains_key(&entry_key) {
                shown.retain(|k, _| clock.visible.contains_key(k));
            }
            shown.insert(entry_key.clone(), ts);
            ts
        }
    });
    let label = caption(now.saturating_sub(start), end.is_none());
    let group = row()
        .separate(Space::Sm)
        .child(status)
        .children(label.map(|label| text(label).text_role(TextRole::Label)));
    if end.is_some() {
        retire();
        return group;
    }
    let clock = &s.transcript_display.tool_clock;
    let lease = clock
        .visible
        .get(&entry_key)
        .and_then(|(lease, _, _)| lease.upgrade())
        .filter(|active| active.get())
        .unwrap_or_else(|| Rc::new(Cell::new(true)));
    let drawn = clock
        .visible
        .get(&entry_key)
        .map(|(_, rect, _)| rect.clone())
        .unwrap_or_else(|| Rc::new(DrawnRect::new([0.0; 4])));
    let clip = clock.active_clip.borrow().clone();
    let scope = s.input_scope.clone();
    let layout_scope = scope.clone();
    let layout_key = entry_key.clone();
    let layout_drawn = drawn.clone();
    let layout_clip = clip.clone();
    let visible_drawn = drawn.clone();
    let visible_clip = clip;
    let observer_key = format!(
        "{entry_key}-{:p}-{}",
        Rc::as_ptr(&scope),
        clock.generation()
    );
    group
        .key(observer_key)
        .drawn_rect_into(&drawn)
        .on_drawn_layout_tx(move |s: &mut State, _, tx| {
            let clock = &s.transcript_display.tool_clock;
            if s.current_scope(&layout_scope)
                && !s.history_detached
                && online(&s.phase)
                && !clock.paused
                && clock.next.is_none()
                && clock.visible.contains_key(&layout_key)
                && in_bounds(
                    layout_drawn.get(),
                    s.tool_diff_preferences.history_bounds.get(),
                    clock.stack_bounds.get(),
                    layout_clip.as_deref(),
                )
            {
                tx.wake_after(Duration::ZERO);
            }
            tx.live_only();
        })
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                let bounds = s.tool_diff_preferences.history_bounds.get();
                let clock = &mut s.transcript_display.tool_clock;
                clock
                    .visible
                    .retain(|_, (lease, _, _)| lease.upgrade().is_some_and(|active| active.get()));
                if visible {
                    let was_offscreen = clock.offscreen.remove(&entry_key);
                    let added = clock
                        .visible
                        .insert(
                            entry_key.clone(),
                            (
                                Rc::downgrade(&lease),
                                visible_drawn.clone(),
                                visible_clip.clone(),
                            ),
                        )
                        .is_none();
                    if (added || was_offscreen)
                        && !s.history_detached
                        && online(&s.phase)
                        && !clock.paused
                        && in_bounds(
                            visible_drawn.get(),
                            bounds,
                            clock.stack_bounds.get(),
                            visible_clip.as_deref(),
                        )
                    {
                        if was_offscreen {
                            clock.epoch = clock.epoch.wrapping_add(1);
                        }
                        tx.wake_after(Duration::ZERO);
                    }
                } else {
                    clock.visible.remove(&entry_key);
                    if clock.offscreen.len() >= 256 {
                        clock.offscreen.clear();
                    }
                    clock.offscreen.insert(entry_key.clone());
                }
            }
            tx.live_only();
        })
}

pub(in crate::chat) fn caption(ms: u64, live: bool) -> Option<String> {
    let seconds = (ms >= 1_000).then_some(ms / 1_000 + u64::from(ms % 1_000 >= 500))?;
    let locale = locale();
    let unit = |count: u64, name: &str, pad: bool| {
        let count_text = numbers::plain(locale, count, if pad { 2 } else { 1 });
        let key = if name == "hours" && count == 1 {
            "toolCall.duration.hours.one".to_owned()
        } else {
            format!("toolCall.duration.{name}")
        };
        catalogue::format(locale, &key, &[("count", &count_text)])
    };
    let (count, name, rest, smaller) = match seconds {
        3600.. => (seconds / 3600, "hours", (seconds / 60) % 60, "minutes"),
        60.. => (seconds / 60, "minutes", seconds % 60, "seconds"),
        _ => (seconds, "seconds", 0, ""),
    };
    let mut result = unit(count, name, false);
    if !smaller.is_empty() && (live || rest != 0) {
        result.push(' ');
        result.push_str(&unit(rest, smaller, live));
    }
    Some(result)
}

#[cfg(test)]
#[test]
fn duration_captions_match_compact_live_and_localized_rules() {
    use crate::strings::with_locale;
    with_locale("en", || {
        assert_eq!(caption(999, false), None);
        assert_eq!(caption(1_000, false).as_deref(), Some("1s"));
        assert_eq!(caption(60_000, false).as_deref(), Some("1m"));
        assert_eq!(caption(60_000, true).as_deref(), Some("1m 00s"));
        assert_eq!(caption(65_000, false).as_deref(), Some("1m 5s"));
        assert_eq!(caption(65_000, true).as_deref(), Some("1m 05s"));
        assert_eq!(caption(3_600_000, false).as_deref(), Some("1h"));
        assert_eq!(caption(3_600_000, true).as_deref(), Some("1h 00m"));
        assert_eq!(caption(1_200 * 3_600_000, false).as_deref(), Some("1200h"));
    });
    with_locale("fr", || {
        assert_eq!(caption(65_000, true).as_deref(), Some("1min 05s"));
    });
    with_locale("ne", || {
        assert_eq!(caption(65_000, true).as_deref(), Some("१ मिनेट ०५ सेकेन्ड"));
    });
    // Disjoint history_bounds (0..100) and nested pane clip (110..200) must reject a spanning header (95..120).
    let clip = Clip {
        rect: Rc::new(DrawnRect::new([0.0, 110.0, 400.0, 90.0])),
        parent: None,
    };
    assert!(!in_bounds(
        [0.0, 95.0, 100.0, 25.0],
        [0.0, 0.0, 400.0, 100.0],
        [0.0; 4],
        Some(&clip)
    ));
    assert!(in_bounds(
        [0.0, 95.0, 100.0, 25.0],
        [0.0, 0.0, 400.0, 120.0],
        [0.0, 0.0, 400.0, 120.0],
        Some(&clip)
    ));
    // Session-stack scroll clip rejects a header hidden above the outer viewport.
    assert!(!in_bounds(
        [0.0, 95.0, 100.0, 25.0],
        [0.0, 0.0, 400.0, 120.0],
        [0.0, 130.0, 400.0, 200.0],
        Some(&clip)
    ));
}
