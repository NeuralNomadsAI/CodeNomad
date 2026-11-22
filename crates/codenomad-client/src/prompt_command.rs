use crate::{backend::Backend, prompt::PromptError};
use serde_json::json;

impl Backend {
    pub async fn prompt_command(&self, name: &str, text: &str) -> Result<(), PromptError> {
        if !crate::history::valid_id(&self.workspace)
            || !crate::history::valid_id(&self.session)
            || name.is_empty()
            || name.len() > 1024
            || name.chars().any(char::is_whitespace)
            || text.len() > 128 * 1024
        {
            return Err(PromptError::Rejected);
        }
        let response = self
            .client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/command",
                self.base, self.workspace, self.session
            ))
            .json(&json!({"name":name,"text":text,"delivery":"steer"}))
            .send()
            .await
            .map_err(|_| PromptError::Unconfirmed)?;
        if response.status().is_success() {
            Ok(())
        } else if response.status().is_client_error()
            || response.status() == reqwest::StatusCode::NOT_IMPLEMENTED
        {
            Err(PromptError::Rejected)
        } else {
            Err(PromptError::Unconfirmed)
        }
    }
}
