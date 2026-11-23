use super::Tool;
use crate::{State, platform::storage::unix_millis, strings::locale};
use rune::{El, Tx, text};
use rune_theme_codenomad::{TextRole, catalogue, layout::Layout, usage::numbers};
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
    time::Duration,
};

#[derive(Default)]
pub(crate) struct Clock {
    visible: HashMap<String, Weak<()>>,
    next: f64,
    epoch: u64,
}

impl Clock {
    pub(super) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn poll(&mut self, now: f64, tx: &mut Tx) -> bool {
        self.visible.retain(|_, lease| lease.strong_count() > 0);
        if self.visible.is_empty() {
            self.next = 0.0;
            return false;
        }
        let tick = now >= self.next;
        if tick {
            self.next = now + 1.0;
            self.epoch = self.epoch.wrapping_add(1);
        }
        tx.wake_at(self.next);
        tick
    }
}

pub(super) fn tool(s: &State, key: &str, tool: &Tool, header: El) -> El {
    let timing = match tool.status.as_str() {
        "running" => tool.started.map(|start| (start, None)),
        "completed" | "error" => tool.started.zip(tool.ended.map(Some)),
        _ => None,
    };
    view(s, key, timing, header)
}

pub(super) fn view(s: &State, key: &str, timing: Option<(u64, Option<u64>)>, header: El) -> El {
    let Some((start, end)) = timing else {
        return header;
    };
    let label = caption(
        end.unwrap_or_else(unix_millis).saturating_sub(start),
        end.is_none(),
    );
    let header = header.children(label.map(|label| text(label).text_role(TextRole::Label)));
    if end.is_some() {
        return header;
    }
    let key = format!("{key}-duration");
    let lease = s
        .transcript_display
        .tool_clock
        .visible
        .get(&key)
        .and_then(Weak::upgrade)
        .unwrap_or_default();
    let scope = s.input_scope.clone();
    header
        .key(key.clone())
        .on_visible(move |s: &mut State, visible, tx| {
            if s.current_scope(&scope) {
                let clock = &mut s.transcript_display.tool_clock;
                if visible {
                    if clock
                        .visible
                        .insert(key.clone(), Rc::downgrade(&lease))
                        .is_none()
                    {
                        tx.wake_after(Duration::ZERO);
                    }
                } else {
                    clock.visible.remove(&key);
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
