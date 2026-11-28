use super::{Target, activate_notice};
use crate::{State, settings::notification_routing::Route, strings::t};
use rune::{El, Tx, text};
use rune_theme_codenomad::{layout, shell::notices as theme};
use std::{collections::VecDeque, rc::Rc, time::Duration};

const HISTORY: usize = 50;
const BUBBLES: usize = 3;
const LIFETIME: Duration = Duration::from_secs(10);

pub(super) enum BubbleOptions {
    Default,
    Toast(u32),
    Compaction,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum BubbleDeadline {
    Remaining(Duration),
    At(f64),
}

struct Record {
    id: u64,
    title: String,
    body: String,
    target: Option<Target>,
    replace: bool,
    #[cfg(any(test, target_arch = "wasm32"))]
    announced: std::cell::Cell<bool>,
}

#[derive(Default)]
pub(super) struct Inbox {
    next: u64,
    history: VecDeque<(Rc<Record>, bool)>,
    bubbles: VecDeque<(Rc<Record>, BubbleDeadline)>,
    opened: bool,
    scheduled_wake: Option<f64>,
    viewport: (f32, f32),
    dirty: bool,
    close_control: crate::window_control::WindowCloseState,
}

impl Inbox {
    pub(super) fn push(
        &mut self,
        title: &str,
        body: &str,
        target: Option<Target>,
        route: &Route,
        options: BubbleOptions,
    ) {
        self.dirty = true;
        let record = Rc::new(Record {
            id: self.next,
            title: title.into(),
            body: body.into(),
            target,
            replace: matches!(options, BubbleOptions::Compaction),
            #[cfg(any(test, target_arch = "wasm32"))]
            announced: Default::default(),
        });
        self.next = self.next.wrapping_add(1);
        if route.history {
            self.history.push_front((record.clone(), false));
            if self.history.len() > HISTORY {
                self.history.pop_back();
            }
        }
        if record.replace
            && let Some(target) = &record.target
        {
            self.bubbles.retain(|(current, _)| {
                !current.replace
                    || current
                        .target
                        .as_ref()
                        .is_none_or(|old| !old.same_event_scope(target))
            });
        }
        if route.screen {
            let duration = match options {
                // A supplied zero falls back to the Solid Toaster's eight-second default.
                BubbleOptions::Toast(0) => Duration::from_secs(8),
                BubbleOptions::Toast(ms) => Duration::from_millis(u64::from(ms)),
                _ => LIFETIME,
            };
            self.bubbles
                .push_front((record, BubbleDeadline::Remaining(duration)));
            if self.bubbles.len() > BUBBLES {
                self.bubbles.pop_back();
            }
        }
    }

    #[cfg(any(test, target_arch = "wasm32"))]
    fn announcement(&self) -> Option<String> {
        if self.opened {
            return None;
        }
        let mut pending = self
            .bubbles
            .iter()
            .rev()
            .filter(|(record, _)| !record.announced.replace(true))
            .map(|(record, _)| format!("{}\n{}", record.title, record.body))
            .peekable();
        pending.peek()?;
        // A transaction keeps one announcement. Preserve every new bubble in that update.
        Some(pending.collect::<Vec<_>>().join("\n"))
    }

    fn next_expiration(&self) -> Option<f64> {
        self.bubbles
            .iter()
            .filter_map(|(_, deadline)| match *deadline {
                BubbleDeadline::At(at) => Some(at),
                BubbleDeadline::Remaining(_) => None,
            })
            .min_by(f64::total_cmp)
    }

    pub(super) fn take_change(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    pub(super) fn is_open(&self) -> bool {
        self.opened
    }

    pub(super) fn forget_tab(&mut self, tab: &str) {
        let keep = |record: &Record| {
            record
                .target
                .as_ref()
                .and_then(|target| target.tab.as_deref())
                != Some(tab)
        };
        self.bubbles.retain(|(record, _)| keep(record));
    }

    fn unread(&self) -> usize {
        self.history.iter().filter(|(_, read)| !read).count()
    }

    fn read(&mut self, id: u64) {
        if let Some((_, read)) = self.history.iter_mut().find(|(record, _)| record.id == id) {
            *read = true;
        }
    }

    fn anchor_bubbles(&mut self, now: f64) {
        for (_, deadline) in &mut self.bubbles {
            if let BubbleDeadline::Remaining(duration) = *deadline {
                *deadline = BubbleDeadline::At(now + duration.as_secs_f64());
            }
        }
    }

    fn pause_bubbles(&mut self, now: f64) {
        self.opened = true;
        self.scheduled_wake = None;
        for (_, deadline) in &mut self.bubbles {
            if let BubbleDeadline::At(at) = *deadline {
                *deadline = BubbleDeadline::Remaining(Duration::from_secs_f64((at - now).max(0.0)));
            }
        }
    }

    fn resume_bubbles(&mut self, now: f64) {
        if self.opened {
            self.opened = false;
            self.scheduled_wake = None;
            self.anchor_bubbles(now);
        }
    }
}

pub(crate) fn tick(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let mut inbox = std::mem::take(&mut s.notifications.in_app);
    let prior = (inbox.history.len(), inbox.bubbles.len());
    let current = |record: &Record| {
        record
            .target
            .as_ref()
            .is_none_or(|target| crate::workspace::owns_notification(s, target))
    };
    let visible = !inbox.opened;
    if visible {
        inbox.anchor_bubbles(now);
    }
    inbox.bubbles.retain(|(record, deadline)| {
        let alive = match *deadline {
            BubbleDeadline::At(at) => !visible || at > now,
            BubbleDeadline::Remaining(_) => true,
        };
        alive && current(record)
    });
    if visible && let Some(deadline) = inbox.next_expiration() {
        if inbox.scheduled_wake != Some(deadline) {
            inbox.scheduled_wake = Some(deadline);
            tx.wake_at(deadline);
        }
    } else {
        inbox.scheduled_wake = None;
    }
    #[cfg(target_arch = "wasm32")]
    if let Some(announcement) = inbox.announcement() {
        layout::announce_polite(tx, announcement);
    }
    let changed = prior != (inbox.history.len(), inbox.bubbles.len());
    s.notifications.in_app = inbox;
    changed
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) -> bool {
    let viewport = &mut s.notifications.in_app.viewport;
    if *viewport != (width, height) {
        *viewport = (width, height);
        tx.instant();
        true
    } else {
        false
    }
}

pub(crate) fn entry(s: &State, touch: bool, skip_tab: bool) -> El {
    entry_with(s, touch, skip_tab, false)
}

pub(crate) fn direct_entry(s: &State, touch: bool, skip_tab: bool) -> El {
    entry_with(s, touch, skip_tab, true)
}

fn entry_with(s: &State, touch: bool, skip_tab: bool, compact: bool) -> El {
    let inbox = &s.notifications.in_app;
    let unread = inbox.unread();
    let count = (unread > 0).then(|| {
        (
            if unread > 9 {
                "9+".into()
            } else {
                unread.to_string()
            },
            t("toastHistory.unread").replace("{count}", &unread.to_string()),
        )
    });
    let on_press = |s: &mut State, tx: &mut Tx| {
        crate::shell::Panels::dismiss_outside(s, tx);
        if s.notifications.in_app.opened {
            close(s, tx);
        } else {
            s.notifications.in_app.pause_bubbles(tx.clock());
            tx.focus_when_shown("notification-history-close", tx.focus_visible());
            tx.instant();
        }
    };
    if compact {
        theme::compact_bell(
            t("toastHistory.title"),
            count,
            inbox.opened,
            touch,
            skip_tab,
            on_press,
        )
    } else {
        theme::bell(
            t("toastHistory.title"),
            count,
            inbox.opened,
            touch,
            skip_tab,
            on_press,
        )
    }
}

pub(crate) fn open_history(s: &mut State, tx: &mut Tx) {
    if !s.notifications.in_app.opened {
        s.notifications.in_app.pause_bubbles(tx.clock());
        tx.focus_when_shown("notification-history-close", tx.focus_visible());
        tx.instant();
    }
}

fn close(s: &mut State, tx: &mut Tx) {
    s.notifications.in_app.resume_bubbles(tx.clock());
    tx.return_focus(theme::ANCHOR, tx.focus_visible());
    tx.instant();
}

pub(crate) fn layers(s: &State, output: &mut Vec<El>) {
    let inbox = &s.notifications.in_app;
    if !inbox.bubbles.is_empty() && !inbox.opened {
        output.push(
            theme::bubbles(
                inbox
                    .bubbles
                    .iter()
                    .map(|(record, _)| card(s, record, None, inbox.viewport.1)),
                inbox.viewport.0,
            )
            .key("notification-bubbles"),
        );
    }
    if inbox.opened {
        let toolbar = layout::action_row()
            .child(layout::button(
                t("toastHistory.markAllRead"),
                inbox.unread() == 0,
                |s: &mut State| {
                    s.notifications
                        .in_app
                        .history
                        .iter_mut()
                        .for_each(|(_, read)| *read = true);
                },
            ))
            .child(layout::button(
                t("toastHistory.clearAll"),
                inbox.history.is_empty(),
                |s: &mut State| {
                    s.notifications.in_app.history.clear();
                },
            ));
        let mut rows: Vec<_> = inbox
            .history
            .iter()
            .map(|(record, read)| card(s, record, Some(*read), inbox.viewport.1))
            .collect();
        if rows.is_empty() {
            rows.push(text(t("toastHistory.empty")));
        }
        output.push(theme::history(
            t("toastHistory.title"),
            crate::window_control::close_button(
                &inbox.close_control,
                "notification-history-close",
                layout::dark(),
                None,
                |s: &mut State| &mut s.notifications.in_app.close_control,
                close,
            ),
            toolbar,
            rows,
            inbox.viewport,
            close,
        ));
    }
}

fn card(s: &State, record: &Record, read: Option<bool>, height: f32) -> El {
    let bubble = read.is_none();
    let skip_tab = bubble && s.shell.has_floating();
    let id = record.id;
    let title = if let Some(read) = read {
        let name = if read {
            record.title.clone()
        } else {
            format!(
                "{} · {}",
                record.title,
                t("toastHistory.unread").replace("{count}", "1")
            )
        };
        layout::button_tx(&record.title, false, move |s: &mut State, _| {
            s.notifications.in_app.read(id)
        })
        .key(format!("notification-read-{id}"))
        .label(name)
    } else {
        theme::title(&record.title)
    };
    let mut toolbar = layout::action_row();
    if let Some(target) = record
        .target
        .clone()
        .filter(|target| crate::workspace::owns_notification(s, target))
    {
        let label = if target.session.is_empty() {
            "folderSelection.recent.switchToOpenProject"
        } else {
            "interruption.viewConversation"
        };
        toolbar = toolbar.child(
            layout::button_tx(t(label), false, move |s: &mut State, tx| {
                if s.notifications.in_app.opened {
                    close(s, tx);
                }
                s.notifications.in_app.read(id);
                s.notifications
                    .in_app
                    .bubbles
                    .retain(|(record, _)| record.id != id);
                activate_notice(s, target.clone());
            })
            .tab_index(if skip_tab { -1 } else { 0 }),
        );
    }
    toolbar = toolbar.child(
        layout::button(
            t(if bubble {
                "toastHistory.close"
            } else {
                "toastHistory.deleteItem"
            }),
            false,
            move |s: &mut State| {
                let inbox = &mut s.notifications.in_app;
                if bubble {
                    inbox.bubbles.retain(|(record, _)| record.id != id);
                } else {
                    inbox.history.retain(|(record, _)| record.id != id);
                }
            },
        )
        .tab_index(if skip_tab { -1 } else { 0 })
        .key(format!("notification-dismiss-{id}")),
    );
    theme::record(
        title,
        &record.body,
        toolbar,
        bubble.then_some(height),
        skip_tab,
    )
    .key(format!("notification-{id}"))
}

#[cfg(test)]
mod tests;
