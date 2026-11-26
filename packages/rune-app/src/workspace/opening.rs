use crate::{backend::Backend, catalog::Project, history::Result, platform};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Clone, Default)]
pub struct Openings(Arc<Mutex<Claims>>);
#[derive(Default)]
struct Claims {
    closed: bool,
    cleanup_allowed: bool,
    #[cfg(any(target_arch = "wasm32", test))]
    departed: bool,
    generation: u64,
    entries: Vec<Claim>,
}
struct Claim {
    backend: Backend,
    request: String,
    intent: String,
    generation: u64,
    project: Option<String>,
    sent: bool,
    alive: bool,
    revoked: bool,
    cleaning: bool,
    done: Option<bool>,
}
#[derive(Clone)]
pub struct Cleanup {
    pub backend: Backend,
    pub request: String,
    pub project: Option<String>,
}
pub struct Pending {
    owner: Openings,
    backend: Backend,
    request: String,
    generation: u64,
    transferred: bool,
}
pub struct Opening {
    pub backend: Backend,
    pub project: Project,
    pending: Pending,
}

impl Openings {
    fn state(&self) -> Result<MutexGuard<'_, Claims>> {
        self.0
            .lock()
            .map_err(|_| "opening owner unavailable".into())
    }
    pub fn begin(&self, backend: Backend, intent: &str) -> Result<Pending> {
        let request = codenomad_client::http::client_id()?;
        let generation = {
            let mut state = self.state()?;
            state.entries.retain(|c| {
                c.alive || c.cleaning || c.done != Some(true) || c.sent && c.project.is_none()
            });
            if state.closed || state.entries.len() >= 16 {
                return Err("opening admission unavailable".into());
            }
            for claim in &mut state.entries {
                if claim.intent == intent {
                    claim.revoked = true;
                }
            }
            state.generation += 1;
            let generation = state.generation;
            state.entries.push(Claim {
                backend: backend.clone(),
                request: request.clone(),
                intent: intent.into(),
                generation,
                project: None,
                sent: false,
                alive: true,
                revoked: false,
                cleaning: false,
                done: None,
            });
            generation
        };
        self.schedule();
        Ok(Pending {
            owner: self.clone(),
            backend,
            request,
            generation,
            transferred: false,
        })
    }
    fn current(&self, request: &str, generation: u64) -> bool {
        self.state().is_ok_and(|s| {
            !s.closed
                && s.entries
                    .iter()
                    .any(|c| c.request == request && c.generation == generation && !c.revoked)
        })
    }
    fn confirmed(&self, request: &str, id: &str) -> Result<()> {
        let mut state = self.state()?;
        let claim = state
            .entries
            .iter_mut()
            .find(|c| c.request == request)
            .ok_or("opening receipt owner unavailable")?;
        if claim.project.as_deref() != Some(id) {
            claim.done = None;
        }
        claim.project = Some(id.into());
        Ok(())
    }
    fn refused(&self, request: &str) {
        if let Ok(mut state) = self.state() {
            state.entries.retain(|claim| claim.request != request);
        }
    }
    fn transfer(&self, request: &str, generation: u64) -> Result<()> {
        let mut state = self.state()?;
        let index = state.entries.iter().position(|c| {
            c.request == request && c.generation == generation && !c.revoked && c.project.is_some()
        });
        if state.closed || index.is_none() {
            return Err("opening intent expired".into());
        }
        if let Some(index) = index {
            state.entries.remove(index);
        }
        Ok(())
    }
    fn revoke(&self, request: &str) {
        if let Ok(mut state) = self.state() {
            if let Some(claim) = state.entries.iter_mut().find(|c| c.request == request) {
                claim.revoked = true;
                claim.alive = false;
            }
        }
        self.schedule();
    }
    pub fn revoke_intent(&self, intent: &str) {
        if let Ok(mut state) = self.state() {
            for claim in &mut state.entries {
                if claim.intent == intent {
                    claim.revoked = true;
                }
            }
        }
        self.schedule();
    }
    pub fn close(&self) {
        if let Ok(mut state) = self.state() {
            state.closed = true;
            for claim in &mut state.entries {
                claim.revoked = true;
            }
        }
    }
    #[cfg(any(target_arch = "wasm32", test))]
    pub fn departure(&self) -> Vec<Cleanup> {
        let Ok(mut state) = self.state() else {
            return Vec::new();
        };
        if state.departed {
            return Vec::new();
        }
        state.closed = true;
        state.cleanup_allowed = true;
        state.departed = true;
        state
            .entries
            .iter_mut()
            .filter_map(|claim| {
                claim.revoked = true;
                if claim.done == Some(true) && (!claim.sent || claim.project.is_some()) {
                    return None;
                }
                Some(Cleanup {
                    backend: claim.backend.clone(),
                    request: claim.request.clone(),
                    project: claim.project.clone(),
                })
            })
            .collect()
    }
    pub fn allow_cleanup(&self) {
        if let Ok(mut state) = self.state() {
            if !state.cleanup_allowed {
                state.cleanup_allowed = true;
                for claim in &mut state.entries {
                    if claim.done == Some(false) {
                        claim.done = None;
                    }
                }
            }
        }
        self.schedule();
    }
    pub fn pending(&self) -> Vec<Cleanup> {
        self.state()
            .map(|s| {
                s.entries
                    .iter()
                    .filter(|c| c.done != Some(true) || c.sent && c.project.is_none())
                    .map(|c| Cleanup {
                        backend: c.backend.clone(),
                        request: c.request.clone(),
                        project: c.project.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn settled(&self) -> bool {
        self.state().is_ok_and(|s| {
            s.entries
                .iter()
                .all(|c| !c.revoked || c.done == Some(true) && (!c.sent || c.project.is_some()))
        })
    }
    pub fn retry_cleanup(&self) {
        if let Ok(mut state) = self.state() {
            for claim in &mut state.entries {
                if claim.revoked && claim.done == Some(false) {
                    claim.done = None;
                }
            }
        }
        self.schedule();
    }
    fn schedule(&self) {
        let jobs = {
            let Ok(mut state) = self.state() else {
                return;
            };
            if state.closed && !state.cleanup_allowed {
                return;
            }
            state
                .entries
                .iter_mut()
                .filter_map(|c| {
                    if !c.revoked || c.cleaning || c.done.is_some() {
                        return None;
                    }
                    c.cleaning = true;
                    Some(Cleanup {
                        backend: c.backend.clone(),
                        request: c.request.clone(),
                        project: c.project.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };
        for job in jobs {
            let owner = self.clone();
            platform::spawn(async move {
                let cancelled = job
                    .backend
                    .cancel_project_creation(&job.request)
                    .await
                    .is_ok();
                let ok = cancelled
                    || match &job.project {
                        Some(id) => job.backend.release_project(id).await.is_ok(),
                        None => false,
                    };
                let mut retry = false;
                if let Ok(mut state) = owner.state() {
                    if let Some(claim) = state.entries.iter_mut().find(|c| c.request == job.request)
                    {
                        claim.cleaning = false;
                        claim.done = Some(ok);
                        if claim.project.is_some() && claim.project != job.project {
                            claim.done = None;
                            retry = true;
                        }
                    }
                }
                if retry {
                    owner.schedule();
                }
            });
        }
    }
}
impl Pending {
    pub fn request_id(&self) -> &str {
        &self.request
    }
    pub async fn create(self, path: &str) -> Result<Opening> {
        {
            let mut state = self.owner.state()?;
            if state.closed {
                return Err("opening intent expired".into());
            }
            let claim = state
                .entries
                .iter_mut()
                .find(|c| {
                    c.request == self.request && c.generation == self.generation && !c.revoked
                })
                .ok_or("opening intent expired")?;
            claim.sent = true;
        }
        let project = match self.backend.create_project(path, &self.request).await {
            Ok(project) => project,
            Err(error) => {
                if error.is::<codenomad_client::catalog::CreationRefused>() {
                    self.owner.refused(&self.request);
                }
                return Err(error);
            }
        };
        self.owner.confirmed(&self.request, &project.id)?;
        if !self.owner.current(&self.request, self.generation) {
            return Err("opening intent expired".into());
        }
        Ok(Opening {
            backend: self.backend.clone(),
            project,
            pending: self,
        })
    }
    #[cfg(test)]
    pub(crate) fn fixture_opening(self, project: Project) -> Opening {
        let _ = self.owner.confirmed(&self.request, &project.id);
        Opening {
            backend: self.backend.clone(),
            project,
            pending: self,
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        if !self.transferred {
            self.owner.revoke(&self.request);
        }
    }
}
impl Opening {
    pub fn adopt(mut self) -> Result<()> {
        self.pending
            .owner
            .transfer(&self.pending.request, self.pending.generation)?;
        self.pending.transferred = true;
        let (backend, request, id) = (
            self.backend.clone(),
            self.pending.request.clone(),
            self.project.id.clone(),
        );
        platform::spawn(async move {
            let _ = backend.release_project_creation(&id, &request).await;
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn backend() -> Backend {
        Backend {
            client: codenomad_client::http::Http::new().unwrap(),
            base: "http://127.0.0.1:9/".into(),
            workspace: String::new(),
            session: String::new(),
            client_id: "fixture".into(),
            session_directory: None,
            fresh_mode: false,
        }
    }
    #[test]
    fn a_late_record_is_new_cleanup_authority_after_a_successful_early_cancel() {
        let owner = Openings::default();
        let pending = owner.begin(backend(), "tab-0").unwrap();
        let request = pending.request_id().to_string();
        owner.close();
        {
            let mut state = owner.state().unwrap();
            let claim = &mut state.entries[0];
            claim.sent = true;
            claim.done = Some(true);
        }
        assert!(
            !owner.settled(),
            "an early ACK does not settle a sent creation without a receipt"
        );
        owner.confirmed(&request, "late-owned-id").unwrap();
        assert_eq!(owner.state().unwrap().entries[0].done, None);
        assert!(!owner.current(&request, pending.generation));
        assert_eq!(owner.pending()[0].project.as_deref(), Some("late-owned-id"));
    }
    #[test]
    fn closed_admission_fences_dispatch_before_any_network_request() {
        let owner = Openings::default();
        let pending = owner.begin(backend(), "tab-0").unwrap();
        owner.close();
        assert!(crate::platform::block_on(pending.create("/fixture")).is_err());
        assert!(owner.begin(backend(), "tab-1").is_err());
        assert!(!owner.state().unwrap().entries[0].sent);
    }
    #[test]
    fn unstaged_departure_keeps_exact_rights_and_is_idempotent() {
        let owner = Openings::default();
        let pending = owner.begin(backend(), "tab-0").unwrap();
        let cleanup = owner.departure();
        assert_eq!(cleanup.len(), 1);
        assert_eq!(cleanup[0].request, pending.request);
        assert_eq!(cleanup[0].backend.base, pending.backend.base);
        assert!(cleanup[0].project.is_none());
        assert!(!owner.current(&pending.request, pending.generation));
        assert!(owner.begin(backend(), "tab-1").is_err());
        assert!(owner.departure().is_empty());
        // Suppress actual IO when this pure admission proof drops its guard.
        owner.state().unwrap().cleanup_allowed = false;
    }
}
