//! Fixed isolated-world reads with registration/deadline fences on both sides.
use super::*;

impl BrowserController {
    pub(super) fn webkit_read(
        &self,
        app: &AppHandle,
        lease: &PageLease,
        operation: &Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        self.webkit_operation(app, lease, operation, deadline, fence, false)
    }
    fn webkit_operation(
        &self,
        app: &AppHandle,
        lease: &PageLease,
        operation: &Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
        cleanup: bool,
    ) -> Result<Value, String> {
        let webview = app
            .get_webview(&lease.registration.webview_label)
            .ok_or("Browser preview is no longer available")?;
        let controller = self.clone();
        let expected = lease.clone();
        let app = app.clone();
        let fence = fence.clone();
        let native = matches!(
            operation["op"].as_str(),
            Some("pointer" | "wheel" | "keyboard" | "insert-text")
        );
        let version = self.document_version(&lease.registration)?;
        let read = if native {
            crate::embedded_view::input::Read::Input {
                document: lease
                    .document
                    .clone()
                    .ok_or("Missing WebKit document identity")?,
                operation: operation.clone(),
                held: lease.held.clone(),
            }
        } else {
            crate::embedded_view::input::Read::Page(operation.to_string())
        };
        let bytes = crate::embedded_view::input::read(
            &webview,
            read,
            if cleanup {
                deadline
            } else {
                deadline.min(lease.expires)
            },
            move || {
                fence.check()?;
                if cleanup {
                    if !controller
                        .inner
                        .0
                        .lock()
                        .map_err(|error| error.to_string())?
                        .page_leases
                        .get(&expected.operation_id)
                        .is_some_and(|lease| {
                            lease.generation == expected.generation
                                && lease.expires == expected.expires
                        })
                    {
                        return Err("Browser page lease is no longer current".into());
                    }
                } else {
                    controller.check_page_state(&expected, deadline)?;
                }
                if native && controller.document_version(&expected.registration)? != version {
                    return Err("Browser page changed during native input".into());
                }
                if controller.resolve(&app, &expected.session_id)? != expected.registration {
                    return Err("Browser page lease is no longer current".into());
                }
                Ok(())
            },
        )?;
        let response: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if !response["document"]
            .as_str()
            .is_some_and(|token| !token.is_empty() && token.len() <= 128)
            || !response["result"].is_object()
        {
            return Err("Invalid native semantic read response".into());
        }
        Ok(response)
    }

    pub(super) fn webkit_cleanup(
        &self,
        app: &AppHandle,
        session: &str,
        operation: &str,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) {
        let lease = self.inner.0.lock().ok().and_then(|inner| {
            inner
                .page_leases
                .get(operation)
                .filter(|lease| lease.session_id == session)
                .cloned()
        });
        let Some(lease) = lease else { return };
        let releases = lease
            .held
            .lock()
            .map(|held| held.clone())
            .unwrap_or_default();
        for (identity, release) in releases.into_iter().rev() {
            let mut result = self.webkit_operation(app, &lease, &release, deadline, fence, true);
            // A same-document navigation can fence an unsent release. Renew its
            // document check once, only while that release is still outstanding.
            // Admitted mutations and completed releases are never replayed.
            if result
                .as_ref()
                .is_err_and(|error| error == "Browser page changed during native input")
                && lease
                    .held
                    .lock()
                    .is_ok_and(|held| held.iter().any(|(id, _)| id == &identity))
            {
                result = self.webkit_operation(app, &lease, &release, deadline, fence, true);
            }
            if let Err(error) = result {
                if std::env::var_os("CN_INPUT_TRACE").is_some() {
                    eprintln!("native input cleanup: {error}");
                }
            }
        }
        if let Ok(mut held) = lease.held.lock() {
            held.clear();
        };
    }
    pub(super) fn webkit_expire(
        &self,
        app: &AppHandle,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) {
        let expired = self
            .inner
            .0
            .lock()
            .map(|inner| {
                inner
                    .page_leases
                    .values()
                    .filter(|lease| lease.expires <= Instant::now())
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for lease in expired {
            self.webkit_cleanup(app, &lease.session_id, &lease.operation_id, deadline, fence);
            self.end_page(&lease.session_id, &lease.operation_id);
        }
    }
}
