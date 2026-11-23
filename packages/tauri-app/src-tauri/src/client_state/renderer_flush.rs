use super::ClientState;
use serde::Serialize;
use std::time::{Duration, Instant};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

const RENDERER_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RendererFlushRequest {
    pub(crate) generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prepare_generation: Option<u64>,
}

#[derive(Default)]
pub(super) struct RendererFlush {
    pub(super) request_lock: Mutex<()>,
    pub(super) windows: Mutex<HashMap<String, (u64, u64)>>,
}

impl ClientState {
    pub(crate) fn wait_for_renderer_flush(
        &self,
        app: &AppHandle,
        window_label: &str,
        window_id: &str,
        require_claim: bool,
    ) -> Result<Option<u64>, ()> {
        let _request = self
            .renderer_flush
            .request_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if require_claim && !self.renderer_access.is_claimed_for(window_id) {
            return Ok(None);
        }
        let Some(webview) = app.get_webview(window_label) else {
            return Err(());
        };
        let generation = {
            let mut windows = self
                .renderer_flush
                .windows
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let state = windows.entry(window_id.to_string()).or_default();
            state.0 += 1;
            state.0
        };
        if let Err(err) = webview.emit_to(
            window_label,
            "client-state:navigation-flush-requested",
            RendererFlushRequest {
                generation,
                prepare_generation: None,
            },
        ) {
            eprintln!("[client-state] failed to request renderer flush: {err}");
            return Err(());
        }

        let deadline = Instant::now() + RENDERER_FLUSH_TIMEOUT;
        while self
            .renderer_flush
            .windows
            .lock()
            .ok()
            .and_then(|windows| windows.get(window_id).copied())
            .is_some_and(|state| state.0 == generation && state.1 != generation)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self
            .renderer_flush
            .windows
            .lock()
            .ok()
            .and_then(|windows| windows.get(window_id).copied())
            .is_some_and(|state| state == (generation, generation))
        {
            Ok(Some(generation))
        } else {
            Self::cancel_navigation_flush(app, window_label, Some(generation));
            Err(())
        }
    }

    pub(crate) fn cancel_navigation_flush(
        app: &AppHandle,
        window_label: &str,
        generation: Option<u64>,
    ) {
        if let (Some(webview), Some(generation)) = (app.get_webview(window_label), generation) {
            let _ = webview.emit_to(
                window_label,
                "client-state:navigation-flush-cancelled",
                RendererFlushRequest {
                    generation,
                    prepare_generation: None,
                },
            );
        }
    }

    pub(super) fn acknowledge_renderer_flush(&self, window_id: &str, generation: u64) {
        if let Ok(mut windows) = self.renderer_flush.windows.lock() {
            if let Some(state) = windows.get_mut(window_id) {
                if state.0 == generation {
                    state.1 = generation;
                }
            }
        }
    }
}
