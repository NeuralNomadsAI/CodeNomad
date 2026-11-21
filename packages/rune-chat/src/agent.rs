//! Session-owned controls. Stop has a separate HTTP lane from catalogue and request reads.
use crate::{
    agent_api::{Action, Form, Model, Permission, Snapshot},
    agent_forms::{self, Drafts},
    backend::Backend,
};
use rune::edit::TextEdit;
use std::sync::mpsc::{self, Receiver, SyncSender};
enum Job {
    Read(bool),
    Act(Action),
}
enum Result {
    Read(Snapshot, bool),
    Act(bool, Snapshot),
    Stop(bool),
}
pub fn navigation_blocked(s: &crate::State) -> bool {
    s.agent.as_ref().is_some_and(|a| {
        a.busy
            || a.stopping
            || a.drafts.values().any(|d| d.dirty)
            || a.reasons.values().any(|d| !d.text.is_empty())
    })
}
pub struct Handle {
    jobs: SyncSender<Job>,
    stop: SyncSender<()>,
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
    reading: bool,
    trailing: Option<bool>,
}
pub fn start(backend: Backend, wake: rune::Waker) -> Handle {
    let (jobs, rx) = mpsc::sync_channel(1);
    let (stop, srx) = mpsc::sync_channel(1);
    let (out, results) = mpsc::sync_channel(8);
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    std::thread::spawn(move || {
        while srx.recv().is_ok() {
            if o.send(Result::Stop(b.interrupt().is_ok())).is_err() {
                break;
            }
            w();
        }
    });
    std::thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            let result = match job {
                Job::Read(catalog) => Result::Read(backend.agent_snapshot(catalog), catalog),
                Job::Act(action) => {
                    let ok = backend.agent_action(&action).is_ok();
                    Result::Act(ok, backend.agent_snapshot(false))
                }
            };
            if out.send(result).is_err() {
                break;
            }
            wake();
        }
    });
    Handle {
        jobs,
        stop,
        results,
    }
}
impl Ui {
    pub fn idle(&self) -> bool {
        !self.reading && !self.busy && !self.stopping && self.trailing.is_none()
    }
    pub fn new(handle: Handle) -> Self {
        let mut ui = Self {
            handle,
            models: vec![],
            current: None,
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
            reading: false,
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
        if self.handle.jobs.try_send(Job::Read(catalog)).is_ok() {
            self.reading = true
        }
    }
    pub fn act(&mut self, action: Action) {
        if self.locked() {
            return;
        }
        if self.handle.jobs.try_send(Job::Act(action)).is_ok() {
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
    fn snapshot(&mut self, s: Snapshot) {
        self.known = s.session_known;
        if s.session_known {
            self.current = s.current;
            self.running = s.running
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
                Result::Read(s, catalog) => {
                    self.reading = false;
                    self.error |= !s.session_known
                        || s.permissions.is_none()
                        || s.forms.is_none()
                        || (catalog && s.models.is_none());
                    self.snapshot(s)
                }
                Result::Act(ok, s) => {
                    self.busy = false;
                    self.error =
                        !ok || !s.session_known || s.permissions.is_none() || s.forms.is_none();
                    self.snapshot(s)
                }
                Result::Stop(ok) => {
                    self.stopping = false;
                    self.error = !ok;
                    self.refresh(false)
                }
            }
            changed = true;
        }
        if !self.reading && !self.busy {
            if let Some(catalog) = self.trailing.take() {
                self.refresh(catalog)
            }
        }
        changed
    }
}
