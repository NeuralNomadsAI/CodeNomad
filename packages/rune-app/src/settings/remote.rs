use super::Preferences;
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::remote::{self, Device, Pairing, Status},
};
use rune::{El, Waker, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

mod pairing_view;

#[derive(Default)]
pub(super) struct Remote {
    owner: Option<String>,
    snapshot: Option<Snapshot>,
    pairing: Option<Pairing>,
    flight: Option<(Option<Sender<()>>, Receiver<Reply>)>,
    failed: bool,
    needs_read: bool,
    unconfirmed: Option<Mutation>,
    copy: pairing_view::Copy,
}

type Snapshot = (Status, Option<Vec<Device>>);

enum Action {
    Refresh,
    Pair(String),
    Revoke(String),
}

enum Mutation {
    Pair,
    Revoke(String),
}

enum Reply {
    Snapshot(Option<Snapshot>),
    Pairing(Pairing),
}

async fn snapshot(backend: &Backend) -> codenomad_client::history::Result<Snapshot> {
    let status = remote::status(backend).await?;
    let devices = if status.manageable {
        remote::devices(backend).await?
    } else {
        None
    };
    Ok((status, devices))
}

impl Remote {
    pub fn close(&mut self) {
        *self = Self::default();
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker) -> bool {
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        let owner = backend.map(|backend| backend.client_id.as_str());
        if self.owner.as_deref() != owner {
            self.close();
            self.owner = owner.map(str::to_owned);
            if let Some(backend) = backend {
                self.start(backend, wake, Action::Refresh);
            }
            return true;
        }
        let copied = self.copy.poll();
        let expired = self
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.remaining().is_zero());
        if expired {
            self.clear_pairing();
        }
        let Some((_, flight)) = &self.flight else {
            return expired | copied;
        };
        let result = match flight.try_recv() {
            Ok(result) => result,
            Err(_) if flight.is_closed() => Reply::Snapshot(None),
            Err(_) => return expired | copied,
        };
        self.flight = None;
        match result {
            Reply::Snapshot(Some(snapshot)) => {
                let (status, devices) = &snapshot;
                if !status.manageable || status.disabled_by_administrator {
                    self.clear_pairing();
                }
                self.needs_read =
                    matches!(self.unconfirmed, Some(Mutation::Revoke(_))) && devices.is_none();
                self.failed = if self.needs_read {
                    true
                } else {
                    match self.unconfirmed.take() {
                        Some(Mutation::Revoke(id)) => devices
                            .as_ref()
                            .is_some_and(|devices| devices.iter().any(|device| device.id == id)),
                        Some(Mutation::Pair) => true,
                        None => false,
                    }
                };
                if !self.needs_read {
                    self.snapshot = Some(snapshot);
                }
            }
            Reply::Snapshot(None) => {
                self.needs_read = true;
                self.failed = true;
            }
            Reply::Pairing(pairing) => {
                self.unconfirmed = None;
                self.needs_read = false;
                self.failed = pairing.remaining().is_zero();
                self.pairing = (!self.failed).then_some(pairing);
            }
        }
        true
    }

    fn clear_pairing(&mut self) {
        self.pairing = None;
        self.copy = Default::default();
    }

    fn start(&mut self, backend: &Backend, wake: &Waker, action: Action) {
        if self.flight.is_some() || self.owner.as_deref() != Some(&backend.client_id) {
            return;
        }
        let eligible = match &action {
            Action::Refresh => true,
            Action::Pair(origin) => self.snapshot.as_ref().is_some_and(|(status, _)| {
                status.manageable
                    && !status.disabled_by_administrator
                    && status.direct_origins.contains(origin)
            }),
            Action::Revoke(id) => self.snapshot.as_ref().is_some_and(|(status, devices)| {
                status.manageable
                    && devices
                        .as_ref()
                        .is_some_and(|devices| devices.iter().any(|device| device.id == *id))
            }),
        };
        if !eligible || (self.needs_read && !matches!(action, Action::Refresh)) {
            return;
        }
        if !matches!(action, Action::Refresh) {
            self.failed = false;
        }
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.flight = Some((matches!(action, Action::Refresh).then_some(cancel), input));
        let (backend, wake) = (backend.clone(), wake.clone());
        match &action {
            Action::Pair(_) => {
                self.clear_pairing();
                self.unconfirmed = Some(Mutation::Pair);
            }
            Action::Revoke(id) => self.unconfirmed = Some(Mutation::Revoke(id.clone())),
            Action::Refresh => {}
        }
        platform::spawn(async move {
            let result = match action {
                Action::Refresh => {
                    let Some(result) =
                        platform::reads::cancellable(&cancelled, snapshot(&backend)).await
                    else {
                        return;
                    };
                    Reply::Snapshot(result.ok())
                }
                Action::Pair(origin) => match remote::pairing(&backend, &origin).await {
                    Ok(pairing) => Reply::Pairing(pairing),
                    Err(_) => Reply::Snapshot(snapshot(&backend).await.ok()),
                },
                Action::Revoke(id) => {
                    let _ = remote::revoke(&backend, &id).await;
                    Reply::Snapshot(snapshot(&backend).await.ok())
                }
            };
            let expiry = match &result {
                Reply::Pairing(value) => Some(value.remaining()),
                _ => None,
            };
            if out.send(result).await.is_ok() {
                wake();
                if let Some(delay) = expiry {
                    platform::sleep(delay).await;
                    wake();
                }
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        access: fn(&mut S) -> Option<&mut Self>,
    ) -> El {
        let prefs = shared.borrow();
        let busy = self.flight.is_some();
        let available = prefs.can_retry()
            && self.owner.as_ref() == prefs.backend.as_ref().map(|backend| &backend.client_id);
        let control = |label: &str, action: Action| {
            let shared = shared.clone();
            let primary = matches!(action, Action::Pair(_));
            let disabled =
                !available || busy || self.needs_read && !matches!(action, Action::Refresh);
            let press = move |s: &mut S| {
                let Some(state) = access(s) else {
                    return;
                };
                let prefs = shared.borrow();
                let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry()) else {
                    return;
                };
                let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref()) else {
                    return;
                };
                state.start(
                    backend,
                    wake,
                    match &action {
                        Action::Refresh => Action::Refresh,
                        Action::Pair(origin) => Action::Pair(origin.clone()),
                        Action::Revoke(id) => Action::Revoke(id.clone()),
                    },
                );
            };
            if primary {
                chrome::primary_action(label, disabled, press)
            } else {
                layout::button(label, disabled, press)
            }
        };
        let heading = |key| text(t(key)).text_role(TextRole::Title).role("heading");
        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(heading("remoteControl.title"))
            .child(control(t("remoteControl.refresh"), Action::Refresh));
        if self.failed {
            card = card.child(text(t("remoteControl.state.error")).role("alert").wrap());
        }
        if let Some((status, devices)) = self.snapshot.as_ref().filter(|_| available) {
            card = card.child(
                text(t(if status.disabled_by_administrator {
                    "remoteControl.state.disabled"
                } else if !status.manageable {
                    "remoteControl.status.hostOnly"
                } else {
                    "remoteControl.state.stopped"
                }))
                .role("status")
                .wrap(),
            );
            if !status.direct_origins.is_empty() {
                card = card.child(heading("remoteControl.direct.title"));
                for origin in &status.direct_origins {
                    card = card.child(chrome::setting_row(
                        origin,
                        control(
                            t("remoteControl.direct.newLink"),
                            Action::Pair(origin.clone()),
                        ),
                    ));
                }
            }
            if let Some(pairing) = &self.pairing {
                card = card.child(pairing_view::view(
                    pairing, &self.copy, busy, shared, access,
                ));
            }
            if let Some(devices) = devices {
                card = card.child(heading("remoteControl.devices.title"));
                if devices.is_empty() {
                    card = card.child(text(t("remoteControl.devices.empty")).wrap());
                }
                for device in devices {
                    let origin = device.origin.as_ref().map_or_else(
                        || t("remoteControl.devices.tunnel").to_owned(),
                        |origin| t("remoteControl.devices.direct").replace("{origin}", origin),
                    );
                    let seen = t("remoteControl.devices.lastSeen")
                        .replace("{time}", &pairing_view::last_seen(&device.last_seen_at));
                    let uncertain = self.needs_read
                        && matches!(&self.unconfirmed, Some(Mutation::Revoke(id)) if *id == device.id);
                    let revoke = t("remoteControl.devices.revoke");
                    card = card.child(
                        col()
                            .full_width()
                            .separate(Space::Xs)
                            .child(chrome::setting_row(
                                &device.name,
                                control(revoke, Action::Revoke(device.id.clone())).label(&format!(
                                    "{revoke} · {} · {origin} · {seen}",
                                    device.name
                                )),
                            ))
                            .child(text(&origin).wrap())
                            .child(text(&seen).wrap())
                            .children(uncertain.then(|| {
                                text(t("remoteControl.devices.revocationPending")).role("status")
                            })),
                    );
                }
            }
        }
        chrome::card(card)
    }
}
