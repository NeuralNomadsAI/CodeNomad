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
    opened: Option<Instant>,
    viewport: (f32, f32),
    dirty: bool,
    close_control: crate::window_control::WindowCloseState,
}

impl Inbox {
    pub(super) fn push(&mut self, title: &str, body: &str, target: Option<Target>, route: &Route) {
        self.dirty = true;
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
            self.bubbles
                .push_front((record, self.opened.unwrap_or_else(Instant::now) + LIFETIME));
            if self.bubbles.len() > BUBBLES {
                self.bubbles.pop_back();
            }
        }
    }

    pub(super) fn take_change(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
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

    fn resume_bubbles(&mut self, now: Instant) {
        if let Some(opened) = self.opened.take() {
            for (_, deadline) in &mut self.bubbles {
                *deadline += now.duration_since(opened);
            }
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
    let visible = inbox.opened.is_none();
    inbox
        .bubbles
        .retain(|(record, deadline)| (!visible || *deadline > clock) && current(record));
    if visible && let Some((_, deadline)) = inbox.bubbles.back() {
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
        inbox.opened.is_some(),
        touch,
        |s: &mut State, tx| {
            if s.notifications.in_app.opened.is_some() {
                close(s, tx);
            } else {
                s.notifications.in_app.opened = Some(Instant::now());
                tx.focus_when_shown("notification-history-close", tx.focus_visible());
                tx.instant();
            }
        },
    )
}

fn close(s: &mut State, tx: &mut Tx) {
    s.notifications.in_app.resume_bubbles(Instant::now());
    tx.return_focus(theme::ANCHOR, tx.focus_visible());
    tx.instant();
}

pub(crate) fn layers(s: &State, output: &mut Vec<El>) {
    let inbox = &s.notifications.in_app;
    if !inbox.bubbles.is_empty() && inbox.opened.is_none() {
        output.push(theme::bubbles(
            inbox
                .bubbles
                .iter()
                .map(|(record, _)| card(s, record, None, inbox.viewport.1)),
            inbox.viewport.0,
        ));
    }
    if inbox.opened.is_some() {
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
        theme::action(&record.title, false, move |s: &mut State, _| {
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
        toolbar = toolbar.child(layout::button_tx(
            t(label),
            false,
            move |s: &mut State, tx| {
                if s.notifications.in_app.opened.is_some() {
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
    theme::record(title, &record.body, toolbar, bubble.then_some(height))
        .key(format!("notification-{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_on_the_current_connection_is_visible_without_confirmed_settings() {
        let mut s = crate::init();
        crate::settings::notification_fixture(&s);
        crate::settings::notification_test_config(&s, None);
        s.notifications.record();
        s.notifications.focused = false;
        super::super::emit_outcome(
            &mut s,
            super::super::Category::Settings,
            None,
            "Write failed",
            true,
        );
        super::super::messages::poll(&mut s);
        assert_eq!(s.notifications.in_app.unread(), 1);
        assert_eq!(s.notifications.in_app.bubbles.len(), 1);
        assert!(s.notifications.recorded().is_empty());
    }

    #[test]
    fn the_bell_opens_history_from_the_keyboard_without_sending_a_system_notice() {
        let mut s = crate::init();
        crate::settings::notification_fixture(&s);
        crate::settings::notification_test_config(
            &s,
            serde_json::json!({"settings":{"notificationRouting":{
                "settings":{"screen":false,"history":false,"system":false}
            }}}),
        );
        s.notifications.record();
        super::super::emit_outcome(
            &mut s,
            super::super::Category::Settings,
            None,
            "Recorded failure",
            true,
        );
        super::super::messages::poll(&mut s);
        assert!(s.notifications.recorded().is_empty());
        assert_eq!(s.notifications.in_app.unread(), 1);
        assert_eq!(s.notifications.in_app.bubbles.len(), 1);
        let mut runtime =
            rune::Runtime::new(s, crate::view, (900.0, 650.0), rune::Env::new(false, 1.0));
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus(theme::ANCHOR, true));
        runtime.frame(0.02);
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        runtime.key(enter.clone());
        runtime.key_up(enter);
        runtime.frame(0.04);
        assert!(runtime.state.notifications.in_app.opened.is_some());
        let tree = runtime.accessibility_json().to_string();
        assert!(
            tree.contains("notification-history") && tree.contains("Recorded failure"),
            "{tree}"
        );
        assert!(tree.contains("notification-history-close"), "{tree}");
        runtime.update(|_, tx| tx.focus("notification-read-0", true));
        runtime.frame(0.06);
        let enter = rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        };
        runtime.key(enter.clone());
        runtime.key_up(enter);
        runtime.frame(0.08);
        assert_eq!(runtime.state.notifications.in_app.unread(), 0);
        assert_eq!(runtime.state.notifications.in_app.history.len(), 1);
    }

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
    #[test]
    fn opening_history_pauses_screen_only_bubbles() {
        let mut inbox = Inbox::default();
        let start = Instant::now();
        inbox.opened = Some(start);
        inbox.push(
            "Private",
            "Only on screen",
            None,
            &Route {
                screen: true,
                history: false,
                system: false,
            },
        );
        let later = start + Duration::from_secs(30);
        inbox.resume_bubbles(later);
        assert_eq!(inbox.bubbles[0].1, later + LIFETIME);
        assert_eq!(inbox.unread(), 0);
    }

    #[test]
    fn the_first_in_app_copy_does_not_claim_a_system_notice_while_focused() {
        let mut s = crate::init();
        let host = &mut s.notifications;
        let first = Target {
            tab: Some("a".into()),
            backend_url: "http://127.0.0.1:9/".into(),
            server: None,
            occurrence: 1,
            workspace: "first".into(),
            session: "ses_example".into(),
        };
        let second = Target {
            tab: Some("b".into()),
            occurrence: 2,
            workspace: "second".into(),
            ..first.clone()
        };
        let route = || Route {
            screen: false,
            history: true,
            system: true,
        };
        let mut initial = route();
        host.focused = true;
        super::super::messages::claim_routes(
            host,
            &first,
            super::super::Category::Sessions,
            "event",
            &mut initial,
            false,
        );
        assert!(initial.history && !initial.system);
        let mut duplicate = route();
        host.focused = false;
        super::super::messages::claim_routes(
            host,
            &second,
            super::super::Category::Sessions,
            "event",
            &mut duplicate,
            false,
        );
        assert!(!duplicate.history && duplicate.system);
    }
}
