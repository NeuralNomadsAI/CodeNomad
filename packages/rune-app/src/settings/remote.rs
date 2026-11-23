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

#[derive(Default)]
pub(super) struct Remote {
    owner: Option<String>,
    snapshot: Option<Snapshot>,
    pairing: Option<Pairing>,
    flight: Option<(Option<Sender<()>>, Receiver<Reply>)>,
    failed: bool,
}

type Snapshot = (Status, Option<Vec<Device>>);

enum Action {
    Refresh,
    Pair(String),
    Revoke(String),
}

enum Reply {
    Snapshot(Option<Snapshot>, bool),
    Pairing(Option<Pairing>),
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
        let expired = self
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.remaining().is_zero());
        if expired {
            self.pairing = None;
        }
        let Some((_, flight)) = &self.flight else {
            return expired;
        };
        let result = match flight.try_recv() {
            Ok(result) => result,
            Err(_) if flight.is_closed() => Reply::Snapshot(None, true),
            Err(_) => return expired,
        };
        self.flight = None;
        match result {
            Reply::Snapshot(snapshot, failed) => {
                self.failed = failed;
                if let Some(snapshot) = snapshot {
                    if !snapshot.0.manageable || snapshot.0.disabled_by_administrator {
                        self.pairing = None;
                    }
                    self.snapshot = Some(snapshot);
                }
            }
            Reply::Pairing(pairing) => {
                self.failed = pairing.is_none();
                self.pairing = pairing.filter(|value| !value.remaining().is_zero());
            }
        }
        true
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
        if !eligible {
            return;
        }
        self.failed = false;
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.flight = Some((matches!(action, Action::Refresh).then_some(cancel), input));
        let (backend, wake) = (backend.clone(), wake.clone());
        if matches!(action, Action::Pair(_)) {
            self.pairing = None;
        }
        platform::spawn(async move {
            let result = match action {
                Action::Refresh => {
                    let Some(result) =
                        platform::reads::cancellable(&cancelled, snapshot(&backend)).await
                    else {
                        return;
                    };
                    let failed = result.is_err();
                    Reply::Snapshot(result.ok(), failed)
                }
                Action::Pair(origin) => {
                    Reply::Pairing(remote::pairing(&backend, &origin).await.ok())
                }
                Action::Revoke(id) => {
                    let failed = remote::revoke(&backend, &id).await.is_err();
                    let result = snapshot(&backend).await;
                    let failed = failed || result.is_err();
                    Reply::Snapshot(result.ok(), failed)
                }
            };
            let expiry = match &result {
                Reply::Pairing(Some(value)) => Some(value.remaining()),
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
                chrome::primary_action(label, !available || busy, press)
            } else {
                layout::button(label, !available || busy, press)
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
            if !status.direct_origins.is_empty() && !self.failed {
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
            if self.pairing.is_some() {
                let shared = shared.clone();
                card = card
                    .child(heading("remoteControl.pairing.title"))
                    .child(layout::button_tx(
                        t("remoteControl.pairing.copy"),
                        busy,
                        move |s, tx| {
                            let Some(state) = access(s) else {
                                return;
                            };
                            let prefs = shared.borrow();
                            if let Some(pairing) = state.pairing.as_ref()
                                && prefs.can_retry()
                                && state.owner.as_ref()
                                    == prefs.backend.as_ref().map(|backend| &backend.client_id)
                                && !pairing.remaining().is_zero()
                            {
                                #[cfg(not(target_arch = "wasm32"))]
                                let _ = tx.copy_secret(pairing.url.clone(), pairing.remaining());
                                #[cfg(target_arch = "wasm32")]
                                tx.copy(pairing.url.clone());
                            }
                        },
                    ));
            }
            if let Some(devices) = devices {
                card = card.child(heading("remoteControl.devices.title"));
                if devices.is_empty() {
                    card = card.child(text(t("remoteControl.devices.empty")).wrap());
                }
                for device in devices {
                    card = card.child(chrome::setting_row(
                        &device.name,
                        control(
                            t("remoteControl.devices.revoke"),
                            Action::Revoke(device.id.clone()),
                        )
                        .label(&format!(
                            "{} · {}",
                            t("remoteControl.devices.revoke"),
                            device.name
                        )),
                    ));
                }
            }
        }
        chrome::card(card)
    }
}
