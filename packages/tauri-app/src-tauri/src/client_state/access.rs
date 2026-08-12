use std::sync::Mutex;
use url::Url;

#[derive(Default)]
pub(super) struct RendererAccess {
    state: Mutex<RendererAccessState>,
}

#[derive(Default)]
struct RendererAccessState {
    token: Option<String>,
    committed_origin: Option<String>,
    pending_origin: Option<String>,
    generation: u64,
}

pub(super) struct PendingNavigation {
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
    pub(super) fn claim(&self, access_token: &str, renderer_url: &Url) -> Result<(), String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let renderer_origin = origin_key(renderer_url)?;
        let mut state = self.state.lock().map_err(|err| err.to_string())?;
        if state.pending_origin.as_deref() == Some(renderer_origin.as_str()) {
            state.token = Some(access_token.to_string());
            state.committed_origin = Some(renderer_origin);
            state.pending_origin = None;
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
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let renderer_origin = origin_key(renderer_url)?;
        let state = self.state.lock().map_err(|err| err.to_string())?;
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
        self.state
            .lock()
            .map(|state| state.generation == generation)
            .unwrap_or(false)
    }

    pub(super) fn begin_navigation(
        &self,
        target_url: Option<&Url>,
    ) -> Result<PendingNavigation, String> {
        let mut state = self.state.lock().map_err(|err| err.to_string())?;
        let previous_origin = state.pending_origin.clone();
        let staged_origin = match target_url {
            Some(url) => Some(origin_key(url)?),
            None => previous_origin
                .clone()
                .or_else(|| state.committed_origin.clone()),
        };
        state.pending_origin = staged_origin.clone();
        Ok(PendingNavigation {
            previous_origin,
            staged_origin,
        })
    }

    pub(super) fn cancel_navigation(&self, navigation: PendingNavigation) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.pending_origin == navigation.staged_origin {
            state.pending_origin = navigation.previous_origin;
        }
    }

    pub(super) fn begin_document(&self, trusted_url: Option<&Url>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|err| err.to_string())?;
        state.token = None;
        state.committed_origin = None;
        state.pending_origin = trusted_url.map(origin_key).transpose()?;
        state.generation = state.generation.wrapping_add(1);
        Ok(())
    }

    pub(super) fn is_claimed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.token.is_some())
            .unwrap_or(false)
    }
}
