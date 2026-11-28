mod accounts;
mod form;
mod images;
mod manager;
mod modal;
#[cfg(test)]
mod tests;
mod websearch;

#[cfg(not(target_arch = "wasm32"))]
use super::view::Window;
use crate::{State, backend::Backend};
use codenomad_client::stream::{CatalogueChanges, ProviderMoves, SessionCatalogueChanges};
use rune::{El, TextEdit, col};
use rune_theme_codenomad::{Space, layout::Layout};
use std::{cell::RefCell, rc::Rc};

pub(super) struct Target {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    owned_tab: bool,
    revision: u64,
    mission_catalog: u64,
    location_epoch: u64,
    observed: Option<u64>,
    observed_location_revision: u64,
    observed_upstream_healthy: bool,
    authority: u64,
    native_authority: u64,
    online: bool,
    native_online: bool,
    stats: [u64; 2],
    stats_status: Option<(bool, Option<u64>)>,
    integrations: u64,
    integrations_session: u64,
}

impl Target {
    pub fn capture(s: &State) -> Option<Self> {
        let (backend, workspace, session, owned_tab, observed, host_online, native_online) =
            if let Some(l) = s.screen.launcher() {
                let backend = l.connection.clone()?;
                let workspace = l.project.as_ref()?.id.clone();
                let session = crate::workspace::active_session(s).map(str::to_owned);
                let (observed, host_online) = match l.catalogue_watch.as_ref() {
                    Some(watch) => {
                        let generation = watch.generation();
                        (Some(generation), generation % 2 == 1)
                    }
                    None => (None, true),
                };
                let native_online = l
                    .catalogue_watch
                    .as_ref()
                    .and_then(|watch| watch.native_connected(&workspace))
                    .unwrap_or(true);
                (
                    backend,
                    workspace,
                    session,
                    true,
                    observed,
                    host_online,
                    native_online,
                )
            } else {
                let backend = super::bound_backend(s)?;
                let (workspace, session) = (backend.workspace.clone(), backend.session.clone());
                let prefs = s.settings.shared.borrow();
                let transport_lost = prefs.is_transport_lost();
                let host_online = if s.incoming.is_some()
                    || s.conversation_client_id.is_some()
                    || s.stream_offline
                    || s.phase.reconnecting()
                    || s.phase == crate::Phase::Failed
                {
                    s.conversation_stream_connected
                        && !s.stream_offline
                        && !s.phase.reconnecting()
                        && s.phase != crate::Phase::Failed
                        && !transport_lost
                } else {
                    !transport_lost
                };
                let native_online = prefs.is_native_stream_online(&workspace);
                (
                    backend,
                    workspace,
                    (!session.is_empty()).then_some(session),
                    false,
                    None,
                    host_online,
                    native_online,
                )
            };
        let (observed_location_revision, observed_upstream_healthy) = backend
            .client
            .location_state(&workspace, session.as_deref());
        Some(Self {
            backend,
            workspace,
            session,
            owned_tab,
            revision: 0,
            mission_catalog: 0,
            location_epoch: 0,
            observed,
            observed_location_revision,
            observed_upstream_healthy,
            authority: 0,
            native_authority: 0,
            online: host_online,
            native_online,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        })
    }

    pub fn validate(
        &mut self,
        s: &State,
        current: Option<&Backend>,
        changes: &CatalogueChanges,
        moves: &ProviderMoves,
        stopped: &CatalogueChanges,
        generation: Option<u64>,
    ) -> bool {
        let exists = (!self.owned_tab || crate::workspace::contains_project(s, &self.workspace))
            && !self.matches(stopped);
        let current = current.filter(|current| {
            current.base == self.backend.base
                && (current.client.same_connection(&self.backend.client)
                    || current.client.server_identity().is_some()
                        && current.client.server_identity()
                            == self.backend.client.server_identity())
        });
        let Some(current) = current.filter(|_| exists) else {
            return false;
        };
        if !self.backend.client.same_connection(&current.client) {
            self.backend = current.clone();
            self.observed = None;
            let (rev, healthy) = self
                .backend
                .client
                .location_state(&self.workspace, self.session.as_deref());
            self.observed_location_revision = rev;
            self.observed_upstream_healthy = healthy;
            self.native_online = true;
            self.authority = self.authority.wrapping_add(1);
        } else if self.matches(changes) {
            self.invalidate();
        }
        match moves {
            ProviderMoves::None => {}
            ProviderMoves::All => {
                self.authority = self.authority.wrapping_add(1);
                self.invalidate_location();
            }
            ProviderMoves::Sessions(entries) => {
                for (workspace, session) in entries {
                    if self.session_moved(workspace, session) {
                        break;
                    }
                }
            }
        }
        if let Some(generation) = generation
            && self.observed != Some(generation)
        {
            self.observed = Some(generation);
            self.transport(generation % 2 == 1);
            self.authority = self.authority.wrapping_add(1);
        }
        true
    }

    pub fn transport(&mut self, online: bool) {
        if self.online != online {
            self.online = online;
            if online {
                self.native_online = true;
            }
            self.authority = self.authority.wrapping_add(1);
            self.invalidate_location();
        }
    }

    pub fn native_transport(&mut self, connected: bool) -> bool {
        if self.native_online != connected {
            self.native_online = connected;
            self.native_authority = self.native_authority.wrapping_add(1);
            self.invalidate_location();
            true
        } else {
            false
        }
    }

    pub(super) fn authority(&self) -> u64 {
        self.authority
    }

    pub(super) fn provider_authority(&self) -> u64 {
        self.authority.wrapping_add(self.native_authority)
    }

    pub(super) fn observe_native_status(&mut self, status: Option<(bool, Option<u64>)>) -> bool {
        status.is_some_and(|(connected, _)| self.native_transport(connected))
    }

    pub fn online(&self) -> bool {
        self.online && self.native_online
    }

    pub(super) fn host_online(&self) -> bool {
        self.online
    }

    pub(super) fn stats_source(&self) -> (&Backend, &str, u64, [u64; 2]) {
        (&self.backend, &self.workspace, self.authority, self.stats)
    }

    pub(super) fn stats_status(&self) -> Option<(bool, Option<u64>)> {
        self.stats_status
    }

    pub(super) fn stats_catalogue(
        &mut self,
        changes: &[CatalogueChanges; 2],
        status: Option<(bool, Option<u64>)>,
    ) -> bool {
        let mut changed = std::mem::replace(&mut self.stats_status, status) != status;
        for (index, lane) in changes.iter().enumerate() {
            if self.matches(lane) {
                self.stats[index] = self.stats[index].wrapping_add(1);
                changed = true;
            }
        }
        changed
    }

    pub(super) fn stats_hint(&mut self, workspace: &str, urgent: bool) {
        if self.is_workspace(workspace) {
            let counter = &mut self.stats[usize::from(!urgent)];
            *counter = counter.wrapping_add(1);
        }
    }

    pub(super) fn backend(&self) -> &Backend {
        &self.backend
    }

    pub(super) fn integrations_source(
        &self,
    ) -> (&Backend, &str, Option<&str>, u64, u64, u64, bool) {
        (
            &self.backend,
            &self.workspace,
            self.session.as_deref(),
            self.authority,
            self.integrations,
            self.integrations_session,
            self.online,
        )
    }

    pub(super) fn integrations_catalogue(
        &mut self,
        changes: &CatalogueChanges,
        session_changes: &SessionCatalogueChanges,
    ) -> bool {
        let mut changed = false;
        if self.matches(changes) {
            self.integrations = self.integrations.wrapping_add(1);
            changed = true;
        }
        let session_matched = match session_changes {
            SessionCatalogueChanges::None => false,
            SessionCatalogueChanges::All => true,
            SessionCatalogueChanges::Sessions(pairs) => self
                .session
                .as_ref()
                .is_some_and(|ses| pairs.contains(&(self.workspace.clone(), ses.clone()))),
        };
        if session_matched {
            self.integrations_session = self.integrations_session.wrapping_add(1);
            changed = true;
        }
        changed
    }

    pub(super) fn integrations_hint(&mut self, workspace: &str, session: Option<&str>) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        match session {
            None => {
                self.integrations = self.integrations.wrapping_add(1);
                true
            }
            Some(ses) if self.session.as_deref() == Some(ses) => {
                self.integrations_session = self.integrations_session.wrapping_add(1);
                true
            }
            Some(_) => false,
        }
    }

    pub(super) fn location(&self) -> (&str, Option<&str>) {
        (&self.workspace, self.session.as_deref())
    }

    pub fn revision(&self) -> u64 {
        self.provider_authority().wrapping_add(self.revision)
    }

    pub(super) fn sync_location_state(&mut self) -> bool {
        let (rev, healthy) = self
            .backend
            .client
            .location_state(&self.workspace, self.session.as_deref());
        let changed =
            self.observed_location_revision != rev || self.observed_upstream_healthy != healthy;
        self.observed_location_revision = rev;
        self.observed_upstream_healthy = healthy;
        changed
    }

    pub(super) fn mission_catalog_revision(&self) -> u64 {
        self.revision().wrapping_add(self.mission_catalog)
    }

    pub(super) fn mission_catalog_catalogue(&mut self, changes: &CatalogueChanges) -> bool {
        if !self.matches(changes) {
            return false;
        }
        self.mission_catalog = self.mission_catalog.wrapping_add(1);
        true
    }

    pub(super) fn mission_catalog_hint(&mut self, workspace: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        self.mission_catalog = self.mission_catalog.wrapping_add(1);
        true
    }

    pub fn location_epoch(&self) -> u64 {
        self.location_epoch
    }

    pub(super) fn matches(&self, changes: &CatalogueChanges) -> bool {
        match changes {
            CatalogueChanges::None => false,
            CatalogueChanges::All => true,
            CatalogueChanges::Workspaces(ids) => ids.contains(&self.workspace),
        }
    }

    pub fn is_workspace(&self, workspace: &str) -> bool {
        self.workspace == workspace
    }

    pub fn hint(&mut self, workspace: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        self.invalidate();
        true
    }

    pub(super) fn invalidate_location(&mut self) {
        self.location_epoch = self.location_epoch.wrapping_add(1);
        self.invalidate();
    }

    pub fn session_moved(&mut self, workspace: &str, session: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        if !session.is_empty() && self.session.as_deref() != Some(session) {
            return false;
        }
        self.authority = self.authority.wrapping_add(1);
        self.invalidate_location();
        true
    }
    fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    #[cfg(test)]
    pub(super) fn fixture(backend: Backend, workspace: &str, session: Option<&str>) -> Self {
        let observed_location_revision = backend.client.location_revision(workspace, session);
        let observed_upstream_healthy = backend.client.workspace_upstream_healthy(workspace);
        Self {
            backend,
            workspace: workspace.to_owned(),
            session: session.map(str::to_owned),
            owned_tab: false,
            revision: 0,
            mission_catalog: 0,
            location_epoch: 0,
            observed: None,
            observed_location_revision,
            observed_upstream_healthy,
            authority: 0,
            native_authority: 0,
            online: true,
            native_online: true,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        }
    }
}

pub(super) struct Catalog {
    manager: manager::Manager,
    websearch: Rc<RefCell<websearch::WebSearch>>,
    images: Rc<RefCell<images::Images>>,
    #[cfg(not(target_arch = "wasm32"))]
    websearch_key: TextEdit,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            manager: manager::Manager::default(),
            websearch: Rc::new(RefCell::new(websearch::WebSearch::default())),
            images: Rc::new(RefCell::new(images::Images::default())),
            #[cfg(not(target_arch = "wasm32"))]
            websearch_key: TextEdit::new(""),
        }
    }
}

impl Catalog {
    pub fn poll<S: 'static>(
        &mut self,
        target: Option<&Target>,
        now: f64,
        wake: Option<&rune::Waker>,
        tx: &mut rune::Tx,
        visible: bool,
        access: fn(&mut S) -> &mut Catalog,
    ) -> bool {
        let mut changed = self.manager.poll(target, now, wake, tx, visible, access);
        changed |= self.websearch.borrow_mut().poll(target, wake);
        #[cfg(not(target_arch = "wasm32"))]
        if self.websearch.borrow_mut().take_wipe_key() {
            self.websearch_key = TextEdit::new("");
        }
        changed |= self.images.borrow_mut().poll(target, wake);
        changed
    }

    pub fn toggle(&mut self) {
        self.manager.toggle();
    }

    pub fn suspend(&mut self) {
        self.manager.suspend();
        let _ = self.websearch.borrow_mut().suspend();
        let _ = self.images.borrow_mut().suspend();
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = self.websearch.borrow_mut().take_wipe_key();
            self.websearch_key = TextEdit::new("");
        }
    }

    pub fn cancel_on_hide(&mut self) -> bool {
        let mut changed = self.manager.cancel_on_hide();
        changed |= self.websearch.borrow_mut().suspend();
        changed |= self.images.borrow_mut().suspend();
        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = self.websearch.borrow_mut().take_wipe_key();
            if !self.websearch_key.text.is_empty() {
                self.websearch_key = TextEdit::new("");
                changed = true;
            }
        }
        changed
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn dismiss_modal(&mut self, tx: &mut rune::Tx) -> bool {
        self.manager.dismiss_modal(tx)
    }

    #[cfg(test)]
    pub(super) fn models_expanded(&self) -> bool {
        self.manager.expanded
    }

    #[cfg(test)]
    pub(super) fn models_settled(&self) -> bool {
        self.manager.settled()
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn view(s: &Window, available: bool, layers: &mut Vec<El>) -> El {
    render_groups(
        &s.providers,
        available,
        layers,
        |s: &mut Window| &mut s.providers,
        Some(&s.providers.websearch_key),
        Some(|s: &mut Window| &mut s.providers.websearch_key),
    )
}

pub(super) fn content<S: 'static>(
    catalog: &Catalog,
    available: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    render_groups(catalog, available, layers, access, None, None)
}

fn render_groups<S: 'static>(
    catalog: &Catalog,
    available: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
    external_key: Option<&TextEdit>,
    edit_key: Option<fn(&mut S) -> &mut TextEdit>,
) -> El {
    col()
        .full_width()
        .separate(Space::Md)
        .child(manager::Manager::view(catalog, available, layers, access))
        .child(websearch::view::<S>(
            &catalog.websearch,
            available,
            external_key,
            edit_key,
        ))
        .child(images::view::<S>(&catalog.images, available))
}

pub(super) fn attach_picker_keys<S: 'static>(
    list: El,
    trigger_key: String,
    option_keys: Vec<String>,
    close: impl Fn(&mut S) + 'static,
) -> El {
    list.focus_group().on_key(move |s: &mut S, event, tx| {
        if event.key == rune::Key::Tab && !event.mods.ctrl && !event.mods.alt && !event.mods.cmd {
            close(s);
            return false;
        }
        if event.mods != rune::Mods::default() || option_keys.is_empty() {
            return false;
        }
        let current = tx
            .focused()
            .and_then(|focused| option_keys.iter().position(|key| key == focused));
        let next = match event.key {
            rune::Key::Down => Some(current.map_or(0, |index| (index + 1) % option_keys.len())),
            rune::Key::Up => Some(current.map_or(option_keys.len() - 1, |index| {
                (index + option_keys.len() - 1) % option_keys.len()
            })),
            rune::Key::Home => Some(0),
            rune::Key::End => Some(option_keys.len() - 1),
            rune::Key::Escape => {
                close(s);
                tx.focus(trigger_key.clone(), true);
                return true;
            }
            _ => None,
        };
        if let Some(index) = next {
            tx.focus(option_keys[index].clone(), true);
            return true;
        }
        false
    })
}

pub(super) mod write_barrier {
    use rune::Waker;
    use std::{
        collections::{HashMap, HashSet, VecDeque},
        sync::{
            Mutex, OnceLock,
            atomic::{AtomicU64, Ordering},
        },
    };

    const MAX_RESULTS: usize = 32;

    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    pub(in crate::settings::providers) enum Domain {
        WebSearch,
        Images,
    }

    struct InFlight {
        id: u64,
        workspace: String,
        waiters: HashMap<u64, Waker>,
    }

    #[derive(Default)]
    struct Entry {
        in_flight: Option<InFlight>,
        settled_id: u64,
        results: VecDeque<(u64, bool)>,
        unseen_errors: HashSet<String>,
    }

    pub(in crate::settings::providers) struct Observation {
        pub active: bool,
        pub settled_id: u64,
        pub unseen_error: bool,
    }

    pub(in crate::settings::providers) struct Guard {
        domain: Domain,
        base: String,
        id: u64,
        settled: bool,
    }

    impl Guard {
        pub fn id(&self) -> u64 {
            self.id
        }

        pub fn finish(mut self, ok: bool) {
            self.settled = true;
            complete(self.domain, &self.base, self.id, ok);
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            if !self.settled {
                complete(self.domain, &self.base, self.id, false);
            }
        }
    }

    fn registry() -> &'static Mutex<HashMap<(Domain, String), Entry>> {
        static REGISTRY: OnceLock<Mutex<HashMap<(Domain, String), Entry>>> = OnceLock::new();
        REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn next_id() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    pub(in crate::settings::providers) fn next_observer() -> u64 {
        next_id()
    }

    pub(in crate::settings::providers) fn try_begin(
        domain: Domain,
        base: &str,
        workspace: &str,
        observer: u64,
        wake: Waker,
    ) -> Option<Guard> {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry((domain, base.to_owned())).or_default();
        if entry.in_flight.is_some() {
            return None;
        }
        let id = next_id();
        entry.unseen_errors.remove(workspace);
        let mut waiters = HashMap::new();
        waiters.insert(observer, wake);
        entry.in_flight = Some(InFlight {
            id,
            workspace: workspace.to_owned(),
            waiters,
        });
        Some(Guard {
            domain,
            base: base.to_owned(),
            id,
            settled: false,
        })
    }

    pub(in crate::settings::providers) fn observe(
        domain: Domain,
        base: &str,
        workspace: &str,
        observer: u64,
        expanded: bool,
        wake: &Waker,
    ) -> Observation {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(&(domain, base.to_owned())) else {
            return Observation {
                active: false,
                settled_id: 0,
                unseen_error: false,
            };
        };
        if let Some(active) = &mut entry.in_flight {
            active.waiters.insert(observer, wake.clone());
        }
        let unseen_error =
            expanded && entry.in_flight.is_none() && entry.unseen_errors.remove(workspace);
        Observation {
            active: entry.in_flight.is_some(),
            settled_id: entry.settled_id,
            unseen_error,
        }
    }

    pub(in crate::settings::providers) fn settled_status(
        domain: Domain,
        base: &str,
        id: u64,
    ) -> Option<bool> {
        let map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(&(domain, base.to_owned()))?;
        if entry
            .in_flight
            .as_ref()
            .is_some_and(|active| active.id == id)
        {
            return None;
        }
        if let Some((_, ok)) = entry.results.iter().find(|(entry_id, _)| *entry_id == id) {
            return Some(*ok);
        }
        (entry.settled_id >= id).then_some(false)
    }

    pub(in crate::settings::providers) fn clear_unseen_error(
        domain: Domain,
        base: &str,
        workspace: &str,
    ) {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&(domain, base.to_owned())) {
            entry.unseen_errors.remove(workspace);
        }
    }

    fn complete(domain: Domain, base: &str, id: u64, ok: bool) {
        let waiters: Vec<Waker> = {
            let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
            let Some(entry) = map.get_mut(&(domain, base.to_owned())) else {
                return;
            };
            let Some(active) = entry.in_flight.as_ref() else {
                return;
            };
            if active.id != id {
                return;
            }
            let active = entry.in_flight.take().unwrap();
            entry.settled_id = id;
            if entry.results.len() >= MAX_RESULTS {
                entry.results.pop_front();
            }
            entry.results.push_back((id, ok));
            if ok {
                entry.unseen_errors.remove(&active.workspace);
            } else {
                entry.unseen_errors.insert(active.workspace);
            }
            active.waiters.into_values().collect()
        };
        for wake in waiters {
            wake();
        }
    }
}
