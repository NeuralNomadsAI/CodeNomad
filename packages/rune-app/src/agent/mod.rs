//! Session-owned controls. Stop has a separate HTTP lane from catalogue and request reads.
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
enum Result {
    Read(Snapshot, bool, u64),
    Act(bool, Snapshot, u64),
    Stop(bool),
    VerifiedIdle(String, bool),
}
pub fn navigation_blocked(s: &crate::State) -> bool {
    s.agent.as_ref().is_some_and(Ui::navigation_blocked)
}
pub struct Handle {
    connection: Option<codenomad_client::http::Http>,
    jobs: Sender<Job>,
    stop: Sender<()>,
    results: Receiver<Result>,
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
    pub known: bool,
    pub running: bool,
    pub pending_known: bool,
    pub online: bool,
    pub(crate) attention: crate::shell::notifications::Attention,
    reading: bool,
    activity_during_job: bool,
    request_during_job: bool,
    usage_during_job: bool,
    trailing: Option<bool>,
}
pub fn start(backend: Backend, wake: rune::Waker) -> Handle {
    let (jobs, rx) = bounded(1);
    let (stop, srx) = bounded(1);
    let (out, results) = bounded(8);
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
    crate::platform::spawn(async move {
        while let Ok(job) = rx.recv().await {
            let result = match job {
                Job::Read(catalog, generation) => {
                    Result::Read(backend.agent_snapshot(catalog).await, catalog, generation)
                }
                Job::Act(action, generation) => {
                    let ok = backend.agent_action(&action).await.is_ok();
                    Result::Act(ok, backend.agent_snapshot(false).await, generation)
                }
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

    pub fn rebind(&mut self, handle: Handle) {
        self.handle = handle;
        self.reading = false;
        self.activity_during_job = false;
        self.request_during_job = false;
        self.usage_during_job = false;
        self.trailing = None;
        self.busy = false;
        self.stopping = false;
        self.error = false;
        self.running = false;
        self.known = false;
        self.pending_known = false;
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
        self.error = false;
        self.refresh(true)
    }
    pub fn choose_model(&mut self, reference: serde_json::Value) {
        if !self.models.iter().any(|model| model.reference == reference) {
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
        !self.reading && !self.busy && !self.stopping && self.trailing.is_none()
    }
    #[cfg(test)]
    pub(crate) fn fixture_ready(&mut self) {
        self.reading = false;
        self.known = true;
        self.pending_known = true;
        self.online = true;
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
            known: false,
            running: false,
            pending_known: false,
            online: false,
            attention: Default::default(),
            reading: false,
            activity_during_job: false,
            request_during_job: false,
            usage_during_job: false,
            trailing: None,
        };
        ui.refresh(true);
        ui
    }
    pub fn refresh(&mut self, catalog: bool) {
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

    pub(crate) fn refresh_usage_model(&mut self, generation: u64) {
        if generation != self.model_generation {
            self.model_generation = generation;
            self.refresh(false);
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
            self.refresh(false);
        }
    }

    pub(crate) fn observe_usage(&mut self, usage: crate::content::Usage) {
        self.usage = Some(usage);
        self.usage_during_job |= self.reading || self.busy;
    }
    pub fn act(&mut self, action: Action) {
        if self.locked() {
            return;
        }
        if self
            .handle
            .jobs
            .try_send(Job::Act(action, self.model_generation))
            .is_ok()
        {
            self.busy = true;
            self.error = false
        }
    }
    pub fn stop(&mut self) {
        if !self.stopping && self.handle.stop.try_send(()).is_ok() {
            self.stopping = true;
            self.error = false
        }
    }
    pub fn blocked(&self) -> bool {
        self.busy || !self.known || !self.online || self.stopping
    }
    pub fn locked(&self) -> bool {
        self.busy || self.reading || !self.pending_known || !self.online
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
        self.request_during_job |= self.reading || self.busy;
        self.refresh(false);
    }

    fn snapshot(&mut self, s: Snapshot, generation: u64) {
        let current_activity = !std::mem::take(&mut self.activity_during_job);
        let current_requests = !std::mem::take(&mut self.request_during_job);
        if self.online {
            self.attention.observe(&s, current_requests);
        }
        let current_usage = !std::mem::take(&mut self.usage_during_job);
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
            self.models = models
        }
        self.pending_known = s.permissions.is_some() && s.forms.is_some();
        if let Some(permissions) = s.permissions {
            self.permissions = permissions;
            self.reasons
                .retain(|k, _| self.permissions.iter().any(|p| p.id == *k));
            for p in &self.permissions {
                self.reasons
                    .entry(p.id.clone())
                    .or_insert_with(|| TextEdit::new(""));
            }
        }
        if let Some(forms) = s.forms {
            self.forms = forms;
            agent_forms::seed(&self.forms, &mut self.drafts)
        }
        let ids = self.ids();
        if !ids.contains(&self.selected) {
            self.selected = ids.first().cloned().unwrap_or_default()
        }
    }
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(result) = self.handle.results.try_recv() {
            match result {
                Result::Read(s, catalog, generation) => {
                    self.reading = false;
                    self.error |= !s.session_known
                        || s.permissions.is_none()
                        || s.forms.is_none()
                        || (catalog && s.models.is_none());
                    self.snapshot(s, generation)
                }
                Result::Act(ok, s, generation) => {
                    self.busy = false;
                    self.error =
                        !ok || !s.session_known || s.permissions.is_none() || s.forms.is_none();
                    self.snapshot(s, generation)
                }
                Result::Stop(ok) => {
                    self.stopping = false;
                    self.error = !ok;
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
                self.refresh(catalog)
            } else if let Some((id, directory)) = self.attention.verify_idle() {
                let _ = self.handle.jobs.try_send(Job::VerifyIdle(id, directory));
            }
        }
        changed
    }
}
