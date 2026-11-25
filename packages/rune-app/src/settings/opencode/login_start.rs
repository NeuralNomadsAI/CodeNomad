use super::super::Preferences;
use crate::{history::Result, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{LoginStartError, LoginStartState, opencode_login_start, set_opencode_login_start},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Failure {
    Read,
    Failed,
    UnsupportedBinary,
}

impl Failure {
    fn key(self) -> &'static str {
        match self {
            Self::Read => "settings.loginStart.error.read",
            Self::Failed => "settings.loginStart.error.failed",
            Self::UnsupportedBinary => "settings.loginStart.error.unsupported-binary",
        }
    }
}

#[derive(Default)]
pub(super) struct State {
    authority: Option<String>,
    transport_epoch: Option<u64>,
    status: Option<LoginStartState>,
    failure: Option<Failure>,
    sequence: u64,
    read_flight: Option<(u64, Sender<()>, Receiver<Result<LoginStartState>>)>,
    write_flight: Option<(
        u64,
        Receiver<std::result::Result<LoginStartState, LoginStartError>>,
    )>,
    pending_write_error: Option<LoginStartError>,
    info_open: bool,
}

impl State {
    pub(super) fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker) -> bool {
        let transport = prefs.opencode_transport_generation();
        let authority = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                transport_epoch: transport.as_ref().map(|(_, epoch)| *epoch),
                ..Self::default()
            };
        } else {
            let epoch = transport.as_ref().map(|(_, epoch)| *epoch);
            if epoch != self.transport_epoch {
                self.transport_epoch = epoch;
                changed = true;
                // Cancel pre-drop reads so stale responses cannot overwrite post-reconnect state;
                // never replay an in-flight POST.
                self.read_flight = None;
                if epoch.is_none() {
                    self.sequence = self.sequence.wrapping_add(1);
                } else if !self.busy() {
                    self.start_read(prefs, wake);
                }
            }
        }

        let write_done = self
            .write_flight
            .as_ref()
            .and_then(|(seq, rx)| rx.try_recv().ok().map(|res| (*seq, res)));
        if let Some((seq, result)) = write_done {
            self.write_flight = None;
            changed = true;
            if seq == self.sequence {
                match result {
                    Ok(state) => {
                        self.status = Some(state);
                        self.failure = None;
                        self.pending_write_error = None;
                    }
                    Err(error) => {
                        // Reload actual host state after a refused change; keep the cause unless
                        // reading the host state also fails.
                        self.pending_write_error = Some(error);
                        self.start_read(prefs, wake);
                    }
                }
            }
        }

        let read_done = self
            .read_flight
            .as_ref()
            .and_then(|(seq, _, rx)| rx.try_recv().ok().map(|res| (*seq, res)));
        if let Some((seq, result)) = read_done {
            self.read_flight = None;
            changed = true;
            if seq == self.sequence {
                let write_error = self.pending_write_error.take();
                match result {
                    Ok(state) => {
                        self.status = Some(state);
                        self.failure = write_error.map(|error| match error {
                            LoginStartError::UnsupportedBinary => Failure::UnsupportedBinary,
                            LoginStartError::Failed => Failure::Failed,
                        });
                    }
                    Err(_) => {
                        self.failure = Some(Failure::Read);
                    }
                }
            }
        }

        if transport.is_some()
            && self.status.is_none()
            && self.failure.is_none()
            && self.read_flight.is_none()
            && self.write_flight.is_none()
        {
            self.start_read(prefs, wake);
            changed = true;
        }
        changed
    }

    pub(super) fn reload(&mut self, prefs: &Preferences, wake: Option<&rune::Waker>) {
        if self.busy() {
            return;
        }
        let Some(wake) = wake else {
            return;
        };
        self.pending_write_error = None;
        self.start_read(prefs, wake);
    }

    fn start_read(&mut self, prefs: &Preferences, wake: &rune::Waker) {
        let Some(backend) = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .cloned()
        else {
            return;
        };
        self.sequence = self.sequence.wrapping_add(1);
        let seq = self.sequence;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        self.read_flight = Some((seq, cancel, rx));
        let wake = wake.clone();
        platform::spawn(async move {
            if let Some(result) =
                platform::reads::cancellable(&cancelled, opencode_login_start(&backend)).await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }

    fn toggle(&mut self, prefs: &Preferences, wake: Option<rune::Waker>, enabled: bool) {
        if self.busy() || self.status.is_none() || self.status == Some(LoginStartState::Unavailable)
        {
            return;
        }
        let (Some(backend), Some(wake)) = (
            prefs
                .backend
                .as_ref()
                .filter(|_| prefs.can_retry())
                .cloned(),
            wake,
        ) else {
            return;
        };
        self.sequence = self.sequence.wrapping_add(1);
        let seq = self.sequence;
        self.read_flight = None;
        self.failure = None;
        self.pending_write_error = None;
        let (out, rx) = bounded(1);
        self.write_flight = Some((seq, rx));
        platform::spawn(async move {
            let result = set_opencode_login_start(&backend, enabled).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    fn busy(&self) -> bool {
        self.write_flight.is_some() || self.pending_write_error.is_some()
    }

    pub(super) fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        wake: Option<rune::Waker>,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let title = t("settings.loginStart.title");
        let unavailable = self.status == Some(LoginStartState::Unavailable);
        let checked = self.status == Some(LoginStartState::On);
        let disabled = self.busy() || self.status.is_none() || unavailable || !prefs.can_retry();
        let toggle_shared = shared.clone();
        let toggle_wake = wake.clone();
        let switch = chrome::setting_switch(title, checked, disabled, move |s: &mut S| {
            let prefs = toggle_shared.borrow();
            access(s)
                .login_start
                .toggle(&prefs, toggle_wake.clone(), !checked);
        })
        .key("opencode-login-start-switch");
        let info = chrome::info_tip(
            t("settings.loginStart.info"),
            t("settings.loginStart.info"),
            self.info_open,
            move |s: &mut S| {
                let state = &mut access(s).login_start;
                state.info_open = !state.info_open;
            },
        )
        .key("opencode-login-start-info");

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::setting_row_with_info(title, Some(info), switch));

        if unavailable {
            card = card.child(
                text(t("settings.loginStart.unavailable"))
                    .wrap()
                    .role("status")
                    .key("opencode-login-start-unavailable"),
            );
        }
        if let Some(failure) = self.failure {
            let mut row = layout::action_row().child(
                text(t(failure.key()))
                    .wrap()
                    .role("alert")
                    .key("opencode-login-start-error"),
            );
            if failure == Failure::Read {
                let retry_shared = shared.clone();
                let retry_wake = wake;
                row = row.child(
                    layout::button(
                        t("settings.loginStart.retry"),
                        self.read_flight.is_some() || !prefs.can_retry(),
                        move |s: &mut S| {
                            let prefs = retry_shared.borrow();
                            access(s).login_start.reload(&prefs, retry_wake.as_ref());
                        },
                    )
                    .key("opencode-login-start-retry"),
                );
            }
            card = card.child(row);
        }
        chrome::card(card)
    }
}
