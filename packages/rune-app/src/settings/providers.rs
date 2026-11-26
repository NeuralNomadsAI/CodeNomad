#[cfg(not(target_arch = "wasm32"))]
use super::view::Window;
use crate::{State, backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{Provider, providers},
    stream::{CatalogueChanges, SessionCatalogueChanges},
};
use rune::{El, TextEdit, col, text};
use rune_theme_codenomad::{Space, TextRole, layout::Layout, settings as chrome};
use std::{cell::RefCell, rc::Rc};

mod images;
#[cfg(test)]
mod tests;
mod websearch;

pub(super) struct Target {
    backend: Backend,
    workspace: String,
    session: Option<String>,
    owned_tab: bool,
    revision: u64,
    location_epoch: u64,
    observed: Option<u64>,
    authority: u64,
    online: bool,
    native_online: bool,
    stats: [u64; 2],
    stats_status: Option<(bool, Option<u64>)>,
    integrations: u64,
    integrations_session: u64,
}

impl Target {
    pub fn capture(s: &State) -> Option<Self> {
        let (backend, workspace, session, owned_tab) = if let Some(l) = s.screen.launcher() {
            let backend = l.connection.clone()?;
            let workspace = l.project.as_ref()?.id.clone();
            let session = crate::workspace::active_session(s).map(str::to_owned);
            (backend, workspace, session, true)
        } else {
            let backend = super::bound_backend(s)?;
            let (workspace, session) = (backend.workspace.clone(), backend.session.clone());
            (
                backend,
                workspace,
                (!session.is_empty()).then_some(session),
                false,
            )
        };
        Some(Self {
            backend,
            workspace,
            session,
            owned_tab,
            revision: 0,
            location_epoch: 0,
            observed: None,
            authority: 0,
            online: true,
            native_online: true,
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
            self.native_online = true;
            self.authority = self.authority.wrapping_add(1);
        } else if self.matches(changes) {
            self.invalidate();
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
            self.authority = self.authority.wrapping_add(1);
            self.invalidate_location();
            true
        } else {
            false
        }
    }

    pub(super) fn observe_native_status(&mut self, status: Option<(bool, Option<u64>)>) -> bool {
        status.is_some_and(|(connected, _)| self.native_transport(connected))
    }

    pub fn online(&self) -> bool {
        self.online && self.native_online
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
        self.authority.wrapping_add(self.revision)
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

    pub fn hint_location(&mut self, workspace: &str) -> bool {
        if !self.is_workspace(workspace) {
            return false;
        }
        self.invalidate_location();
        true
    }

    pub(super) fn invalidate_location(&mut self) {
        self.location_epoch = self.location_epoch.wrapping_add(1);
        self.invalidate();
    }

    fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }

    #[cfg(test)]
    pub(super) fn fixture(backend: Backend, workspace: &str, session: Option<&str>) -> Self {
        Self {
            backend,
            workspace: workspace.to_owned(),
            session: session.map(str::to_owned),
            owned_tab: false,
            revision: 0,
            location_epoch: 0,
            observed: None,
            authority: 0,
            online: true,
            native_online: true,
            stats: [0; 2],
            stats_status: None,
            integrations: 0,
            integrations_session: 0,
        }
    }
}

type Flight = (Sender<()>, Receiver<Option<Vec<Provider>>>);

pub(super) struct Catalog {
    pub expanded: bool,
    scope: Option<(String, String, Option<String>)>,
    authority: u64,
    seen: Option<u64>,
    flight: Option<Flight>,
    rows: Option<Vec<Provider>>,
    failed: bool,
    websearch: Rc<RefCell<websearch::WebSearch>>,
    images: Rc<RefCell<images::Images>>,
    #[cfg(not(target_arch = "wasm32"))]
    websearch_key: TextEdit,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            expanded: true,
            scope: None,
            authority: 0,
            seen: None,
            flight: None,
            rows: None,
            failed: false,
            websearch: Rc::new(RefCell::new(websearch::WebSearch::default())),
            images: Rc::new(RefCell::new(images::Images::default())),
            #[cfg(not(target_arch = "wasm32"))]
            websearch_key: TextEdit::new(""),
        }
    }
}

impl Catalog {
    fn clear_models(&mut self) -> bool {
        let changed =
            self.seen.is_some() || self.flight.is_some() || self.rows.is_some() || self.failed;
        self.scope = None;
        self.authority = 0;
        self.seen = None;
        self.flight = None;
        self.rows = None;
        self.failed = false;
        changed
    }

    pub fn poll(&mut self, target: Option<&Target>, wake: Option<&rune::Waker>) -> bool {
        let mut changed = self.websearch.borrow_mut().poll(target, wake);
        #[cfg(not(target_arch = "wasm32"))]
        if self.websearch.borrow_mut().take_wipe_key() {
            self.websearch_key = TextEdit::new("");
        }
        changed |= self.images.borrow_mut().poll(target, wake);

        let Some((target, wake)) = target
            .zip(wake)
            .filter(|(target, _)| self.expanded && target.online())
        else {
            return self.clear_models() | changed;
        };
        if self
            .scope
            .as_ref()
            .is_none_or(|(client, workspace, session)| {
                client != &target.backend.client_id
                    || workspace != &target.workspace
                    || session != &target.session
            })
            || self.authority != target.authority
        {
            self.clear_models();
            self.scope = Some((
                target.backend.client_id.clone(),
                target.workspace.clone(),
                target.session.clone(),
            ));
            self.authority = target.authority;
            changed = true;
        }
        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok())
        {
            self.flight = None;
            if self.seen == Some(target.revision) {
                self.failed = result.is_none();
                if let Some(rows) = result {
                    self.rows = Some(rows);
                }
            }
            changed = true;
        }
        if self.flight.is_none() && self.seen != Some(target.revision) {
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            let (backend, workspace, session, wake) = (
                target.backend.clone(),
                target.workspace.clone(),
                target.session.clone(),
                wake.clone(),
            );
            self.seen = Some(target.revision);
            self.flight = Some((cancel, reply));
            self.failed = false;
            platform::spawn(async move {
                if let Some(result) = platform::reads::cancellable(
                    &cancelled,
                    providers(&backend, &workspace, session.as_deref()),
                )
                .await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn view(s: &Window, available: bool) -> El {
    render_groups(
        &s.providers,
        available,
        |s: &mut Window| s.providers.toggle(),
        Some(&s.providers.websearch_key),
        Some(|s: &mut Window| &mut s.providers.websearch_key),
    )
}

impl Catalog {
    pub fn toggle(&mut self) {
        self.expanded = !self.expanded;
        self.clear_models();
    }

    pub fn suspend(&mut self) {
        self.clear_models();
        self.websearch.borrow_mut().suspend();
        self.images.borrow_mut().suspend();
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.websearch_key = TextEdit::new("");
        }
    }
}

pub(super) fn content<S: 'static>(
    catalog: &Catalog,
    available: bool,
    toggle: impl Fn(&mut S) + Clone + 'static,
) -> El {
    render_groups(catalog, available, toggle, None, None)
}

fn render_groups<S: 'static>(
    catalog: &Catalog,
    available: bool,
    toggle: impl Fn(&mut S) + Clone + 'static,
    external_key: Option<&TextEdit>,
    edit_key: Option<fn(&mut S) -> &mut TextEdit>,
) -> El {
    let mut body = col().full_width().separate(Space::Sm);
    if catalog.expanded {
        if !available {
            body = body.child(text(t("settings.providers.empty.noInstance")).role("status"));
        } else {
            if catalog.flight.is_some() {
                body = body.child(text(t("settings.providers.loading")).role("status"));
            } else if catalog.failed {
                body = body.child(
                    text(t("settings.providers.errors.loadFailed"))
                        .wrap()
                        .role("alert"),
                );
            }
            if let Some(rows) = &catalog.rows {
                if rows.is_empty() {
                    body = body.child(
                        text(t("settings.providers.empty.noConfiguredProviders")).role("status"),
                    );
                }
                for provider in rows {
                    let mut row = col().full_width().separate(Space::Sm).child(
                        text(&provider.name)
                            .full_width()
                            .wrap_anywhere()
                            .text_role(TextRole::Title)
                            .role("heading"),
                    );
                    if let Some(active) = &provider.active {
                        let label = text(&active.label);
                        row = row.child(chrome::setting_row(
                            t("settings.accounts.current"),
                            if active.environment {
                                label.help(t("settings.providers.source.env"))
                            } else {
                                label
                            },
                        ));
                    }
                    body = body.child(chrome::card(row).key(format!("provider-{}", provider.id)));
                }
            }
        }
    }
    col()
        .full_width()
        .separate(Space::Md)
        .child(chrome::card(chrome::disclosure(
            t("settings.providers.models.title"),
            catalog.expanded,
            body,
            toggle,
        )))
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
