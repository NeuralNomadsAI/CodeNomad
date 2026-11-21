use gtk::prelude::*;
use std::{
    collections::VecDeque,
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Arc, OnceLock, Weak,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, Webview};
use uuid::Uuid;
use zbus::{
    blocking::{connection::Builder, Connection, Proxy},
    zvariant::Value,
};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const REPLY_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Default)]
pub(super) struct LinuxNotifications {
    pub(super) host: OnceLock<Weak<AppHandle>>,
    worker: OnceLock<Result<Arc<SyncSender<Event>>, String>>,
}

struct Bus {
    proxy: Proxy<'static>,
    capabilities: Vec<String>,
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
    fn connect(events: Weak<SyncSender<Event>>) -> Result<Self, String> {
        let session = Builder::session()
            .and_then(connect_with_timeout)
            .map_err(|error| error.to_string())?;
        let bus = Self::new(session).map_err(|error| error.to_string())?;
        let signals = bus
            .proxy
            .receive_all_signals()
            .map_err(|error| error.to_string())?;
        std::thread::Builder::new()
            .name("notification-actions".into())
            .spawn(move || {
                for signal in signals {
                    let Some(events) = events.upgrade() else {
                        break;
                    };
                    if events.send(Event::Signal(signal)).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(bus)
    }

    fn new(session: Connection) -> zbus::Result<Self> {
        let proxy = Proxy::new_owned(session, SERVICE, PATH, SERVICE)?;
        // A timed-out or unsupported probe stays plain text until there is a new connection.
        let capabilities = proxy.call("GetCapabilities", &()).unwrap_or_default();
        Ok(Self {
            proxy,
            capabilities,
            notices: VecDeque::new(),
        })
    }

    fn show(&mut self, id: Uuid, title: &str, body: &str) -> zbus::Result<()> {
        let body = super::linux_body(body, &self.capabilities);
        let hints = std::collections::HashMap::from([(
            "desktop-entry",
            Value::from(crate::identity::STABLE_IDENTIFIER),
        )]);
        let reply = self.proxy.call_method(
            "Notify",
            &(
                "CodeNomad",
                0u32,
                "codenomad-tauri",
                title,
                body.as_ref(),
                ["default", ""].as_slice(),
                hints,
                -1i32,
            ),
        )?;
        let number = reply.body().deserialize::<u32>()?;
        if let Some(owner) = reply.header().sender() {
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
                        bus = Some(Bus::connect(events.clone())?);
                    }
                    bus.as_mut()
                        .unwrap()
                        .show(id, &title, &body)
                        .map_err(|error| error.to_string())
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

pub(super) fn focus_with_token(webview: &Webview, token: Option<&str>) -> bool {
    let Some(token) = token else { return false };
    let Ok(window) = webview.window().gtk_window() else {
        return false;
    };
    // GTK forwards the compositor-issued startup ID to this window's Wayland surface.
    window.show();
    window.deiconify();
    window.set_startup_id(token);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use zbus::blocking::MessageIterator;

    #[test]
    #[allow(deprecated)] // Use blocking TCP sockets for the private peer-to-peer bus.
    fn notification_capability_timeout_caches_plain_text_and_allows_later_sends() {
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
            for number in 1..=2u32 {
                let request = messages.next().unwrap().unwrap();
                assert_eq!(request.header().member().unwrap().as_str(), "Notify");
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
        assert!(bus.capabilities.is_empty());
        resume.send(()).unwrap();
        for _ in 0..2 {
            bus.show(Uuid::new_v4(), "Title", "R&D").unwrap();
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
