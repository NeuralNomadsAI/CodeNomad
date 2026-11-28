use super::{
    Target,
    write_barrier::{self, Domain},
};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::websearch::{self, Scope, SearchIntegration, Selection, Snapshot},
};
use rune::Waker;

mod view;
pub(super) use view::view;

type ScopeKey = (String, String, Option<String>);

#[derive(Clone)]
struct LiveTarget {
    backend: Backend,
    workspace: String,
    wake: Waker,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteKind {
    Connect,
    Other,
}

struct OwnedWrite {
    base: String,
    id: u64,
    kind: WriteKind,
}

enum WriteOp {
    Connect { integration_id: String, key: String },
    Remove { credential_id: String },
    SaveScope { scope: Scope, selection: Selection },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Picker {
    Provider,
    Scope(Scope),
}

pub(super) struct WebSearch {
    observer: u64,
    expanded: bool,
    scope_id: Option<ScopeKey>,
    authority: u64,
    seen: Option<u64>,
    seen_location: Option<u64>,
    live: Option<LiveTarget>,
    read_flight: Option<(Sender<()>, Receiver<Option<Snapshot>>)>,
    owned_write: Option<OwnedWrite>,
    write_active: bool,
    seen_settled_id: Option<u64>,
    trailing: bool,
    keep_error: bool,
    stale_after_write: bool,
    snapshot: Option<Snapshot>,
    error: bool,
    selected_id: String,
    active_id: String,
    #[cfg(not(target_arch = "wasm32"))]
    wipe_external_key: bool,
    open_picker: Option<Picker>,
    global_info_open: bool,
}

impl Default for WebSearch {
    fn default() -> Self {
        Self {
            observer: write_barrier::next_observer(),
            expanded: false,
            scope_id: None,
            authority: 0,
            seen: None,
            seen_location: None,
            live: None,
            read_flight: None,
            owned_write: None,
            write_active: false,
            seen_settled_id: None,
            trailing: false,
            keep_error: false,
            stale_after_write: false,
            snapshot: None,
            error: false,
            selected_id: String::new(),
            active_id: String::new(),
            #[cfg(not(target_arch = "wasm32"))]
            wipe_external_key: false,
            open_picker: None,
            global_info_open: false,
        }
    }
}

impl WebSearch {
    pub fn toggle(&mut self) {
        self.expanded = !self.expanded;
        self.open_picker = None;
        if !self.expanded {
            self.reset_read_state(true);
        }
        if let Some(live) = &self.live {
            (live.wake)();
        }
    }

    pub fn suspend(&mut self) -> bool {
        let changed = self.live.is_some()
            || self.write_active
            || self.seen_settled_id.is_some()
            || self.scope_id.is_some()
            || self.read_flight.is_some()
            || self.snapshot.is_some()
            || self.error
            || self.open_picker.is_some()
            || !self.selected_id.is_empty()
            || !self.active_id.is_empty();
        self.live = None;
        self.write_active = false;
        self.seen_settled_id = None;
        self.reset_read_state(true);
        changed
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn take_wipe_key(&mut self) -> bool {
        std::mem::take(&mut self.wipe_external_key)
    }

    fn reset_read_state(&mut self, wipe_form: bool) {
        self.scope_id = None;
        self.authority = 0;
        self.seen = None;
        self.seen_location = None;
        self.read_flight = None;
        self.trailing = false;
        self.keep_error = false;
        self.stale_after_write = false;
        self.snapshot = None;
        self.error = false;
        self.open_picker = None;
        if wipe_form {
            self.selected_id.clear();
            self.active_id.clear();
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.wipe_external_key = true;
            }
        }
    }

    fn drain_owned_write(&mut self) -> bool {
        let Some(owned) = &self.owned_write else {
            return false;
        };
        let Some(ok) = write_barrier::settled_status(Domain::WebSearch, &owned.base, owned.id)
        else {
            return false;
        };
        let owned = self.owned_write.take().unwrap();
        if ok && owned.kind == WriteKind::Connect {
            self.active_id.clear();
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.wipe_external_key = true;
            }
        }
        true
    }

    pub fn poll(&mut self, target: Option<&Target>, wake: Option<&Waker>) -> bool {
        let Some((target, wake)) = target.zip(wake).filter(|(target, _)| target.online()) else {
            let mut changed = self.snapshot.is_some()
                || self.read_flight.is_some()
                || self.error
                || self.write_active;
            self.live = None;
            self.write_active = false;
            self.seen_settled_id = None;
            self.reset_read_state(true);
            changed |= self.drain_owned_write();
            return changed;
        };

        let next_live = LiveTarget {
            backend: target.backend.clone(),
            workspace: target.workspace.clone(),
            wake: wake.clone(),
        };
        let mut changed = self.drain_owned_write();
        let obs = write_barrier::observe(
            Domain::WebSearch,
            &target.backend.base,
            &target.workspace,
            self.observer,
            self.expanded,
            wake,
        );

        if !self.expanded {
            let had_data = self.snapshot.is_some()
                || self.read_flight.is_some()
                || self.error
                || self.write_active != obs.active;
            self.live = Some(next_live);
            self.write_active = obs.active;
            self.seen_settled_id = None;
            if had_data {
                self.reset_read_state(true);
                changed = true;
            }
            return changed;
        }

        let scope_changed = self
            .scope_id
            .as_ref()
            .is_none_or(|(client, workspace, session)| {
                client != &target.backend.client_id
                    || workspace != &target.workspace
                    || session != &target.session
            })
            || self.authority != target.provider_authority();
        if scope_changed {
            self.reset_read_state(true);
            self.scope_id = Some((
                target.backend.client_id.clone(),
                target.workspace.clone(),
                target.session.clone(),
            ));
            self.authority = target.provider_authority();
            self.seen_location = Some(target.location_epoch());
            self.seen_settled_id = Some(obs.settled_id);
            changed = true;
        }
        self.live = Some(next_live);

        let target_location = target.location_epoch();
        if self.seen_location != Some(target_location) {
            self.seen_location = Some(target_location);
            if self.snapshot.is_some() {
                self.stale_after_write = true;
            }
            self.read_flight = None;
            self.trailing = true;
            self.open_picker = None;
            self.active_id.clear();
            #[cfg(not(target_arch = "wasm32"))]
            {
                self.wipe_external_key = true;
            }
            changed = true;
        }

        if obs.active {
            if !self.write_active {
                self.write_active = true;
                changed = true;
            }
            if self.read_flight.take().is_some() {
                changed = true;
            }
            self.trailing = true;
        } else {
            let was_writing = std::mem::take(&mut self.write_active);
            let newly_settled = obs.settled_id != 0
                && self
                    .seen_settled_id
                    .is_some_and(|seen| seen != obs.settled_id);
            if was_writing || newly_settled {
                self.seen_settled_id = Some(obs.settled_id);
                self.stale_after_write = true;
                self.read_flight = None;
                self.trailing = true;
                changed = true;
            }
            if obs.unseen_error {
                self.keep_error = true;
                self.error = true;
                changed = true;
            }
        }

        let target_rev = target.revision();
        if self.seen != Some(target_rev) {
            self.seen = Some(target_rev);
            self.trailing = true;
        }

        if let Some((_, rx)) = &self.read_flight {
            match rx.try_recv() {
                Ok(result) => {
                    self.read_flight = None;
                    if !self.trailing && !self.write_active {
                        match result {
                            Some(snapshot) => {
                                self.snapshot = Some(snapshot);
                                self.stale_after_write = false;
                                self.error = self.keep_error;
                            }
                            None => self.error = true,
                        }
                        self.keep_error = false;
                    }
                    changed = true;
                }
                Err(_) if rx.is_closed() => {
                    self.read_flight = None;
                    if !self.trailing && !self.write_active {
                        self.error = true;
                        self.keep_error = false;
                    }
                    changed = true;
                }
                Err(_) => {}
            }
        }

        if self.trailing && self.read_flight.is_none() && !self.write_active {
            self.trailing = false;
            self.spawn_read(target, wake);
            changed = true;
        }
        changed
    }

    fn busy(&self) -> bool {
        self.read_flight.is_some() || self.write_active
    }

    fn mutations_disabled(&self) -> bool {
        self.write_active || self.stale_after_write
    }

    fn spawn_read(&mut self, target: &Target, wake: &Waker) {
        let (cancel, cancelled) = bounded(1);
        let (out, rx) = bounded(1);
        self.read_flight = Some((cancel, rx));
        let (backend, workspace, session, wake) = (
            target.backend.clone(),
            target.workspace.clone(),
            target.session.clone(),
            wake.clone(),
        );
        platform::spawn(async move {
            if let Some(result) = platform::reads::cancellable(
                &cancelled,
                websearch::load(&backend, &workspace, session.as_deref()),
            )
            .await
                && out.send(result.ok()).await.is_ok()
            {
                wake();
            }
        });
    }

    fn request_refresh(&mut self) {
        let Some(live) = &self.live else {
            return;
        };
        if self.busy() {
            return;
        }
        write_barrier::clear_unseen_error(Domain::WebSearch, &live.backend.base, &live.workspace);
        self.keep_error = false;
        self.error = false;
        self.trailing = true;
        (live.wake)();
    }

    fn start_write(&mut self, kind: WriteKind, op: WriteOp) {
        if self.mutations_disabled() {
            return;
        }
        let Some(live) = self.live.clone() else {
            return;
        };
        let Some(directory) = self.snapshot.as_ref().map(|s| s.directory.clone()) else {
            return;
        };
        let Some(guard) = write_barrier::try_begin(
            Domain::WebSearch,
            &live.backend.base,
            &live.workspace,
            self.observer,
            live.wake.clone(),
        ) else {
            self.write_active = true;
            return;
        };
        self.read_flight = None;
        self.trailing = false;
        self.keep_error = false;
        self.error = false;
        self.open_picker = None;
        self.write_active = true;
        self.owned_write = Some(OwnedWrite {
            base: live.backend.base.clone(),
            id: guard.id(),
            kind,
        });
        platform::spawn(async move {
            let ok = match op {
                WriteOp::Connect {
                    integration_id,
                    key,
                } => websearch::connect_key(
                    &live.backend,
                    &live.workspace,
                    &directory,
                    &integration_id,
                    &key,
                )
                .await
                .is_ok(),
                WriteOp::Remove { credential_id } => websearch::remove_credential(
                    &live.backend,
                    &live.workspace,
                    &directory,
                    &credential_id,
                )
                .await
                .is_ok(),
                WriteOp::SaveScope { scope, selection } => websearch::save_default(
                    &live.backend,
                    &live.workspace,
                    &directory,
                    scope,
                    &selection,
                )
                .await
                .is_ok(),
            };
            guard.finish(ok);
        });
    }

    fn connect(&mut self, integration_id: String, key: String) {
        if key.trim().is_empty() {
            return;
        }
        self.start_write(
            WriteKind::Connect,
            WriteOp::Connect {
                integration_id,
                key,
            },
        );
    }

    fn remove(&mut self, credential_id: String) {
        self.start_write(WriteKind::Other, WriteOp::Remove { credential_id });
    }

    fn save_scope(&mut self, scope: Scope, selection: Selection) {
        self.start_write(WriteKind::Other, WriteOp::SaveScope { scope, selection });
    }

    fn selected_integration(&self) -> Option<&SearchIntegration> {
        let integrations = &self.snapshot.as_ref()?.integrations;
        integrations
            .iter()
            .find(|item| item.id == self.selected_id)
            .or_else(|| integrations.first())
    }

    fn active_integration(&self) -> Option<&SearchIntegration> {
        let integrations = &self.snapshot.as_ref()?.integrations;
        integrations.iter().find(|item| item.id == self.active_id)
    }

    fn selection_label(&self, selection: &Selection) -> String {
        match selection {
            Selection::Default => t("settings.websearch.default").to_owned(),
            Selection::Off => t("settings.websearch.off").to_owned(),
            Selection::Provider(id) if id == "random" => t("settings.websearch.random").to_owned(),
            Selection::Provider(id) => self
                .snapshot
                .as_ref()
                .and_then(|s| s.providers.iter().find(|p| p.id == *id))
                .map(|p| p.name.clone())
                .unwrap_or_else(|| id.clone()),
        }
    }

    #[cfg(test)]
    pub(super) fn is_expanded(&self) -> bool {
        self.expanded
    }

    #[cfg(test)]
    pub(super) fn has_snapshot(&self) -> bool {
        self.snapshot.is_some()
    }

    #[cfg(test)]
    pub(super) fn is_idle(&self) -> bool {
        !self.busy() && !self.trailing
    }
}
