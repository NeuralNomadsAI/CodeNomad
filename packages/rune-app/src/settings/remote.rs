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
    owner_server: Option<String>,
    owner_drop_gen: Option<u64>,
    owner_stream_drop_epoch: Option<u64>,
    owner_auth_gen: u64,
    snapshot_verified: bool,
    devices_verified: bool,
    snapshot: Option<Snapshot>,
    pairing: Option<ActivePairing>,
    flight: Option<(FlightStamp, Option<Sender<()>>, Receiver<Reply>)>,
    detached_mutations: Vec<(String, Option<String>, Receiver<Reply>)>,
    pending_refresh: bool,
    recheck: Option<(Sender<()>, Receiver<()>)>,
    error: Option<ErrorText>,
    mutation_error: Option<(MutationOutcome, ErrorText)>,
    explicit_refresh: bool,
    needs_read: bool,
    unconfirmed: Option<Mutation>,
    disabled_info_open: bool,
    previews_info_open: bool,
    copy: pairing_view::Copy,
    direct: direct::DirectAccess,
}

type FlightStamp = (String, Option<String>, u64, u64, u64);

type Snapshot = (Status, Option<Vec<Device>>);

struct SnapshotRead {
    status: Status,
    devices: Option<Vec<Device>>,
    devices_error: Option<remote::Error>,
    verified: bool,
}

pub(super) struct ActivePairing {
    pub pairing: Pairing,
    pub direct: bool,
}

#[derive(Clone)]
enum Action {
    Refresh { explicit: bool },
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
    Started(Result<(Status, Pairing, Option<Vec<Device>>, Option<remote::Error>), remote::Error>),
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
        verified: true,
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

    fn current_stamp(prefs: &Preferences, backend: &Backend) -> FlightStamp {
        (
            backend.client_id.clone(),
            backend.client.server_identity().map(str::to_owned),
            backend.client.drop_generation(),
            backend.client.stream_drop_epoch(),
            prefs
                .authority_handle()
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    fn stamp_matches(prefs: &Preferences, backend: &Backend, stamp: &FlightStamp) -> bool {
        !prefs.transport_lost()
            && super::ServerOwner::backend_verified(backend)
            && stamp.0 == backend.client_id
            && stamp.1.as_deref() == backend.client.server_identity()
            && stamp.2 == backend.client.drop_generation()
            && stamp.3 == backend.client.stream_drop_epoch()
            && stamp.4
                == prefs
                    .authority_handle()
                    .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn matches_backend(&self, prefs: &Preferences, backend: &Backend) -> bool {
        !prefs.transport_lost()
            && super::ServerOwner::backend_verified(backend)
            && self.owner.as_deref() == Some(backend.client_id.as_str())
            && self.owner_drop_gen == Some(backend.client.drop_generation())
            && self.owner_stream_drop_epoch == Some(backend.client.stream_drop_epoch())
            && self.owner_server.as_deref() == backend.client.server_identity()
            && self.owner_auth_gen
                == prefs
                    .authority_handle()
                    .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn detach_active_mutation(&mut self) {
        if let Some((stamp, None, receiver)) = self.flight.take() {
            self.detached_mutations.push((stamp.0, stamp.1, receiver));
        }
    }

    fn drain_detached_mutations(&mut self, backend: Option<&Backend>) -> bool {
        let mut settled_for_active = false;
        self.detached_mutations
            .retain(|(client_id, server, rx)| match rx.try_recv() {
                Ok(_) => {
                    if let Some(b) = backend
                        && (b.client_id == *client_id
                            || (server.is_some()
                                && b.client.server_identity() == server.as_deref()))
                    {
                        settled_for_active = true;
                    }
                    false
                }
                Err(_) if rx.is_closed() => {
                    if let Some(b) = backend
                        && (b.client_id == *client_id
                            || (server.is_some()
                                && b.client.server_identity() == server.as_deref()))
                    {
                        settled_for_active = true;
                    }
                    false
                }
                Err(_) => true,
            });
        settled_for_active
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker) -> bool {
        let backend = prefs.backend.as_ref().filter(|b| {
            prefs.can_retry() && !prefs.transport_lost() && super::ServerOwner::backend_verified(b)
        });
        let owner = backend.map(|backend| backend.client_id.as_str());
        let drop_gen = backend.map(|b| b.client.drop_generation());
        let stream_drop_epoch = backend.map(|b| b.client.stream_drop_epoch());
        let server = backend.and_then(|b| b.client.server_identity());
        let auth_gen = prefs
            .authority_handle()
            .load(std::sync::atomic::Ordering::SeqCst);
        if self.owner.as_deref() != owner {
            self.detach_active_mutation();
            let carried: Vec<_> = if let Some(server_id) = server {
                self.detached_mutations
                    .drain(..)
                    .filter(|(_, s, _)| s.as_deref() == Some(server_id))
                    .collect()
            } else {
                Vec::new()
            };
            self.close();
            self.detached_mutations = carried;
            self.owner = owner.map(str::to_owned);
            self.owner_server = server.map(str::to_owned);
            self.owner_drop_gen = drop_gen;
            self.owner_stream_drop_epoch = stream_drop_epoch;
            self.owner_auth_gen = auth_gen;
            if self.drain_detached_mutations(backend) {
                self.pending_refresh = true;
            }
            if let Some(backend) = backend {
                self.start(prefs, backend, wake, Action::Refresh { explicit: false });
                self.direct.poll(prefs, Some(backend), wake);
            }
            return true;
        }
        let mut changed = false;
        if let Some(backend) = backend
            && (self.owner_drop_gen != drop_gen
                || self.owner_stream_drop_epoch != stream_drop_epoch
                || self.owner_server.as_deref() != server
                || self.owner_auth_gen != auth_gen)
        {
            self.detach_active_mutation();
            self.flight = None;
            self.recheck = None;
            self.snapshot_verified = false;
            self.devices_verified = false;
            if let Some((_, devices)) = &mut self.snapshot {
                *devices = None;
            }
            self.needs_read = true;
            self.clear_pairing();
            self.owner_server = server.map(str::to_owned);
            self.owner_drop_gen = drop_gen;
            self.owner_stream_drop_epoch = stream_drop_epoch;
            self.owner_auth_gen = auth_gen;
            self.direct.on_unverified();
            self.start(prefs, backend, wake, Action::Refresh { explicit: false });
            self.direct.refresh(prefs, backend, wake);
            changed = true;
        }
        if self.drain_detached_mutations(backend) {
            self.pending_refresh = true;
            changed = true;
        }
        if self.pending_refresh
            && self.flight.is_none()
            && let Some(backend) = backend
        {
            self.pending_refresh = false;
            self.start(prefs, backend, wake, Action::Refresh { explicit: false });
            changed = true;
        }
        changed |= self.direct.poll(prefs, backend, wake);
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
                self.start(prefs, backend, wake, Action::Refresh { explicit: false });
                changed = true;
            }
        }
        let Some((flight_stamp, _, flight)) = &self.flight else {
            return changed;
        };
        let result = match flight.try_recv() {
            Ok(result) => result,
            Err(_) if flight.is_closed() => {
                self.flight = None;
                self.snapshot_verified = false;
                self.devices_verified = false;
                self.needs_read = true;
                self.error = Some(ErrorText::Key("remoteControl.state.error"));
                self.sync_connecting_poll(wake);
                return true;
            }
            Err(_) => return changed,
        };
        let flight_stamp = flight_stamp.clone();
        self.flight = None;
        let current_flight = backend.is_some_and(|b| {
            self.matches_backend(prefs, b) && Self::stamp_matches(prefs, b, &flight_stamp)
        });
        match result {
            Reply::Snapshot(Ok(read), revoke_err) => {
                if !read.verified || !current_flight {
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                    self.error = Some(ErrorText::Key("remoteControl.state.error"));
                    self.sync_connecting_poll(wake);
                    return true;
                }
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
                    self.devices_verified
                        .then(|| self.snapshot.as_ref().and_then(|(_, d)| d.clone()))
                        .flatten()
                } else {
                    read.devices
                };
                self.devices_verified =
                    !status.manageable || (read.devices_error.is_none() && devices.is_some());
                self.needs_read = matches!(self.unconfirmed, Some(Mutation::Revoke(_, _)))
                    && (read.devices_error.is_some() || devices.is_none());
                self.snapshot_verified = !self.needs_read;
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
                        && (self.explicit_refresh || !matches!(err, ErrorText::Raw(_)))
                        && outcome.confirmed(
                            &status,
                            devices.as_deref(),
                            read.devices_error.is_some(),
                        )
                    {
                        self.mutation_error = None;
                    }
                    self.explicit_refresh = false;
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
                self.snapshot_verified = false;
                self.devices_verified = false;
                self.needs_read = true;
                if !current_flight {
                    self.unconfirmed = None;
                    self.clear_pairing();
                    self.error = Some(ErrorText::Key("remoteControl.state.error"));
                } else {
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
            }
            Reply::Started(Ok((status, pairing, devices, devices_error))) => {
                self.unconfirmed = None;
                self.mutation_error = None;
                if !current_flight {
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                    self.error = Some(ErrorText::Key("remoteControl.state.error"));
                } else {
                    self.needs_read = false;
                    self.snapshot_verified = true;
                    self.error = devices_error.as_ref().map(|err| {
                        ErrorText::from_remote(err.clone(), "remoteControl.state.error")
                    });
                    let existing_devices = self
                        .devices_verified
                        .then(|| self.snapshot.as_ref().and_then(|(_, d)| d.clone()))
                        .flatten();
                    let next_devices = if devices_error.is_none() {
                        devices
                    } else {
                        existing_devices
                    };
                    self.devices_verified =
                        !status.manageable || (devices_error.is_none() && next_devices.is_some());
                    self.snapshot = Some((status, next_devices));
                    self.set_pairing(pairing, false);
                }
            }
            Reply::Started(Err(err)) => {
                let err_text = if current_flight {
                    ErrorText::from_remote(err, "remoteControl.state.error")
                } else {
                    ErrorText::Key("remoteControl.state.error")
                };
                if current_flight {
                    self.mutation_error = Some((MutationOutcome::Start, err_text.clone()));
                }
                self.error = Some(err_text);
                if let Some(backend) = backend.filter(|b| self.matches_backend(prefs, b)) {
                    self.start(prefs, backend, wake, Action::Refresh { explicit: false });
                } else {
                    self.unconfirmed = None;
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                }
            }
            Reply::Status(Ok(status)) => {
                let mutation = self.unconfirmed.take();
                self.mutation_error = None;
                if !current_flight {
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                    self.error = Some(ErrorText::Key("remoteControl.state.error"));
                } else {
                    self.needs_read = false;
                    self.snapshot_verified = true;
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
                    let devices = if status.manageable {
                        self.snapshot.as_ref().and_then(|(_, d)| d.clone())
                    } else {
                        self.devices_verified = true;
                        None
                    };
                    self.snapshot = Some((status, devices));
                }
            }
            Reply::Status(Err(err)) => {
                let err_text = if current_flight {
                    ErrorText::from_remote(err, "remoteControl.state.error")
                } else {
                    ErrorText::Key("remoteControl.state.error")
                };
                if current_flight
                    && let Some(outcome) = self.unconfirmed.as_ref().map(Mutation::outcome)
                {
                    self.mutation_error = Some((outcome, err_text.clone()));
                }
                self.error = Some(err_text);
                if let Some(backend) = backend.filter(|b| self.matches_backend(prefs, b)) {
                    self.start(prefs, backend, wake, Action::Refresh { explicit: false });
                } else {
                    self.unconfirmed = None;
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                }
            }
            Reply::Pairing(Ok((pairing, direct))) => {
                self.unconfirmed = None;
                self.mutation_error = None;
                if !current_flight {
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                    self.error = Some(ErrorText::Key("remoteControl.state.error"));
                } else {
                    self.needs_read = false;
                    self.snapshot_verified = true;
                    self.error = None;
                    self.set_pairing(pairing, direct);
                }
            }
            Reply::Pairing(Err(err)) => {
                let err_text = if current_flight {
                    ErrorText::from_remote(err, "remoteControl.state.error")
                } else {
                    ErrorText::Key("remoteControl.state.error")
                };
                if current_flight {
                    self.mutation_error = Some((MutationOutcome::Pair, err_text.clone()));
                }
                self.error = Some(err_text);
                if let Some(backend) = backend.filter(|b| self.matches_backend(prefs, b)) {
                    self.start(prefs, backend, wake, Action::Refresh { explicit: false });
                } else {
                    self.unconfirmed = None;
                    self.snapshot_verified = false;
                    self.devices_verified = false;
                    self.needs_read = true;
                    self.clear_pairing();
                }
            }
        }
        if self.pending_refresh
            && self.flight.is_none()
            && let Some(backend) = backend.filter(|b| self.matches_backend(prefs, b))
        {
            self.pending_refresh = false;
            self.start(prefs, backend, wake, Action::Refresh { explicit: false });
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

    fn start(&mut self, prefs: &Preferences, backend: &Backend, wake: &Waker, action: Action) {
        if self.flight.is_some() || !self.matches_backend(prefs, backend) {
            return;
        }
        let is_refresh = matches!(action, Action::Refresh { .. });
        if !is_refresh && (!self.snapshot_verified || self.needs_read) {
            return;
        }
        let eligible = match &action {
            Action::Refresh { .. } => true,
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
            Action::Revoke(id) => {
                self.devices_verified
                    && self.snapshot.as_ref().is_some_and(|(status, devices)| {
                        status.manageable
                            && devices.as_ref().is_some_and(|devices| {
                                devices.iter().any(|device| device.id == *id)
                            })
                    })
            }
        };
        if !eligible || (self.needs_read && !is_refresh) {
            return;
        }
        self.recheck = None;
        if !is_refresh {
            self.mutation_error = None;
            self.error = None;
        }
        self.explicit_refresh = matches!(action, Action::Refresh { explicit: true });
        let flight_stamp = Self::current_stamp(prefs, backend);
        let expected_server = flight_stamp.1.clone();
        let prepared_gen = flight_stamp.2;
        let prepared_stream_epoch = flight_stamp.3;
        let prefs_auth = prefs.authority_handle();
        let prefs_gen = flight_stamp.4;
        let tunnel_origin = self
            .snapshot
            .as_ref()
            .and_then(|(status, _)| status.remote_url.clone());
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.flight = Some((flight_stamp, is_refresh.then_some(cancel), input));
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
            Action::Refresh { .. } => {}
        }
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(std::sync::atomic::Ordering::SeqCst) == prefs_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && super::ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let attest = || async {
                still_ok()
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok()
            };
            let attest_ref = &attest;
            let sanitize_err = |err: remote::Error| async move {
                match err {
                    remote::Error::Server(msg) if attest_ref().await => remote::Error::Server(msg),
                    remote::Error::Server(_) => remote::Error::Transport,
                    other => other,
                }
            };
            let result = match action {
                Action::Refresh { .. } => {
                    let task = async {
                        if !attest().await {
                            return Err(remote::Error::Transport);
                        }
                        match snapshot(&backend).await {
                            Ok(mut read) => {
                                read.verified = attest().await;
                                if !read.verified {
                                    read.devices_error =
                                        read.devices_error.map(|_| remote::Error::Transport);
                                }
                                Ok(read)
                            }
                            Err(err) => Err(sanitize_err(err).await),
                        }
                    };
                    let Some(result) = platform::reads::cancellable(&cancelled, task).await else {
                        return;
                    };
                    Reply::Snapshot(result, None)
                }
                Action::Start => {
                    if !attest().await {
                        Reply::Started(Err(remote::Error::Transport))
                    } else {
                        match remote::start(&backend).await {
                            Ok(started) if attest().await => {
                                let (devices, devices_error) = match remote::devices(&backend).await
                                {
                                    Ok(devices) if attest().await => (devices, None),
                                    Ok(_) => (None, Some(remote::Error::Transport)),
                                    Err(err) => (None, Some(sanitize_err(err).await)),
                                };
                                Reply::Started(Ok((
                                    started.status,
                                    started.pairing,
                                    devices,
                                    devices_error,
                                )))
                            }
                            Ok(_) => Reply::Started(Err(remote::Error::Transport)),
                            Err(err) => Reply::Started(Err(sanitize_err(err).await)),
                        }
                    }
                }
                Action::Stop => {
                    if !attest().await {
                        Reply::Status(Err(remote::Error::Transport))
                    } else {
                        match remote::stop(&backend).await {
                            Ok(status) if attest().await => Reply::Status(Ok(status)),
                            Ok(_) => Reply::Status(Err(remote::Error::Transport)),
                            Err(err) => Reply::Status(Err(sanitize_err(err).await)),
                        }
                    }
                }
                Action::SetPreviews(enabled) => {
                    if !attest().await {
                        Reply::Status(Err(remote::Error::Transport))
                    } else {
                        match remote::set_previews(&backend, enabled).await {
                            Ok(status) if attest().await => Reply::Status(Ok(status)),
                            Ok(_) => Reply::Status(Err(remote::Error::Transport)),
                            Err(err) => Reply::Status(Err(sanitize_err(err).await)),
                        }
                    }
                }
                Action::PairTunnel => {
                    if !attest().await {
                        Reply::Pairing(Err(remote::Error::Transport))
                    } else {
                        match tunnel_origin {
                            Some(origin) => match remote::pairing(&backend, None, &origin).await {
                                Ok(p) if attest().await => Reply::Pairing(Ok((p, false))),
                                Ok(_) => Reply::Pairing(Err(remote::Error::Transport)),
                                Err(err) => Reply::Pairing(Err(sanitize_err(err).await)),
                            },
                            None => Reply::Pairing(Err(remote::Error::InvalidResponse)),
                        }
                    }
                }
                Action::PairDirect(origin) => {
                    if !attest().await {
                        Reply::Pairing(Err(remote::Error::Transport))
                    } else {
                        match remote::pairing(&backend, Some(&origin), &origin).await {
                            Ok(p) if attest().await => Reply::Pairing(Ok((p, true))),
                            Ok(_) => Reply::Pairing(Err(remote::Error::Transport)),
                            Err(err) => Reply::Pairing(Err(sanitize_err(err).await)),
                        }
                    }
                }
                Action::Revoke(id) => {
                    if !attest().await {
                        Reply::Snapshot(Err(remote::Error::Transport), None)
                    } else {
                        let revoke_err = match remote::revoke(&backend, &id).await {
                            Ok(()) => None,
                            Err(err) => Some(sanitize_err(err).await),
                        };
                        let snap = if attest().await {
                            match snapshot(&backend).await {
                                Ok(mut read) => {
                                    read.verified = attest().await;
                                    if !read.verified {
                                        read.devices_error =
                                            read.devices_error.map(|_| remote::Error::Transport);
                                    }
                                    Ok(read)
                                }
                                Err(err) => Err(sanitize_err(err).await),
                            }
                        } else {
                            Err(remote::Error::Transport)
                        };
                        Reply::Snapshot(snap, revoke_err)
                    }
                }
            };
            let expiry = match &result {
                Reply::Pairing(Ok((value, _))) | Reply::Started(Ok((_, value, _, _))) => {
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

    #[cfg(any(test, not(target_arch = "wasm32")))]
    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        access: fn(&mut S) -> Option<&mut Self>,
        edit: fn(&mut S) -> &mut Self,
    ) -> El {
        self.view_gated(shared, true, access, edit)
    }

    pub fn view_gated<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        host_ready: bool,
        access: fn(&mut S) -> Option<&mut Self>,
        edit: fn(&mut S) -> &mut Self,
    ) -> El {
        let prefs = shared.borrow();
        let busy = self.flight.is_some();
        let available = host_ready
            && prefs.can_retry()
            && prefs
                .backend
                .as_ref()
                .is_some_and(|backend| self.matches_backend(&prefs, backend));
        let control = |label: &str, primary: bool, extra_disabled: bool, action: Action| {
            let shared = shared.clone();
            let is_refresh = matches!(action, Action::Refresh { .. });
            let needs_devices = matches!(action, Action::Revoke(_));
            let disabled = !available
                || busy
                || extra_disabled
                || (!is_refresh
                    && (self.needs_read
                        || !self.snapshot_verified
                        || (needs_devices && !self.devices_verified)));
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
                state.start(&prefs, backend, wake, action.clone());
            };
            if primary {
                chrome::primary_action(label, disabled, press)
            } else {
                chrome::secondary_action(label, disabled, press)
            }
        };
        let refresh_shared = shared.clone();
        let refresh = chrome::refresh_icon_button(
            t("remoteControl.refresh"),
            !available || busy,
            move |s: &mut S| {
                let Some(state) = access(s) else {
                    return;
                };
                let prefs = refresh_shared.borrow();
                let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry()) else {
                    return;
                };
                let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref()) else {
                    return;
                };
                state.start(&prefs, backend, wake, Action::Refresh { explicit: true });
            },
        )
        .key("remote-control-refresh");
        let mut rc = col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::remote_header(
                t("remoteControl.title"),
                t("remoteControl.description"),
                chrome::server_scope_badge(t("settings.scope.server")),
                refresh,
            ));

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
            let (subtitle, subtitle_is_url) = if !status.manageable {
                (t("remoteControl.status.hostOnly"), false)
            } else if let Some(url) = status.remote_url.as_deref() {
                (url, true)
            } else {
                (t("remoteControl.status.localOnly"), false)
            };
            let tone = if status.disabled_by_administrator {
                "stopped"
            } else if status.state == TunnelState::Connected {
                "connected"
            } else if status.state.is_connecting() {
                "connecting"
            } else if status.state == TunnelState::Error {
                "error"
            } else {
                "stopped"
            };
            rc = rc.child(chrome::remote_status_card(
                tone,
                t(state_key),
                disabled_info,
                subtitle,
                subtitle_is_url,
            ));
            if let Some(err) = status
                .error
                .as_deref()
                .filter(|_| status.state == TunnelState::Error)
            {
                rc = rc.child(chrome::palette::save_error(err));
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
                    rc = rc.child(
                        text(t("remoteControl.direct.title"))
                            .text_role(TextRole::Title)
                            .role("heading"),
                    );
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
                    !available || busy || self.needs_read || !self.snapshot_verified,
                    move |s: &mut S| {
                        let Some(state) = access(s) else { return };
                        let prefs = previews_shared.borrow();
                        if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                            && let Some(wake) =
                                prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                        {
                            state.start(&prefs, backend, wake, Action::SetPreviews(previews_next));
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
                let mut list =
                    col()
                        .full_width()
                        .separate(Space::Sm)
                        .child(chrome::heading_with_icon(
                            "shield-check",
                            t("remoteControl.devices.title"),
                        ));
                if devices.is_empty() {
                    list = list.child(chrome::empty_box(t("remoteControl.devices.empty")));
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
                            .inset_surface()
                            .pad(Space::Sm)
                            .separate(Space::Xs)
                            .child(chrome::setting_row(
                                &device.name,
                                control(revoke, false, false, Action::Revoke(device.id.clone()))
                                    .label(&format!(
                                        "{revoke} · {} · {origin} · {detail}",
                                        device.name
                                    ))
                                    .key(&format!("remote-device-revoke-{}", device.id)),
                            ))
                            .child(text(&origin).text_role(TextRole::Small).wrap())
                            .child(
                                text(&detail)
                                    .text_role(TextRole::Small)
                                    .role(if uncertain { "status" } else { "text" })
                                    .wrap(),
                            ),
                    );
                }
                devices_card = Some(chrome::card(list));
            }
        }
        if available {
            if let Some(err) = &self.error {
                rc = rc.child(chrome::palette::save_error(err.as_str()));
            }
        } else if host_ready
            && (!prefs.can_retry()
                || prefs.transport_lost()
                || prefs
                    .backend
                    .as_ref()
                    .is_some_and(|b| !super::ServerOwner::backend_verified(b)))
        {
            rc = rc.child(chrome::palette::save_error(t("rune.connect_error")));
        }

        // REMOTE_CONTROL.md: Remote Control comes first; Direct/LAN access sits below in one
        // collapsed disclosure that opens automatically while the server listens beyond localhost.
        col()
            .full_width()
            .separate(Space::Md)
            .child(chrome::card(rc))
            .children(self.pairing.as_ref().filter(|_| available).map(|active| {
                chrome::card(pairing_view::view(
                    &active.pairing,
                    &self.copy,
                    busy,
                    shared,
                    access,
                ))
            }))
            .children(devices_card)
            .children(available.then(|| self.direct.view(shared, available, access, edit)))
    }
}
