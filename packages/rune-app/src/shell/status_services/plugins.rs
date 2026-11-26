//! Right-panel Status: Plugins controls, source add/remove, and package actions state.
use super::barrier::{self, Kind};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    plugins::{self, ActionError, ActivationResult, RemovalTarget, Scope, Snapshot},
};
use rune::TextEdit;
use std::collections::{HashMap, HashSet};

pub(super) const CONSENT_DELAY_S: f64 = 0.6;
pub(super) const CONSENT_EXPIRY_S: f64 = 120.0;
pub(super) const INSTALL_PENDING_S: f64 = 120.0;
const MAX_PENDING_INSTALLS: usize = 64;

enum ReadOutcome {
    Snapshot(Box<Snapshot>, u64, HashMap<String, u64>),
    Unsupported,
    Failed,
}

type ReadFlight = (Sender<()>, Receiver<ReadOutcome>, u64, HashMap<String, u64>);

#[derive(Clone, Debug)]
pub(super) struct ConfirmRemove {
    pub removal: RemovalTarget,
    pub opened_at: f64,
    pub consent_epoch: u64,
    pub ready_notified: bool,
    pub return_focus: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct PendingInstall {
    pub directory: String,
    pub scope: Scope,
    pub spec: String,
    pub started_at: f64,
    pub expired_notified: bool,
    pub seen_in_snapshot: bool,
}

struct PendingActivation {
    id: u64,
    location_epoch: u64,
    name: String,
    scope: Scope,
    enabled: bool,
    rx: Receiver<Result<ActivationResult, ActionError>>,
}

struct PendingAdd {
    id: u64,
    location_epoch: u64,
    directory: String,
    scope: Scope,
    rx: Receiver<Result<String, ActionError>>,
}

struct PendingRemove {
    base: String,
    id: u64,
    directory: String,
    removal: RemovalTarget,
}

struct PendingPackage {
    base: String,
    id: u64,
    target: String,
}

pub(crate) struct PluginsPanel {
    observer: u64,
    pub(super) expanded: bool,
    pub(super) backend: Option<Backend>,
    pub(super) online: bool,
    visible: bool,
    dirty: bool,
    pub(super) clock: f64,
    consent_epoch: u64,
    location_epoch: u64,
    pub(super) write_unconfirmed: bool,
    pub(super) write_active: bool,
    location_unconfirmed: bool,
    confirmed_settled_id: u64,
    attempted_settled_id: u64,
    confirmed_package_generations: HashMap<String, u64>,
    attempted_package_generations: HashMap<String, u64>,
    unconfirmed_packages: HashSet<String>,
    pub(super) runtime_unconfirmed: HashSet<String>,
    read: Option<ReadFlight>,
    pending_activation: Option<PendingActivation>,
    pending_add: Option<PendingAdd>,
    pending_remove: Option<PendingRemove>,
    pending_packages: Vec<PendingPackage>,
    pub(super) pending_installs: Vec<PendingInstall>,
    pub(super) snapshot: Option<Snapshot>,
    pub(super) unsupported: bool,
    pub(super) failed: bool,
    pub(super) feedback_error: Option<String>,
    pub(super) add_open: bool,
    pub(crate) add_spec: TextEdit,
    pub(super) add_scope: Scope,
    pub(super) add_error: Option<String>,
    pub(super) add_info_open: bool,
    pub(super) open_info_key: Option<String>,
    pub(super) confirm_remove: Option<ConfirmRemove>,
}

impl Default for PluginsPanel {
    fn default() -> Self {
        Self {
            observer: barrier::next_observer(),
            expanded: false,
            backend: None,
            online: false,
            visible: false,
            dirty: false,
            clock: 0.0,
            consent_epoch: 1,
            location_epoch: 1,
            write_unconfirmed: false,
            write_active: false,
            location_unconfirmed: false,
            confirmed_settled_id: 0,
            attempted_settled_id: 0,
            confirmed_package_generations: HashMap::new(),
            attempted_package_generations: HashMap::new(),
            unconfirmed_packages: HashSet::new(),
            runtime_unconfirmed: HashSet::new(),
            read: None,
            pending_activation: None,
            pending_add: None,
            pending_remove: None,
            pending_packages: Vec::new(),
            pending_installs: Vec::new(),
            snapshot: None,
            unsupported: false,
            failed: false,
            feedback_error: None,
            add_open: false,
            add_spec: TextEdit::new(""),
            add_scope: Scope::Global,
            add_error: None,
            add_info_open: false,
            open_info_key: None,
            confirm_remove: None,
        }
    }
}

impl PluginsPanel {
    fn revoke_consent(&mut self) {
        self.consent_epoch = self.consent_epoch.wrapping_add(1);
        self.confirm_remove = None;
    }

    pub(super) fn attach(&mut self, backend: Option<&Backend>) {
        if backend.is_some_and(|next| self.same_scope(next)) {
            self.online(false);
            return;
        }
        let expanded = self.expanded;
        let clock = self.clock;
        *self = Self {
            expanded,
            clock,
            ..Self::default()
        };
    }

    pub(super) fn bind(&mut self, backend: &Backend) {
        if !self.same_scope(backend) {
            self.attach(Some(backend));
            self.backend = (!backend.workspace.is_empty()).then(|| backend.clone());
            self.dirty = true;
            self.write_unconfirmed = true;
        } else if self.backend.is_none() && !backend.workspace.is_empty() {
            self.backend = Some(backend.clone());
            self.dirty = true;
            self.write_unconfirmed = true;
        }
    }

    pub(super) fn same_scope(&self, next: &Backend) -> bool {
        self.backend.as_ref().is_some_and(|prev| {
            prev.base == next.base
                && prev.workspace == next.workspace
                && prev.session == next.session
                && prev.client.same_connection(&next.client)
                && (self.location_unconfirmed || prev.session_directory == next.session_directory)
        })
    }

    pub(super) fn workspace_id(&self) -> Option<&str> {
        self.backend
            .as_ref()
            .map(|b| b.workspace.as_str())
            .filter(|id| !id.is_empty())
    }

    pub(super) fn online(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            self.dirty = true;
            if !online {
                self.read = None;
                self.write_unconfirmed = true;
                self.location_unconfirmed = true;
                self.location_epoch = self.location_epoch.wrapping_add(1);
                self.revoke_consent();
                if let Some(backend) = &mut self.backend
                    && !backend.session.is_empty()
                {
                    backend.session_directory = None;
                }
            }
        }
    }

    pub(super) fn require_revalidation(&mut self) {
        self.online = true;
        self.write_unconfirmed = true;
        self.location_unconfirmed = true;
        self.location_epoch = self.location_epoch.wrapping_add(1);
        self.read = None;
        self.dirty = true;
        self.revoke_consent();
        if let Some(backend) = &mut self.backend
            && !backend.session.is_empty()
        {
            backend.session_directory = None;
        }
    }

    pub(super) fn synchronized(&mut self) {
        if !self.online {
            self.online(true);
        }
    }

    pub(super) fn location_moved(&mut self) {
        self.online = false;
        self.write_unconfirmed = true;
        self.location_unconfirmed = true;
        self.location_epoch = self.location_epoch.wrapping_add(1);
        self.read = None;
        self.dirty = true;
        self.feedback_error = None;
        self.add_open = false;
        self.add_spec = TextEdit::new("");
        self.add_error = None;
        self.add_info_open = false;
        self.open_info_key = None;
        self.runtime_unconfirmed.clear();
        self.revoke_consent();
        if let Some(backend) = &mut self.backend {
            backend.session_directory = None;
        }
    }

    pub(super) fn invalidate(&mut self, directory: Option<&str>) {
        let matches = directory.is_none_or(|dir| {
            self.snapshot
                .as_ref()
                .is_none_or(|snap| plugins::location_matches(&snap.directory, dir))
        });
        if matches {
            self.dirty = true;
            self.revoke_consent();
        }
    }

    pub(super) fn show(&mut self, visible: bool) {
        if self.visible != visible {
            self.visible = visible;
            if visible {
                self.dirty = true;
            } else {
                self.read = None;
                self.add_info_open = false;
                self.open_info_key = None;
                self.revoke_consent();
            }
        }
    }

    pub(super) fn toggle_section(&mut self) {
        self.expanded = !self.expanded;
        self.add_info_open = false;
        self.open_info_key = None;
        if self.expanded {
            self.dirty = true;
        } else {
            self.read = None;
            self.revoke_consent();
        }
    }

    pub(super) fn toggle_info(&mut self, key: String) {
        if self.open_info_key.as_deref() == Some(key.as_str()) {
            self.open_info_key = None;
        } else {
            self.open_info_key = Some(key);
        }
    }

    pub(super) fn request_refresh(&mut self) {
        if !self.online || self.reading() || self.write_active {
            return;
        }
        self.failed = false;
        self.feedback_error = None;
        self.dirty = true;
        self.revoke_consent();
    }

    pub(super) fn open_add(&mut self) {
        self.add_open = !self.add_open;
        self.add_spec = TextEdit::new("");
        self.add_scope = Scope::Global;
        self.add_error = None;
        self.add_info_open = false;
        self.revoke_consent();
    }

    pub(super) fn set_add_scope(&mut self, scope: Scope) {
        if scope == Scope::Project
            && !self
                .snapshot
                .as_ref()
                .is_some_and(Snapshot::project_available)
        {
            return;
        }
        self.add_scope = scope;
        self.add_error = None;
    }

    pub(super) fn request_remove_confirm(
        &mut self,
        removal: RemovalTarget,
        trigger_key: String,
        tx: &mut rune::Tx,
    ) {
        if self.mutations_locked() {
            return;
        }
        self.add_open = false;
        self.feedback_error = None;
        let return_focus = Some(tx.focused().map(str::to_owned).unwrap_or(trigger_key));
        self.confirm_remove = Some(ConfirmRemove {
            removal,
            opened_at: self.clock,
            consent_epoch: self.consent_epoch,
            ready_notified: false,
            return_focus,
        });
        tx.focus("plugins-remove-cancel", true);
        tx.wake_at(self.clock + CONSENT_DELAY_S);
    }

    pub(super) fn cancel_remove_confirm(&mut self, tx: &mut rune::Tx) -> bool {
        let Some(confirm) = self.confirm_remove.take() else {
            return false;
        };
        if let Some(key) = confirm.return_focus {
            tx.return_focus(key, tx.focus_visible());
        }
        true
    }

    pub(super) fn remove_ready(&self) -> bool {
        self.confirm_remove.as_ref().is_some_and(|confirm| {
            confirm.consent_epoch == self.consent_epoch
                && self.clock - confirm.opened_at >= CONSENT_DELAY_S
                && self.clock - confirm.opened_at <= CONSENT_EXPIRY_S
        })
    }

    pub(super) fn is_install_pending(&self, directory: &str, spec: &str) -> bool {
        self.pending_installs.iter().any(|item| {
            plugins::location_matches(&item.directory, directory)
                && item.spec == spec
                && self.clock - item.started_at <= INSTALL_PENDING_S
        })
    }

    pub(super) fn pending_specs_for<'a>(&'a self, snap: &'a Snapshot) -> Vec<&'a str> {
        let mut out = Vec::new();
        for item in &self.pending_installs {
            if !plugins::location_matches(&item.directory, &snap.directory) {
                continue;
            }
            let managed = snap
                .configured_sources
                .iter()
                .any(|s| s.target == item.spec && s.managed_by_codenomad);
            if managed {
                continue;
            }
            let loaded = snap.runtime.iter().any(|r| match &r.source {
                plugins::RuntimeSource::Package { target, .. } => target == &item.spec,
                _ => false,
            });
            if !loaded && !out.contains(&item.spec.as_str()) {
                out.push(item.spec.as_str());
            }
        }
        out
    }

    pub(super) fn reading(&self) -> bool {
        self.read.is_some()
    }

    pub(super) fn mutations_locked(&self) -> bool {
        !self.online || self.write_active || self.write_unconfirmed || self.location_unconfirmed
    }

    pub(super) fn package_busy(&self, target: &str) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|b| barrier::is_active(&Kind::PluginPackage(target.to_owned()), &b.base))
    }

    pub(super) fn package_unconfirmed(&self, target: &str) -> bool {
        self.unconfirmed_packages.contains(target)
    }

    pub(super) fn toggle_activation(
        &mut self,
        plugin_id: String,
        scope: Scope,
        enabled: bool,
        managed_by_codenomad: bool,
        wake: &rune::Waker,
    ) {
        if self.mutations_locked() || !self.visible || !self.expanded {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(snap) = &self.snapshot else {
            return;
        };
        if !snap.controls_available || !snap.scope_available(scope) {
            return;
        }
        let directory = snap.directory.clone();
        let Some(guard) = barrier::try_begin(
            Kind::Plugins,
            &backend.base,
            self.confirmed_settled_id,
            self.observer,
            wake.clone(),
        ) else {
            self.write_unconfirmed = true;
            self.dirty = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.feedback_error = None;
        self.revoke_consent();
        self.write_active = true;
        let (tx, rx) = bounded(1);
        let id = guard.id();
        self.pending_activation = Some(PendingActivation {
            id,
            location_epoch: self.location_epoch,
            name: plugin_id.clone(),
            scope,
            enabled,
            rx,
        });
        platform::spawn(async move {
            let outcome = plugins::set_activation(
                &backend,
                &directory,
                &plugin_id,
                scope,
                enabled,
                managed_by_codenomad,
            )
            .await;
            let status = outcome.as_ref().map(|_| ()).map_err(Clone::clone);
            let _ = tx.send(outcome).await;
            guard.finish(status);
        });
    }

    pub(super) fn submit_add(&mut self, wake: &rune::Waker) {
        if self.mutations_locked() || !self.visible || !self.expanded {
            return;
        }
        let spec = self.add_spec.text.trim().to_owned();
        if spec.is_empty() {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(snap) = &self.snapshot else {
            return;
        };
        if !snap.controls_available {
            return;
        }
        let scope = self.add_scope;
        if scope == Scope::Project && !snap.project_available() {
            return;
        }
        let directory = snap.directory.clone();
        let Some(guard) = barrier::try_begin(
            Kind::Plugins,
            &backend.base,
            self.confirmed_settled_id,
            self.observer,
            wake.clone(),
        ) else {
            self.write_unconfirmed = true;
            self.dirty = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.add_error = None;
        self.feedback_error = None;
        self.write_active = true;
        let (tx, rx) = bounded(1);
        let id = guard.id();
        self.pending_add = Some(PendingAdd {
            id,
            location_epoch: self.location_epoch,
            directory: directory.clone(),
            scope,
            rx,
        });
        platform::spawn(async move {
            let outcome = plugins::add_source(&backend, &directory, scope, &spec).await;
            let status = outcome.as_ref().map(|_| ()).map_err(Clone::clone);
            let _ = tx.send(outcome).await;
            guard.finish(status);
        });
    }

    pub(super) fn confirm_and_remove(&mut self, wake: &rune::Waker) {
        if self.mutations_locked() || !self.visible || !self.expanded || !self.remove_ready() {
            return;
        }
        let Some(confirm) = self.confirm_remove.take() else {
            return;
        };
        let removal = confirm.removal;
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(snap) = &self.snapshot else {
            return;
        };
        if !snap.controls_available {
            return;
        }
        let directory = snap.directory.clone();
        let Some(guard) = barrier::try_begin(
            Kind::Plugins,
            &backend.base,
            self.confirmed_settled_id,
            self.observer,
            wake.clone(),
        ) else {
            self.write_unconfirmed = true;
            self.dirty = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.feedback_error = None;
        self.write_active = true;
        self.pending_remove = Some(PendingRemove {
            base: backend.base.clone(),
            id: guard.id(),
            directory: directory.clone(),
            removal: removal.clone(),
        });
        platform::spawn(async move {
            let outcome = plugins::remove_source(&backend, &directory, &removal).await;
            guard.finish(outcome);
        });
    }

    pub(super) fn run_package(&mut self, target: String, update: bool, wake: &rune::Waker) {
        if self.mutations_locked()
            || !self.visible
            || !self.expanded
            || self.unconfirmed_packages.contains(&target)
        {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(snap) = &self.snapshot else {
            return;
        };
        if !snap.controls_available {
            return;
        }
        let directory = snap.directory.clone();
        let kind = Kind::PluginPackage(target.clone());
        let expected = self
            .confirmed_package_generations
            .get(&target)
            .copied()
            .unwrap_or(0);
        let Some(guard) =
            barrier::try_begin(kind, &backend.base, expected, self.observer, wake.clone())
        else {
            self.unconfirmed_packages.insert(target);
            self.dirty = true;
            return;
        };
        self.feedback_error = None;
        self.unconfirmed_packages.insert(target.clone());
        self.pending_packages.push(PendingPackage {
            base: backend.base.clone(),
            id: guard.id(),
            target: target.clone(),
        });
        platform::spawn(async move {
            let outcome = plugins::run_package_action(&backend, &directory, &target, update).await;
            guard.finish(outcome);
        });
    }

    pub(super) fn poll(
        &mut self,
        now: f64,
        reads: &platform::reads::Reads,
        wake: &rune::Waker,
        tx: &mut rune::Tx,
    ) -> bool {
        self.clock = now;
        let mut changed = false;

        if let Some(confirm) = &mut self.confirm_remove {
            let elapsed = now - confirm.opened_at;
            if confirm.consent_epoch != self.consent_epoch || elapsed > CONSENT_EXPIRY_S {
                let return_focus = confirm.return_focus.clone();
                self.confirm_remove = None;
                if let Some(key) = return_focus {
                    tx.return_focus(key, tx.focus_visible());
                }
                changed = true;
            } else if elapsed < CONSENT_DELAY_S {
                tx.wake_at(confirm.opened_at + CONSENT_DELAY_S);
            } else {
                if !confirm.ready_notified {
                    confirm.ready_notified = true;
                    changed = true;
                }
                tx.wake_at(confirm.opened_at + CONSENT_EXPIRY_S + 0.01);
            }
        }

        let mut next_install_due: Option<f64> = None;
        for item in &mut self.pending_installs {
            let end = item.started_at + INSTALL_PENDING_S;
            if now > end {
                if !item.expired_notified {
                    item.expired_notified = true;
                    changed = true;
                }
            } else {
                let due = end + 0.01;
                next_install_due = Some(next_install_due.map_or(due, |cur| cur.min(due)));
            }
        }
        if let Some(due) = next_install_due {
            tx.wake_at(due);
        }

        changed |= self.poll_writes(wake);

        if let Some(base) = self.backend.as_ref().map(|b| b.base.clone()) {
            let obs = barrier::observe(&Kind::Plugins, &base, self.observer, wake);
            if obs.active {
                if !self.write_active {
                    self.write_active = true;
                    changed = true;
                }
                if self.read.take().is_some() {
                    changed = true;
                }
            } else {
                let was_writing = std::mem::take(&mut self.write_active);
                let foreign_settled =
                    obs.settled_id != 0 && self.confirmed_settled_id != obs.settled_id;
                let in_flight_covers = self
                    .read
                    .as_ref()
                    .is_some_and(|(_, _, read_gen, _)| *read_gen == obs.settled_id);
                let already_failed = self.failed && self.attempted_settled_id == obs.settled_id;
                if foreign_settled {
                    if self.pending_activation.is_none()
                        && self.pending_add.is_none()
                        && self.pending_remove.is_none()
                    {
                        if !self.write_unconfirmed {
                            self.write_unconfirmed = true;
                            self.revoke_consent();
                            changed = true;
                        }
                        if !in_flight_covers && !already_failed {
                            self.dirty = true;
                            changed = true;
                        }
                    }
                } else if was_writing {
                    changed = true;
                }
            }

            if let Some(snap) = &self.snapshot {
                for target in package_targets(snap) {
                    let kind = Kind::PluginPackage(target.to_owned());
                    let obs = barrier::observe(&kind, &base, self.observer, wake);
                    let confirmed = self
                        .confirmed_package_generations
                        .get(target)
                        .copied()
                        .unwrap_or(0);
                    let in_flight_covers = self.read.as_ref().is_some_and(|(_, _, _, pkg_gens)| {
                        pkg_gens.get(target).copied().unwrap_or(0) == obs.settled_id
                    });
                    let already_failed = self.failed
                        && self
                            .attempted_package_generations
                            .get(target)
                            .copied()
                            .unwrap_or(0)
                            == obs.settled_id;
                    if obs.active || obs.settled_id != confirmed {
                        if self.unconfirmed_packages.insert(target.to_owned()) {
                            changed = true;
                        }
                        if !obs.active && !in_flight_covers && !already_failed {
                            self.dirty = true;
                        }
                    }
                }
            }
        }

        if let Some((_, rx, _, _)) = &self.read {
            match rx.try_recv() {
                Ok(outcome) => {
                    self.read = None;
                    if !self.dirty && !self.write_active {
                        match outcome {
                            ReadOutcome::Snapshot(snap, read_gen, pkg_gens) => {
                                let snap = *snap;
                                let moved = self.snapshot.as_ref().is_some_and(|prev| {
                                    !plugins::location_matches(&prev.directory, &snap.directory)
                                });
                                if moved {
                                    self.add_open = false;
                                    self.add_spec = TextEdit::new("");
                                    self.add_error = None;
                                    self.add_info_open = false;
                                    self.open_info_key = None;
                                    self.feedback_error = None;
                                    self.runtime_unconfirmed.clear();
                                } else {
                                    self.runtime_unconfirmed.retain(|plugin_id| {
                                        snap.controls.iter().any(|c| {
                                            c.id == *plugin_id
                                                && c.managed_by_codenomad
                                                && c.runtime.is_none()
                                        })
                                    });
                                }
                                if let Some(backend) = &mut self.backend
                                    && !backend.session.is_empty()
                                {
                                    backend.session_directory = Some(snap.directory.clone());
                                }
                                self.location_unconfirmed = false;
                                self.prune_loaded_installs(&snap);
                                self.revoke_consent();
                                let base = self.backend.as_ref().map(|b| b.base.as_str());
                                let live_gen =
                                    base.map_or(0, |b| barrier::settled_id(&Kind::Plugins, b));
                                let active =
                                    base.is_some_and(|b| barrier::is_active(&Kind::Plugins, b));
                                let mut need_reread = false;
                                for target in package_targets(&snap) {
                                    let at_read = pkg_gens.get(target).copied().unwrap_or(0);
                                    let live = base.map_or(0, |b| {
                                        barrier::settled_id(
                                            &Kind::PluginPackage(target.to_owned()),
                                            b,
                                        )
                                    });
                                    let pkg_active = base.is_some_and(|b| {
                                        barrier::is_active(
                                            &Kind::PluginPackage(target.to_owned()),
                                            b,
                                        )
                                    });
                                    if !pkg_active && live == at_read {
                                        self.confirmed_package_generations
                                            .insert(target.to_owned(), at_read);
                                        self.unconfirmed_packages.remove(target);
                                    } else {
                                        self.unconfirmed_packages.insert(target.to_owned());
                                        if !pkg_active {
                                            need_reread = true;
                                        }
                                    }
                                }
                                self.snapshot = Some(snap);
                                self.unsupported = false;
                                self.failed = false;
                                if !active && live_gen == read_gen {
                                    self.confirmed_settled_id = read_gen;
                                    self.write_unconfirmed = false;
                                } else {
                                    self.write_unconfirmed = true;
                                    if !active {
                                        need_reread = true;
                                    }
                                }
                                if need_reread {
                                    self.dirty = true;
                                }
                            }
                            ReadOutcome::Unsupported => {
                                self.snapshot = None;
                                self.unsupported = true;
                                self.failed = false;
                                self.write_unconfirmed = false;
                                self.location_unconfirmed = false;
                                self.revoke_consent();
                            }
                            ReadOutcome::Failed => self.failed = true,
                        }
                    }
                    changed = true;
                }
                Err(codenomad_client::TryRecvError::Closed) => {
                    self.read = None;
                    if !self.dirty && !self.write_active {
                        self.failed = true;
                    }
                    changed = true;
                }
                Err(codenomad_client::TryRecvError::Empty) => {}
            }
        }

        if self.dirty
            && self.visible
            && self.expanded
            && self.online
            && self.read.is_none()
            && !self.write_active
            && let Some(mut backend) = self.backend.clone()
        {
            if self.location_unconfirmed && !backend.session.is_empty() {
                backend.session_directory = None;
            }
            let (cancel, cancelled) = bounded(1);
            let (out, rx) = bounded(1);
            let read_gen = barrier::settled_id(&Kind::Plugins, &backend.base);
            let pkg_gens = barrier::package_generations(&backend.base);
            self.attempted_settled_id = read_gen;
            self.attempted_package_generations = pkg_gens.clone();
            self.dirty = false;
            self.read = Some((cancel, rx, read_gen, pkg_gens.clone()));
            let (reads, wake) = (reads.clone(), wake.clone());
            platform::spawn(async move {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, plugins::load(&backend, None)).await
                {
                    let outcome = match result {
                        Ok(Some(snap)) => ReadOutcome::Snapshot(Box::new(snap), read_gen, pkg_gens),
                        Ok(None) => ReadOutcome::Unsupported,
                        Err(_) => ReadOutcome::Failed,
                    };
                    if out.send(outcome).await.is_ok() {
                        wake();
                    }
                }
            });
            changed = true;
        }
        changed
    }

    fn poll_writes(&mut self, wake: &rune::Waker) -> bool {
        let mut changed = false;
        if let Some(pending) = &self.pending_activation {
            let outcome = match pending.rx.try_recv() {
                Ok(res) => Some(res),
                Err(codenomad_client::TryRecvError::Closed) => Some(Err(ActionError::Failed)),
                Err(codenomad_client::TryRecvError::Empty) => None,
            };
            if let Some(outcome) = outcome {
                let pending = self.pending_activation.take().unwrap();
                let stale_location =
                    pending.location_epoch != self.location_epoch || self.location_unconfirmed;
                match outcome {
                    Ok(ActivationResult {
                        snapshot: snap,
                        reload_pending,
                    }) if !stale_location => {
                        let missing_revisions = snap
                            .targets
                            .iter()
                            .any(|target| target.exists && target.expected_revision.is_none());
                        if pending.enabled
                            && reload_pending
                            && snap
                                .controls
                                .iter()
                                .any(|c| c.id == pending.name && c.managed_by_codenomad)
                        {
                            self.runtime_unconfirmed.insert(pending.name.clone());
                        } else if !pending.enabled {
                            self.runtime_unconfirmed.remove(&pending.name);
                        }
                        self.prune_loaded_installs(&snap);
                        self.revoke_consent();
                        self.snapshot = Some(snap);
                        self.confirmed_settled_id = self.confirmed_settled_id.max(pending.id);
                        self.write_unconfirmed = false;
                        self.failed = false;
                        self.feedback_error = None;
                        if missing_revisions {
                            self.dirty = true;
                        }
                    }
                    Ok(_) => {
                        self.write_unconfirmed = true;
                        self.dirty = true;
                    }
                    Err(err) => {
                        if !stale_location {
                            let scope_label = t(pending.scope.i18n_key());
                            self.feedback_error = Some(
                                t(err.activation_i18n_key())
                                    .replace("{name}", &pending.name)
                                    .replace("{scope}", scope_label),
                            );
                        }
                        self.write_unconfirmed = true;
                        self.dirty = true;
                    }
                }
                changed = true;
            }
        }

        if let Some(pending) = &self.pending_add {
            let outcome = match pending.rx.try_recv() {
                Ok(res) => Some(res),
                Err(codenomad_client::TryRecvError::Closed) => Some(Err(ActionError::Failed)),
                Err(codenomad_client::TryRecvError::Empty) => None,
            };
            if let Some(outcome) = outcome {
                let pending = self.pending_add.take().unwrap();
                let stale_location =
                    pending.location_epoch != self.location_epoch || self.location_unconfirmed;
                match outcome {
                    Ok(spec) => {
                        self.record_pending_install(pending.directory, pending.scope, spec);
                        self.add_open = false;
                        self.add_spec = TextEdit::new("");
                        self.add_error = None;
                        self.write_unconfirmed = true;
                        self.dirty = true;
                    }
                    Err(err) => {
                        if !stale_location {
                            let scope_label = t(pending.scope.i18n_key());
                            let global_label = t(Scope::Global.i18n_key());
                            self.add_error = Some(
                                t(err.add_source_i18n_key())
                                    .replace("{scope}", scope_label)
                                    .replace("{global}", global_label),
                            );
                        }
                        let definite_rejection = !stale_location
                            && matches!(
                                &err,
                                ActionError::Code(code)
                                    if matches!(
                                        code.as_str(),
                                        "invalid-spec"
                                            | "local-path"
                                            | "plugin-id"
                                            | "duplicate"
                                            | "global-only"
                                    )
                            );
                        if definite_rejection {
                            self.confirmed_settled_id = self.confirmed_settled_id.max(pending.id);
                        } else {
                            self.write_unconfirmed = true;
                            self.dirty = true;
                        }
                    }
                }
                changed = true;
            }
        }

        if let Some(pending) = &self.pending_remove
            && let Some(outcome) = barrier::result(&Kind::Plugins, &pending.base, pending.id)
        {
            let pending = self.pending_remove.take().unwrap();
            self.pending_installs.retain(|item| {
                !(plugins::location_matches(&item.directory, &pending.directory)
                    && item.scope == pending.removal.scope
                    && item.spec == pending.removal.target)
            });
            if let Err(err) = outcome {
                let scope_label = t(pending.removal.scope.i18n_key());
                self.feedback_error = Some(
                    t(err.remove_source_i18n_key())
                        .replace("{name}", &pending.removal.target)
                        .replace("{scope}", scope_label),
                );
            }
            self.write_unconfirmed = true;
            self.dirty = true;
            changed = true;
        }

        let mut i = 0;
        while i < self.pending_packages.len() {
            let p = &self.pending_packages[i];
            let kind = Kind::PluginPackage(p.target.clone());
            let _ = barrier::observe(&kind, &p.base, self.observer, wake);
            if let Some(outcome) = barrier::result(&kind, &p.base, p.id) {
                let p = self.pending_packages.remove(i);
                if outcome.is_err() {
                    self.feedback_error =
                        Some(t("settings.pluginPackages.error").replace("{target}", &p.target));
                }
                self.dirty = true;
                changed = true;
            } else {
                i += 1;
            }
        }
        changed
    }

    fn record_pending_install(&mut self, directory: String, scope: Scope, spec: String) {
        self.pending_installs.retain(|item| {
            !(plugins::location_matches(&item.directory, &directory)
                && item.scope == scope
                && item.spec == spec)
        });
        if self.pending_installs.len() >= MAX_PENDING_INSTALLS {
            self.pending_installs.remove(0);
        }
        self.pending_installs.push(PendingInstall {
            directory,
            scope,
            spec,
            started_at: self.clock,
            expired_notified: false,
            seen_in_snapshot: false,
        });
    }

    fn prune_loaded_installs(&mut self, snap: &Snapshot) {
        self.pending_installs.retain_mut(|item| {
            if !plugins::location_matches(&item.directory, &snap.directory) {
                return true;
            }
            let loaded = snap.runtime.iter().any(|r| match &r.source {
                plugins::RuntimeSource::Package { target, .. } => target == &item.spec,
                _ => false,
            });
            if loaded {
                return false;
            }
            let configured = snap
                .configured_sources
                .iter()
                .any(|s| s.target == item.spec);
            if configured {
                item.seen_in_snapshot = true;
                true
            } else {
                !item.seen_in_snapshot
            }
        });
    }
}

fn package_targets(snap: &Snapshot) -> Vec<&str> {
    let mut out = Vec::new();
    for entry in &snap.runtime {
        if let plugins::RuntimeSource::Package { target, .. } = &entry.source
            && !out.contains(&target.as_str())
        {
            out.push(target.as_str());
        }
    }
    for control in &snap.controls {
        if let Some(rt) = &control.runtime
            && let plugins::RuntimeSource::Package { target, .. } = &rt.source
            && !out.contains(&target.as_str())
        {
            out.push(target.as_str());
        }
    }
    out
}
