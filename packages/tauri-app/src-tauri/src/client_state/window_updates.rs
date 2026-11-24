use super::{
    envelope::PersistedClientState,
    window::{NativeWindowState, WindowBounds, DEFAULT_ZOOM_LEVEL},
    ClientState,
};
use std::collections::{HashMap, HashSet};

pub(super) struct WindowGeometry {
    pub bounds: Option<WindowBounds>,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Default)]
pub(super) struct WindowCaptures {
    latest: HashMap<String, NativeWindowState>,
    active: Option<String>,
    new_windows: HashSet<String>,
    // A clear/disable/removal is tentative until publication. Keep admission
    // based on its previous policy so a failed write cannot drop live events.
    mutation: Option<(String, Option<NativeWindowState>)>,
    unpublished: bool,
    stopped: bool,
}

impl ClientState {
    pub(crate) fn queue_active_window(&self, app: &tauri::AppHandle, id: String) {
        if self.capture_active_window(id) {
            self.schedule_window_flush(app);
        }
    }

    fn capture_active_window(&self, id: String) -> bool {
        if let Ok(mut pending) = self.pending_windows.lock() {
            if pending.stopped {
                return false;
            }
            pending.active = Some(id);
            return true;
        }
        false
    }

    pub(super) fn capture_window_geometry(
        &self,
        window_id: &str,
        read_native: impl FnOnce() -> WindowGeometry,
    ) -> bool {
        // A native getter can synchronously wait for the UI event loop. Do not
        // hold ANY client-state lock until it returns, including during shutdown.
        let geometry = read_native();
        let zoom = self
            .zoom_levels
            .lock()
            .ok()
            .and_then(|levels| levels.get(window_id).copied())
            .unwrap_or(DEFAULT_ZOOM_LEVEL);
        self.queue_window_capture(
            window_id,
            geometry.bounds,
            geometry.maximized,
            geometry.fullscreen,
            zoom,
        )
    }

    // Neither lock below is held across disk I/O. One latest capture per known
    // window bounds memory; unknown/removed/disabled windows cannot grow the queue.
    pub(super) fn queue_window_capture(
        &self,
        window_id: &str,
        bounds: Option<WindowBounds>,
        maximized: bool,
        fullscreen: bool,
        zoom_factor: f64,
    ) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if state.unsupported_future_envelope {
            return false;
        }
        let Ok(mut pending) = self.pending_windows.lock() else {
            return false;
        };
        if pending.stopped {
            return false;
        }
        let previous_window = if let Some((_, window)) =
            pending.mutation.as_ref().filter(|(id, _)| id == window_id)
        {
            window.as_ref()
        } else if window_id == crate::preferences_window::LABEL {
            state.preferences_window.as_ref()
        } else if pending.new_windows.contains(window_id) {
            None
        } else {
            let Ok(record) = state.record(window_id) else {
                return false;
            };
            if !record.writes_enabled {
                return false;
            }
            record.window.as_ref()
        };
        let bounds = bounds.or_else(|| {
            pending
                .latest
                .get(window_id)
                .or(previous_window)
                .map(|window| window.bounds.clone())
        });
        let Some(bounds) = bounds else { return false };
        pending.latest.insert(
            window_id.to_string(),
            NativeWindowState {
                bounds,
                maximized,
                fullscreen,
                zoom_factor,
            },
        );
        true
    }

    // Caller holds write_lock and state, before publication or record policy
    // changes. Merging before rollback snapshots preserves pending captures even
    // when a subsequent clear/disable/removal cannot be published.
    pub(super) fn apply_window_captures(
        &self,
        state: &mut PersistedClientState,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_windows
            .lock()
            .map_err(|error| error.to_string())?;
        if state.unsupported_future_envelope {
            pending.latest.clear();
            pending.active = None;
            return Ok(());
        }
        let mut applied = false;
        if let Some(id) = pending.active.take() {
            if pending.new_windows.contains(&id) {
                pending.active = Some(id);
            } else if id != state.active_window_id && state.record(&id).is_ok() {
                state.active_window_id = id;
                applied = true;
            }
        }
        let WindowCaptures { new_windows, latest, .. } = &mut *pending;
        latest.retain(|id, capture| {
            if new_windows.contains(id) {
                return true;
            }
            if id == crate::preferences_window::LABEL {
                state.preferences_window = Some(capture.clone());
                applied = true;
            } else if let Ok(record) = state.record_mut(id) {
                if record.writes_enabled {
                    record.window = Some(capture.clone());
                    applied = true;
                }
            }
            false
        });
        pending.unpublished |= applied;
        Ok(())
    }

    pub(crate) fn admit_new_window_capture(&self, id: String) {
        let mut pending = self.pending_windows.lock().unwrap_or_else(|err| err.into_inner());
        if !pending.stopped {
            pending.new_windows.insert(id);
        }
    }

    pub(crate) fn discard_new_window_capture(&self, id: &str) {
        let mut pending = self.pending_windows.lock().unwrap_or_else(|err| err.into_inner());
        if pending.new_windows.remove(id) {
            pending.latest.remove(id);
            if pending.active.as_deref() == Some(id) {
                pending.active = None;
            }
        }
    }

    pub(super) fn snapshot_new_window_capture(
        &self,
        state: &mut PersistedClientState,
        id: &str,
    ) -> Result<(), String> {
        let pending = self.pending_windows.lock().map_err(|err| err.to_string())?;
        if pending.new_windows.contains(id) {
            state.record_mut(id)?.window = pending.latest.get(id).cloned();
            if pending.active.as_deref() == Some(id) {
                state.active_window_id = id.to_owned();
            }
        }
        Ok(())
    }

    // Called with state locked after publication. Captures that arrived during
    // publication now belong to the saved record and stay queued for flushing.
    pub(super) fn finish_new_window_capture(&self, state: &PersistedClientState, id: &str) {
        let mut pending = self.pending_windows.lock().unwrap_or_else(|err| err.into_inner());
        if pending.new_windows.remove(id) {
            if pending.latest.get(id) == state.record(id).ok().and_then(|record| record.window.as_ref()) {
                pending.latest.remove(id);
            }
            if state.active_window_id == id && pending.active.as_deref() == Some(id) {
                pending.active = None;
            }
        }
    }

    pub(super) fn window_captures_published(&self) {
        self.pending_windows
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .unpublished = false;
    }

    // Caller holds state and write_lock. Only one record mutation can publish at
    // once; other windows continue using their own policy and independent queue.
    pub(super) fn preserve_window_capture_policy(&self, previous: &PersistedClientState, id: &str) {
        let mut pending = self
            .pending_windows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.mutation = if previous.unsupported_future_envelope {
            None
        } else {
            previous
                .record(id)
                .ok()
                .filter(|record| record.writes_enabled)
                .map(|record| (id.to_string(), record.window.clone()))
        };
    }

    pub(super) fn finish_window_capture_policy(&self, state: &PersistedClientState, id: &str) {
        let mut pending = self
            .pending_windows
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        pending.mutation = None;
        // Successful destructive changes discard speculative events. On rollback,
        // the restored record admits them and the next flush publishes the latest.
        if state.unsupported_future_envelope
            || !state.record(id).is_ok_and(|record| record.writes_enabled)
        {
            pending.latest.remove(id);
        }
    }

    pub(super) fn set_window_captures_stopped(&self, stopped: bool) {
        self.pending_windows
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .stopped = stopped;
    }

    pub(super) fn window_captures_stopped(&self) -> Result<bool, String> {
        Ok(self.pending_windows.lock().map_err(|error| error.to_string())?.stopped)
    }

    // Caller holds write_lock, after the worker has joined and before ownership
    // release. Admission is closed, so this is also safe if a wakeup was omitted.
    pub(super) fn flush_pending_window_captures(&self) -> Result<(), String> {
        {
            let state = self.state.lock().map_err(|error| error.to_string())?;
            let pending = self
                .pending_windows
                .lock()
                .map_err(|error| error.to_string())?;
            if state.unsupported_future_envelope
                || (pending.latest.is_empty() && pending.active.is_none() && !pending.unpublished
                    && !self.root_sync_pending.load(std::sync::atomic::Ordering::Relaxed))
            {
                return Ok(());
            }
        }
        // Keep the state mutex available to native window callbacks during the ownership read.
        if !self.process.verify_primary()? {
            return Ok(());
        }
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            self.apply_window_captures(&mut state)?;
        }
        self.write_current_state()
    }
}

#[cfg(test)]
#[path = "window_updates_tests.rs"]
mod tests;
