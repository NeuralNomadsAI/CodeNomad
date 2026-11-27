use super::{El, Layout, chrome, col, layout, t, text};
use crate::{
    platform,
    settings::{ServerOwner, providers::Target},
};
use codenomad_client::{
    Receiver, Sender,
    backend::Backend,
    bounded,
    settings::memory::{self, Entry, List, Scope},
};
use rune_theme_codenomad::Space;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[derive(Clone)]
pub(in crate::settings) enum Action {
    Scope(Scope),
    Fold,
    Retry,
    Write(Edit, Option<Fields>),
    Tidy,
    ConfirmTidy(cleanup::Intent, bool),
}

#[derive(Clone)]
pub(in crate::settings) struct Edit {
    pub entry: Entry,
    key: Key,
    namespace: String,
}

impl Edit {
    pub(super) fn belongs_to_backend(&self, backend: &Backend) -> bool {
        self.key.owner.same_backend_server(backend)
    }
}

#[cfg(test)]
impl Edit {
    pub(in crate::settings) fn fixture() -> Self {
        Self {
            entry: Entry {
                id: "entry".into(),
                title: "Original title".into(),
                kind: memory::Kind::Fact,
                text: "Original text".into(),
                created: "2026-01-01T00:00:00Z".into(),
                updated: "2026-01-01T00:00:00Z".into(),
                revision: "a".repeat(64),
                flagged: false,
            },
            key: Key {
                owner: ServerOwner::fixture(),
                scope: Scope::Global,
                context: None,
            },
            namespace: "global".into(),
        }
    }
}
#[derive(Clone)]
pub(in crate::settings) struct Fields {
    pub title: String,
    pub text: String,
    pub kind: memory::Kind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TidyState {
    Idle,
    Active(u64),
    Prompting(u64),
    Succeeded,
    Failed,
}

impl Default for TidyState {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub(super) struct Review {
    scope: Option<Scope>,
    expanded: bool,
    key: Option<Key>,
    snapshot: Option<List>,
    flight: Option<(
        (u64, u64, u64),
        Sender<()>,
        Receiver<Result<List, &'static str>>,
    )>,
    refresh: bool,
    failed: Option<&'static str>,
    pending: Option<(Edit, Option<Fields>, u64)>,
    write: Option<Receiver<Result<(), &'static str>>>,
    write_result: Option<(Edit, Result<(), &'static str>)>,
    writing: Option<Edit>,
    tidy: Option<cleanup::Intent>,
    cleanup: Option<cleanup::Intent>,
    tidy_state: [TidyState; 2],
    unverified: bool,
    authority: Arc<AtomicU64>,
    cleanup_token: Arc<AtomicU64>,
    enabled_token: Arc<AtomicU64>,
    epoch: u64,
    seen: super::seen::Seen,
}

fn scope_slot(scope: Scope) -> usize {
    usize::from(scope == Scope::Project)
}

#[derive(Clone)]
struct Key {
    owner: ServerOwner,
    scope: Scope,
    context: Option<(String, Option<String>)>,
}

impl Key {
    fn same_target(&self, other: &Self) -> bool {
        self.owner.same_server(&other.owner)
            && self.scope == other.scope
            && self.context == other.context
    }
}

impl Review {
    pub fn revoke_authority(&self) {
        self.authority.fetch_add(1, Ordering::SeqCst);
        self.cleanup_token.fetch_add(1, Ordering::SeqCst);
        self.enabled_token.fetch_add(1, Ordering::SeqCst);
    }

    pub fn revoke_cleanup_disable(&mut self) {
        self.enabled_token.fetch_add(1, Ordering::SeqCst);
        self.cleanup_token.fetch_add(1, Ordering::SeqCst);
        self.tidy = None;
        self.cleanup = None;
        self.mark_active_tidy_interrupted();
    }

    fn mark_active_tidy_interrupted(&mut self) {
        for slot in 0..2 {
            if matches!(self.tidy_state[slot], TidyState::Active(_)) {
                self.tidy_state[slot] = TidyState::Failed;
            }
        }
    }

    pub fn begin_visit(&mut self) {
        self.seen.begin_visit();
        self.cleanup_token.fetch_add(1, Ordering::SeqCst);
        self.tidy_state = [TidyState::Idle; 2];
    }

    pub fn on_authentication_required(&mut self) {
        self.unverified = true;
        self.epoch = self.epoch.wrapping_add(1);
        self.cleanup_token.fetch_add(1, Ordering::SeqCst);
        self.flight = None;
        if let Some((edit, _, _)) = self.pending.take() {
            self.write_result = Some((edit, Err(UNAVAILABLE)));
        }
        self.tidy = None;
        self.cleanup = None;
        self.mark_active_tidy_interrupted();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn bind_seen(&mut self, store: Option<crate::platform::storage::Store>) {
        self.seen.bind(store);
    }
    pub fn active_scope(&self, project: Option<&Target>) -> Scope {
        self.scope(project)
    }

    fn scope(&self, project: Option<&Target>) -> Scope {
        self.scope.unwrap_or(if project.is_some() {
            Scope::Project
        } else {
            Scope::Global
        })
    }

    pub fn suspend(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.cleanup_token.fetch_add(1, Ordering::SeqCst);
        self.key = None;
        self.snapshot = None;
        self.flight = None;
        self.failed = None;
        if let Some((edit, _, _)) = self.pending.take() {
            self.write_result = Some((edit, Err("settings.memory.error.conflict")));
        }
        self.tidy = None;
        self.cleanup = None;
        self.mark_active_tidy_interrupted();
    }

    pub fn invalidate(&mut self) {
        self.refresh = true;
    }

    pub fn action(
        &mut self,
        action: Action,
        project: Option<&Target>,
        prefs_authority: &Arc<AtomicU64>,
    ) {
        match action {
            Action::Fold => {
                self.expanded = !self.expanded;
                if let Some((key, list)) = self.key.as_ref().zip(self.snapshot.as_ref()) {
                    self.seen.observe(key.owner.seen_key(), list, self.expanded);
                }
            }
            Action::Scope(scope)
                if scope != self.scope(project)
                    && (scope != Scope::Project || project.is_some()) =>
            {
                self.suspend();
                self.scope = Some(scope);
            }
            Action::Retry => self.invalidate(),
            Action::Write(edit, fields) if !self.writing() && self.writable(&edit) => {
                let admitted_gen = prefs_authority.load(Ordering::SeqCst);
                self.write_result = None;
                self.pending = Some((edit, fields, admitted_gen));
            }
            Action::Tidy => self.tidy = self.cleanup_intent(project, prefs_authority),
            Action::ConfirmTidy(expected, accept) if self.tidy.as_ref() == Some(&expected) => {
                let intent = self.tidy.take();
                // Consume consent before publishing; a second activation cannot start this run.
                if accept && intent == self.cleanup_intent(project, prefs_authority) {
                    if let Some(ref confirmed) = intent {
                        self.tidy_state[scope_slot(confirmed.scope)] =
                            TidyState::Active(confirmed.cleanup_token_gen);
                    }
                    self.cleanup = intent;
                }
            }
            _ => {}
        }
    }

    fn can_tidy(&self, project: Option<&Target>) -> bool {
        let Some(list) = self.snapshot.as_ref() else {
            return false;
        };
        let Some(key) = self.key.as_ref() else {
            return false;
        };
        if project.filter(|p| p.online()).is_none() {
            return false;
        }
        !self.unverified
            && !self.refresh
            && self.tidy_state[scope_slot(key.scope)] == TidyState::Idle
            && !self.writing()
            && self.flight.is_none()
            && self.failed.is_none()
            && list.cleanup_writable
            && list.cleanup_directory.is_some()
            && list.entries.iter().any(|entry| !entry.flagged)
    }

    fn cleanup_intent(
        &self,
        project: Option<&Target>,
        prefs_authority: &Arc<AtomicU64>,
    ) -> Option<cleanup::Intent> {
        if !self.can_tidy(project) {
            return None;
        }
        let list = self.snapshot.as_ref()?;
        let key = self.key.as_ref()?;
        let (workspace, session) = project.filter(|p| p.online())?.location();
        let directory = list.cleanup_directory.clone()?;
        Some(cleanup::Intent {
            epoch: self.epoch,
            connection: key.owner.client_id().to_owned(),
            workspace: workspace.into(),
            session: session.map(str::to_owned),
            directory,
            scope: key.scope,
            authority: prefs_authority.clone(),
            authority_gen: prefs_authority.load(Ordering::SeqCst),
            cleanup_token: self.cleanup_token.clone(),
            cleanup_token_gen: self.cleanup_token.load(Ordering::SeqCst),
            enabled_token: self.enabled_token.clone(),
            enabled_token_gen: self.enabled_token.load(Ordering::SeqCst),
        })
    }

    pub fn take_cleanup(&mut self) -> Option<cleanup::Intent> {
        self.cleanup.take()
    }
    pub fn cleanup_current(&self, intent: &cleanup::Intent) -> bool {
        !self.unverified
            && Arc::ptr_eq(&self.cleanup_token, &intent.cleanup_token)
            && self.tidy_state[scope_slot(intent.scope)]
                == TidyState::Active(intent.cleanup_token_gen)
            && self.epoch == intent.epoch
            && intent.token_valid()
            && self.key.as_ref().is_some_and(|key| {
                key.owner.client_id() == intent.connection
                    && key.scope == intent.scope
                    && key.context.as_ref().is_some_and(|(workspace, session)| {
                        *workspace == intent.workspace && *session == intent.session
                    })
            })
    }
    pub fn cleanup_prompting(&mut self, intent: &cleanup::Intent) {
        let slot = scope_slot(intent.scope);
        if Arc::ptr_eq(&self.cleanup_token, &intent.cleanup_token)
            && self.tidy_state[slot] == TidyState::Active(intent.cleanup_token_gen)
        {
            self.tidy_state[slot] = TidyState::Prompting(intent.cleanup_token_gen);
        }
    }
    pub fn cleanup_failed(&mut self, intent: &cleanup::Intent) {
        let slot = scope_slot(intent.scope);
        if Arc::ptr_eq(&self.cleanup_token, &intent.cleanup_token)
            && matches!(
                self.tidy_state[slot],
                TidyState::Active(token) | TidyState::Prompting(token)
                    if token == intent.cleanup_token_gen
            )
        {
            self.tidy_state[slot] = TidyState::Failed;
        }
    }
    pub fn cleanup_succeeded(&mut self, intent: &cleanup::Intent) {
        let slot = scope_slot(intent.scope);
        if Arc::ptr_eq(&self.cleanup_token, &intent.cleanup_token)
            && self.tidy_state[slot] == TidyState::Prompting(intent.cleanup_token_gen)
        {
            self.tidy_state[slot] = TidyState::Succeeded;
        }
    }

    pub fn cleanup_confirmation<S: 'static>(
        &self,
        apply: impl Fn(&mut S, Action) -> bool + 'static,
    ) -> Option<El> {
        let intent = self.tidy.clone()?;
        let scope = t(if intent.scope == Scope::Global {
            "settings.memory.global"
        } else {
            "settings.memory.project"
        });
        Some(rune_theme_codenomad::document_reader::editor::confirmation(
            layout::dark(),
            &t("settings.memory.tidyConfirm").replace("{scope}", scope),
            t("settings.memory.cancel"),
            t("settings.memory.tidy"),
            move |s, accept, _| {
                apply(s, Action::ConfirmTidy(intent.clone(), accept));
            },
        ))
    }

    #[cfg(test)]
    pub(super) fn first_edit(&self) -> Option<Edit> {
        let key = self.key.as_ref()?.clone();
        let list = self.snapshot.as_ref()?;
        let entry = list.entries.first()?.clone();
        Some(Edit {
            entry,
            key,
            namespace: list.scope_key.clone(),
        })
    }

    pub fn is_current(&self, edit: &Edit) -> bool {
        self.key
            .as_ref()
            .is_some_and(|key| key.same_target(&edit.key))
            && self.snapshot.as_ref().is_some_and(|list| {
                list.scope_key == edit.namespace
                    && list.entries.iter().any(|entry| {
                        entry.id == edit.entry.id && entry.revision == edit.entry.revision
                    })
            })
    }
    pub fn failed(&self) -> Option<&'static str> {
        self.failed
    }

    pub fn loading(&self) -> bool {
        self.flight.is_some() || self.refresh
    }

    pub fn writable(&self, edit: &Edit) -> bool {
        self.is_current(edit)
            && !self.unverified
            && !self.refresh
            && self.failed.is_none()
            && self.flight.is_none()
            && self.snapshot.as_ref().is_some_and(|list| {
                edit.key.scope == Scope::Global || list.cleanup_directory.is_some()
            })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn cancel_cleanup_confirmation(&mut self) -> bool {
        self.tidy.take().is_some()
    }

    pub fn writing(&self) -> bool {
        self.pending.is_some() || self.write.is_some()
    }

    pub fn write_result(&self, edit: &Edit) -> Option<Result<(), &'static str>> {
        self.write_result
            .as_ref()
            .filter(|(sent, _)| {
                sent.key.same_target(&edit.key)
                    && sent.entry.id == edit.entry.id
                    && sent.entry.revision == edit.entry.revision
            })
            .map(|(_, result)| *result)
    }

    pub fn poll_write(&mut self) -> bool {
        let Some(reply) = &self.write else {
            return false;
        };
        let result = match reply.try_recv() {
            Ok(result) => result,
            Err(_) if reply.is_closed() => Err(UNAVAILABLE),
            Err(_) => return false,
        };
        self.write = None;
        self.write_result = self.writing.take().map(|edit| (edit, result));
        self.invalidate();
        true
    }

    pub fn poll(
        &mut self,
        backend: Option<&Backend>,
        project: Option<&Target>,
        transport_lost: bool,
        prefs_authority: &Arc<AtomicU64>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        let scope = self.scope(project);
        if backend.is_some() && project.is_some() {
            self.scope.get_or_insert(scope);
        }
        let next_key = backend
            .filter(|_| scope == Scope::Global || project.is_some())
            .map(|backend| Key {
                owner: ServerOwner::from_backend(backend),
                scope,
                context: project.map(|target| {
                    let (workspace, session) = target.location();
                    (workspace.to_owned(), session.map(str::to_owned))
                }),
            });
        let target_offline = scope == Scope::Project && !project.is_some_and(Target::online);
        let was_unverified = self.unverified;
        self.unverified = transport_lost
            || target_offline
            || backend.is_some_and(|b| !ServerOwner::backend_verified(b));
        let mut changed = was_unverified != self.unverified;
        match (&mut self.key, next_key) {
            (Some(current), Some(next)) if current.same_target(&next) => {
                if let Some(backend) = backend
                    && current.owner.adopt_same_server(backend)
                {
                    // Re-authenticated to the same server and scope: keep the loaded snapshot
                    // so open entry drafts stay current while a fresh read confirms revisions.
                    self.epoch = self.epoch.wrapping_add(1);
                    self.cleanup_token.fetch_add(1, Ordering::SeqCst);
                    self.flight = None;
                    self.failed = None;
                    if let Some((edit, _, _)) = self.pending.take() {
                        self.write_result = Some((edit, Err(UNAVAILABLE)));
                    }
                    self.tidy = None;
                    self.cleanup = None;
                    self.mark_active_tidy_interrupted();
                    self.invalidate();
                    changed = true;
                }
            }
            (None, None) => {}
            (_, next) => {
                let switching_owner = self
                    .key
                    .as_ref()
                    .zip(next.as_ref())
                    .is_some_and(|(old, new)| !old.owner.same_server(&new.owner));
                if switching_owner {
                    self.revoke_authority();
                    self.tidy_state = [TidyState::Idle; 2];
                }
                self.suspend();
                self.key = next;
                self.invalidate();
                changed = true;
            }
        }
        if self.poll_write() {
            changed = true;
        }
        let current_auth = prefs_authority.load(Ordering::SeqCst);
        if let Some((_, _, admitted_gen)) = &self.pending
            && *admitted_gen != current_auth
        {
            if let Some((edit, _, _)) = self.pending.take() {
                self.write_result = Some((edit, Err(UNAVAILABLE)));
                changed = true;
            }
        }
        if self.write.is_some() {
            return changed;
        }
        let (Some(key), Some(backend)) = (&self.key, backend) else {
            return changed;
        };
        // Never publish or start list reads or cleanup while transport, target, or attestation is
        // unverified: keep the last attested snapshot so open drafts stay visible read-only.
        if self.unverified {
            if let Some((edit, _, _)) = self.pending.take() {
                self.write_result = Some((edit, Err(UNAVAILABLE)));
                changed = true;
            }
            if self.flight.take().is_some() {
                self.invalidate();
                changed = true;
            }
            if self.tidy.take().is_some() || self.cleanup.take().is_some() {
                self.epoch = self.epoch.wrapping_add(1);
                self.cleanup_token.fetch_add(1, Ordering::SeqCst);
                self.mark_active_tidy_interrupted();
                changed = true;
            } else if !was_unverified {
                self.cleanup_token.fetch_add(1, Ordering::SeqCst);
                self.mark_active_tidy_interrupted();
            }
            if !was_unverified {
                self.invalidate();
            }
            return changed;
        }
        let current_stamp = (
            current_auth,
            backend.client.drop_generation(),
            backend.client.stream_drop_epoch(),
        );
        if let Some((flight_stamp, _, flight)) = &self.flight {
            if *flight_stamp != current_stamp {
                self.flight = None;
                self.refresh = true;
                changed = true;
            } else {
                let result = match flight.try_recv() {
                    Ok(result) => result,
                    Err(_) if flight.is_closed() => Err(UNAVAILABLE),
                    Err(_) => return changed,
                };
                self.flight = None;
                if ServerOwner::backend_verified(backend) && key.owner.same_backend_server(backend)
                {
                    self.failed = result.as_ref().err().copied();
                    if let Ok(list) = result {
                        self.seen
                            .observe(key.owner.seen_key(), &list, self.expanded);
                        self.snapshot = Some(list);
                    }
                } else {
                    self.unverified = true;
                    self.refresh = true;
                }
                changed = true;
            }
        }
        if !self.refresh
            && self.flight.is_none()
            && let Some((edit, fields, admitted_gen)) = self.pending.take()
        {
            if admitted_gen == prefs_authority.load(Ordering::SeqCst)
                && self.writable(&edit)
                && key.owner.verified_for_write(backend)
            {
                self.start_write(
                    backend,
                    prefs_authority,
                    admitted_gen,
                    edit,
                    fields,
                    main,
                    window,
                );
            } else {
                self.write_result = Some((edit, Err("settings.memory.error.conflict")));
            }
            return true;
        }
        if !std::mem::take(&mut self.refresh) {
            return changed;
        }
        let (hold, cancel) = bounded::<()>(1);
        let (out, input) = bounded(1);
        self.flight = Some((current_stamp, hold, input));
        let (backend, key, main, window) =
            (backend.clone(), key.clone(), main.clone(), window.clone());
        let expected_server = key.owner.server().map(str::to_owned);
        let prefs_auth = prefs_authority.clone();
        let (prefs_gen, prepared_gen, prepared_stream_epoch) = current_stamp;
        let review_auth = self.authority.clone();
        let review_gen = review_auth.load(Ordering::SeqCst);
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(Ordering::SeqCst) == prefs_gen
                    && review_auth.load(Ordering::SeqCst) == review_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let context = key
                .context
                .as_ref()
                .map(|(workspace, session)| (workspace.as_str(), session.as_deref()));
            let read = async {
                if !still_ok() {
                    return Err(UNAVAILABLE);
                }
                if backend.client.tracks_server_attestation()
                    && backend.attest_server().await.is_err()
                {
                    return Err(UNAVAILABLE);
                }
                if !still_ok() {
                    return Err(UNAVAILABLE);
                }
                let result = memory::list(&backend, key.scope, context)
                    .await
                    .map_err(error_key);
                if !still_ok() {
                    return Err(UNAVAILABLE);
                }
                if backend.client.tracks_server_attestation()
                    && backend.attest_server().await.is_err()
                {
                    return Err(UNAVAILABLE);
                }
                if !still_ok() {
                    return Err(UNAVAILABLE);
                }
                result
            };
            let result = platform::reads::cancellable(&cancel, read).await;
            if let Some(result) = result {
                let _ = out.send(result).await;
                for wake in [main, window].into_iter().flatten() {
                    wake();
                }
            }
        });
        true
    }

    fn start_write(
        &mut self,
        backend: &Backend,
        prefs_authority: &Arc<AtomicU64>,
        admitted_gen: u64,
        edit: Edit,
        fields: Option<Fields>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) {
        use serde_json::json;
        let directory = self
            .snapshot
            .as_ref()
            .and_then(|list| list.cleanup_directory.clone());
        let workspace = edit
            .key
            .context
            .as_ref()
            .filter(|_| edit.key.scope == Scope::Project)
            .map(|(workspace, _)| workspace.clone());
        let entry_id = edit.entry.id.clone();
        let scope = edit.key.scope;
        let mut input =
            json!({"action":"delete", "id":edit.entry.id, "revision":edit.entry.revision});
        let save = fields.is_some();
        if let Some(fields) = fields {
            input["action"] = json!("save");
            input["content"] =
                json!({"title":fields.title,"type":fields.kind.key(),"text":fields.text});
        }
        let expected_server = edit.key.owner.server().map(str::to_owned);
        let prepared_gen = backend.client.drop_generation();
        let prepared_stream_epoch = backend.client.stream_drop_epoch();
        let prefs_auth = prefs_authority.clone();
        let prefs_gen = admitted_gen;
        let review_auth = self.authority.clone();
        let review_gen = review_auth.load(Ordering::SeqCst);
        let (out, reply) = bounded(1);
        self.write_result = None;
        self.writing = Some(edit);
        self.write = Some(reply);
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let same_server = || {
                backend.client.drop_generation() == prepared_gen
                    && ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let still_authorized = || {
                prefs_auth.load(Ordering::SeqCst) == prefs_gen
                    && review_auth.load(Ordering::SeqCst) == review_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && same_server()
            };
            // Re-attest live HTTP routing right before sending the draft when attestation is
            // tracked; the server HTTP route has no server-id precondition header, so a fresh
            // /api/meta check on the same client prevents sending to a foreign profile even if
            // SSE remained attached to the old host.
            let verified = if !still_authorized() {
                false
            } else if backend.client.tracks_server_attestation() {
                backend.attest_server().await.is_ok() && still_authorized()
            } else {
                true
            };
            let result = if !verified || !still_authorized() {
                Err(UNAVAILABLE)
            } else {
                let context = workspace
                    .as_deref()
                    .map(|workspace| (workspace, directory.as_deref()));
                let ack_ok = memory::operation(&backend, scope, context, input)
                    .await
                    .map_err(error_key)
                    .and_then(|ack| {
                        if (save
                            && ack["id"] == entry_id
                            && ack["revision"].as_str().is_some_and(|r| r.len() == 64))
                            || (!save && ack["deleted"] == true)
                        {
                            Ok(())
                        } else {
                            Err(UNAVAILABLE)
                        }
                    });
                match ack_ok {
                    Ok(())
                        if same_server()
                            && (!backend.client.tracks_server_attestation()
                                || backend.attest_server().await.is_ok())
                            && same_server() =>
                    {
                        Ok(())
                    }
                    Ok(()) => Err(UNAVAILABLE),
                    Err(err) => Err(err),
                }
            };
            let _ = out.send(result).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        project: Option<&Target>,
        setting_busy: bool,
        open: impl Fn(&mut S, Edit) + Clone + 'static,
        act: impl Fn(&mut S, Action) + Clone + 'static,
    ) -> El {
        let scope = self.scope(project);
        let choose = act.clone();
        let scopes = if project.is_some() || scope == Scope::Project {
            chrome::segments(
                t("settings.memory.scope"),
                &[t("settings.memory.global"), t("settings.memory.project")],
                Some(usize::from(scope == Scope::Project)),
                false,
                move |s, i| {
                    choose(
                        s,
                        Action::Scope(if i == 0 {
                            Scope::Global
                        } else {
                            Scope::Project
                        }),
                    )
                },
            )
        } else {
            text(t("settings.memory.global"))
        };
        let tidy = act.clone();
        let mut panel = col()
            .full_width()
            .separate(Space::Sm)
            .child(
                layout::action_row()
                    .child(scopes)
                    .children(project.map(|_| {
                        layout::button(
                            t("settings.memory.tidy"),
                            setting_busy || !self.can_tidy(project),
                            move |s| tidy(s, Action::Tidy),
                        )
                        .help(t("settings.memory.tidyInfo"))
                    })),
            )
            .children(
                (self.tidy_state[scope_slot(scope)] == TidyState::Failed)
                    .then(|| text(t("settings.memory.tidyFailed")).role("alert").wrap()),
            );
        if scope == Scope::Project {
            match project {
                None => return panel.child(text(t("settings.memory.noProject")).role("status")),
                Some(target) if !target.online() => {
                    return panel
                        .child(text(t("settings.memory.error.unavailable")).role("status"));
                }
                _ => {}
            }
        }
        if let Some(error) = self.failed {
            let retry = act.clone();
            panel = panel.child(
                layout::action_row()
                    .child(text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("settings.memory.retry"),
                        self.flight.is_some(),
                        move |s| retry(s, Action::Retry),
                    )),
            );
        }
        let Some(list) = &self.snapshot else {
            return panel.children(
                self.flight
                    .is_some()
                    .then(|| text(t("settings.memory.loading")).role("status")),
            );
        };
        if list.entries.is_empty() {
            return panel.children(
                self.failed
                    .is_none()
                    .then(|| text(t("settings.memory.empty")).role("status")),
            );
        }
        let count = t("settings.memory.count")
            .replace("{count}", &list.entries.len().to_string())
            .replace("{limit}", &scope.limit().to_string());
        let mut label = format!("{} {count}", t("settings.memory.entries"));
        if let Some(key) = &self.key {
            for badge in [
                "settings.memory.new",
                "settings.memory.modified",
                "settings.memory.flagged",
            ] {
                if list.entries.iter().any(|entry| {
                    if badge == "settings.memory.flagged" {
                        entry.flagged
                    } else {
                        self.seen.badge(key.owner.seen_key(), list, entry) == Some(badge)
                    }
                }) {
                    label.push(' ');
                    label.push_str(t(badge));
                }
            }
        }
        let mut rows = col().full_width().separate(Space::Xs);
        if self.expanded {
            for entry in &list.entries {
                let Some(key) = &self.key else { break };
                let edit = Edit {
                    entry: entry.clone(),
                    key: key.clone(),
                    namespace: list.scope_key.clone(),
                };
                let read = open.clone();
                let kind = t(match entry.kind {
                    memory::Kind::Fact => "settings.memory.type.fact",
                    memory::Kind::Preference => "settings.memory.type.preference",
                    memory::Kind::Reference => "settings.memory.type.reference",
                });
                rows = rows.child(
                    layout::action_row()
                        .key(&entry.id)
                        .child(
                            layout::button(&entry.title, self.writing(), move |s| {
                                read(s, edit.clone())
                            })
                            .content_direction(),
                        )
                        .child(text(kind))
                        .children(
                            self.seen
                                .badge(key.owner.seen_key(), list, entry)
                                .map(|badge| text(t(badge))),
                        )
                        .children(entry.flagged.then(|| text(t("settings.memory.flagged")))),
                );
            }
        }
        panel.child(chrome::disclosure(&label, self.expanded, rows, move |s| {
            act(s, Action::Fold)
        }))
    }
}

const UNAVAILABLE: &str = "settings.memory.error.unavailable";
fn error_key(error: codenomad_client::history::Error) -> &'static str {
    error
        .downcast_ref::<memory::Refused>()
        .map_or(UNAVAILABLE, |error| error.0)
}

use super::cleanup;
