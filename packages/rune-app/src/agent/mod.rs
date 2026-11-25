//! Session-owned controls. Session, permissions, forms, model catalogue and stop use separate HTTP lanes.
pub(crate) mod form_view;
pub(crate) mod forms;
#[cfg(test)]
mod tests;
pub(crate) mod view;
#[cfg(test)]
mod viewport_tests;
use crate::{
    agent_api::{Action, Form, Model, Permission, Snapshot},
    agent_forms::{self, Drafts},
    backend::Backend,
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::edit::TextEdit;
enum Job {
    Read(bool, u64),
    Act(Action, u64),
    VerifyIdle(String, String),
}
enum PendingJob {
    Read(u64),
    Act(Action, u64),
}
enum Result {
    #[cfg(test)]
    Read(Snapshot, bool, u64),
    Session(Snapshot, Option<String>, bool, u64),
    Permissions(Option<Vec<Permission>>, u64),
    Forms(Option<Vec<Form>>, u64),
    Catalog(Option<Vec<Model>>, String, u64),
    Act(bool, Snapshot, u64),
    ActPermission(bool, Option<Vec<Permission>>, u64),
    ActForm(bool, Option<Vec<Form>>, u64),
    Stop(bool),
    VerifiedIdle(String, bool),
}
#[derive(Default)]
struct RequestLane {
    known: bool,
    reading: bool,
    busy: bool,
    trailing: bool,
    error: bool,
    generation: u64,
    hint_during_job: bool,
}
impl RequestLane {
    fn locked(&self, online: bool) -> bool {
        self.busy || self.reading || !self.known || !online
    }
    fn idle(&self) -> bool {
        !self.reading && !self.busy && !self.trailing
    }
    fn bump(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }
    fn reset(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self {
            generation,
            ..Self::default()
        };
    }
}
pub fn navigation_blocked(s: &crate::State) -> bool {
    s.agent.as_ref().is_some_and(Ui::navigation_blocked)
}
pub struct Handle {
    connection: Option<codenomad_client::http::Http>,
    jobs: Sender<Job>,
    permissions: Sender<PendingJob>,
    forms: Sender<PendingJob>,
    catalog: Sender<(String, u64)>,
    stop: Sender<()>,
    results: Receiver<Result>,
}
#[cfg(test)]
impl Handle {
    fn test(jobs: Sender<Job>, stop: Sender<()>, results: Receiver<Result>) -> Self {
        let (permissions, _) = bounded(1);
        let (forms, _) = bounded(1);
        let (catalog, _) = bounded(1);
        Self {
            connection: None,
            jobs,
            permissions,
            forms,
            catalog,
            stop,
            results,
        }
    }
}
impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionControls")
    }
}
pub struct Ui {
    handle: Handle,
    pub models: Vec<Model>,
    pub current: Option<serde_json::Value>,
    pub usage: Option<crate::content::Usage>,
    pub directory: Option<String>,
    model_generation: u64,
    confirmed_model_generation: u64,
    pub permissions: Vec<Permission>,
    pub forms: Vec<Form>,
    pub drafts: Drafts,
    pub reasons: std::collections::HashMap<String, TextEdit>,
    pub selected: String,
    pub picker: bool,
    pub search: TextEdit,
    pub busy: bool,
    pub stopping: bool,
    pub error: bool,
    session_error: bool,
    catalog_error: bool,
    stop_error: bool,
    pub known: bool,
    pub running: bool,
    pub pending_known: bool,
    pub online: bool,
    pub(crate) attention: crate::shell::notifications::Attention,
    reading: bool,
    catalog_reading: bool,
    catalog_generation: u64,
    catalog_directory: Option<String>,
    permissions_lane: RequestLane,
    forms_lane: RequestLane,
    activity_during_job: bool,
    usage_during_job: bool,
    trailing: Option<bool>,
    catalog_trailing: Option<String>,
}
pub fn start(backend: Backend, wake: rune::Waker) -> Handle {
    let (jobs, rx) = bounded(1);
    let (permissions, prx) = bounded(1);
    let (forms, frx) = bounded(1);
    let (catalog, crx) = bounded::<(String, u64)>(1);
    let (stop, srx) = bounded(1);
    let (out, results) = bounded(16);
    let connection = Some(backend.client.clone());
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while srx.recv().await.is_ok() {
            if o.send(Result::Stop(b.interrupt().await.is_ok()))
                .await
                .is_err()
            {
                break;
            }
            w();
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok(job) = prx.recv().await {
            let result = match job {
                PendingJob::Read(generation) => {
                    Result::Permissions(b.permissions_snapshot().await, generation)
                }
                PendingJob::Act(action, generation) => {
                    let ok = b.agent_action(&action).await.is_ok();
                    Result::ActPermission(ok, b.permissions_snapshot().await, generation)
                }
            };
            if o.send(result).await.is_err() {
                break;
            }
            w();
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok(job) = frx.recv().await {
            let result = match job {
                PendingJob::Read(generation) => Result::Forms(b.forms_snapshot().await, generation),
                PendingJob::Act(action, generation) => {
                    let ok = b.agent_action(&action).await.is_ok();
                    Result::ActForm(ok, b.forms_snapshot().await, generation)
                }
            };
            if o.send(result).await.is_err() {
                break;
            }
            w();
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok((directory, generation)) = crx.recv().await {
            let models = b.model_catalog(&directory).await;
            if o.send(Result::Catalog(models, directory, generation))
                .await
                .is_err()
            {
                break;
            }
            w();
        }
    });
    crate::platform::spawn(async move {
        while let Ok(job) = rx.recv().await {
            let result = match job {
                Job::Read(catalog, generation) => {
                    let (snapshot, catalog_dir) = backend.session_snapshot().await;
                    Result::Session(snapshot, catalog_dir, catalog, generation)
                }
                Job::Act(action, generation) => match action {
                    Action::Model(reference) => match backend.apply_model(&reference).await {
                        Ok(snapshot) => Result::Act(true, snapshot, generation),
                        Err(_) => {
                            let (snapshot, _) = backend.session_snapshot().await;
                            Result::Act(false, snapshot, generation)
                        }
                    },
                    other => {
                        let ok = backend.agent_action(&other).await.is_ok();
                        let (snapshot, _) = backend.session_snapshot().await;
                        Result::Act(ok, snapshot, generation)
                    }
                },
                Job::VerifyIdle(id, directory) => {
                    Result::VerifiedIdle(id, backend.session_inactive_at(&directory).await)
                }
            };
            if out.send(result).await.is_err() {
                break;
            }
            wake();
        }
    });
    Handle {
        connection,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    }
}
impl Ui {
    pub(crate) fn includes_cost(&self, provider: &str, id: &str) -> bool {
        self.models.iter().any(|model| {
            model.included
                && model.reference["providerID"] == provider
                && model.reference["id"] == id
        })
    }

    fn sync_error(&mut self) {
        self.error = self.session_error
            || self.permissions_lane.error
            || self.forms_lane.error
            || self.catalog_error
            || self.stop_error;
    }

    fn sync_pending_known(&mut self) {
        self.pending_known = self.permissions_lane.known && self.forms_lane.known;
    }

    pub(crate) fn mark_offline(&mut self) {
        self.online = false;
        self.permissions_lane.known = false;
        self.forms_lane.known = false;
        self.sync_pending_known();
    }

    #[cfg(test)]
    pub(crate) fn mark_pending_known(&mut self) {
        self.permissions_lane.known = true;
        self.forms_lane.known = true;
        self.sync_pending_known();
    }

    pub fn rebind(&mut self, handle: Handle) {
        self.handle = handle;
        self.reading = false;
        self.catalog_reading = false;
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        self.catalog_directory = None;
        self.permissions_lane.reset();
        self.forms_lane.reset();
        self.activity_during_job = false;
        self.usage_during_job = false;
        self.trailing = None;
        self.catalog_trailing = None;
        self.busy = false;
        self.stopping = false;
        self.session_error = false;
        self.catalog_error = false;
        self.stop_error = false;
        self.sync_error();
        self.running = false;
        self.known = false;
        self.sync_pending_known();
        self.online = false;
        self.refresh(true);
    }
    pub(crate) fn uses_connection(&self, backend: &Backend) -> bool {
        self.handle
            .connection
            .as_ref()
            .is_none_or(|previous| previous.same_connection(&backend.client))
    }

    pub(crate) fn reauthenticate(&mut self, handle: Handle) {
        let mut replacement = Self::new(handle);
        replacement.drafts = std::mem::take(&mut self.drafts);
        replacement.reasons = std::mem::take(&mut self.reasons);
        replacement.attention = std::mem::take(&mut self.attention);
        *self = replacement;
    }

    pub fn navigation_blocked(&self) -> bool {
        self.busy
            || self.permissions_lane.busy
            || self.forms_lane.busy
            || self.stopping
            || self.drafts.values().any(|d| d.dirty)
            || self.reasons.values().any(|d| !d.text.is_empty())
    }
    pub fn toggle_picker(&mut self) {
        self.picker = !self.picker;
        if self.picker {
            self.refresh(true)
        }
    }
    pub fn refresh_controls(&mut self) {
        self.session_error = false;
        self.permissions_lane.error = false;
        self.forms_lane.error = false;
        self.catalog_error = false;
        self.stop_error = false;
        self.sync_error();
        self.refresh(true)
    }
    pub fn choose_model(&mut self, reference: serde_json::Value) {
        if self.model_locked() || !self.models.iter().any(|model| model.reference == reference) {
            return;
        }
        self.act(Action::Model(reference));
        self.picker = false;
    }
    pub fn select_request(&mut self, id: String) {
        if self.permissions.iter().any(|p| p.id == id) || self.forms.iter().any(|f| f.id == id) {
            self.selected = id;
        }
    }
    pub fn reply_permission(&mut self, id: String, decision: &str) {
        if !self.permissions.iter().any(|p| p.id == id && p.supported) {
            return;
        }
        let message = self
            .reasons
            .get(&id)
            .map(|v| v.text.clone())
            .unwrap_or_default();
        self.act(Action::Permission(id, decision.into(), message))
    }
    pub fn answer_form(&mut self, id: &str) {
        if let Some(form) = self.forms.iter().find(|f| f.id == id) {
            if let Ok(answer) = agent_forms::answer(form, &self.drafts) {
                self.act(Action::Answer(id.into(), answer, form.fields.clone()))
            }
        }
    }
    pub fn cancel_form(&mut self, id: String) {
        if self.forms.iter().any(|f| f.id == id) {
            self.act(Action::Cancel(id));
        }
    }
    pub fn idle(&self) -> bool {
        !self.reading
            && !self.busy
            && self.permissions_lane.idle()
            && self.forms_lane.idle()
            && !self.catalog_reading
            && !self.stopping
            && self.trailing.is_none()
            && self.catalog_trailing.is_none()
    }
    pub fn new(handle: Handle) -> Self {
        let mut ui = Self {
            handle,
            models: vec![],
            current: None,
            usage: None,
            directory: None,
            model_generation: 0,
            confirmed_model_generation: 0,
            permissions: vec![],
            forms: vec![],
            drafts: Default::default(),
            reasons: Default::default(),
            selected: String::new(),
            picker: false,
            search: TextEdit::new(""),
            busy: false,
            stopping: false,
            error: false,
            session_error: false,
            catalog_error: false,
            stop_error: false,
            known: false,
            running: false,
            pending_known: false,
            online: false,
            attention: Default::default(),
            reading: false,
            catalog_reading: false,
            catalog_generation: 0,
            catalog_directory: None,
            permissions_lane: RequestLane::default(),
            forms_lane: RequestLane::default(),
            activity_during_job: false,
            usage_during_job: false,
            trailing: None,
            catalog_trailing: None,
        };
        ui.refresh(true);
        ui
    }
    pub fn refresh(&mut self, catalog: bool) {
        self.refresh_session(catalog);
        self.refresh_permissions();
        self.refresh_forms();
    }
    pub(crate) fn refresh_session(&mut self, catalog: bool) {
        if self.reading || self.busy {
            self.trailing = Some(self.trailing.unwrap_or(false) || catalog);
            return;
        }
        if self
            .handle
            .jobs
            .try_send(Job::Read(catalog, self.model_generation))
            .is_ok()
        {
            self.reading = true
        }
    }
    fn dispatch_permissions_read(&mut self, generation: u64) {
        if self
            .handle
            .permissions
            .try_send(PendingJob::Read(generation))
            .is_ok()
        {
            self.permissions_lane.reading = true;
            self.permissions_lane.hint_during_job = false;
        }
    }
    pub(crate) fn refresh_permissions(&mut self) {
        let generation = self.permissions_lane.bump();
        self.attention.invalidate_kind(0);
        if self.permissions_lane.reading || self.permissions_lane.busy {
            self.permissions_lane.trailing = true;
            return;
        }
        self.dispatch_permissions_read(generation);
    }
    fn dispatch_forms_read(&mut self, generation: u64) {
        if self
            .handle
            .forms
            .try_send(PendingJob::Read(generation))
            .is_ok()
        {
            self.forms_lane.reading = true;
            self.forms_lane.hint_during_job = false;
        }
    }
    pub(crate) fn refresh_forms(&mut self) {
        let generation = self.forms_lane.bump();
        self.attention.invalidate_kind(1);
        if self.forms_lane.reading || self.forms_lane.busy {
            self.forms_lane.trailing = true;
            return;
        }
        self.dispatch_forms_read(generation);
    }
    fn dispatch_catalog_read(&mut self, directory: String, generation: u64) {
        if self
            .handle
            .catalog
            .try_send((directory, generation))
            .is_ok()
        {
            self.catalog_reading = true;
        }
    }
    fn refresh_catalog(&mut self, directory: String) {
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        self.catalog_directory = Some(directory.clone());
        if self.catalog_reading {
            self.catalog_trailing = Some(directory);
            return;
        }
        self.dispatch_catalog_read(directory, self.catalog_generation);
    }

    pub(crate) fn refresh_usage_model(&mut self, generation: u64) {
        if generation != self.model_generation {
            self.model_generation = generation;
            self.refresh_session(false);
        }
    }

    pub(crate) fn usage_model(&self, generation: u64) -> Option<(&str, &serde_json::Value)> {
        (generation == self.confirmed_model_generation).then_some(())?;
        self.directory.as_deref().zip(self.current.as_ref())
    }

    pub(crate) fn observe_running(&mut self, running: bool) {
        let refresh = !self.known || self.running != running;
        self.running = running;
        self.activity_during_job |= self.reading || self.busy;
        if refresh {
            self.refresh_session(false);
        }
    }

    pub(crate) fn observe_usage(&mut self, usage: crate::content::Usage) {
        self.usage = Some(usage);
        self.usage_during_job |= self.reading || self.busy;
    }
    pub fn act(&mut self, action: Action) {
        match action {
            Action::Model(_) => {
                if self.model_locked() {
                    return;
                }
                if self
                    .handle
                    .jobs
                    .try_send(Job::Act(action, self.model_generation))
                    .is_ok()
                {
                    self.busy = true;
                    self.session_error = false;
                    self.sync_error();
                }
            }
            Action::Permission(_, _, _) => {
                if self.permissions_locked() {
                    return;
                }
                let generation = self.permissions_lane.bump();
                if self
                    .handle
                    .permissions
                    .try_send(PendingJob::Act(action, generation))
                    .is_ok()
                {
                    self.attention.invalidate_kind(0);
                    self.permissions_lane.busy = true;
                    self.permissions_lane.hint_during_job = false;
                    self.permissions_lane.error = false;
                    self.sync_error();
                }
            }
            Action::Answer(_, _, _) | Action::Cancel(_) => {
                if self.forms_locked() {
                    return;
                }
                let generation = self.forms_lane.bump();
                if self
                    .handle
                    .forms
                    .try_send(PendingJob::Act(action, generation))
                    .is_ok()
                {
                    self.attention.invalidate_kind(1);
                    self.forms_lane.busy = true;
                    self.forms_lane.hint_during_job = false;
                    self.forms_lane.error = false;
                    self.sync_error();
                }
            }
        }
    }
    pub fn stop(&mut self) {
        if !self.stopping && self.handle.stop.try_send(()).is_ok() {
            self.stopping = true;
            self.stop_error = false;
            self.sync_error();
        }
    }
    pub fn blocked(&self) -> bool {
        self.busy
            || self.permissions_lane.busy
            || self.forms_lane.busy
            || !self.known
            || !self.online
            || self.stopping
    }
    pub fn model_locked(&self) -> bool {
        self.busy || self.reading || !self.online
    }
    pub fn permissions_locked(&self) -> bool {
        self.permissions_lane.locked(self.online)
    }
    pub fn forms_locked(&self) -> bool {
        self.forms_lane.locked(self.online)
    }
    pub fn ids(&self) -> Vec<String> {
        self.permissions
            .iter()
            .map(|p| p.id.clone())
            .chain(self.forms.iter().map(|p| p.id.clone()))
            .collect()
    }
    pub(crate) fn notice_request(&mut self, form: bool, id: String) {
        self.attention.request(form, id);
        if form {
            self.forms_lane.hint_during_job |= self.forms_lane.reading || self.forms_lane.busy;
            self.refresh_forms();
        } else {
            self.permissions_lane.hint_during_job |=
                self.permissions_lane.reading || self.permissions_lane.busy;
            self.refresh_permissions();
        }
        if !self.known {
            self.refresh_session(false);
        }
    }

    pub(crate) fn resolve_request(&mut self, form: bool, id: &str) {
        self.attention.resolve_request(form, id);
        if form {
            self.refresh_forms();
        } else {
            self.refresh_permissions();
        }
    }

    fn apply_session(&mut self, s: Snapshot, generation: u64) {
        let current_activity = !std::mem::take(&mut self.activity_during_job);
        let current_usage = !std::mem::take(&mut self.usage_during_job);
        if self.online {
            self.attention
                .observe_session(s.session_known, s.root_directory.as_deref());
        }
        self.known = s.session_known;
        if generation == self.model_generation {
            self.directory = s.directory;
            if s.session_known {
                self.current = s.current;
                self.confirmed_model_generation = generation;
            }
        }
        if s.session_known {
            if current_usage {
                self.usage = s.usage;
            }
            if current_activity {
                self.running = s.running;
            }
        }
        if let Some(models) = s.models {
            self.models = models;
        }
    }

    fn reconcile_selected(&mut self) {
        let ids = self.ids();
        if !ids.contains(&self.selected) {
            self.selected = ids.first().cloned().unwrap_or_default();
        }
    }

    fn apply_permissions(&mut self, permissions: Option<Vec<Permission>>) {
        let current_requests = !std::mem::take(&mut self.permissions_lane.hint_during_job);
        self.permissions_lane.known = permissions.is_some();
        self.sync_pending_known();
        if let Some(permissions) = permissions {
            if self.online {
                self.attention.observe_kind(
                    0,
                    permissions.iter().map(|p| p.id.clone()),
                    current_requests,
                );
            }
            self.permissions = permissions;
            self.reasons
                .retain(|k, _| self.permissions.iter().any(|p| p.id == *k));
            for p in &self.permissions {
                self.reasons
                    .entry(p.id.clone())
                    .or_insert_with(|| TextEdit::new(""));
            }
        }
        self.reconcile_selected();
    }

    fn apply_forms(&mut self, forms: Option<Vec<Form>>) {
        let current_requests = !std::mem::take(&mut self.forms_lane.hint_during_job);
        self.forms_lane.known = forms.is_some();
        self.sync_pending_known();
        if let Some(forms) = forms {
            if self.online {
                self.attention.observe_kind(
                    1,
                    forms.iter().map(|f| f.id.clone()),
                    current_requests,
                );
            }
            self.forms = forms;
            agent_forms::seed(&self.forms, &mut self.drafts);
        }
        self.reconcile_selected();
    }

    #[cfg(test)]
    fn snapshot(&mut self, mut s: Snapshot, generation: u64) {
        let permissions = s.permissions.take();
        let forms = s.forms.take();
        self.apply_session(s, generation);
        self.apply_permissions(permissions);
        self.apply_forms(forms);
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(result) = self.handle.results.try_recv() {
            match result {
                #[cfg(test)]
                Result::Read(s, catalog, generation) => {
                    self.reading = false;
                    self.permissions_lane.reading = false;
                    self.forms_lane.reading = false;
                    self.session_error |= !s.session_known;
                    self.permissions_lane.error |= s.permissions.is_none();
                    self.forms_lane.error |= s.forms.is_none();
                    self.catalog_error |= catalog && s.models.is_none();
                    self.sync_error();
                    self.snapshot(s, generation)
                }
                Result::Session(s, catalog_dir, catalog, generation) => {
                    self.reading = false;
                    let session_known = s.session_known;
                    self.session_error |= !session_known;
                    if catalog && catalog_dir.is_none() {
                        self.catalog_error = true;
                    }
                    self.sync_error();
                    self.apply_session(s, generation);
                    if catalog && let Some(dir) = catalog_dir {
                        self.refresh_catalog(dir);
                    } else if session_known
                        && self.catalog_directory.is_some()
                        && self.catalog_directory != catalog_dir
                    {
                        self.catalog_generation = self.catalog_generation.wrapping_add(1);
                        self.catalog_directory = catalog_dir;
                        self.catalog_trailing = None;
                    }
                }
                Result::Permissions(permissions, generation) => {
                    self.permissions_lane.reading = false;
                    if generation == self.permissions_lane.generation {
                        self.permissions_lane.error |= permissions.is_none();
                        self.sync_error();
                        self.apply_permissions(permissions);
                    }
                }
                Result::Forms(forms, generation) => {
                    self.forms_lane.reading = false;
                    if generation == self.forms_lane.generation {
                        self.forms_lane.error |= forms.is_none();
                        self.sync_error();
                        self.apply_forms(forms);
                    }
                }
                Result::Catalog(models, directory, generation) => {
                    self.catalog_reading = false;
                    if generation == self.catalog_generation
                        && self.catalog_directory.as_deref() == Some(directory.as_str())
                    {
                        self.catalog_error = models.is_none();
                        self.sync_error();
                        if let Some(models) = models {
                            self.models = models;
                        }
                    }
                }
                Result::Act(ok, s, generation) => {
                    self.busy = false;
                    self.session_error = !ok || !s.session_known;
                    self.sync_error();
                    self.apply_session(s, generation);
                }
                Result::ActPermission(ok, permissions, generation) => {
                    self.permissions_lane.busy = false;
                    let fresh = generation == self.permissions_lane.generation;
                    self.permissions_lane.error = !ok || (fresh && permissions.is_none());
                    self.sync_error();
                    if fresh {
                        self.apply_permissions(permissions);
                    }
                }
                Result::ActForm(ok, forms, generation) => {
                    self.forms_lane.busy = false;
                    let fresh = generation == self.forms_lane.generation;
                    self.forms_lane.error = !ok || (fresh && forms.is_none());
                    self.sync_error();
                    if fresh {
                        self.apply_forms(forms);
                    }
                }
                Result::Stop(ok) => {
                    self.stopping = false;
                    self.stop_error = !ok;
                    self.sync_error();
                    self.refresh(false)
                }
                Result::VerifiedIdle(idle, inactive) => {
                    self.attention
                        .confirm_idle(idle, inactive && self.online && !self.running);
                }
            }
            changed = true;
        }
        if !self.reading && !self.busy {
            if let Some(catalog) = self.trailing.take() {
                self.refresh_session(catalog)
            } else if let Some((id, directory)) = self.attention.verify_idle() {
                let _ = self.handle.jobs.try_send(Job::VerifyIdle(id, directory));
            }
        }
        if !self.permissions_lane.reading
            && !self.permissions_lane.busy
            && std::mem::take(&mut self.permissions_lane.trailing)
        {
            self.dispatch_permissions_read(self.permissions_lane.generation);
        }
        if !self.forms_lane.reading
            && !self.forms_lane.busy
            && std::mem::take(&mut self.forms_lane.trailing)
        {
            self.dispatch_forms_read(self.forms_lane.generation);
        }
        if !self.catalog_reading
            && let Some(directory) = self.catalog_trailing.take()
        {
            self.dispatch_catalog_read(directory, self.catalog_generation);
        }
        changed
    }
}
