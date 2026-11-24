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
    collections::HashMap,
    rc::{Rc, Weak},
    time::Duration,
};

struct Clip {
    rect: Rc<DrawnRect>,
    parent: Option<Rc<Clip>>,
}

#[derive(Default)]
pub(crate) struct Clock {
    visible: HashMap<String, (Weak<Cell<bool>>, Rc<DrawnRect>, Option<Rc<Clip>>)>,
    clips: RefCell<HashMap<String, Weak<DrawnRect>>>,
    active_clip: RefCell<Option<Rc<Clip>>>,
    next: Option<f64>,
    epoch: u64,
    generation: u64,
    paused: bool,
}

fn in_viewport(rect: [f32; 4], bounds: [f32; 4]) -> bool {
    if bounds[2] <= 0.0 || bounds[3] <= 0.0 {
        return true;
    }
    rect[2] > 0.0
        && rect[3] > 0.0
        && rect[0] < bounds[0] + bounds[2]
        && rect[0] + rect[2] > bounds[0]
        && rect[1] < bounds[1] + bounds[3]
        && rect[1] + rect[3] > bounds[1]
}

fn in_bounds(rect: [f32; 4], bounds: [f32; 4], mut clip: Option<&Clip>) -> bool {
    if !in_viewport(rect, bounds) {
        return false;
    }
    while let Some(node) = clip {
        if !in_viewport(rect, node.rect.get()) {
            return false;
        }
        clip = node.parent.as_deref();
    }
    true
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

    pub(super) fn clip_rect(&self, key: &str) -> Rc<DrawnRect> {
        let mut clips = self.clips.borrow_mut();
        clips.retain(|_, rect| rect.strong_count() > 0);
        if let Some(rect) = clips.get(key).and_then(Weak::upgrade) {
            return rect;
        }
        let rect = Rc::new(DrawnRect::new([0.0; 4]));
        clips.insert(key.into(), Rc::downgrade(&rect));
        rect
    }

    pub(super) fn with_clip<T>(&self, clip: &Rc<DrawnRect>, render: impl FnOnce() -> T) -> T {
        struct Restore<'a>(&'a RefCell<Option<Rc<Clip>>>, Option<Rc<Clip>>);
        impl Drop for Restore<'_> {
            fn drop(&mut self) {
                *self.0.borrow_mut() = self.1.take();
            }
        }
        let prev = {
            let mut current = self.active_clip.borrow_mut();
            let next = Rc::new(Clip {
                rect: clip.clone(),
                parent: current.clone(),
            });
            current.replace(next)
        };
        let _restore = Restore(&self.active_clip, prev);
        render()
    }

    pub(crate) fn pause(&mut self) {
        self.paused = true;
        self.next = None;
    }

    pub(crate) fn resume(&mut self) {
        self.paused = false;
    }

    pub(crate) fn reset(&mut self) {
        self.visible.clear();
        self.clips.get_mut().clear();
        self.next = None;
        self.paused = false;
        self.generation = self.generation.wrapping_add(1);
    }

    pub(crate) fn poll(&mut self, now: f64, bounds: [f32; 4], tx: &mut Tx) -> bool {
        if self.paused {
            self.next = None;
            return false;
        }
        self.visible
            .retain(|_, (lease, _, _)| lease.upgrade().is_some_and(|active| active.get()));
        if !self
            .visible
            .values()
            .any(|(_, rect, clip)| in_bounds(rect.get(), bounds, clip.as_deref()))
        {
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

pub(super) fn tool_timing(tool: &Tool) -> Option<(u64, Option<u64>)> {
    match tool.status.as_str() {
        "running" => tool.started.map(|start| (start, tool.ended)),
        "completed" | "error" => tool.started.zip(tool.ended.map(Some)),
        _ => None,
    }
}

pub(super) fn view(s: &State, key: &str, timing: Option<(u64, Option<u64>)>, status: El) -> El {
    let entry_key = format!("{key}-duration");
    let retire = || {
        if let Some(active) = s
            .transcript_display
            .tool_clock
            .visible
            .get(&entry_key)
            .and_then(|(lease, _, _)| lease.upgrade())
        {
            active.set(false);
        }
    };
    let Some((start, end)) = timing else {
        retire();
        return status;
    };
    let label = caption(
        end.unwrap_or_else(unix_millis).saturating_sub(start),
        end.is_none(),
    );
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
                && online(&s.phase)
                && !clock.paused
                && clock.next.is_none()
                && clock.visible.contains_key(&layout_key)
                && in_bounds(
                    layout_drawn.get(),
                    s.tool_diff_preferences.history_bounds.get(),
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
                if visible {
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
                    if added
                        && online(&s.phase)
                        && !clock.paused
                        && in_bounds(visible_drawn.get(), bounds, visible_clip.as_deref())
                    {
                        tx.wake_after(Duration::ZERO);
                    }
                } else {
                    clock.visible.remove(&entry_key);
                }
            }
            tx.live_only();
        })
}

fn caption(ms: u64, live: bool) -> Option<String> {
    let seconds = (ms >= 1_000).then_some(ms.saturating_add(500) / 1_000)?;
    let locale = locale();
    let unit = |count: u64, name: &str, pad: bool| {
        let count_text = numbers::plain(locale, count, if pad { 2 } else { 1 });
        catalogue::format(
            locale,
            &format!("toolCall.duration.{name}"),
            &[("count", &count_text)],
        )
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
}
