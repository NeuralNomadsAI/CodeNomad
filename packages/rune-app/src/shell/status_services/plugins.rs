//! Right-panel Status: Plugins controls, source add/remove, and package actions state.
use super::barrier::{self, Kind};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    plugins::{self, ActionError, RemovalTarget, Scope, Snapshot},
};
use rune::TextEdit;

enum ReadOutcome {
    Snapshot(Snapshot),
    Unsupported,
    Failed,
}

struct PendingActivation {
    id: u64,
    name: String,
    scope: Scope,
    rx: Receiver<Result<Snapshot, ActionError>>,
}

struct PendingAdd {
    base: String,
    id: u64,
    scope: Scope,
}

struct PendingRemove {
    base: String,
    id: u64,
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
    pub(super) write_unconfirmed: bool,
    pub(super) write_active: bool,
    seen_settled_id: u64,
    read: Option<(Sender<()>, Receiver<ReadOutcome>)>,
    pending_activation: Option<PendingActivation>,
    pending_add: Option<PendingAdd>,
    pending_remove: Option<PendingRemove>,
    pending_packages: Vec<PendingPackage>,
    pub(super) snapshot: Option<Snapshot>,
    pub(super) unsupported: bool,
    pub(super) failed: bool,
    pub(super) feedback_error: Option<String>,
    pub(super) add_open: bool,
    pub(crate) add_spec: TextEdit,
    pub(super) add_scope: Scope,
    pub(super) add_error: Option<String>,
    pub(super) add_info_open: bool,
    pub(super) confirm_remove: Option<RemovalTarget>,
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
            write_unconfirmed: false,
            write_active: false,
            seen_settled_id: 0,
            read: None,
            pending_activation: None,
            pending_add: None,
            pending_remove: None,
            pending_packages: Vec::new(),
            snapshot: None,
            unsupported: false,
            failed: false,
            feedback_error: None,
            add_open: false,
            add_spec: TextEdit::new(""),
            add_scope: Scope::Global,
            add_error: None,
            add_info_open: false,
            confirm_remove: None,
        }
    }
}

impl PluginsPanel {
    pub(super) fn attach(&mut self, backend: Option<&Backend>) {
        if backend.is_some_and(|next| self.same_scope(next)) {
            self.online(false);
            return;
        }
        let expanded = self.expanded;
        *self = Self {
            expanded,
            ..Self::default()
        };
    }

    pub(super) fn bind(&mut self, backend: &Backend) {
        if !self.same_scope(backend) {
            self.attach(Some(backend));
            self.backend = (!backend.workspace.is_empty()).then(|| backend.clone());
            self.dirty = true;
        } else if self.backend.is_none() && !backend.workspace.is_empty() {
            self.backend = Some(backend.clone());
            self.dirty = true;
        }
    }

    fn same_scope(&self, next: &Backend) -> bool {
        self.backend.as_ref().is_some_and(|prev| {
            prev.base == next.base
                && prev.workspace == next.workspace
                && prev.session == next.session
                && prev.session_directory == next.session_directory
                && prev.client.same_connection(&next.client)
        })
    }

    pub(super) fn online(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            self.dirty = true;
            if !online {
                self.read = None;
                self.write_unconfirmed = true;
                self.confirm_remove = None;
            }
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
        self.read = None;
        self.dirty = true;
        self.feedback_error = None;
        self.add_open = false;
        self.add_spec = TextEdit::new("");
        self.add_error = None;
        self.add_info_open = false;
        self.confirm_remove = None;
        if let Some(backend) = &mut self.backend {
            backend.session_directory = None;
        }
    }

    pub(super) fn invalidate(&mut self, directory: Option<&str>) {
        let matches = directory.is_none_or(|dir| {
            self.snapshot
                .as_ref()
                .is_none_or(|snap| codenomad_client::same_server_path(&snap.directory, dir))
        });
        if matches {
            self.dirty = true;
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
            }
        }
    }

    pub(super) fn toggle_section(&mut self) {
        self.expanded = !self.expanded;
        self.add_info_open = false;
        if self.expanded {
            self.dirty = true;
        } else {
            self.read = None;
            self.confirm_remove = None;
        }
    }

    pub(super) fn request_refresh(&mut self) {
        if !self.online || self.reading() || self.write_active {
            return;
        }
        self.failed = false;
        self.feedback_error = None;
        self.dirty = true;
    }

    pub(super) fn open_add(&mut self) {
        self.add_open = !self.add_open;
        self.add_spec = TextEdit::new("");
        self.add_scope = Scope::Global;
        self.add_error = None;
        self.add_info_open = false;
        self.confirm_remove = None;
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

    pub(super) fn request_remove_confirm(&mut self, removal: RemovalTarget) {
        if self.mutations_locked() {
            return;
        }
        self.add_open = false;
        self.feedback_error = None;
        self.confirm_remove = Some(removal);
    }

    pub(super) fn cancel_remove_confirm(&mut self) {
        self.confirm_remove = None;
    }

    pub(super) fn reading(&self) -> bool {
        self.read.is_some()
    }

    pub(super) fn mutations_locked(&self) -> bool {
        !self.online || self.write_active || self.write_unconfirmed
    }

    pub(super) fn package_busy(&self, target: &str) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|b| barrier::is_active(&Kind::PluginPackage(target.to_owned()), &b.base))
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
        let Some(guard) =
            barrier::try_begin(Kind::Plugins, &backend.base, self.observer, wake.clone())
        else {
            self.write_active = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.feedback_error = None;
        self.confirm_remove = None;
        self.write_active = true;
        let (tx, rx) = bounded(1);
        let id = guard.id();
        self.pending_activation = Some(PendingActivation {
            id,
            name: plugin_id.clone(),
            scope,
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
        let Some(guard) =
            barrier::try_begin(Kind::Plugins, &backend.base, self.observer, wake.clone())
        else {
            self.write_active = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.add_error = None;
        self.feedback_error = None;
        self.write_active = true;
        self.pending_add = Some(PendingAdd {
            base: backend.base.clone(),
            id: guard.id(),
            scope,
        });
        platform::spawn(async move {
            let outcome = plugins::add_source(&backend, &directory, scope, &spec)
                .await
                .map(|_| ());
            guard.finish(outcome);
        });
    }

    pub(super) fn confirm_and_remove(&mut self, wake: &rune::Waker) {
        if self.mutations_locked() || !self.visible || !self.expanded {
            return;
        }
        let Some(removal) = self.confirm_remove.take() else {
            return;
        };
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
        let Some(guard) =
            barrier::try_begin(Kind::Plugins, &backend.base, self.observer, wake.clone())
        else {
            self.write_active = true;
            return;
        };
        self.read = None;
        self.dirty = false;
        self.feedback_error = None;
        self.write_active = true;
        self.pending_remove = Some(PendingRemove {
            base: backend.base.clone(),
            id: guard.id(),
            removal: removal.clone(),
        });
        platform::spawn(async move {
            let outcome = plugins::remove_source(&backend, &directory, &removal).await;
            guard.finish(outcome);
        });
    }

    pub(super) fn run_package(&mut self, target: String, update: bool, wake: &rune::Waker) {
        if self.mutations_locked() || !self.visible || !self.expanded {
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
        let Some(guard) = barrier::try_begin(
            Kind::PluginPackage(target.clone()),
            &backend.base,
            self.observer,
            wake.clone(),
        ) else {
            return;
        };
        self.feedback_error = None;
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

    pub(super) fn poll(&mut self, reads: &platform::reads::Reads, wake: &rune::Waker) -> bool {
        let mut changed = self.poll_writes(wake);
        if let Some(backend) = &self.backend {
            let obs = barrier::observe(&Kind::Plugins, &backend.base, self.observer, wake);
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
                let newly_settled = obs.settled_id != 0 && self.seen_settled_id != obs.settled_id;
                if newly_settled {
                    self.seen_settled_id = obs.settled_id;
                    if self.pending_activation.is_none()
                        && self.pending_add.is_none()
                        && self.pending_remove.is_none()
                    {
                        self.dirty = true;
                    }
                    changed = true;
                } else if was_writing {
                    changed = true;
                }
            }
        }

        if let Some((_, rx)) = &self.read {
            match rx.try_recv() {
                Ok(outcome) => {
                    self.read = None;
                    if !self.dirty && !self.write_active {
                        match outcome {
                            ReadOutcome::Snapshot(snap) => {
                                self.reconcile_confirm_remove(&snap);
                                self.snapshot = Some(snap);
                                self.unsupported = false;
                                self.failed = false;
                                self.write_unconfirmed = false;
                            }
                            ReadOutcome::Unsupported => {
                                self.snapshot = None;
                                self.unsupported = true;
                                self.failed = false;
                                self.write_unconfirmed = false;
                                self.confirm_remove = None;
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
            && let Some(backend) = self.backend.clone()
        {
            let (cancel, cancelled) = bounded(1);
            let (out, rx) = bounded(1);
            self.dirty = false;
            self.read = Some((cancel, rx));
            let (reads, wake) = (reads.clone(), wake.clone());
            platform::spawn(async move {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, plugins::load(&backend, None)).await
                {
                    let outcome = match result {
                        Ok(Some(snap)) => ReadOutcome::Snapshot(snap),
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
                self.seen_settled_id = self.seen_settled_id.max(pending.id);
                match outcome {
                    Ok(snap) => {
                        self.reconcile_confirm_remove(&snap);
                        self.snapshot = Some(snap);
                        self.write_unconfirmed = false;
                        self.failed = false;
                        self.feedback_error = None;
                    }
                    Err(err) => {
                        let scope_label = t(pending.scope.i18n_key());
                        self.feedback_error = Some(
                            t(err.activation_i18n_key())
                                .replace("{name}", &pending.name)
                                .replace("{scope}", scope_label),
                        );
                        self.write_unconfirmed = true;
                        self.dirty = true;
                    }
                }
                changed = true;
            }
        }

        if let Some(pending) = &self.pending_add
            && let Some(outcome) = barrier::result(&Kind::Plugins, &pending.base, pending.id)
        {
            let pending = self.pending_add.take().unwrap();
            self.seen_settled_id = self.seen_settled_id.max(pending.id);
            match outcome {
                Ok(()) => {
                    self.add_open = false;
                    self.add_spec = TextEdit::new("");
                    self.add_error = None;
                    self.write_unconfirmed = true;
                    self.dirty = true;
                }
                Err(err) => {
                    let scope_label = t(pending.scope.i18n_key());
                    let global_label = t(Scope::Global.i18n_key());
                    self.add_error = Some(
                        t(err.add_source_i18n_key())
                            .replace("{scope}", scope_label)
                            .replace("{global}", global_label),
                    );
                    let definite_rejection = matches!(
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
                    if !definite_rejection {
                        self.dirty = true;
                    }
                }
            }
            changed = true;
        }

        if let Some(pending) = &self.pending_remove
            && let Some(outcome) = barrier::result(&Kind::Plugins, &pending.base, pending.id)
        {
            let pending = self.pending_remove.take().unwrap();
            self.seen_settled_id = self.seen_settled_id.max(pending.id);
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

    fn reconcile_confirm_remove(&mut self, snap: &Snapshot) {
        let Some(confirm) = &self.confirm_remove else {
            return;
        };
        let still_valid = snap
            .controls
            .iter()
            .flat_map(|c| snap.removable_for_control(c))
            .chain(
                snap.unmatched_sources()
                    .into_iter()
                    .flat_map(|s| snap.removable_for_target(&s.target)),
            )
            .any(|candidate| candidate == *confirm);
        if !still_valid {
            self.confirm_remove = None;
        }
    }
}
