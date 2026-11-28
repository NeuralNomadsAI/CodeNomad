use super::{format_template, host_action_key};
use crate::{
    backend::Backend,
    platform,
    settings::{ExternalLink, providers::Target, stats::dates::Visibility},
    strings::t,
};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::integrations::{
        self as api, AttachOutcome, BindingState, DetachOutcome, HostOffer, HostState,
        InstallOutcome, IntegrationError, IntegrationFamily, IntegrationScope, IntegrationView,
        IntegrationsSnapshot, RuntimeState,
    },
};
use std::{collections::BTreeMap, time::Duration};

pub(super) const EVENT_COALESCE_SECS: f64 = 0.3;

pub(super) enum LoadState {
    Idle,
    Loading,
    Ready(IntegrationsSnapshot),
    Unsupported,
    Error,
}

impl Default for LoadState {
    fn default() -> Self {
        Self::Idle
    }
}

pub(super) struct Notice {
    pub text: String,
    pub error: bool,
}

pub(super) enum PendingConfirm {
    CatalogInstall {
        id: String,
        display_name: String,
        scope: IntegrationScope,
        authority: u64,
        epoch: u64,
        directory: String,
    },
    HostInstall {
        id: String,
        display_name: String,
        app_name: String,
        version: String,
        action_key: &'static str,
        signature: Box<IntegrationView>,
        authority: u64,
        epoch: u64,
        directory: String,
    },
}

pub(super) struct OfferChooser {
    pub id: String,
    pub offers: Vec<HostOffer>,
    authority: u64,
    epoch: u64,
    session_epoch: u64,
    directory: String,
    session_id: String,
}

struct ReadFlight {
    cancel: Sender<()>,
    rx: Receiver<ReadReply>,
    epoch: u64,
    session_epoch: u64,
}

enum ReadReply {
    Loaded(String, IntegrationsSnapshot),
    Unsupported,
    Failed,
}

struct DetailFlight {
    cancel: Sender<()>,
    rx: Receiver<DetailReply>,
    epoch: u64,
    session_epoch: u64,
}

enum DetailReply {
    Binding(String, BindingState),
    Offers(String, Result<Vec<HostOffer>, IntegrationError>),
}

struct AttachProbe {
    id: String,
    app_name: String,
    expected_offer: Option<String>,
    authority: u64,
    epoch: u64,
    session_epoch: u64,
    directory: String,
    session_id: String,
    cancel: Sender<()>,
    rx: Receiver<Result<Vec<HostOffer>, IntegrationError>>,
}

struct MutationFlight {
    rx: Receiver<MutationReply>,
    scope: (String, String),
    backend: Backend,
}

fn same_mutation_server(a: &Backend, b: &Backend) -> bool {
    a.base == b.base
        && (a.client.same_connection(&b.client)
            || (a.client.server_identity().is_some()
                && a.client.server_identity() == b.client.server_identity()))
}

enum MutationReply {
    CatalogInstall(Result<(), IntegrationError>),
    HostInstall(Result<InstallOutcome, IntegrationError>),
    Attach(Result<AttachOutcome, IntegrationError>),
    Detach(Result<DetachOutcome, IntegrationError>),
}

type TransportKey = (String, u64, bool, Option<(bool, Option<u64>)>);

#[derive(Default)]
pub(in crate::settings) struct Panel {
    scope: Option<(String, String, Option<String>)>,
    transport: Option<TransportKey>,
    backend: Option<Backend>,
    workspace: Option<String>,
    session: Option<String>,
    directory: Option<String>,
    authority: u64,
    online: bool,
    last_hint: u64,
    last_session_hint: u64,
    epoch: u64,
    session_epoch: u64,
    due: Option<f64>,
    dirty_while_reading: bool,
    visible: bool,
    visibility: Visibility,
    wake: Option<rune::Waker>,
    pub(super) load: LoadState,
    pub(super) stale: bool,
    pub(super) refresh_error: bool,
    read_flight: Option<ReadFlight>,
    pub(super) bindings: BTreeMap<String, BindingState>,
    pub(super) offers: BTreeMap<String, Vec<HostOffer>>,
    detail_flights: Vec<DetailFlight>,
    attach_probe: Option<AttachProbe>,
    pub(super) chooser: Option<OfferChooser>,
    pub(super) confirm: Option<PendingConfirm>,
    mutation: Option<MutationFlight>,
    pub(super) notice: Option<Notice>,
    scopes: BTreeMap<String, IntegrationScope>,
    pub(super) open_info: Option<String>,
    pub(super) docs_link: ExternalLink,
}

impl Panel {
    pub(super) fn available(&self) -> bool {
        self.scope.is_some() && self.online
    }

    pub(super) fn fresh(&self) -> bool {
        self.available()
            && !self.stale
            && self.read_flight.is_none()
            && self.due.is_none()
            && matches!(self.load, LoadState::Ready(_))
    }

    pub(super) fn reading(&self) -> bool {
        self.read_flight.is_some()
    }

    pub(super) fn busy(&self) -> bool {
        self.mutation.is_some() || self.attach_probe.is_some()
    }

    pub(super) fn has_session(&self) -> bool {
        self.session.is_some()
    }

    pub(super) fn selected_scope(&self, entry: &IntegrationView) -> IntegrationScope {
        if entry.family == IntegrationFamily::Native {
            return IntegrationScope::Global;
        }
        self.scopes
            .get(&entry.id)
            .copied()
            .unwrap_or(IntegrationScope::Global)
    }

    pub(super) fn set_scope(&mut self, id: &str, scope: IntegrationScope) {
        if let Some(entry) = self.entry(id)
            && entry.family == IntegrationFamily::Native
        {
            return;
        }
        self.scopes.insert(id.to_owned(), scope);
    }

    pub(super) fn toggle_info(&mut self, id: &str) {
        if self.open_info.as_deref() == Some(id) {
            self.open_info = None;
        } else {
            self.open_info = Some(id.to_owned());
        }
    }

    pub(in crate::settings) fn dismiss_overlay(&mut self) -> bool {
        if self.confirm.take().is_some() {
            return true;
        }
        if self.chooser.take().is_some() {
            return true;
        }
        if let Some(probe) = self.attach_probe.take() {
            probe.cancel.close();
            return true;
        }
        self.open_info.take().is_some()
    }

    pub(in crate::settings) fn suspend(&mut self) {
        self.cancel_reads();
        self.revoke_intents();
        let in_flight = self.mutation.take();
        *self = Self {
            mutation: in_flight,
            ..Self::default()
        };
    }

    pub(super) fn refresh(&mut self) {
        if !self.available() {
            return;
        }
        self.revoke_intents();
        self.notice = None;
        self.docs_link.clear();
        self.refresh_error = false;
        self.directory = None;
        self.bindings.clear();
        self.offers.clear();
        if matches!(self.load, LoadState::Ready(_)) {
            self.stale = true;
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.cancel_reads();
        self.dirty_while_reading = false;
        self.due = Some(0.0);
        if let Some(wake) = &self.wake {
            wake();
        }
    }

    pub(super) fn request_catalog_install(&mut self, id: &str) {
        if !self.fresh() || self.busy() || self.confirm.is_some() {
            return;
        }
        let Some(directory) = self.directory.clone() else {
            return;
        };
        let Some(entry) = self.entry(id).filter(|e| e.installable()).cloned() else {
            return;
        };
        let scope = self.selected_scope(&entry);
        self.chooser = None;
        self.notice = None;
        self.confirm = Some(PendingConfirm::CatalogInstall {
            id: entry.id,
            display_name: entry.display_name,
            scope,
            authority: self.authority,
            epoch: self.epoch,
            directory,
        });
    }

    pub(super) fn request_host_install(&mut self, id: &str) {
        if !self.fresh() || self.busy() || self.confirm.is_some() {
            return;
        }
        let Some(directory) = self.directory.clone() else {
            return;
        };
        let Some(entry) = self.entry(id).cloned() else {
            return;
        };
        let Some(action_key) = host_action_key(&entry) else {
            return;
        };
        let Some(version) = entry.status.as_ref().map(|s| s.version.clone()) else {
            return;
        };
        self.chooser = None;
        self.notice = None;
        self.confirm = Some(PendingConfirm::HostInstall {
            id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            app_name: entry.app.name.clone(),
            version,
            action_key,
            signature: Box::new(entry),
            authority: self.authority,
            epoch: self.epoch,
            directory,
        });
    }

    pub(super) fn decide_confirm(&mut self, accept: bool) {
        let Some(pending) = self.confirm.take() else {
            return;
        };
        if !accept || !self.fresh() || self.busy() {
            return;
        }
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        let mutation_scope = (backend.base.clone(), workspace.clone());
        match pending {
            PendingConfirm::CatalogInstall {
                id,
                scope,
                authority,
                epoch,
                directory,
                ..
            } => {
                if authority != self.authority
                    || epoch != self.epoch
                    || self.directory.as_deref() != Some(directory.as_str())
                    || !self.entry(&id).is_some_and(IntegrationView::installable)
                {
                    return;
                }
                let (out, rx) = bounded(1);
                self.mutation = Some(MutationFlight {
                    rx,
                    scope: mutation_scope,
                    backend: backend.clone(),
                });
                platform::spawn(async move {
                    let result =
                        api::install_catalog(&backend, &workspace, &directory, &id, scope).await;
                    if out
                        .send(MutationReply::CatalogInstall(result))
                        .await
                        .is_ok()
                    {
                        wake();
                    }
                });
            }
            PendingConfirm::HostInstall {
                id,
                signature,
                authority,
                epoch,
                directory,
                ..
            } => {
                if authority != self.authority
                    || epoch != self.epoch
                    || self.directory.as_deref() != Some(directory.as_str())
                    || self.entry(&id) != Some(signature.as_ref())
                    || host_action_key(&signature).is_none()
                {
                    return;
                }
                let (out, rx) = bounded(1);
                self.mutation = Some(MutationFlight {
                    rx,
                    scope: mutation_scope,
                    backend: backend.clone(),
                });
                platform::spawn(async move {
                    let result = api::install_host(&backend, &workspace, &directory, &id).await;
                    if out.send(MutationReply::HostInstall(result)).await.is_ok() {
                        wake();
                    }
                });
            }
        }
    }

    pub(super) fn request_attach(&mut self, id: &str, expected_offer: Option<String>) {
        if !self.fresh() || self.busy() || self.confirm.is_some() {
            return;
        }
        let Some(binding) = self.bindings.get(id) else {
            return;
        };
        if matches!(binding, BindingState::Attached(_)) {
            return;
        }
        let Some(entry) = self.entry(id) else {
            return;
        };
        if !native_attachable(entry) {
            return;
        }
        let app_name = entry.app.name.clone();
        let Some(directory) = self.directory.clone() else {
            return;
        };
        let Some(session_id) = self.session.clone() else {
            return;
        };
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        self.chooser = None;
        self.notice = None;
        let (cancel, cancelled) = bounded(1);
        let (out, rx) = bounded(1);
        let probe_dir = directory.clone();
        let probe_id = id.to_owned();
        self.attach_probe = Some(AttachProbe {
            id: id.to_owned(),
            app_name,
            expected_offer,
            authority: self.authority,
            epoch: self.epoch,
            session_epoch: self.session_epoch,
            directory,
            session_id,
            cancel,
            rx,
        });
        platform::spawn(async move {
            if let Some(result) = platform::reads::cancellable(
                &cancelled,
                api::list_hosts(&backend, &workspace, &probe_dir, &probe_id),
            )
            .await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }

    pub(super) fn choose_offer(&mut self, offer_id: &str) {
        let Some(chooser) = self.chooser.take() else {
            return;
        };
        if !self.fresh()
            || self.busy()
            || chooser.authority != self.authority
            || chooser.epoch != self.epoch
            || chooser.session_epoch != self.session_epoch
            || self.directory.as_deref() != Some(chooser.directory.as_str())
            || self.session.as_deref() != Some(chooser.session_id.as_str())
            || !self.bindings.contains_key(&chooser.id)
            || matches!(
                self.bindings.get(&chooser.id),
                Some(BindingState::Attached(_))
            )
            || !chooser
                .offers
                .iter()
                .any(|offer| offer.protocol_ok && offer.offer_id == offer_id)
        {
            return;
        }
        self.dispatch_attach(chooser.id, chooser.directory, chooser.session_id, offer_id);
    }

    pub(super) fn request_detach(&mut self, id: &str) {
        if !self.fresh() || self.busy() || self.confirm.is_some() {
            return;
        }
        if !matches!(self.bindings.get(id), Some(BindingState::Attached(_))) {
            return;
        }
        let Some(directory) = self.directory.clone() else {
            return;
        };
        let Some(session_id) = self.session.clone() else {
            return;
        };
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        self.chooser = None;
        self.notice = None;
        let (out, rx) = bounded(1);
        let id = id.to_owned();
        self.mutation = Some(MutationFlight {
            rx,
            scope: (backend.base.clone(), workspace.clone()),
            backend: backend.clone(),
        });
        platform::spawn(async move {
            let result = api::detach_host(&backend, &workspace, &directory, &id, &session_id).await;
            if out.send(MutationReply::Detach(result)).await.is_ok() {
                wake();
            }
        });
    }

    pub(in crate::settings) fn poll(
        &mut self,
        target: Option<&Target>,
        active: bool,
        wake: &rune::Waker,
        now: f64,
        tx: &mut rune::Tx,
    ) -> bool {
        let Some(target) = target.filter(|_| active) else {
            let changed = self.scope.is_some() || !matches!(self.load, LoadState::Idle);
            if changed {
                self.suspend();
            }
            return changed;
        };
        self.wake = Some(wake.clone());
        let (backend, workspace, session, authority, hint, session_hint, target_online) =
            target.integrations_source();
        let native = target.stats_status();
        let online = target_online && native.is_none_or(|(connected, _)| connected);
        let scope = (
            backend.base.clone(),
            workspace.to_owned(),
            session.map(str::to_owned),
        );
        let new_scope = self.scope.as_ref() != Some(&scope);
        let ws_scope = (backend.base.clone(), workspace.to_owned());
        if new_scope {
            self.suspend();
            self.mutation = self
                .mutation
                .take()
                .filter(|m| m.scope == ws_scope && same_mutation_server(&m.backend, backend));
            self.wake = Some(wake.clone());
            self.scope = Some(scope);
            self.backend = Some(backend.clone());
            self.workspace = Some(workspace.to_owned());
            self.session = session.map(str::to_owned);
            self.authority = authority;
            self.last_hint = hint;
            self.last_session_hint = session_hint;
        }
        let transport = (backend.client_id.clone(), authority, online, native);
        let transport_changed = self.transport.as_ref() != Some(&transport);
        if transport_changed {
            self.transport = Some(transport);
            self.backend = Some(backend.clone());
            self.authority = authority;
            self.online = online;
            self.directory = None;
            self.bindings.clear();
            self.offers.clear();
            self.cancel_reads();
            self.revoke_intents();
            if self
                .mutation
                .as_ref()
                .is_some_and(|m| m.scope != ws_scope || !same_mutation_server(&m.backend, backend))
            {
                self.mutation = None;
            }
            self.epoch = self.epoch.wrapping_add(1);
            if online {
                if matches!(self.load, LoadState::Ready(_)) {
                    self.stale = true;
                }
                self.schedule_read(0.0);
            } else {
                self.due = None;
                self.dirty_while_reading = false;
                if matches!(self.load, LoadState::Ready(_)) {
                    self.stale = true;
                }
            }
        }

        let visible = self.visibility.visible(wake);
        if !visible || !online {
            let lost =
                self.visible || self.read_flight.is_some() || !self.detail_flights.is_empty();
            self.visible = false;
            self.cancel_reads();
            self.revoke_intents();
            self.bindings.clear();
            self.offers.clear();
            self.due = None;
            self.dirty_while_reading = false;
            if matches!(self.load, LoadState::Ready(_)) {
                self.stale = true;
            }
            return new_scope || transport_changed || lost;
        }
        let became_visible = !self.visible;
        if became_visible {
            self.visible = true;
            if matches!(self.load, LoadState::Idle | LoadState::Error) || self.stale {
                self.schedule_read(0.0);
            }
        }

        let mut paint = new_scope || transport_changed || became_visible;
        let ws_changed = self.last_hint != hint;
        let ses_changed = self.last_session_hint != session_hint;
        if ws_changed || ses_changed {
            self.last_hint = hint;
            self.last_session_hint = session_hint;
            if ws_changed {
                self.epoch = self.epoch.wrapping_add(1);
            }
            if ses_changed {
                self.session_epoch = self.session_epoch.wrapping_add(1);
                self.directory = None;
            }
            self.bindings.clear();
            self.offers.clear();
            self.revoke_intents();
            if matches!(self.load, LoadState::Ready(_)) {
                self.stale = true;
            }
            self.schedule_coalesced(now);
            paint = true;
        }

        paint |= self.poll_read(now);
        paint |= self.poll_details();
        paint |= self.poll_attach_probe();
        paint |= self.poll_mutation();

        if let Some(due) = self.due.filter(|_| self.read_flight.is_none()) {
            if due <= now {
                self.due = None;
                self.start_read();
                paint = true;
            } else {
                tx.wake_after(Duration::from_secs_f64(due - now));
            }
        }
        paint
    }

    fn entry(&self, id: &str) -> Option<&IntegrationView> {
        let LoadState::Ready(snapshot) = &self.load else {
            return None;
        };
        snapshot.integrations.iter().find(|item| item.id == id)
    }

    fn cancel_reads(&mut self) {
        if let Some(flight) = self.read_flight.take() {
            flight.cancel.close();
        }
        for flight in self.detail_flights.drain(..) {
            flight.cancel.close();
        }
    }

    fn revoke_intents(&mut self) {
        self.confirm = None;
        self.chooser = None;
        if let Some(probe) = self.attach_probe.take() {
            probe.cancel.close();
        }
    }

    fn schedule_read(&mut self, due: f64) {
        if self.read_flight.is_some() {
            self.dirty_while_reading = true;
        } else {
            self.due = Some(self.due.map_or(due, |old| old.min(due)));
        }
    }

    fn schedule_coalesced(&mut self, now: f64) {
        if matches!(self.load, LoadState::Unsupported) {
            return;
        }
        self.schedule_read(now + EVENT_COALESCE_SECS);
    }

    fn start_read(&mut self) {
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        let session = self.session.clone();
        let cached_dir = self.directory.clone();
        let (cancel, cancelled) = bounded(1);
        let (out, rx) = bounded(1);
        if matches!(self.load, LoadState::Idle) {
            self.load = LoadState::Loading;
        }
        self.read_flight = Some(ReadFlight {
            cancel,
            rx,
            epoch: self.epoch,
            session_epoch: self.session_epoch,
        });
        platform::spawn(async move {
            let work = async {
                let directory = match cached_dir {
                    Some(dir) => dir,
                    None => match api::resolve_directory(&backend, &workspace, session.as_deref())
                        .await
                    {
                        Ok(dir) => dir,
                        Err(_) => return ReadReply::Failed,
                    },
                };
                match api::load(&backend, &workspace, &directory).await {
                    Ok(snapshot) => ReadReply::Loaded(directory, snapshot),
                    Err(IntegrationError::RouteUnsupported) => ReadReply::Unsupported,
                    Err(_) => ReadReply::Failed,
                }
            };
            if let Some(reply) = platform::reads::cancellable(&cancelled, work).await
                && out.send(reply).await.is_ok()
            {
                wake();
            }
        });
    }

    fn poll_read(&mut self, now: f64) -> bool {
        let Some(reply) = self.read_flight.as_ref().and_then(|flight| {
            flight
                .rx
                .try_recv()
                .ok()
                .map(|r| (flight.epoch, flight.session_epoch, r))
        }) else {
            return false;
        };
        self.read_flight = None;
        let (epoch, session_epoch, reply) = reply;
        if epoch == self.epoch && session_epoch == self.session_epoch {
            match reply {
                ReadReply::Loaded(directory, snapshot) => {
                    self.directory = Some(directory.clone());
                    self.stale = false;
                    self.refresh_error = false;
                    self.reconcile_intents(&snapshot);
                    self.load = LoadState::Ready(snapshot);
                    self.start_detail_reads(&directory);
                }
                ReadReply::Unsupported => {
                    self.mark_unsupported();
                }
                ReadReply::Failed => {
                    self.directory = None;
                    if matches!(self.load, LoadState::Ready(_)) {
                        self.stale = true;
                        self.refresh_error = true;
                    } else {
                        self.load = LoadState::Error;
                    }
                }
            }
        }
        if std::mem::take(&mut self.dirty_while_reading)
            && !matches!(self.load, LoadState::Unsupported)
        {
            self.schedule_coalesced(now);
        }
        true
    }

    fn reconcile_intents(&mut self, snapshot: &IntegrationsSnapshot) {
        if let Some(pending) = &self.confirm {
            let valid = match pending {
                PendingConfirm::CatalogInstall { id, .. } => snapshot
                    .integrations
                    .iter()
                    .find(|item| item.id == *id)
                    .is_some_and(IntegrationView::installable),
                PendingConfirm::HostInstall { id, signature, .. } => snapshot
                    .integrations
                    .iter()
                    .find(|item| item.id == *id)
                    .is_some_and(|item| {
                        item == signature.as_ref() && host_action_key(item).is_some()
                    }),
            };
            if !valid {
                self.confirm = None;
            }
        }
    }

    fn start_detail_reads(&mut self, directory: &str) {
        for flight in self.detail_flights.drain(..) {
            flight.cancel.close();
        }
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        let LoadState::Ready(snapshot) = &self.load else {
            return;
        };
        let valid_ids: Vec<_> = snapshot
            .integrations
            .iter()
            .filter(|e| native_attachable(e))
            .map(|e| {
                (
                    e.id.clone(),
                    e.status
                        .as_ref()
                        .and_then(|s| s.connection.as_ref())
                        .and_then(|c| c.offers)
                        .unwrap_or(0),
                )
            })
            .collect();
        self.bindings.clear();
        self.offers.clear();
        let Some(session_id) = self.session.clone() else {
            return;
        };
        for (id, offer_count) in valid_ids {
            {
                let (cancel, cancelled) = bounded(1);
                let (out, rx) = bounded(1);
                let (backend, workspace, dir, id_clone, session, wake) = (
                    backend.clone(),
                    workspace.clone(),
                    directory.to_owned(),
                    id.clone(),
                    session_id.clone(),
                    wake.clone(),
                );
                self.detail_flights.push(DetailFlight {
                    cancel,
                    rx,
                    epoch: self.epoch,
                    session_epoch: self.session_epoch,
                });
                platform::spawn(async move {
                    if let Some(binding) = platform::reads::cancellable(
                        &cancelled,
                        api::read_binding(&backend, &workspace, &dir, &id_clone, &session),
                    )
                    .await
                        && out
                            .send(DetailReply::Binding(id_clone, binding))
                            .await
                            .is_ok()
                    {
                        wake();
                    }
                });
            }
            if offer_count > 0 {
                let (cancel, cancelled) = bounded(1);
                let (out, rx) = bounded(1);
                let (backend, workspace, dir, id_clone, wake) = (
                    backend.clone(),
                    workspace.clone(),
                    directory.to_owned(),
                    id,
                    wake.clone(),
                );
                self.detail_flights.push(DetailFlight {
                    cancel,
                    rx,
                    epoch: self.epoch,
                    session_epoch: self.session_epoch,
                });
                platform::spawn(async move {
                    if let Some(result) = platform::reads::cancellable(
                        &cancelled,
                        api::list_hosts(&backend, &workspace, &dir, &id_clone),
                    )
                    .await
                        && out
                            .send(DetailReply::Offers(id_clone, result))
                            .await
                            .is_ok()
                    {
                        wake();
                    }
                });
            }
        }
    }

    fn poll_details(&mut self) -> bool {
        let mut changed = false;
        let mut remaining = Vec::with_capacity(self.detail_flights.len());
        for flight in self.detail_flights.drain(..) {
            if let Ok(reply) = flight.rx.try_recv() {
                if flight.epoch == self.epoch && flight.session_epoch == self.session_epoch {
                    match reply {
                        DetailReply::Binding(id, state) => {
                            self.bindings.insert(id, state);
                        }
                        DetailReply::Offers(id, Ok(list)) => {
                            self.offers.insert(id, list);
                        }
                        DetailReply::Offers(id, Err(_)) => {
                            self.offers.remove(&id);
                        }
                    }
                    changed = true;
                }
            } else if !flight.rx.is_closed() {
                remaining.push(flight);
            }
        }
        self.detail_flights = remaining;
        changed
    }

    fn poll_attach_probe(&mut self) -> bool {
        let Some(result) = self
            .attach_probe
            .as_ref()
            .and_then(|probe| probe.rx.try_recv().ok())
        else {
            return false;
        };
        let Some(probe) = self.attach_probe.take() else {
            return false;
        };
        if !self.fresh()
            || probe.authority != self.authority
            || probe.epoch != self.epoch
            || probe.session_epoch != self.session_epoch
            || self.directory.as_deref() != Some(probe.directory.as_str())
            || self.session.as_deref() != Some(probe.session_id.as_str())
            || matches!(
                self.bindings.get(&probe.id),
                Some(BindingState::Attached(_))
            )
        {
            return true;
        }
        match result {
            Ok(offers) => {
                let compatible: Vec<_> = offers.into_iter().filter(|o| o.protocol_ok).collect();
                if compatible.is_empty() {
                    self.notice = Some(Notice {
                        text: format_template(
                            "integrations.connection.noOffer",
                            &[("app", &probe.app_name)],
                        ),
                        error: true,
                    });
                    self.schedule_read(0.0);
                } else if compatible.len() == 1
                    && probe
                        .expected_offer
                        .as_deref()
                        .is_none_or(|exp| exp == compatible[0].offer_id)
                {
                    let offer_id = compatible[0].offer_id.clone();
                    self.dispatch_attach(probe.id, probe.directory, probe.session_id, &offer_id);
                } else {
                    self.chooser = Some(OfferChooser {
                        id: probe.id,
                        offers: compatible,
                        authority: probe.authority,
                        epoch: probe.epoch,
                        session_epoch: probe.session_epoch,
                        directory: probe.directory,
                        session_id: probe.session_id,
                    });
                }
            }
            Err(IntegrationError::RouteUnsupported) => {
                self.load = LoadState::Unsupported;
            }
            Err(_) => {
                self.notice = Some(Notice {
                    text: t("integrations.error.retry").to_owned(),
                    error: true,
                });
            }
        }
        true
    }

    fn dispatch_attach(
        &mut self,
        id: String,
        directory: String,
        session_id: String,
        offer_id: &str,
    ) {
        let Some((backend, workspace, wake)) = self
            .backend
            .clone()
            .zip(self.workspace.clone())
            .zip(self.wake.clone())
            .map(|((b, w), k)| (b, w, k))
        else {
            return;
        };
        let offer_id = offer_id.to_owned();
        let (out, rx) = bounded(1);
        self.mutation = Some(MutationFlight {
            rx,
            scope: (backend.base.clone(), workspace.clone()),
            backend: backend.clone(),
        });
        platform::spawn(async move {
            let result = api::attach_host(
                &backend,
                &workspace,
                &directory,
                &id,
                &session_id,
                &offer_id,
            )
            .await;
            if out.send(MutationReply::Attach(result)).await.is_ok() {
                wake();
            }
        });
    }

    fn mark_unsupported(&mut self) {
        self.cancel_reads();
        self.revoke_intents();
        self.bindings.clear();
        self.offers.clear();
        self.stale = false;
        self.refresh_error = false;
        self.dirty_while_reading = false;
        self.due = None;
        self.load = LoadState::Unsupported;
    }

    fn reconcile_after_mutation(&mut self) {
        self.cancel_reads();
        self.revoke_intents();
        self.bindings.clear();
        self.offers.clear();
        self.epoch = self.epoch.wrapping_add(1);
        if matches!(self.load, LoadState::Ready(_)) {
            self.stale = true;
        }
        self.dirty_while_reading = false;
        self.due = Some(0.0);
    }

    fn poll_mutation(&mut self) -> bool {
        let reply = match self.mutation.as_ref().map(|flight| flight.rx.try_recv()) {
            Some(Ok(reply)) => reply,
            Some(Err(_)) if self.mutation.as_ref().is_some_and(|f| f.rx.is_closed()) => {
                self.mutation = None;
                return true;
            }
            _ => return false,
        };
        self.mutation = None;
        match reply {
            MutationReply::CatalogInstall(Ok(())) => {
                self.notice = Some(Notice {
                    text: t("integrations.message.installRequested").to_owned(),
                    error: false,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::CatalogInstall(Err(IntegrationError::RouteUnsupported)) => {
                self.mark_unsupported();
            }
            MutationReply::CatalogInstall(Err(IntegrationError::Code(code)))
                if code == "global-only" =>
            {
                self.notice = Some(Notice {
                    text: t("integrations.section.scopeGlobalOnly").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::CatalogInstall(Err(_)) => {
                self.notice = Some(Notice {
                    text: t("integrations.install.error").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::HostInstall(Ok(outcome)) => {
                let (key, error) = match outcome {
                    InstallOutcome::Installed => ("integrations.installHost.installed", false),
                    InstallOutcome::Updated => ("integrations.installHost.updated", false),
                    InstallOutcome::Unchanged => ("integrations.installHost.unchanged", false),
                    InstallOutcome::Refused => ("integrations.installHost.refused", true),
                    InstallOutcome::Failed => ("integrations.installHost.failed", true),
                };
                self.notice = Some(Notice {
                    text: t(key).to_owned(),
                    error,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::HostInstall(Err(IntegrationError::RouteUnsupported)) => {
                self.mark_unsupported();
            }
            MutationReply::HostInstall(Err(IntegrationError::Code(code)))
                if code == "unsupported" =>
            {
                self.notice = Some(Notice {
                    text: t("integrations.installHost.unsupported").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::HostInstall(Err(_)) => {
                self.notice = Some(Notice {
                    text: t("integrations.installHost.error").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::Attach(Ok(outcome)) => {
                match outcome {
                    AttachOutcome::Attached => {
                        self.notice = None;
                    }
                    AttachOutcome::Busy => {
                        self.notice = Some(Notice {
                            text: t("integrations.outcome.busy").to_owned(),
                            error: true,
                        });
                    }
                    AttachOutcome::Gone => {
                        self.notice = Some(Notice {
                            text: t("integrations.outcome.gone").to_owned(),
                            error: true,
                        });
                    }
                    AttachOutcome::Refused => {
                        self.notice = Some(Notice {
                            text: t("integrations.outcome.refused").to_owned(),
                            error: true,
                        });
                    }
                }
                self.reconcile_after_mutation();
            }
            MutationReply::Attach(Err(IntegrationError::RouteUnsupported)) => {
                self.mark_unsupported();
            }
            MutationReply::Attach(Err(_)) => {
                self.notice = Some(Notice {
                    text: t("integrations.error.retry").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
            MutationReply::Detach(Ok(DetachOutcome::Detached | DetachOutcome::None)) => {
                self.notice = None;
                self.reconcile_after_mutation();
            }
            MutationReply::Detach(Err(IntegrationError::RouteUnsupported)) => {
                self.mark_unsupported();
            }
            MutationReply::Detach(Err(_)) => {
                self.notice = Some(Notice {
                    text: t("integrations.error.retry").to_owned(),
                    error: true,
                });
                self.reconcile_after_mutation();
            }
        }
        true
    }
}

fn native_attachable(entry: &IntegrationView) -> bool {
    entry.family == IntegrationFamily::Native
        && entry.state == RuntimeState::Ok
        && !entry.ambiguous
        && entry
            .status
            .as_ref()
            .and_then(|s| s.host.as_ref())
            .is_none_or(|h| h.state != HostState::Unsupported)
}
