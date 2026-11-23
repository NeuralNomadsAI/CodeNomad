use super::{Target, activate_notice};
use crate::{State, settings::notification_routing::Route, strings::t};
use codenomad_client::runtime::Instant;
use rune::{El, Tx, text};
use rune_theme_codenomad::{layout, shell::notices as theme};
use std::{collections::VecDeque, rc::Rc, time::Duration};

const HISTORY: usize = 50;
const BUBBLES: usize = 3;
const LIFETIME: Duration = Duration::from_secs(10);

struct Record {
    id: u64,
    title: String,
    body: String,
    target: Option<Target>,
}

#[derive(Default)]
pub(super) struct Inbox {
    next: u64,
    history: VecDeque<(Rc<Record>, bool)>,
    bubbles: VecDeque<(Rc<Record>, Instant)>,
    open: bool,
    viewport: (f32, f32),
}

impl Inbox {
    pub(super) fn push(&mut self, title: &str, body: &str, target: Option<Target>, route: &Route) {
        let record = Rc::new(Record {
            id: self.next,
            title: title.into(),
            body: body.into(),
            target,
        });
        self.next = self.next.wrapping_add(1);
        if route.history {
            self.history.push_front((record.clone(), false));
            if self.history.len() > HISTORY {
                self.history.pop_back();
            }
        }
        if route.screen {
            self.bubbles.push_front((record, Instant::now() + LIFETIME));
            if self.bubbles.len() > BUBBLES {
                self.bubbles.pop_back();
            }
        }
    }

    pub(super) fn forget_tab(&mut self, tab: &str) {
        let keep = |record: &Record| {
            record
                .target
                .as_ref()
                .and_then(|target| target.tab.as_deref())
                != Some(tab)
        };
        self.history.retain(|(record, _)| keep(record));
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
}

pub(crate) fn tick(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    let clock = Instant::now();
    let mut inbox = std::mem::take(&mut s.notifications.in_app);
    let prior = (inbox.history.len(), inbox.bubbles.len());
    let current = |record: &Record| {
        record
            .target
            .as_ref()
            .is_none_or(|target| crate::workspace::owns_notification(s, target))
    };
    inbox.history.retain(|(record, _)| current(record));
    inbox
        .bubbles
        .retain(|(record, deadline)| *deadline > clock && current(record));
    if let Some((_, deadline)) = inbox.bubbles.back() {
        tx.wake_at(now + (*deadline - clock).as_secs_f64());
    }
    let changed = prior != (inbox.history.len(), inbox.bubbles.len());
    s.notifications.in_app = inbox;
    changed
}

pub(crate) fn measure(s: &mut State, [_, _, width, height]: [f32; 4], tx: &mut Tx) {
    let viewport = &mut s.notifications.in_app.viewport;
    if *viewport != (width, height) {
        *viewport = (width, height);
        tx.instant();
    }
}

pub(crate) fn entry(s: &State, touch: bool) -> El {
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
    theme::bell(
        t("toastHistory.title"),
        count,
        inbox.open,
        touch,
        |s: &mut State, tx| {
            if s.notifications.in_app.open {
                close(s, tx);
            } else {
                s.notifications.in_app.open = true;
                tx.instant();
            }
        },
    )
}

fn close(s: &mut State, tx: &mut Tx) {
    s.notifications.in_app.open = false;
    tx.return_focus(theme::ANCHOR, tx.focus_visible());
    tx.instant();
}

pub(crate) fn layers(s: &State, output: &mut Vec<El>) {
    let inbox = &s.notifications.in_app;
    if !inbox.bubbles.is_empty() && !inbox.open {
        output.push(theme::bubbles(
            inbox.bubbles.iter().map(|(record, _)| card(record, true)),
            inbox.viewport.0,
        ));
    }
    if inbox.open {
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
            .map(|(record, _)| card(record, false))
            .collect();
        if rows.is_empty() {
            rows.push(text(t("toastHistory.empty")));
        }
        output.push(theme::history(
            t("toastHistory.title"),
            toolbar,
            rows,
            inbox.viewport,
            close,
        ));
    }
}

fn card(record: &Record, bubble: bool) -> El {
    let id = record.id;
    let mut toolbar = layout::action_row();
    if let Some(target) = record.target.clone() {
        let label = if target.session.is_empty() {
            "folderSelection.recent.switchToOpenProject"
        } else {
            "interruption.viewConversation"
        };
        toolbar = toolbar.child(layout::button_tx(
            t(label),
            false,
            move |s: &mut State, tx| {
                if s.notifications.in_app.open {
                    close(s, tx);
                }
                s.notifications.in_app.read(id);
                s.notifications
                    .in_app
                    .bubbles
                    .retain(|(record, _)| record.id != id);
                activate_notice(s, target.clone());
            },
        ));
    }
    toolbar = toolbar.child(layout::button(
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
    ));
    theme::record(&record.title, &record.body, toolbar, bubble).key(format!("notification-{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_destinations_control_history_and_bubbles_per_window() {
        let mut s = crate::init();
        let other = crate::init();
        super::super::messages::publish(
            &mut s,
            "Project",
            "Screen",
            None,
            Route {
                screen: true,
                history: false,
                system: false,
            },
            false,
        );
        super::super::messages::publish(
            &mut s,
            "Project",
            "History",
            None,
            Route {
                screen: false,
                history: true,
                system: false,
            },
            false,
        );
        let inbox = &s.notifications.in_app;
        assert_eq!(inbox.unread(), 1);
        assert_eq!(inbox.bubbles[0].0.body, "Screen");
        assert_eq!(inbox.history[0].0.body, "History");
        assert_eq!(other.notifications.in_app.unread(), 0);
        for _ in 0..HISTORY {
            s.notifications.in_app.push(
                "Project",
                "Earlier",
                None,
                &Route {
                    screen: true,
                    history: true,
                    system: false,
                },
            );
        }
        let inbox = &mut s.notifications.in_app;
        assert_eq!(inbox.history.len(), HISTORY);
        assert_eq!(inbox.bubbles.len(), BUBBLES);
        inbox.read(inbox.history[0].0.id);
        assert_eq!(inbox.unread(), HISTORY - 1);
    }
}
