use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use url::Url;

#[derive(Default)]
pub(super) struct RendererAccess {
    state: Mutex<HashMap<String, RendererAccessState>>,
    sequence: AtomicU64,
}

#[derive(Default)]
struct RendererAccessState {
    token: Option<String>,
    retired_token: Option<String>,
    committed_origin: Option<String>,
    pending_origin: Option<String>,
    generation: u64,
    document: u64,
    challenge: Option<(uuid::Uuid, String)>,
}

pub(super) struct PendingNavigation {
    window_id: String,
    previous_origin: Option<String>,
    staged_origin: Option<String>,
}

fn origin_key(url: &Url) -> Result<String, String> {
    match (url.scheme(), url.host_str()) {
        ("http" | "https", Some(_)) => Ok(url.origin().ascii_serialization()),
        ("tauri" | "asset", Some(host)) => Ok(format!("{}://{}", url.scheme(), host)),
        _ => Err("Client state renderer URL does not have a supported origin".to_string()),
    }
}

impl RendererAccess {
    fn next(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(super) fn document_for(&self, window_id: &str) -> u64 {
        let mut states = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let state = states.entry(window_id.to_owned()).or_default();
        if state.document == 0 {
            state.document = self.next();
        }
        state.document
    }

    pub(super) fn document_is_current(&self, window_id: &str, document: u64) -> bool {
        self.state.lock().is_ok_and(|states| {
            states.get(window_id).is_some_and(|state| state.document == document)
        })
    }

    pub(super) fn page_started(&self, window_id: &str, allowed_url: Option<&Url>) {
        let mut states = self.state.lock().unwrap_or_else(|err| err.into_inner());
        let state = states.entry(window_id.to_owned()).or_default();
        let document = self.next();
        state.document = document;
        state.challenge = None;
        state.generation = document;
        if let Some(token) = state.token.take() {
            state.retired_token = Some(token);
        }
        state.committed_origin = None;
        state.pending_origin = allowed_url.and_then(|url| origin_key(url).ok());
    }

    pub(super) fn document_challenge(&self, window_id: &str, url: &Url) -> Option<uuid::Uuid> {
        let origin = origin_key(url).ok()?;
        let mut states = self.state.lock().ok()?;
        let state = states.get_mut(window_id)?;
        let (nonce, bound_origin) = state.challenge.get_or_insert_with(|| (uuid::Uuid::new_v4(), origin.clone()));
        (*bound_origin == origin).then_some(*nonce)
    }

    pub(super) fn challenged_document(&self, window_id: &str, challenge: &str, url: &Url) -> Result<u64, String> {
        let origin = origin_key(url)?;
        let challenge = uuid::Uuid::parse_str(challenge).ok();
        self.state.lock().ok().and_then(|states| {
            let state = states.get(window_id)?;
            let (nonce, bound_origin) = state.challenge.as_ref()?;
            (challenge.as_ref() == Some(nonce) && bound_origin == &origin).then_some(state.document)
        }).ok_or_else(|| "Client state renderer document retired".to_string())
    }

    pub(super) fn claim(&self, access_token: &str, renderer_url: &Url) -> Result<(), String> {
        self.claim_for("test-window", access_token, renderer_url)
    }

    pub(super) fn claim_for(
        &self,
        window_id: &str,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<(), String> {
        self.claim_in_document(window_id, self.document_for(window_id), access_token, renderer_url)
    }

    pub(super) fn claim_in_document(
        &self,
        window_id: &str,
        document: u64,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<(), String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let renderer_origin = origin_key(renderer_url)?;
        let mut states = self.state.lock().map_err(|err| err.to_string())?;
        let state = states.get_mut(window_id).filter(|state| state.document == document)
            .ok_or("Client state renderer document retired")?;
        if state.retired_token.as_deref() == Some(access_token) {
            return Err("Client state renderer document retired".into());
        }
        if state.token.is_none() {
            state.token = Some(access_token.to_string());
            state.committed_origin = Some(renderer_origin);
            state.pending_origin = None;
            state.generation = self.next();
            return Ok(());
        }
        if state.token.as_deref() != Some(access_token) {
            return Err("Client state access token does not match this renderer".to_string());
        }
        if state.committed_origin.as_deref() == Some(renderer_origin.as_str()) {
            Ok(())
        } else {
            Err("Client state renderer origin changed without access rotation".to_string())
        }
    }

    pub(super) fn validate(&self, access_token: &str, renderer_url: &Url) -> Result<u64, String> {
        self.validate_for("test-window", access_token, renderer_url)
    }

    pub(super) fn validate_for(
        &self,
        window_id: &str,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<u64, String> {
        self.validate_in_document(window_id, self.document_for(window_id), access_token, renderer_url)
    }

    pub(super) fn validate_in_document(
        &self,
        window_id: &str,
        document: u64,
        access_token: &str,
        renderer_url: &Url,
    ) -> Result<u64, String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let renderer_origin = origin_key(renderer_url)?;
        let states = self.state.lock().map_err(|err| err.to_string())?;
        let Some(state) = states.get(window_id) else {
            return Err("Client state access has not been claimed by this renderer".to_string());
        };
        if state.document != document {
            return Err("Client state renderer document retired".into());
        }
        if state.token.as_deref() == Some(access_token)
            && state.committed_origin.as_deref() == Some(renderer_origin.as_str())
        {
            return Ok(state.generation);
        }
        match state.token.as_deref() {
            Some(current) if current == access_token => {
                Err("Client state renderer origin does not match this renderer".to_string())
            }
            Some(_) => Err("Client state access token does not match this renderer".to_string()),
            None => Err("Client state access has not been claimed by this renderer".to_string()),
        }
    }

    pub(super) fn is_generation_current(&self, generation: u64) -> bool {
        self.is_generation_current_for("test-window", generation)
    }

    pub(super) fn is_generation_current_for(&self, window_id: &str, generation: u64) -> bool {
        self.state
            .lock()
            .map(|state| {
                state
                    .get(window_id)
                    .is_some_and(|state| state.generation == generation)
            })
            .unwrap_or(false)
    }

    pub(super) fn allows_claim_origin_for(&self, window_id: &str, renderer_url: &Url) -> bool {
        let Ok(renderer_origin) = origin_key(renderer_url) else {
            return false;
        };
        self.state
            .lock()
            .map(|states| {
                states.get(window_id).is_some_and(|state| {
                    state.committed_origin.as_deref() == Some(renderer_origin.as_str())
                        || state.pending_origin.as_deref() == Some(renderer_origin.as_str())
                })
            })
            .unwrap_or(false)
    }

    pub(super) fn begin_navigation(
        &self,
        target_url: Option<&Url>,
    ) -> Result<PendingNavigation, String> {
        self.begin_navigation_for("test-window", target_url)
    }

    pub(super) fn begin_navigation_for(
        &self,
        window_id: &str,
        target_url: Option<&Url>,
    ) -> Result<PendingNavigation, String> {
        let mut states = self.state.lock().map_err(|err| err.to_string())?;
        let state = states.entry(window_id.to_string()).or_default();
        let previous_origin = state.pending_origin.clone();
        let staged_origin = match target_url {
            Some(url) => Some(origin_key(url)?),
            None => previous_origin
                .clone()
                .or_else(|| state.committed_origin.clone()),
        };
        state.pending_origin = staged_origin.clone();
        Ok(PendingNavigation {
            window_id: window_id.to_string(),
            previous_origin,
            staged_origin,
        })
    }

    pub(super) fn cancel_navigation(&self, navigation: PendingNavigation) {
        let mut states = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(state) = states.get_mut(&navigation.window_id) {
            if state.pending_origin == navigation.staged_origin {
                state.pending_origin = navigation.previous_origin;
            }
        }
    }

    pub(super) fn is_claimed_for(&self, window_id: &str) -> bool {
        self.state
            .lock()
            .map(|state| {
                state
                    .get(window_id)
                    .is_some_and(|state| state.token.is_some())
            })
            .unwrap_or(false)
    }

    pub(super) fn remove(&self, window_id: &str) {
        if let Ok(mut states) = self.state.lock() {
            states.remove(window_id);
        }
    }

}
