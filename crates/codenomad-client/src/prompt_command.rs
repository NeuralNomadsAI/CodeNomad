use crate::{backend::Backend, prompt::PromptError};
use serde_json::json;

impl Backend {
    pub async fn prompt_command(&self, name: &str, text: &str) -> Result<(), PromptError> {
        if self.client.server_identity_mismatch()
            || !crate::history::valid_id(&self.workspace)
            || !crate::history::valid_id(&self.session)
            || name.is_empty()
            || name.len() > 1024
            || name.chars().any(char::is_whitespace)
            || text.len() > 128 * 1024
        {
            return Err(PromptError::Rejected);
        }
        let mut request = self
            .client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/command",
                self.base, self.workspace, self.session
            ))
            .json(&json!({"name":name,"text":text,"delivery":"steer"}));
        if let Some(directory) = &self.session_directory {
            request = request.query(&[("directory", directory.as_str())]).header(
                "x-codenomad-session-directory",
                crate::backend::percent_encode_header(directory),
            );
        }
        let response = request
            .send()
            .await
            .map_err(|error| crate::backend::send_transport_error(&error))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(crate::backend::classify_http_error(response).await)
        }
    }
}
