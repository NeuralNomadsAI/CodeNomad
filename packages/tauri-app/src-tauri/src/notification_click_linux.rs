use gtk::gdk::Backend;
use gtk::prelude::*;
use std::{
    collections::VecDeque,
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Arc, OnceLock, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
use uuid::Uuid;
use zbus::{
    blocking::{connection::Builder, Connection, MessageIterator, Proxy},
    message::Type,
    zvariant::Value,
    MatchRule,
};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const REPLY_TIMEOUT: Duration = Duration::from_millis(300);
const CAPABILITIES_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct LinuxNotifications {
    pub(super) host: OnceLock<Weak<AppHandle>>,
    worker: OnceLock<Result<Arc<SyncSender<Event>>, String>>,
}

struct Bus {
    proxy: Proxy<'static>,
    capabilities: (Instant, Vec<String>),
    notices: VecDeque<Notice>,
}

enum Event {
    Show(Uuid, String, String),
    Signal(zbus::Message),
}

struct Notice {
    owner: String,
    number: u32,
    route: Uuid,
    token: Option<String>,
}

impl Bus {
    fn connect(session: Connection, events: Weak<SyncSender<Event>>) -> zbus::Result<Self> {
        let bus = Self::new(session)?;
        if let Err(error) = bus.listen(events) {
            eprintln!("[notification] cannot listen for actions: {error}");
        }
        Ok(bus)
    }

    fn listen(&self, events: Weak<SyncSender<Event>>) -> zbus::Result<()> {
        // Match without a well-known sender lookup; consume_signal checks the Notify reply's sender.
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .path(PATH)?
            .interface(SERVICE)?
            .build();
        let signals = MessageIterator::for_match_rule(rule, self.proxy.connection(), None)?;
        std::thread::Builder::new()
            .name("notification-actions".into())
            .spawn(move || {
                for signal in signals {
                    let Ok(signal) = signal else { break };
                    let Some(events) = events.upgrade() else {
                        break;
                    };
                    if events.send(Event::Signal(signal)).is_err() {
                        break;
                    }
                }
            })?;
        Ok(())
    }

    fn new(session: Connection) -> zbus::Result<Self> {
        let proxy = Proxy::new_owned(session, SERVICE, PATH, SERVICE)?;
        let capabilities = proxy.call("GetCapabilities", &()).unwrap_or_default();
        Ok(Self {
            proxy,
            capabilities: (Instant::now(), capabilities),
            notices: VecDeque::new(),
        })
    }

    fn show(&mut self, id: Uuid, title: &str, body: &str) -> zbus::Result<()> {
        self.show_at(id, title, body, Instant::now())
    }

    fn show_at(&mut self, id: Uuid, title: &str, body: &str, now: Instant) -> zbus::Result<()> {
        // A running daemon can change its capabilities on reload. Probe again on demand.
        if now.duration_since(self.capabilities.0) >= CAPABILITIES_TTL {
            let capabilities = self.proxy.call("GetCapabilities", &()).unwrap_or_default();
            self.capabilities = (now, capabilities);
        }
        let body = super::linux_body(body, &self.capabilities.1);
        // Some daemons (Notify OSD) turn any action into a dialog: offer the click only when supported.
        let clickable = self.capabilities.1.iter().any(|value| value == "actions");
        let actions: &[&str] = if clickable { &["default", ""] } else { &[] };
        let hints = std::collections::HashMap::from([(
            "desktop-entry",
            Value::from(crate::identity::STABLE_IDENTIFIER),
        )]);
        let reply = self.proxy.call_method(
            "Notify",
            &(
                "codenomad-tauri",
                0u32,
                "codenomad-tauri",
                title,
                body.as_ref(),
                actions,
                hints,
                -1i32,
            ),
        )?;
        let number = reply.body().deserialize::<u32>()?;
        if let Some(owner) = reply.header().sender().filter(|_| clickable) {
            if self.notices.len() >= super::MAX_NOTICES {
                self.notices.pop_front();
            }
            self.notices.push_back(Notice {
                owner: owner.to_string(),
                number,
                route: id,
                token: None,
            });
        }
        Ok(())
    }
}

fn connect_with_timeout(builder: Builder<'_>) -> zbus::Result<Connection> {
    builder.method_timeout(REPLY_TIMEOUT).build()
}

fn consume_signal(
    notices: &mut VecDeque<Notice>,
    signal: &zbus::Message,
) -> Option<(Notice, bool)> {
    let header = signal.header();
    let owner = header.sender()?;
    let body = signal.body();
    let (number, token, click) = match header.member()?.as_str() {
        "ActivationToken" => {
            let (number, token) = body.deserialize::<(u32, String)>().ok()?;
            if token.is_empty() || token.len() > 4096 {
                return None;
            }
            (number, Some(token), false)
        }
        "ActionInvoked" => {
            let (number, "default") = body.deserialize::<(u32, &str)>().ok()? else {
                return None;
            };
            (number, None, true)
        }
        "NotificationClosed" => (body.deserialize::<(u32, u32)>().ok()?.0, None, false),
        _ => return None,
    };
    let index = notices
        .iter()
        .position(|notice| notice.number == number && notice.owner == owner.as_str())?;
    if let Some(token) = token {
        notices[index].token = Some(token);
        return None;
    }
    notices.remove(index).map(|notice| (notice, click))
}

pub(super) fn show(
    state: &LinuxNotifications,
    id: Uuid,
    title: String,
    body: String,
) -> Result<(), String> {
    let Some(host) = state.host.get() else {
        return Err("Notification host is unavailable".into());
    };
    let worker = state.worker.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel(super::MAX_NOTICES);
        let tx = Arc::new(tx);
        let events = Arc::downgrade(&tx);
        let host = host.clone();
        std::thread::Builder::new()
            .name("notification-send".into())
            .spawn(move || run(host, events, rx))
            .map_err(|error| error.to_string())?;
        Ok(tx)
    });
    worker
        .as_ref()
        .map_err(Clone::clone)?
        .try_send(Event::Show(id, title, body))
        .map_err(|error| error.to_string())
}

fn run(host: Weak<AppHandle>, events: Weak<SyncSender<Event>>, rx: Receiver<Event>) {
    // One worker owns the connection and table. Even a fast click is handled after Notify
    // records its ID; no shared lock spans a D-Bus call.
    let mut bus = None;
    for event in rx {
        let Some(app) = host.upgrade() else { break };
        match event {
            Event::Show(id, title, body) => {
                let result = (|| {
                    if bus.is_none() {
                        let session = connect_with_timeout(Builder::session()?)?;
                        bus = Some(Bus::connect(session, events.clone())?);
                    }
                    bus.as_mut().unwrap().show(id, &title, &body)
                })();
                if let Err(error) = result {
                    app.state::<super::NotificationClicks>().take(id);
                    eprintln!("[notification] failed to show: {error}");
                }
            }
            Event::Signal(signal) => {
                if let Some((notice, click)) = bus
                    .as_mut()
                    .and_then(|bus| consume_signal(&mut bus.notices, &signal))
                {
                    if click {
                        super::clicked(&app, notice.route, notice.token);
                    } else {
                        app.state::<super::NotificationClicks>().take(notice.route);
                    }
                }
            }
        }
    }
    if let Some(bus) = bus {
        let _ = bus.proxy.connection().clone().close();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum FocusRequest<'a> {
    Wayland(&'a str),
    X11(Option<u32>),
    Fallback,
}

fn focus_request(backend: Backend, token: Option<&str>) -> FocusRequest<'_> {
    match (backend, token) {
        (Backend::Wayland, Some(token)) => FocusRequest::Wayland(token),
        (Backend::X11, token) => FocusRequest::X11(
            token
                .and_then(|token| token.rsplit_once("_TIME"))
                .and_then(|(_, time)| time.parse().ok()),
        ),
        _ => FocusRequest::Fallback,
    }
}

pub(super) fn focus(webview: &Webview, token: Option<&str>) -> bool {
    let Ok(window) = webview.window().gtk_window() else {
        return false;
    };
    match focus_request(window.display().backend(), token) {
        FocusRequest::Wayland(token) => {
            // GTK forwards the compositor-issued startup ID to this Wayland surface.
            window.show();
            window.deiconify();
            window.set_startup_id(token);
        }
        FocusRequest::X11(timestamp) => {
            // An X11 startup ID alone does not raise the window.
            window.deiconify();
            window.present_with_time(timestamp.unwrap_or(gtk::gdk::ffi::GDK_CURRENT_TIME as u32));
        }
        FocusRequest::Fallback => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::{TcpListener, TcpStream};
    use zbus::zvariant::OwnedValue;

    #[test]
    fn notification_focus_uses_the_window_backend_and_click_timestamp() {
        let token = Some("plasmashell-123_TIME4294967295");
        assert_eq!(
            focus_request(Backend::Wayland, token),
            FocusRequest::Wayland(token.unwrap())
        );
        assert_eq!(
            focus_request(Backend::X11, token),
            FocusRequest::X11(Some(u32::MAX))
        );
        assert_eq!(focus_request(Backend::X11, None), FocusRequest::X11(None));
        assert_eq!(
            focus_request(Backend::X11, Some("opaque_TIMEbad")),
            FocusRequest::X11(None)
        );
        assert_eq!(
            focus_request(Backend::Wayland, None),
            FocusRequest::Fallback
        );
        assert_eq!(
            focus_request(Backend::Broadway, token),
            FocusRequest::Fallback
        );
    }

    #[test]
    #[allow(deprecated)] // Use blocking TCP sockets for the private test bus.
    fn notification_send_continues_when_the_bus_does_not_answer_add_match() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let server = std::thread::spawn(move || {
            let mut messages = Builder::tcp_stream(listener.accept().unwrap().0)
                .auth_mechanism(zbus::AuthMechanism::Anonymous)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .build_message_iterator()
                .unwrap();
            let connection = Connection::from(&messages);
            let mut request = |member| {
                let message = messages.next().unwrap().unwrap();
                assert_eq!(message.header().member().unwrap().as_str(), member);
                message
            };
            connection
                .reply(&request("Hello").header(), &":1.20")
                .unwrap();
            connection
                .reply(&request("GetCapabilities").header(), &Vec::<String>::new())
                .unwrap();
            let add_match = request("AddMatch").body();
            let rule: MatchRule<'_> = add_match.deserialize().unwrap();
            assert_eq!(rule.msg_type(), Some(Type::Signal));
            assert_eq!(rule.interface().unwrap().as_str(), SERVICE);
            assert!(
                matches!(rule.path_spec(), Some(zbus::match_rule::PathSpec::Path(path)) if path.as_str() == PATH)
            );
            assert!(rule.sender().is_none());
            // A silent AddMatch must not stop Notify; GetNameOwner must never be sent.
            connection
                .reply(&request("Notify").header(), &1u32)
                .unwrap();
        });
        let session = connect_with_timeout(
            Builder::tcp_stream(stream).auth_mechanism(zbus::AuthMechanism::Anonymous),
        )
        .unwrap();
        let (done, result) = mpsc::channel();
        let client = std::thread::spawn(move || {
            let sent = Bus::connect(session, Weak::new())
                .and_then(|mut bus| bus.show(Uuid::new_v4(), "Title", "Body"));
            done.send(sent).unwrap();
        });
        result.recv_timeout(REPLY_TIMEOUT * 10).unwrap().unwrap();
        client.join().unwrap();
        server.join().unwrap();
    }

    #[test]
    #[allow(deprecated)] // Use blocking TCP sockets for the private peer-to-peer bus.
    fn notification_capabilities_expire_even_after_a_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (ready, subscribed) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let connection = Builder::tcp_stream(listener.accept().unwrap().0)
                .auth_mechanism(zbus::AuthMechanism::Anonymous)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .build()
                .unwrap();
            let mut messages = MessageIterator::from(&connection);
            ready.send(()).unwrap();
            let request = messages.next().unwrap().unwrap();
            assert_eq!(
                request.header().member().unwrap().as_str(),
                "GetCapabilities"
            );
            // Give the client time to use its deadline, even if the implementation under test
            // forgot to set one. A reply before the deadline would advertise markup.
            let _ = resume_rx.recv_timeout(REPLY_TIMEOUT * 5);
            connection
                .reply(&request.header(), &vec!["body-markup"])
                .unwrap();
            for (number, expected_body) in [(1u32, "R&D"), (2, "R&D"), (3, "R&amp;D"), (4, "R&D")] {
                if number >= 3 {
                    let request = messages.next().unwrap().unwrap();
                    assert_eq!(
                        request.header().member().unwrap().as_str(),
                        "GetCapabilities"
                    );
                    let capabilities = if number == 3 {
                        vec!["body-markup", "actions"]
                    } else {
                        vec![]
                    };
                    connection.reply(&request.header(), &capabilities).unwrap();
                }
                let request = messages.next().unwrap().unwrap();
                assert_eq!(request.header().member().unwrap().as_str(), "Notify");
                type Notify<'a> = (
                    &'a str,
                    u32,
                    &'a str,
                    &'a str,
                    &'a str,
                    Vec<&'a str>,
                    HashMap<String, OwnedValue>,
                    i32,
                );
                let payload = request.body();
                let (app_name, _, _, _, body, actions, mut hints, _): Notify<'_> =
                    payload.deserialize().unwrap();
                assert_eq!(app_name, "codenomad-tauri");
                assert_eq!(body, expected_body);
                // Without the `actions` capability the notification stays passive.
                let expected_actions: &[&str] = if number == 3 { &["default", ""] } else { &[] };
                assert_eq!(actions, expected_actions);
                assert_eq!(
                    String::try_from(hints.remove("desktop-entry").unwrap()).unwrap(),
                    crate::identity::STABLE_IDENTIFIER
                );
                connection.reply(&request.header(), &number).unwrap();
            }
        });
        let session = connect_with_timeout(
            Builder::tcp_stream(stream)
                .auth_mechanism(zbus::AuthMechanism::Anonymous)
                .p2p(),
        )
        .unwrap();
        subscribed.recv().unwrap();
        let mut bus = Bus::new(session).unwrap();
        assert!(bus.capabilities.1.is_empty());
        let checked_at = bus.capabilities.0;
        resume.send(()).unwrap();
        for elapsed in [
            Duration::ZERO,
            CAPABILITIES_TTL - Duration::from_millis(1),
            CAPABILITIES_TTL,
            CAPABILITIES_TTL * 2,
        ] {
            bus.show_at(Uuid::new_v4(), "Title", "R&D", checked_at + elapsed)
                .unwrap();
        }
        server.join().unwrap();
    }

    #[test]
    fn only_the_notifying_daemon_can_activate_a_notice_with_its_token() {
        let route = Uuid::new_v4();
        let mut notices = VecDeque::from([Notice {
            owner: ":1.5".into(),
            number: 7,
            route,
            token: None,
        }]);
        let signal = |member, owner, value| {
            zbus::Message::signal(PATH, SERVICE, member)
                .unwrap()
                .sender(owner)
                .unwrap()
                .build(&(7u32, value))
                .unwrap()
        };
        assert!(
            consume_signal(&mut notices, &signal("ActionInvoked", ":1.6", "default")).is_none()
        );
        assert!(
            consume_signal(&mut notices, &signal("ActivationToken", ":1.5", "token")).is_none()
        );
        assert!(consume_signal(&mut notices, &signal("ActionInvoked", ":1.5", "other")).is_none());
        let message = signal("ActionInvoked", ":1.5", "default");
        let (notice, clicked) = consume_signal(&mut notices, &message).unwrap();
        assert!(clicked);
        assert_eq!(notice.route, route);
        assert_eq!(notice.token.as_deref(), Some("token"));
        assert!(consume_signal(&mut notices, &message).is_none());
    }
}
