use std::sync::Mutex;

#[derive(Default)]
pub(super) struct RendererAccess {
    token: Mutex<Option<String>>,
}

impl RendererAccess {
    pub(super) fn claim(&self, access_token: &str) -> Result<(), String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let mut token = self.token.lock().map_err(|err| err.to_string())?;
        match token.as_deref() {
            Some(current) if current != access_token => {
                Err("Client state access token does not match this renderer".to_string())
            }
            Some(_) => Ok(()),
            None => {
                *token = Some(access_token.to_string());
                Ok(())
            }
        }
    }

    pub(super) fn validate(&self, access_token: &str) -> Result<(), String> {
        if access_token.is_empty() {
            return Err("Client state access token must not be empty".to_string());
        }

        let token = self.token.lock().map_err(|err| err.to_string())?;
        match token.as_deref() {
            Some(current) if current == access_token => Ok(()),
            Some(_) => Err("Client state access token does not match this renderer".to_string()),
            None => Err("Client state access has not been claimed by this renderer".to_string()),
        }
    }

    pub(super) fn reset(&self) {
        *self.token.lock().unwrap_or_else(|err| err.into_inner()) = None;
    }

    pub(super) fn is_claimed(&self) -> bool {
        self.token
            .lock()
            .map(|token| token.is_some())
            .unwrap_or(false)
    }
}
