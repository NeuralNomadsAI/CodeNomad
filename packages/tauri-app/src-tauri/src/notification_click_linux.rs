use gtk::prelude::*;
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    sync::{Arc, Weak},
};
use tauri::{AppHandle, Manager, Webview};
use uuid::Uuid;
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::Value,
};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

#[derive(Default)]
pub(super) struct LinuxNotifications {
    pub(super) host: Mutex<Weak<AppHandle>>,
    bus: Mutex<Option<Bus>>,
}

struct Bus {
    proxy: Proxy<'static>,
    notices: Arc<Mutex<VecDeque<Notice>>>,
}

struct Notice {
    owner: String,
    number: u32,
    route: Uuid,
    token: Option<String>,
}

impl Bus {
    fn connect(host: Weak<AppHandle>) -> Result<Self, String> {
        let session = Connection::session().map_err(|error| error.to_string())?;
        let proxy =
            Proxy::new_owned(session, SERVICE, PATH, SERVICE).map_err(|error| error.to_string())?;
        let signals = proxy
            .receive_all_signals()
            .map_err(|error| error.to_string())?;
        let notices = Arc::new(Mutex::new(VecDeque::<Notice>::new()));
        let tracked = notices.clone();
        std::thread::Builder::new()
            .name("notification-actions".into())
            .spawn(move || {
                for signal in signals {
                    let Some(app) = host.upgrade() else { break };
                    let action = consume_signal(&mut tracked.lock(), &signal);
                    if let Some((notice, click)) = action {
                        if click {
                            super::clicked(&app, notice.route, notice.token);
                        } else {
                            app.state::<super::NotificationClicks>().take(notice.route);
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { proxy, notices })
    }

    fn show(&self, id: Uuid, title: &str, body: &str) -> zbus::Result<()> {
        let hints = std::collections::HashMap::from([(
            "desktop-entry",
            Value::from(crate::identity::STABLE_IDENTIFIER),
        )]);
        // Hold the table until the server's ID is recorded; a fast click can arrive meanwhile.
        let mut notices = self.notices.lock();
        let reply = self.proxy.call_method(
            "Notify",
            &(
                "CodeNomad",
                0u32,
                "codenomad-tauri",
                title,
                gtk::glib::markup_escape_text(body).as_str(),
                ["default", ""].as_slice(),
                hints,
                -1i32,
            ),
        )?;
        let number = reply.body().deserialize::<u32>()?;
        if let Some(owner) = reply.header().sender() {
            if notices.len() >= super::MAX_NOTICES {
                notices.pop_front();
            }
            notices.push_back(Notice {
                owner: owner.to_string(),
                number,
                route: id,
                token: None,
            });
        }
        Ok(())
    }
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
    let Some(host) = state.host.lock().upgrade() else {
        return Err("Notification host is unavailable".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let routes = host.state::<super::NotificationClicks>();
        let result = (|| {
            let mut bus = routes.linux.bus.lock();
            if bus.is_none() {
                *bus = Some(Bus::connect(Arc::downgrade(&host))?);
            }
            bus.as_ref()
                .unwrap()
                .show(id, &title, &body)
                .map_err(|error| error.to_string())
        })();
        if let Err(error) = result {
            host.state::<super::NotificationClicks>().take(id);
            eprintln!("[notification] failed to show: {error}");
        }
    });
    Ok(())
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
