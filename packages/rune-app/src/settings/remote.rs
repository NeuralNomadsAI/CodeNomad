use super::Preferences;
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::remote::{self, Device, Pairing, Status, TunnelState},
};
use rune::{El, Waker, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc, time::Duration};

mod direct;
mod pairing_view;
#[cfg(test)]
mod tests;

const CONNECTING_POLL_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub(super) enum ErrorText {
    Key(&'static str),
    Raw(String),
}

impl ErrorText {
    pub fn from_remote(err: remote::Error, fallback_key: &'static str) -> Self {
        match err {
            remote::Error::Server(message) => Self::Raw(message),
            remote::Error::Transport
            | remote::Error::InvalidResponse
            | remote::Error::SaveFailed => Self::Key(fallback_key),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Key(key) => t(key),
            Self::Raw(message) => message,
        }
    }
}

#[derive(Default)]
pub(super) struct Remote {
    owner: Option<String>,
    snapshot: Option<Snapshot>,
    pairing: Option<ActivePairing>,
    flight: Option<(Option<Sender<()>>, Receiver<Reply>)>,
    recheck: Option<(Sender<()>, Receiver<()>)>,
    error: Option<ErrorText>,
    mutation_error: Option<(MutationOutcome, ErrorText)>,
    needs_read: bool,
    unconfirmed: Option<Mutation>,
    disabled_info_open: bool,
    previews_info_open: bool,
    copy: pairing_view::Copy,
    direct: direct::DirectAccess,
}

type Snapshot = (Status, Option<Vec<Device>>);

struct SnapshotRead {
    status: Status,
    devices: Option<Vec<Device>>,
    devices_error: Option<remote::Error>,
}

pub(super) struct ActivePairing {
    pub pairing: Pairing,
    pub direct: bool,
}

#[derive(Clone)]
enum Action {
    Refresh,
    Start,
    Stop,
    SetPreviews(bool),
    PairTunnel,
    PairDirect(String),
    Revoke(String),
}

#[derive(Clone)]
enum MutationOutcome {
    Start,
    Stop,
    SetPreviews(bool),
    Pair,
    Revoke(String),
}

impl MutationOutcome {
    fn confirmed(&self, status: &Status, devices: Option<&[Device]>, devices_error: bool) -> bool {
        match self {
            Self::Start => status.enabled,
            Self::Stop => !status.enabled && !status.starts_on_launch,
            Self::SetPreviews(desired) => status.previews == *desired,
            Self::Pair => false,
            Self::Revoke(id) => {
                !devices_error && devices.is_some_and(|list| !list.iter().any(|d| d.id == *id))
            }
        }
    }
}

enum Mutation {
    Start,
    Stop,
    SetPreviews(bool),
    Pair,
    Revoke(String, Option<ErrorText>),
}

impl Mutation {
    fn outcome(&self) -> MutationOutcome {
        match self {
            Self::Start => MutationOutcome::Start,
            Self::Stop => MutationOutcome::Stop,
            Self::SetPreviews(desired) => MutationOutcome::SetPreviews(*desired),
            Self::Pair => MutationOutcome::Pair,
            Self::Revoke(id, _) => MutationOutcome::Revoke(id.clone()),
        }
    }
}

enum Reply {
    Snapshot(Result<SnapshotRead, remote::Error>, Option<remote::Error>),
    Started(Result<(Status, Pairing, Option<Vec<Device>>), remote::Error>),
    Status(Result<Status, remote::Error>),
    Pairing(Result<(Pairing, bool), remote::Error>),
}

async fn snapshot(backend: &Backend) -> Result<SnapshotRead, remote::Error> {
    let status = remote::status(backend).await?;
    let (devices, devices_error) = if status.manageable {
        match remote::devices(backend).await {
            Ok(devices) => (devices, None),
            Err(err) => (None, Some(err)),
        }
    } else {
        (None, None)
    };
    Ok(SnapshotRead {
        status,
        devices,
        devices_error,
    })
}

impl Remote {
    pub fn close(&mut self) {
        self.direct.close();
        let direct = std::mem::take(&mut self.direct);
        *self = Self {
            direct,
            ..Self::default()
        };
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker) -> bool {
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        let owner = backend.map(|backend| backend.client_id.as_str());
        if self.owner.as_deref() != owner {
            self.close();
            self.owner = owner.map(str::to_owned);
            if let Some(backend) = backend {
                self.start(backend, wake, Action::Refresh);
                self.direct.poll(Some(backend), wake);
            }
            return true;
        }
        let mut changed = self.direct.poll(backend, wake);
        changed |= self.copy.poll();
        let expired = self
            .pairing
            .as_ref()
            .is_some_and(|active| active.pairing.remaining().is_zero());
        if expired {
            self.clear_pairing();
            changed = true;
        }
        if let Some((_, timer)) = &self.recheck
            && timer.try_recv().is_ok()
        {
            self.recheck = None;
            if self.flight.is_none()
                && let Some(backend) = backend
                && self
                    .snapshot
                    .as_ref()
                    .is_some_and(|(status, _)| status.state.is_connecting())
            {
                self.start(backend, wake, Action::Refresh);
                changed = true;
            }
        }
        let Some((_, flight)) = &self.flight else {
            return changed;
        };
        let result = match flight.try_recv() {
            Ok(result) => result,
            Err(_) if flight.is_closed() => {
                self.flight = None;
                self.needs_read = true;
                self.error = Some(ErrorText::Key("remoteControl.state.error"));
                self.sync_connecting_poll(wake);
                return true;
            }
            Err(_) => return changed,
        };
        self.flight = None;
        match result {
            Reply::Snapshot(Ok(read), revoke_err) => {
                if let Some(Mutation::Revoke(id, stored)) = self.unconfirmed.as_mut()
                    && let Some(err) = revoke_err
                {
                    let err_text = ErrorText::from_remote(err, "remoteControl.state.error");
                    *stored = Some(err_text.clone());
                    self.mutation_error = Some((MutationOutcome::Revoke(id.clone()), err_text));
                }
                let status = read.status;
                let keep_direct = self.pairing.as_ref().is_some_and(|p| p.direct);
                if !status.manageable
                    || status.disabled_by_administrator
                    || (!status.enabled && !keep_direct)
                {
                    self.clear_pairing();
                }
                let devices = if !status.manageable {
                    None
                } else if read.devices_error.is_some() {
                    self.snapshot.as_ref().and_then(|(_, d)| d.clone())
                } else {
                    read.devices
                };
                self.needs_read = matches!(self.unconfirmed, Some(Mutation::Revoke(_, _)))
                    && (read.devices_error.is_some() || devices.is_none());
                if self.needs_read {
                    let stored = self
                        .mutation_error
                        .as_ref()
                        .map(|(_, e)| e.clone())
                        .or_else(|| match &self.unconfirmed {
                            Some(Mutation::Revoke(_, err)) => err.clone(),
                            _ => None,
                        });
                    self.error = stored
                        .clone()
                        .filter(|err| matches!(err, ErrorText::Raw(_)))
                        .or_else(|| {
                            read.devices_error
                                .map(|err| ErrorText::from_remote(err, "remoteControl.state.error"))
                        })
                        .or(stored)
                        .or(Some(ErrorText::Key("remoteControl.state.error")));
                } else {
                    if let Some(mutation) = self.unconfirmed.take() {
                        let outcome = mutation.outcome();
                        if !outcome.confirmed(
                            &status,
                            devices.as_deref(),
                            read.devices_error.is_some(),
                        ) && self.mutation_error.is_none()
                        {
                            let err_text = match mutation {
                                Mutation::Revoke(_, Some(err)) => err,
                                _ => ErrorText::Key("remoteControl.state.error"),
                            };
                            self.mutation_error = Some((outcome, err_text));
                        }
                    }
                    if let Some((outcome, err)) = &self.mutation_error
                        && !(matches!(outcome, MutationOutcome::Start | MutationOutcome::Stop)
                            && matches!(err, ErrorText::Raw(_)))
                        && outcome.confirmed(
                            &status,
                            devices.as_deref(),
                            read.devices_error.is_some(),
                        )
                    {
                        self.mutation_error = None;
                    }
                    let explicit_mutation = self
                        .mutation_error
                        .as_ref()
                        .map(|(_, err)| err.clone())
                        .filter(|err| matches!(err, ErrorText::Raw(_)));
                    self.error = explicit_mutation
                        .or_else(|| {
                            read.devices_error
                                .map(|err| ErrorText::from_remote(err, "remoteControl.state.error"))
                        })
                        .or_else(|| self.mutation_error.as_ref().map(|(_, err)| err.clone()));
                }
                self.snapshot = Some((status, devices));
            }
            Reply::Snapshot(Err(err), revoke_err) => {
                self.needs_read = true;
                if let Some(Mutation::Revoke(id, stored)) = self.unconfirmed.as_mut()
                    && let Some(err) = revoke_err
                {
                    let err_text = ErrorText::from_remote(err, "remoteControl.state.error");
                    *stored = Some(err_text.clone());
                    self.mutation_error = Some((MutationOutcome::Revoke(id.clone()), err_text));
                }
                let stored = self.mutation_error.as_ref().map(|(_, err)| err.clone());
                self.error = stored
                    .filter(|err| matches!(err, ErrorText::Raw(_)))
                    .or_else(|| Some(ErrorText::from_remote(err, "remoteControl.state.error")));
            }
            Reply::Started(Ok((status, pairing, devices))) => {
                self.unconfirmed = None;
                self.mutation_error = None;
                self.needs_read = false;
                self.error = None;
                let existing_devices = self.snapshot.as_ref().and_then(|(_, d)| d.clone());
                self.snapshot = Some((status, devices.or(existing_devices)));
                self.set_pairing(pairing, false);
            }
            Reply::Started(Err(err)) => {
                let err_text = ErrorText::from_remote(err, "remoteControl.state.error");
                self.mutation_error = Some((MutationOutcome::Start, err_text.clone()));
                self.error = Some(err_text);
                if let Some(backend) = backend {
                    self.start(backend, wake, Action::Refresh);
                } else {
                    self.unconfirmed = None;
                    self.needs_read = true;
                }
            }
            Reply::Status(Ok(status)) => {
                let mutation = self.unconfirmed.take();
                self.mutation_error = None;
                self.needs_read = false;
                self.error = None;
                let keep_direct = self.pairing.as_ref().is_some_and(|p| p.direct);
                if matches!(mutation, Some(Mutation::Stop)) && !keep_direct {
                    self.clear_pairing();
                } else if !status.manageable
                    || status.disabled_by_administrator
                    || (!status.enabled && !keep_direct)
                {
                    self.clear_pairing();
                }
                let devices = self.snapshot.as_ref().and_then(|(_, d)| d.clone());
                self.snapshot = Some((status, devices));
            }
            Reply::Status(Err(err)) => {
                let err_text = ErrorText::from_remote(err, "remoteControl.state.error");
                if let Some(outcome) = self.unconfirmed.as_ref().map(Mutation::outcome) {
                    self.mutation_error = Some((outcome, err_text.clone()));
                }
                self.error = Some(err_text);
                if let Some(backend) = backend {
                    self.start(backend, wake, Action::Refresh);
                } else {
                    self.unconfirmed = None;
                    self.needs_read = true;
                }
            }
            Reply::Pairing(Ok((pairing, direct))) => {
                self.unconfirmed = None;
                self.mutation_error = None;
                self.needs_read = false;
                self.error = None;
                self.set_pairing(pairing, direct);
            }
            Reply::Pairing(Err(err)) => {
                let err_text = ErrorText::from_remote(err, "remoteControl.state.error");
                self.mutation_error = Some((MutationOutcome::Pair, err_text.clone()));
                self.error = Some(err_text);
                if let Some(backend) = backend {
                    self.start(backend, wake, Action::Refresh);
                } else {
                    self.unconfirmed = None;
                    self.needs_read = true;
                }
            }
        }
        self.sync_connecting_poll(wake);
        true
    }

    fn set_pairing(&mut self, pairing: Pairing, direct: bool) {
        self.copy = Default::default();
        if pairing.remaining().is_zero() {
            self.pairing = None;
            self.error = Some(ErrorText::Key("remoteControl.state.error"));
        } else {
            self.pairing = Some(ActivePairing { pairing, direct });
        }
    }

    fn clear_pairing(&mut self) {
        self.pairing = None;
        self.copy = Default::default();
    }

    fn sync_connecting_poll(&mut self, wake: &Waker) {
        let connecting = self
            .snapshot
            .as_ref()
            .is_some_and(|(status, _)| status.state.is_connecting());
        if !connecting {
            self.recheck = None;
            return;
        }
        if self.recheck.is_some() || self.flight.is_some() {
            return;
        }
        let (cancel, cancelled) = bounded(1);
        let (out, ready) = bounded(1);
        self.recheck = Some((cancel, ready));
        let wake = wake.clone();
        platform::spawn(async move {
            if platform::reads::cancellable(&cancelled, platform::sleep(CONNECTING_POLL_DELAY))
                .await
                .is_some()
                && out.send(()).await.is_ok()
            {
                wake();
            }
        });
    }

    fn start(&mut self, backend: &Backend, wake: &Waker, action: Action) {
        if self.flight.is_some() || self.owner.as_deref() != Some(&backend.client_id) {
            return;
        }
        let eligible = match &action {
            Action::Refresh => true,
            Action::Start => self.snapshot.as_ref().is_some_and(|(status, _)| {
                status.manageable && !status.disabled_by_administrator && !status.enabled
            }),
            Action::Stop => self.snapshot.as_ref().is_some_and(|(status, _)| {
                status.manageable
                    && !status.disabled_by_administrator
                    && (status.enabled || status.starts_on_launch)
            }),
            Action::SetPreviews(_) => self
                .snapshot
                .as_ref()
                .is_some_and(|(status, _)| status.manageable && !status.disabled_by_administrator),
            Action::PairTunnel => self.snapshot.as_ref().is_some_and(|(status, _)| {
                status.manageable
                    && !status.disabled_by_administrator
                    && status.enabled
                    && status.state == TunnelState::Connected
                    && status.remote_url.is_some()
            }),
            Action::PairDirect(origin) => self.snapshot.as_ref().is_some_and(|(status, _)| {
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
        self.recheck = None;
        if !matches!(action, Action::Refresh) {
            self.mutation_error = None;
            self.error = None;
        }
        let tunnel_origin = self
            .snapshot
            .as_ref()
            .and_then(|(status, _)| status.remote_url.clone());
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.flight = Some((matches!(action, Action::Refresh).then_some(cancel), input));
        let (backend, wake) = (backend.clone(), wake.clone());
        match &action {
            Action::Start => self.unconfirmed = Some(Mutation::Start),
            Action::Stop => self.unconfirmed = Some(Mutation::Stop),
            Action::SetPreviews(enabled) => {
                self.unconfirmed = Some(Mutation::SetPreviews(*enabled))
            }
            Action::PairTunnel | Action::PairDirect(_) => {
                self.clear_pairing();
                self.unconfirmed = Some(Mutation::Pair);
            }
            Action::Revoke(id) => self.unconfirmed = Some(Mutation::Revoke(id.clone(), None)),
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
                    Reply::Snapshot(result, None)
                }
                Action::Start => match remote::start(&backend).await {
                    Ok(started) => {
                        let devices = remote::devices(&backend).await.ok().flatten();
                        Reply::Started(Ok((started.status, started.pairing, devices)))
                    }
                    Err(err) => Reply::Started(Err(err)),
                },
                Action::Stop => Reply::Status(remote::stop(&backend).await),
                Action::SetPreviews(enabled) => {
                    Reply::Status(remote::set_previews(&backend, enabled).await)
                }
                Action::PairTunnel => match tunnel_origin {
                    Some(origin) => Reply::Pairing(
                        remote::pairing(&backend, None, &origin)
                            .await
                            .map(|p| (p, false)),
                    ),
                    None => Reply::Pairing(Err(remote::Error::InvalidResponse)),
                },
                Action::PairDirect(origin) => Reply::Pairing(
                    remote::pairing(&backend, Some(&origin), &origin)
                        .await
                        .map(|p| (p, true)),
                ),
                Action::Revoke(id) => {
                    let revoke_err = remote::revoke(&backend, &id).await.err();
                    Reply::Snapshot(snapshot(&backend).await, revoke_err)
                }
            };
            let expiry = match &result {
                Reply::Pairing(Ok((value, _))) | Reply::Started(Ok((_, value, _))) => {
                    Some(value.remaining())
                }
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
        edit: fn(&mut S) -> &mut Self,
    ) -> El {
        let prefs = shared.borrow();
        let busy = self.flight.is_some();
        let available = prefs.can_retry()
            && self.owner.as_ref() == prefs.backend.as_ref().map(|backend| &backend.client_id);
        let control = |label: &str, primary: bool, extra_disabled: bool, action: Action| {
            let shared = shared.clone();
            let disabled = !available
                || busy
                || extra_disabled
                || (self.needs_read && !matches!(action, Action::Refresh));
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
                state.start(backend, wake, action.clone());
            };
            if primary {
                chrome::primary_action(label, disabled, press)
            } else {
                layout::button(label, disabled, press)
            }
        };
        let heading = |key| text(t(key)).text_role(TextRole::Title).role("heading");
        let mut rc = col()
            .full_width()
            .separate(Space::Sm)
            .child(
                layout::action_row()
                    .child(heading("remoteControl.title"))
                    .child(
                        control(t("remoteControl.refresh"), false, false, Action::Refresh)
                            .key("remote-control-refresh"),
                    ),
            )
            .child(text(t("remoteControl.description")).wrap());

        let mut devices_card = None;
        if let Some((status, devices)) = self.snapshot.as_ref().filter(|_| available) {
            let state_key = if status.disabled_by_administrator {
                "remoteControl.state.disabled"
            } else {
                status.state.i18n_key()
            };
            let disabled_info = status.disabled_by_administrator.then(|| {
                chrome::info_tip(
                    t("remoteControl.state.disabled"),
                    t("remoteControl.disabled.info"),
                    self.disabled_info_open,
                    move |s: &mut S| {
                        if let Some(state) = access(s) {
                            state.disabled_info_open = !state.disabled_info_open;
                        }
                    },
                )
                .key("remote-control-disabled-info")
            });
            let subtitle = if !status.manageable {
                t("remoteControl.status.hostOnly")
            } else if let Some(url) = status.remote_url.as_deref() {
                url
            } else {
                t("remoteControl.status.localOnly")
            };
            rc = rc
                .child(
                    layout::action_row()
                        .child(text(t(state_key)).role("status").wrap())
                        .children(disabled_info),
                )
                .child(text(subtitle).wrap().literal_direction());
            if let Some(err) = status
                .error
                .as_deref()
                .filter(|_| status.state == TunnelState::Error)
            {
                rc = rc.child(text(err).role("alert").wrap());
            }

            if status.manageable && !status.disabled_by_administrator {
                let mut actions = layout::action_row();
                if status.enabled {
                    actions = actions
                        .child(
                            control(
                                t("remoteControl.newLink"),
                                true,
                                status.state != TunnelState::Connected
                                    || status.remote_url.is_none(),
                                Action::PairTunnel,
                            )
                            .key("remote-control-new-link"),
                        )
                        .child(
                            control(t("remoteControl.stop"), false, false, Action::Stop)
                                .key("remote-control-stop"),
                        );
                } else {
                    actions = actions.child(
                        control(t("remoteControl.start"), true, false, Action::Start)
                            .key("remote-control-start"),
                    );
                    if status.starts_on_launch {
                        actions = actions.child(
                            control(t("remoteControl.stop"), false, false, Action::Stop)
                                .key("remote-control-stop"),
                        );
                    }
                }
                rc = rc.child(actions);

                if !status.direct_origins.is_empty() {
                    let link_label = t("remoteControl.direct.newLink");
                    rc = rc.child(heading("remoteControl.direct.title"));
                    for origin in &status.direct_origins {
                        rc = rc.child(chrome::setting_row(
                            origin,
                            control(link_label, false, false, Action::PairDirect(origin.clone()))
                                .label(&format!("{link_label} · {origin}")),
                        ));
                    }
                }

                let previews_next = !status.previews;
                let previews_shared = shared.clone();
                let previews_info = chrome::info_tip(
                    t("remoteControl.previews.title"),
                    t("remoteControl.previews.info"),
                    self.previews_info_open,
                    move |s: &mut S| {
                        if let Some(state) = access(s) {
                            state.previews_info_open = !state.previews_info_open;
                        }
                    },
                )
                .key("remote-control-previews-info");
                let previews_switch = chrome::setting_switch(
                    t("remoteControl.previews.title"),
                    status.previews,
                    !available || busy || self.needs_read,
                    move |s: &mut S| {
                        let Some(state) = access(s) else { return };
                        let prefs = previews_shared.borrow();
                        if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                            && let Some(wake) =
                                prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                        {
                            state.start(backend, wake, Action::SetPreviews(previews_next));
                        }
                    },
                )
                .key("remote-control-previews-switch");
                rc = rc.child(chrome::setting_row_with_info(
                    t("remoteControl.previews.title"),
                    Some(previews_info),
                    previews_switch,
                ));
            }

            if status.manageable
                && let Some(devices) = devices
            {
                let mut list = col()
                    .full_width()
                    .separate(Space::Sm)
                    .child(heading("remoteControl.devices.title"));
                if devices.is_empty() {
                    list = list.child(text(t("remoteControl.devices.empty")).wrap());
                }
                for device in devices {
                    let origin = device.origin.as_ref().map_or_else(
                        || t("remoteControl.devices.tunnel").to_owned(),
                        |origin| t("remoteControl.devices.direct").replace("{origin}", origin),
                    );
                    let uncertain = device.revocation_pending
                        || (self.needs_read
                            && matches!(&self.unconfirmed, Some(Mutation::Revoke(id, _)) if *id == device.id));
                    let detail = if uncertain {
                        t("remoteControl.devices.revocationPending").to_owned()
                    } else {
                        t("remoteControl.devices.lastSeen")
                            .replace("{time}", &pairing_view::last_seen(&device.last_seen_at))
                    };
                    let revoke = t("remoteControl.devices.revoke");
                    list = list.child(
                        col()
                            .full_width()
                            .separate(Space::Xs)
                            .child(chrome::setting_row(
                                &device.name,
                                control(revoke, false, false, Action::Revoke(device.id.clone()))
                                    .label(&format!(
                                        "{revoke} · {} · {origin} · {detail}",
                                        device.name
                                    )),
                            ))
                            .child(text(&origin).wrap())
                            .child(
                                text(&detail)
                                    .role(if uncertain { "status" } else { "text" })
                                    .wrap(),
                            ),
                    );
                }
                devices_card = Some(chrome::card(list));
            }
        }
        if let Some(err) = &self.error {
            rc = rc.child(text(err.as_str()).role("alert").wrap());
        }

        // REMOTE_CONTROL.md: Remote Control comes first; Direct/LAN access sits below in one
        // collapsed disclosure that opens automatically while the server listens beyond localhost.
        col()
            .full_width()
            .separate(Space::Md)
            .child(chrome::card(rc))
            .children(self.pairing.as_ref().map(|active| {
                chrome::card(pairing_view::view(
                    &active.pairing,
                    &self.copy,
                    busy,
                    shared,
                    access,
                ))
            }))
            .children(devices_card)
            .child(self.direct.view(shared, available, access, edit))
    }
}
