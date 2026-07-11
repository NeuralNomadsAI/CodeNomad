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
        match state.token.as_deref() {
            Some(current)
                if current == access_token
                    && state.committed_origin.as_deref() == Some(renderer_origin.as_str()) =>
            {
                Ok(())
            }
            Some(_) if state.pending_origin.as_deref() == Some(renderer_origin.as_str()) => {
                state.token = Some(access_token.to_string());
                state.committed_origin = Some(renderer_origin);
                state.pending_origin = None;
                Ok(())
            }
            Some(current) if current != access_token => {
                Err("Client state access token does not match this renderer".to_string())
            }
            Some(_) => {
                Err("Client state renderer origin changed without access rotation".to_string())
            }
            None => {
                state.token = Some(access_token.to_string());
                state.committed_origin = Some(renderer_origin);
                state.pending_origin = None;
                Ok(())
            }
        }
    }

    pub(super) fn validate(&self, access_token: &str, renderer_url: &Url) -> Result<(), String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let renderer_origin = origin_key(renderer_url)?;
        let state = self.state.lock().map_err(|err| err.to_string())?;
        match state.token.as_deref() {
            Some(current)
                if current == access_token
                    && state.committed_origin.as_deref() == Some(renderer_origin.as_str()) =>
            {
                Ok(())
            }
            Some(current) if current == access_token => {
                Err("Client state renderer origin does not match this renderer".to_string())
            }
            Some(_) => Err("Client state access token does not match this renderer".to_string()),
            None => Err("Client state access has not been claimed by this renderer".to_string()),
        }
    }

    pub(super) fn allows_claim_origin(&self, renderer_url: &Url) -> bool {
        let Ok(renderer_origin) = origin_key(renderer_url) else {
            return false;
        };
        self.state
            .lock()
            .map(|state| {
                state.committed_origin.as_deref() == Some(renderer_origin.as_str())
                    || state.pending_origin.as_deref() == Some(renderer_origin.as_str())
            })
            .unwrap_or(false)
    }

    pub(super) fn begin_navigation(&self, target_url: Option<&Url>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|err| err.to_string())?;
        state.pending_origin = match target_url {
            Some(url) => Some(origin_key(url)?),
            None => state.committed_origin.clone(),
        };
        Ok(())
    }

    pub(super) fn cancel_navigation(&self) {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .pending_origin = None;
    }

    pub(super) fn is_claimed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.token.is_some())
            .unwrap_or(false)
    }
}
