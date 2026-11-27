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
impl Claim {
    fn settled(&self) -> bool {
        self.revoked
            && !self.cleaning
            && self.done == Some(true)
            && (!self.alive || !self.sent || self.project.is_some())
    }
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
    fn same_server(claim: &Backend, current: &Backend) -> bool {
        claim.base == current.base
            && match (
                claim.client.server_identity(),
                current.client.server_identity(),
            ) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            }
    }
    pub fn begin(&self, backend: Backend, intent: &str) -> Result<Pending> {
        let request = codenomad_client::http::client_id()?;
        let mut retry_failed = false;
        let generation = {
            let mut state = self.state()?;
            state.entries.retain(|c| c.alive || !c.settled());
            if !state.closed {
                for claim in &mut state.entries {
                    if claim.revoked && !claim.cleaning && claim.done == Some(false) {
                        if Self::same_server(&claim.backend, &backend) {
                            claim.backend.client = backend.client.clone();
                            claim.backend.client_id.clone_from(&backend.client_id);
                        }
                        claim.done = None;
                        retry_failed = true;
                    }
                }
            }
            if state.closed || state.entries.len() >= 16 {
                drop(state);
                if retry_failed {
                    self.schedule();
                }
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
                let was_alive = claim.alive;
                claim.revoked = true;
                claim.alive = false;
                // An early cancel ACK while Pending was still live may have preceded a failed send.
                if was_alive && claim.sent && claim.project.is_none() && claim.done == Some(true) {
                    claim.done = None;
                }
            }
            state.entries.retain(|c| c.alive || !c.settled());
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
                if claim.settled() {
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
                    .filter(|c| c.done != Some(true) || (c.alive && c.sent && c.project.is_none()))
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
        self.state()
            .is_ok_and(|s| s.entries.iter().all(|c| !c.revoked || c.settled()))
    }
    pub fn retry_cleanup(&self, current: Option<&Backend>) {
        if let Ok(mut state) = self.state() {
            for claim in &mut state.entries {
                if claim.revoked && !claim.cleaning && claim.done == Some(false) {
                    if let Some(current) = current
                        && Self::same_server(&claim.backend, current)
                    {
                        claim.backend.client = current.client.clone();
                        claim.backend.client_id.clone_from(&current.client_id);
                    }
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
                    state.entries.retain(|c| c.alive || !c.settled());
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

    fn opening_fixture_server(
        cancel_status: std::sync::Arc<std::sync::atomic::AtomicU16>,
        cancel_hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> (
        String,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        use std::sync::atomic::Ordering::SeqCst;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = format!("http://{}/", listener.local_addr().unwrap());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_flag = stop.clone();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !stop_flag.load(SeqCst) && std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let _ = socket.set_nonblocking(false);
                        let _ = socket.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                        let _ = socket.set_write_timeout(Some(std::time::Duration::from_secs(2)));
                        let mut req = Vec::new();
                        let mut byte = [0u8; 1];
                        while !req.ends_with(b"\r\n\r\n") && req.len() < 16384 {
                            if socket.read(&mut byte).unwrap_or(0) == 0 {
                                break;
                            }
                            req.push(byte[0]);
                        }
                        let text = String::from_utf8_lossy(&req);
                        let length = text
                            .lines()
                            .filter_map(|line| line.split_once(':'))
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if length > 0 && length <= 65536 {
                            let mut body = vec![0u8; length];
                            let _ = socket.read_exact(&mut body);
                        }
                        let is_cancel = text
                            .lines()
                            .next()
                            .is_some_and(|line| line.contains("/api/workspaces/creation/cancel"));
                        let (status, body) = if is_cancel {
                            cancel_hits.fetch_add(1, SeqCst);
                            let expected = cancel_status.load(SeqCst);
                            let has_fresh_cookie = text.lines().any(|line| {
                                line.split_once(':').is_some_and(|(k, v)| {
                                    k.eq_ignore_ascii_case("cookie")
                                        && v.contains("cn_session=fresh")
                                })
                            });
                            if expected == 204 || (expected == 401 && has_fresh_cookie) {
                                ("204 No Content", "")
                            } else if expected == 401 {
                                ("401 Unauthorized", r#"{"error":"unauthorized"}"#)
                            } else {
                                ("503 Service Unavailable", r#"{"error":"unavailable"}"#)
                            }
                        } else {
                            ("500 Internal Server Error", r#"{"error":"boom"}"#)
                        };
                        let resp = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(resp.as_bytes());
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        (addr, stop, handle)
    }

    fn backend_at(base: String) -> Backend {
        Backend {
            client: codenomad_client::http::Http::new().unwrap(),
            base,
            workspace: String::new(),
            session: String::new(),
            client_id: "fixture".into(),
            session_directory: None,
            fresh_mode: false,
        }
    }

    #[test]
    fn failed_openings_release_admission_slots_once_cleanup_settles_after_drop() {
        use std::sync::{
            Arc,
            atomic::{AtomicU16, AtomicUsize, Ordering::SeqCst},
        };

        let cancel_status = Arc::new(AtomicU16::new(204));
        let cancel_hits = Arc::new(AtomicUsize::new(0));
        let (base, stop, handle) = opening_fixture_server(cancel_status, cancel_hits.clone());
        let owner = Openings::default();
        let backend = backend_at(base);

        for attempt in 0..18 {
            let pending = owner
                .begin(backend.clone(), "tab-0")
                .unwrap_or_else(|e| panic!("attempt {attempt} must obtain a slot: {e}"));
            assert!(crate::platform::block_on(pending.create("/fixture")).is_err());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !owner.settled() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "attempt {attempt} cleanup did not settle"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        assert!(owner.settled());
        assert!(owner.pending().is_empty());
        assert_eq!(cancel_hits.load(SeqCst), 18);
        assert!(owner.departure().is_empty());

        stop.store(true, SeqCst);
        handle.join().unwrap();
    }

    #[test]
    fn failed_cleanups_retry_on_reconnect_and_begin_to_reclaim_slots() {
        use std::sync::{
            Arc,
            atomic::{AtomicU16, AtomicUsize, Ordering::SeqCst},
        };

        let cancel_status = Arc::new(AtomicU16::new(503));
        let cancel_hits = Arc::new(AtomicUsize::new(0));
        let (base, stop, handle) =
            opening_fixture_server(cancel_status.clone(), cancel_hits.clone());
        let owner = Openings::default();
        let backend = backend_at(base);

        for _ in 0..16 {
            let pending = owner.begin(backend.clone(), "tab-0").unwrap();
            assert!(crate::platform::block_on(pending.create("/fixture")).is_err());
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while owner
            .state()
            .unwrap()
            .entries
            .iter()
            .any(|c| c.cleaning || c.done != Some(false))
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(!owner.settled());

        // 1. Server recovers: beginning a new opening retries failed cleanups, then slots free up.
        cancel_status.store(204, SeqCst);
        assert!(owner.begin(backend.clone(), "tab-0").is_err());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !owner.settled() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let recovered = owner.begin(backend.clone(), "tab-0").unwrap();
        owner.state().unwrap().entries.clear();
        drop(recovered);

        // 2. Reconnect path (`retry_cleanup`) refreshes rotated session cookies and frees the slot.
        cancel_status.store(401, SeqCst);
        let stale = Backend {
            client: codenomad_client::http::Http::with_session_cookie(
                &backend.base,
                "cn_session",
                "stale",
            )
            .unwrap(),
            ..backend.clone()
        };
        let pending = owner.begin(stale, "tab-1").unwrap();
        assert!(crate::platform::block_on(pending.create("/fixture")).is_err());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while owner
            .state()
            .unwrap()
            .entries
            .iter()
            .any(|c| c.cleaning || c.done != Some(false))
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(!owner.settled());
        let renewed = Backend {
            client: codenomad_client::http::Http::with_session_cookie(
                &backend.base,
                "cn_session",
                "fresh",
            )
            .unwrap(),
            ..backend.clone()
        };
        owner.retry_cleanup(Some(&renewed));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !owner.settled() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(owner.pending().is_empty());

        stop.store(true, SeqCst);
        handle.join().unwrap();
    }

    #[test]
    fn early_cancel_before_failed_send_rechecks_cleanup_after_pending_drops() {
        use std::sync::{
            Arc,
            atomic::{AtomicU16, AtomicUsize, Ordering::SeqCst},
        };

        let cancel_status = Arc::new(AtomicU16::new(204));
        let cancel_hits = Arc::new(AtomicUsize::new(0));
        let (base, stop, handle) = opening_fixture_server(cancel_status, cancel_hits.clone());
        let owner = Openings::default();
        let pending = owner.begin(backend_at(base), "tab-0").unwrap();
        {
            let mut state = owner.state().unwrap();
            let claim = &mut state.entries[0];
            claim.sent = true;
            claim.revoked = true;
            claim.done = Some(true);
        }
        assert!(!owner.settled());
        drop(pending);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !owner.settled() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(cancel_hits.load(SeqCst), 1);
        assert!(owner.pending().is_empty());

        stop.store(true, SeqCst);
        handle.join().unwrap();
    }
}
