//! Fixed isolated-world reads with registration/deadline fences on both sides.
use super::*;

impl BrowserController {
    pub(super) fn webkit_read(
        &self, app: &AppHandle, lease: &PageLease, operation: &Value,
        deadline: Instant, fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let webview = app.get_webview(&lease.registration.webview_label)
            .ok_or("Browser preview is no longer available")?;
        let controller = self.clone();
        let expected = lease.clone();
        let app = app.clone();
        let fence = fence.clone();
        let bytes = crate::embedded_view::input::read(
            &webview, crate::embedded_view::input::Read::Page(operation.to_string()),
            deadline.min(lease.expires), move || {
                fence.check()?;
                controller.check_page_state(&expected, deadline)?;
                if controller.resolve(&app, &expected.session_id)? != expected.registration {
                    return Err("Browser page lease is no longer current".into());
                }
                Ok(())
            },
        )?;
        let response: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if !response["document"].as_str().is_some_and(|token| !token.is_empty() && token.len() <= 128)
            || !response["result"].is_object() {
            return Err("Invalid native semantic read response".into());
        }
        Ok(response)
    }
}
