pub(super) mod behavior;
mod document;
mod notifications;
pub(super) mod server;

use super::transcript_preset::{self, Row};
use crate::{backend::Backend, platform};
pub(super) use codenomad_client::settings::Owner;
use codenomad_client::settings::PreferencesWatch;
pub(super) use document::env_var_is_masked;
use document::{Choice, Document};
use rune_theme_codenomad::palettes::{
    ColorSchemeColors, Palette, ResolvedPalette, built_in, custom, increased_contrast,
};
use serde_json::Value;
#[cfg(any(test, feature = "test-support"))]
use serde_json::json;

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub(super) struct Preferences {
    pub(super) backend: Option<Backend>,
    pub(super) provider_target: Option<super::providers::Target>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) open_providers: bool,
    pub(super) memory: super::memory::Setting,
    pub(super) missions: super::missions::Shared,
    pub(super) startup: super::startup_state::StartupState,
    pub(super) opencode_install: super::opencode::install::Install,
    pub(super) notification_update: Option<String>,
    pub(super) announced_update: Option<String>,
    palette_preview: Option<(bool, Option<&'static str>, ColorSchemeColors)>,
    binding_epoch: u64,
    authority: Arc<AtomicU64>,
    config: Document,
    state: Document,
    server: Document,
    show_server: bool,
    show_environment: bool,
    pub(super) window_wake: Option<rune::Waker>,
    pub(super) main_wake: Option<rune::Waker>,
    pub(super) revision: u64,
    stream: Option<PreferencesWatch>,
    closing_stream: Option<codenomad_client::Receiver<()>>,
    closing_stream_client_id: Option<String>,
    authentication_required: bool,
    transport_lost: bool,
    observed_clients: Vec<(String, bool)>,
    seen_drops: Vec<(String, u64)>,
    seen_drop_generation: u64,
    observed_drop_watch: Option<codenomad_client::http::ClientDropWatch>,
    native_stream_offline: std::collections::HashSet<String>,
    pending_native_outage: bool,
    direct_access_lock: std::sync::Mutex<Option<(String, codenomad_client::Receiver<()>)>>,
}

impl Preferences {
    pub(super) fn set_native_stream_online(&mut self, workspace: &str, connected: bool) {
        if connected {
            self.native_stream_offline.remove(workspace);
        } else {
            if !self.native_stream_offline.contains(workspace)
                && self.native_stream_offline.len() >= 128
            {
                self.native_stream_offline.clear();
            }
            self.native_stream_offline.insert(workspace.to_owned());
        }
    }

    pub(super) fn is_native_stream_online(&self, workspace: &str) -> bool {
        !self.native_stream_offline.contains(workspace)
    }

    pub(super) fn clear_native_stream_state(&mut self) {
        self.native_stream_offline.clear();
        self.pending_native_outage = false;
    }

    pub(super) fn set_pending_native_outage(&mut self, pending: bool) {
        self.pending_native_outage = pending;
    }

    pub(super) fn take_pending_native_outage(&mut self) -> bool {
        std::mem::take(&mut self.pending_native_outage)
    }
    pub(super) fn set_direct_access_lock(
        &self,
        owner: String,
        lock: codenomad_client::Receiver<()>,
    ) {
        *self.direct_access_lock.lock().unwrap() = Some((owner, lock));
    }

    pub(super) fn clear_direct_access_lock(&self) {
        *self.direct_access_lock.lock().unwrap() = None;
    }

    pub(super) fn direct_access_locked(&self, owner: Option<&str>) -> bool {
        let Some(owner) = owner else {
            return false;
        };
        let guard = self.direct_access_lock.lock().unwrap();
        guard
            .as_ref()
            .is_some_and(|(lock_owner, rx)| lock_owner == owner && !rx.is_closed())
    }

    pub(super) fn take_finished_direct_access_lock(&self, owner: Option<&str>) -> bool {
        let mut guard = self.direct_access_lock.lock().unwrap();
        let finished = guard.as_ref().is_some_and(|(_, rx)| rx.is_closed());
        if !finished {
            return false;
        }
        let lock_owner = guard.take().map(|(id, _)| id);
        owner.is_some() && owner == lock_owner.as_deref()
    }
    pub(super) fn show_timeline(&self) -> bool {
        self.config
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot["settings"]["showMessageTimeline"].as_bool())
            .unwrap_or(true)
    }

    pub(super) fn usage_visibility(&self, pending: bool) -> &'static str {
        self.transcript_mode(Row::Usage, pending)
    }

    #[cfg(test)]
    pub(super) fn set_usage_visibility(&mut self, mode: &'static str) {
        self.set_transcript(Some(Row::Usage), mode);
    }

    fn transcript_settings(&self) -> &Value {
        self.saved(Owner::Config)
            .map_or(&Value::Null, |data| &data["settings"])
    }

    pub(super) fn transcript_mode(&self, row: Row, pending: bool) -> &'static str {
        if pending && let Some(mode) = self.config.pending_transcript_mode(row) {
            return mode;
        }
        row.mode(self.transcript_settings())
    }

    pub(super) fn transcript_preset(&self) -> &'static str {
        transcript_preset::selected(self.transcript_settings())
    }

    pub(super) fn transcript_preset_display(&self) -> &'static str {
        let Some((pending, base_preset, pending_usage_exp)) = self
            .config
            .pending_transcript_preset(transcript_preset::saved_preset(self.transcript_settings()))
        else {
            return self.transcript_preset();
        };
        if pending != "custom" {
            return pending;
        }
        if base_preset == "custom" {
            return "custom";
        }
        let usage_expansion = pending_usage_exp
            .unwrap_or_else(|| transcript_preset::usage_expansion(self.transcript_settings()));
        if transcript_preset::matches_named_details(
            base_preset,
            |row| self.transcript_mode(row, true),
            usage_expansion,
        ) {
            base_preset
        } else {
            "custom"
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn fixture_transcript(&mut self, settings: Value) {
        self.config.snapshot = Some(json!({ "settings": settings }));
    }

    #[cfg(test)]
    pub(super) fn fixture_config_doc(&mut self, doc: Value) {
        self.config.snapshot = Some(doc);
    }

    fn seen_drop(&self, client_id: &str) -> u64 {
        self.seen_drops
            .iter()
            .find(|(seen_id, _)| seen_id == client_id)
            .map_or(0, |(_, count)| *count)
    }

    fn active_client_ids(&self, backend: &Backend) -> Vec<String> {
        let mut ids = Vec::new();
        let healthy_observed: Vec<_> = self
            .observed_clients
            .iter()
            .filter(|(id, healthy)| {
                *healthy && backend.client.transport_drops(id) == self.seen_drop(id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !healthy_observed.is_empty() {
            ids.extend(healthy_observed);
        } else {
            ids.extend(self.observed_clients.iter().map(|(id, _)| id.clone()));
        }
        if let Some(stream) = &self.stream {
            let id = stream.client_id();
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_owned());
            }
        }
        if let Some(id) = &self.closing_stream_client_id
            && !ids.iter().any(|existing| existing == id)
        {
            ids.push(id.clone());
        }
        if ids.is_empty() {
            ids.push(backend.client_id.clone());
        }
        ids
    }

    fn seen_drops_sum(&self, client_ids: &[String]) -> u64 {
        client_ids.iter().map(|id| self.seen_drop(id)).sum()
    }

    fn sync_drop_watch(&mut self) {
        let Some(backend) = &self.backend else {
            self.observed_drop_watch = None;
            return;
        };
        let mut ids = Vec::new();
        for (id, _) in &self.observed_clients {
            ids.push(id.clone());
        }
        if let Some(stream) = &self.stream {
            ids.push(stream.client_id().to_owned());
        }
        if let Some(id) = &self.closing_stream_client_id {
            ids.push(id.clone());
        }
        if ids.is_empty() {
            ids.push(backend.client_id.clone());
        }
        self.observed_drop_watch = Some(backend.client.watch_drops(&ids));
    }

    fn is_tracked_client(&self, client_id: &str) -> bool {
        self.observed_clients.iter().any(|(id, _)| id == client_id)
            || self
                .stream
                .as_ref()
                .is_some_and(|stream| stream.client_id() == client_id)
            || self.closing_stream_client_id.as_deref() == Some(client_id)
    }

    fn record_seen_drop(&mut self, client_id: &str, count: u64) -> bool {
        if let Some((_, seen)) = self.seen_drops.iter_mut().find(|(id, _)| id == client_id) {
            let dropped = count > *seen;
            *seen = count;
            dropped
        } else {
            if count == 0 {
                return false;
            }
            while self.seen_drops.len() >= 64 {
                if let Some(index) = self
                    .seen_drops
                    .iter()
                    .position(|(id, _)| !self.is_tracked_client(id))
                {
                    self.seen_drops.remove(index);
                } else {
                    break;
                }
            }
            self.seen_drops.push((client_id.to_owned(), count));
            true
        }
    }

    pub(super) fn has_healthy_watch_stream(&self) -> bool {
        let Some(backend) = &self.backend else {
            return false;
        };
        self.stream.as_ref().is_some_and(|stream| {
            stream.is_connected() && !backend.client.is_in_outage(stream.client_id())
        })
    }

    pub(super) fn observe_conversation_clients(&mut self, clients: &[(String, bool)]) {
        if self.observed_clients != clients {
            let previous = self.observed_clients.clone();
            let old_dropped = self.observe_transport_drops();
            let revalidated = self.config.transport_revalidated()
                || self.state.transport_revalidated()
                || self.server.transport_revalidated();
            let watch_healthy = self.has_healthy_watch_stream();
            let newly_unhealthy = revalidated
                && !watch_healthy
                && !clients.is_empty()
                && clients.iter().all(|(_, healthy)| !*healthy);
            self.observed_clients = clients.to_vec();
            self.sync_drop_watch();
            // A stream that dropped while hidden and has since reconnected (re-attesting /api/meta
            // and finishing its sync while another tab kept Preferences healthy) baselines its old
            // drop counter so closing the original tab later does not look like a new outage.
            if !self.transport_lost
                && let Some(backend) = self.backend.clone()
            {
                let still_healthy = watch_healthy
                    || clients.iter().any(|(id, healthy)| {
                        *healthy && backend.client.transport_drops(id) == self.seen_drop(id)
                    });
                if still_healthy {
                    for (id, healthy) in clients {
                        if *healthy
                            && previous
                                .iter()
                                .any(|(prev_id, prev_healthy)| prev_id == id && !*prev_healthy)
                        {
                            let drops = backend.client.transport_drops(id);
                            let _ = self.record_seen_drop(id, drops);
                        }
                    }
                }
            }
            let new_dropped = self.observe_transport_drops();
            if !old_dropped && !new_dropped && newly_unhealthy {
                self.mark_transport_lost();
            }
            if (old_dropped || new_dropped)
                && (self.has_healthy_watch_stream() || clients.iter().any(|(_, healthy)| *healthy))
            {
                self.revalidate_transport();
            }
        }
    }

    pub(super) fn revalidate_transport(&mut self) {
        self.config.retry_revalidation(self.transport_lost);
        self.state.retry_revalidation(self.transport_lost);
        if self.show_server || self.show_environment || self.server.unsettled() {
            self.server.retry_revalidation(self.transport_lost);
        }
    }

    pub(super) fn is_transport_lost(&self) -> bool {
        self.transport_lost
    }

    pub(super) fn is_repeated_outage(&self, client_id: &str) -> bool {
        let Some(backend) = self.backend.as_ref() else {
            return false;
        };
        let seen = self.seen_drop(client_id);
        seen > 0
            && backend.client.is_in_outage(client_id)
            && backend.client.transport_drops(client_id) == seen
    }

    pub(super) fn note_client_outage(&mut self, client_id: &str) {
        if let Some(backend) = self.backend.clone() {
            let drops = backend.client.transport_drops(client_id);
            let _ = self.record_seen_drop(client_id, drops);
        }
    }

    fn revoke_send_authority(&self) {
        self.authority.fetch_add(1, Ordering::SeqCst);
    }

    pub(super) fn mark_transport_lost(&mut self) {
        self.revoke_send_authority();
        if let Some(backend) = self.backend.clone() {
            self.seen_drop_generation = backend.client.drop_generation();
            let mut ids = self.active_client_ids(&backend);
            for (id, _) in &self.observed_clients {
                if !ids.iter().any(|existing| existing == id) {
                    ids.push(id.clone());
                }
            }
            for id in ids {
                let drops = backend.client.transport_drops(&id);
                let _ = self.record_seen_drop(&id, drops);
            }
        }
        self.config.mark_transport_lost();
        self.state.mark_transport_lost();
        self.server.mark_transport_lost();
        self.missions.on_transport_lost();
        if !self.transport_lost {
            self.transport_lost = true;
            self.revision += 1;
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
    }

    fn observe_transport_drops(&mut self) -> bool {
        let Some(backend) = self.backend.clone() else {
            return false;
        };
        let mut dropped = false;
        let stream_id = self.stream.as_ref().map(|s| s.client_id().to_owned());
        let closing_id = self.closing_stream_client_id.clone();
        let mut watch_dropped = false;
        for id in stream_id.iter().chain(closing_id.iter()) {
            let drops = backend.client.transport_drops(id);
            if self.record_seen_drop(id, drops) {
                dropped = true;
                if stream_id.as_deref() == Some(id.as_str()) {
                    watch_dropped = true;
                }
            }
        }
        let watch_continuously_healthy = !watch_dropped && self.has_healthy_watch_stream();
        let any_continuously_healthy = watch_continuously_healthy
            || (!self.observed_clients.is_empty()
                && self.observed_clients.iter().any(|(id, healthy)| {
                    *healthy && backend.client.transport_drops(id) == self.seen_drop(id)
                }));
        if self.observed_clients.is_empty() && stream_id.is_none() && closing_id.is_none() {
            let drops = backend.client.transport_drops(&backend.client_id);
            if self.record_seen_drop(&backend.client_id, drops) {
                dropped = true;
            }
        } else if !self.observed_clients.is_empty() && !any_continuously_healthy {
            let clients = self.observed_clients.clone();
            for (id, _) in &clients {
                let drops = backend.client.transport_drops(id);
                if self.record_seen_drop(id, drops) {
                    dropped = true;
                }
            }
        }
        if self
            .closing_stream
            .as_ref()
            .is_none_or(codenomad_client::Receiver::is_closed)
        {
            self.closing_stream = None;
            if self.closing_stream_client_id.take().is_some() {
                self.sync_drop_watch();
            }
        }
        let current_drop_gen = backend.client.drop_generation();
        let drop_gen_changed = current_drop_gen != self.seen_drop_generation;
        self.seen_drop_generation = current_drop_gen;
        if ((!any_continuously_healthy && drop_gen_changed) || backend.client.attestation_revoked())
            && (self.config.transport_revalidated()
                || self.state.transport_revalidated()
                || self.server.transport_revalidated())
        {
            dropped = true;
        }
        if !dropped {
            return false;
        }
        self.revoke_send_authority();
        self.config.mark_transport_lost();
        self.state.mark_transport_lost();
        self.server.mark_transport_lost();
        self.missions.on_transport_lost();
        if !self.transport_lost {
            self.transport_lost = true;
            self.revision += 1;
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
        if watch_continuously_healthy || self.observed_clients.iter().any(|(_, healthy)| *healthy) {
            self.revalidate_transport();
        }
        true
    }

    pub(super) fn transcript_ready(&self) -> bool {
        self.saved(Owner::Config).is_some()
            && self.can_retry()
            && !self.config.read_failed()
            && !self.transport_lost
    }

    pub(super) fn set_transcript(&mut self, row: Option<Row>, mode: &'static str) {
        if self.transcript_ready()
            && row.is_none_or(|row| self.transcript_mode(row, true) != mode)
            && self.config.stage_transcript_batch([(
                row.map_or(Choice::TranscriptPreset, Choice::TranscriptRow),
                mode,
            )])
        {
            self.revision += 1;
        }
    }

    pub(super) fn set_transcript_batch(
        &mut self,
        rows: impl IntoIterator<Item = (Row, &'static str)>,
    ) {
        if !self.transcript_ready() {
            return;
        }
        let batch: Vec<_> = rows
            .into_iter()
            .filter(|&(row, mode)| self.transcript_mode(row, true) != mode)
            .map(|(row, mode)| (Choice::TranscriptRow(row), mode))
            .collect();
        if !batch.is_empty() && self.config.stage_transcript_batch(batch) {
            self.revision += 1;
        }
    }

    pub(super) fn take_notification_failure(&mut self) -> bool {
        self.config.take_notification_failure()
            | self.state.take_notification_failure()
            | self.server.take_notification_failure()
    }
    #[cfg(test)]
    pub(super) fn notification_test_config(&mut self, snapshot: Option<Value>) {
        self.reset_notification_fixture();
        self.config.snapshot = snapshot;
    }

    pub(super) fn shortcut(&self, action: &str) -> Option<&[Value]> {
        self.config.snapshot.as_ref()?["settings"]["hotkeyOverrides"][action]
            .as_array()
            .map(Vec::as_slice)
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(super) fn stage_file_save(&mut self, binding: Value) {
        self.stage_shortcut(super::shortcuts::FILE_SAVE, binding);
    }

    pub(super) fn stage_shortcut(&mut self, id: &'static str, binding: Value) {
        if self.can_retry()
            && self.saved(Owner::Config).is_some()
            && !self.config.resetting_shortcuts()
        {
            self.config.stage_shortcut(id, binding);
            self.revision += 1;
        }
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(super) fn file_save_pending(&self) -> bool {
        self.shortcuts_pending()
    }

    pub(super) fn shortcuts_pending(&self) -> bool {
        self.config.shortcuts_pending()
    }

    pub(super) fn shortcut_failed(&self, id: Option<&'static str>) -> bool {
        self.config
            .choice_failed(id.map_or(Choice::ShortcutReset, Choice::Shortcut))
    }

    pub(super) fn resetting_shortcuts(&self) -> bool {
        self.config.resetting_shortcuts()
    }

    pub(super) fn reset_shortcuts(&mut self) {
        if self.can_retry() && self.saved(Owner::Config).is_some() {
            self.config.reset_shortcuts();
            self.revision += 1;
        }
    }

    pub(super) fn queues_follow_ups(&self) -> bool {
        self.saved(Owner::Config)
            .is_some_and(|data| data["settings"]["followUpBehavior"] == "queue")
    }

    #[cfg(test)]
    pub(super) fn fixture_shortcuts(&mut self, overrides: Value) {
        self.config.snapshot = Some(json!({"settings": {"hotkeyOverrides": overrides}}));
    }

    #[cfg(test)]
    pub(super) fn fixture_settings(&mut self, settings: Value) {
        self.config.snapshot = Some(json!({"settings": settings}));
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(super) fn fixture_config(&mut self, url: &str, settings: Value) {
        let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        backend.base = url.into();
        self.backend = Some(backend);
        self.config.snapshot = Some(json!({"settings": settings}));
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn prepare_all_drains(&mut self, check_revisions: bool, retry_failed: bool) {
        let Some(backend) = &self.backend else {
            return;
        };
        let config_rev =
            check_revisions.then(|| backend.client.preferences_revision(Owner::Config));
        let state_rev = check_revisions.then(|| backend.client.preferences_revision(Owner::State));
        let server_rev =
            check_revisions.then(|| backend.client.preferences_revision(Owner::Server));
        let atomic = backend.client.supports_atomic_settings_patches();
        self.config.prepare_drain(
            config_rev,
            retry_failed,
            atomic,
            self.missions.needs_config_revalidation(),
        );
        self.state
            .prepare_drain(state_rev, retry_failed, atomic, false);
        self.server
            .prepare_drain(server_rev, retry_failed, atomic, false);
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn preferences_revisions(&self) -> Option<(u64, u64, u64)> {
        let backend = self.backend.as_ref()?;
        Some((
            backend.client.preferences_revision(Owner::Config),
            backend.client.preferences_revision(Owner::State),
            backend.client.preferences_revision(Owner::Server),
        ))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn flush(&mut self) -> bool {
        use std::time::{Duration, Instant};
        self.missions.suspend_reads();
        if self.backend.is_some() && !self.authentication_required {
            self.observe_transport_drops();
            self.take_invalidations();
            let mut last_revs = self.preferences_revisions();
            self.prepare_all_drains(true, true);
            // Coalesced queues hold at most 1 in-flight + 2 unsent transcript batches (Preset + Rows);
            // bound both per-flight inactivity and overall wall-clock close wait.
            if self.documents_draining() {
                let started = Instant::now();
                let stall_budget =
                    codenomad_client::http::REQUEST_TIMEOUT * 3 + Duration::from_millis(100);
                let total_budget =
                    codenomad_client::http::REQUEST_TIMEOUT * 6 + Duration::from_millis(100);
                let max_ops = 16u32.saturating_add(self.missions.pending_ops().saturating_mul(4));
                platform::block_on(async {
                    let mut last_progress = Instant::now();
                    let mut settled_ops = 0u32;
                    while self.documents_draining()
                        && started.elapsed() < total_budget
                        && last_progress.elapsed() < stall_budget
                        && settled_ops < max_ops
                    {
                        let transport_or_watch =
                            self.observe_transport_drops() | self.take_invalidations();
                        let revs = self.preferences_revisions();
                        let rev_changed = revs != last_revs;
                        last_revs = revs;
                        if transport_or_watch || rev_changed {
                            self.prepare_all_drains(rev_changed, false);
                        }
                        let (_, dropped_mid_poll, settled) = self.poll_documents_inner(false);
                        if settled {
                            settled_ops += 1;
                            if !rev_changed && !dropped_mid_poll {
                                last_progress = Instant::now();
                            }
                        }
                        if dropped_mid_poll || settled {
                            self.prepare_all_drains(false, false);
                        }
                        if self.documents_draining() {
                            platform::sleep(Duration::from_millis(10)).await;
                        }
                    }
                });
            }
        }
        !self.config.has_unconfirmed()
            && !self.state.has_unconfirmed()
            && !self.server.has_unconfirmed()
            && !self.missions.has_unconfirmed()
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn documents_draining(&self) -> bool {
        let config_refreshing = self.can_retry() && self.config.read_refreshing();
        let can_start_missions_write = self.can_retry()
            && (config_refreshing
                || (self.config_loaded()
                    && !self.config.busy_for_external_write()
                    && self
                        .backend
                        .as_ref()
                        .is_some_and(super::ServerOwner::backend_verified)));
        self.config.draining()
            || self.state.draining()
            || self.server.draining()
            || self
                .missions
                .draining(can_start_missions_write, config_refreshing)
    }
    pub fn bind(&mut self, owner: Option<Backend>) -> bool {
        if self.backend.as_ref().map(|b| &b.client_id) == owner.as_ref().map(|b| &b.client_id) {
            return false;
        }
        let same_address = self
            .backend
            .as_ref()
            .zip(owner.as_ref())
            .is_some_and(|(old, new)| {
                old.base == new.base
                    && !new.client.attestation_revoked()
                    && old.client.server_identity().is_some()
                    && old.client.server_identity() == new.client.server_identity()
            });
        self.unwatch();
        self.revoke_send_authority();
        if !same_address {
            self.seen_drops.clear();
            self.closing_stream_client_id = None;
            self.binding_epoch = self.binding_epoch.wrapping_add(1);
            self.palette_preview = None;
        }
        self.config.rebind(same_address);
        self.state.rebind(same_address);
        self.server.rebind(same_address);
        self.memory.bind(same_address);
        self.missions.rebind(same_address);
        self.opencode_install.cancel_check();
        self.backend = owner;
        self.seen_drop_generation = self
            .backend
            .as_ref()
            .map_or(0, |b| b.client.drop_generation());
        self.authentication_required = false;
        self.transport_lost = same_address;
        self.observed_clients.clear();
        self.native_stream_offline.clear();
        self.pending_native_outage = false;
        self.sync_drop_watch();
        self.refresh();
        self.revision += 1;
        true
    }

    pub fn refresh(&mut self) {
        self.config.invalidate();
        self.state.invalidate();
    }

    pub(super) fn retry_general(&mut self) {
        self.config.retry(general_config);
        self.state.retry(general_state);
        if self.transport_lost {
            self.config.retry_revalidation(true);
            self.state.retry_revalidation(true);
        }
    }

    pub(super) fn transcript_error(&self) -> Option<&'static str> {
        if self.authentication_required || self.config.read_failed() || self.transport_lost {
            Some("rune.connect_error")
        } else if self.config.any_failure(is_transcript) {
            Some("settings.preferenceSaveFailed")
        } else {
            None
        }
    }

    pub(super) fn retry_transcript(&mut self) {
        self.config.retry(is_transcript);
        if self.transport_lost {
            self.config.retry_revalidation(true);
            self.state.retry_revalidation(true);
            if self.show_server || self.show_environment || self.server.unsettled() {
                self.server.retry_revalidation(true);
            }
        }
    }

    pub(super) fn retry_advanced(&mut self) {
        self.config.retry(is_advanced);
        if self.transport_lost {
            self.config.retry_revalidation(true);
        }
    }

    pub(super) fn advanced_failed(&self) -> bool {
        self.config.any_failure(is_advanced)
    }

    pub(super) fn notifications_error(&self) -> Option<&'static str> {
        if self.authentication_required || self.config.read_failed() || self.transport_lost {
            Some("rune.connect_error")
        } else if self.config.any_failure(is_notification) {
            Some("settings.preferenceSaveFailed")
        } else {
            None
        }
    }

    #[cfg(test)]
    pub(super) fn notifications_failed(&self) -> bool {
        self.notifications_error().is_some()
    }

    pub(super) fn retry_notifications(&mut self) {
        self.config.retry(is_notification);
        if self.transport_lost {
            self.config.retry_revalidation(true);
        }
    }

    pub(super) fn retry_shortcuts(&mut self) {
        self.config.retry(is_shortcut);
        if self.transport_lost {
            self.config.retry_revalidation(true);
        }
    }

    pub(super) fn shortcuts_failed(&self) -> bool {
        self.config.any_failure(is_shortcut)
    }

    pub(super) fn general_error(&self) -> Option<&'static str> {
        if self.authentication_required
            || self.config.read_failed()
            || self.state.read_failed()
            || self.transport_lost
        {
            Some("rune.connect_error")
        } else if self.contrast_failed() {
            Some("settings.appearance.contrast.saveError")
        } else if self.config.any_failure(general_config) || self.state.any_failure(general_state) {
            Some("settings.preferenceSaveFailed")
        } else {
            None
        }
    }

    pub fn can_retry(&self) -> bool {
        self.backend.is_some() && !self.authentication_required
    }

    pub fn transport_lost(&self) -> bool {
        self.transport_lost
    }

    pub(super) fn authority_handle(&self) -> Arc<AtomicU64> {
        self.authority.clone()
    }

    pub(super) fn awaiting_appearance(&self) -> bool {
        self.can_retry()
            && (self.config.awaiting_initial_read() || self.state.awaiting_initial_read())
    }

    pub fn watch(&mut self, wake: &rune::Waker) {
        self.watch_project(None, wake);
    }

    pub fn watch_project(&mut self, project: Option<&str>, wake: &rune::Waker) {
        if self.authentication_required {
            return;
        }
        if self
            .stream
            .as_ref()
            .is_some_and(|watch| watch.project() != project)
        {
            self.unwatch();
        }
        if self
            .closing_stream
            .as_ref()
            .is_some_and(|reader| !reader.is_closed())
        {
            return;
        }
        self.observe_transport_drops();
        self.closing_stream = None;
        self.closing_stream_client_id = None;
        if self.stream.is_none()
            && let Some(backend) = &self.backend
        {
            let (watch, task) = PreferencesWatch::task(backend.clone(), project, wake.clone());
            self.stream = Some(watch);
            self.sync_drop_watch();
            platform::spawn(task);
        }
    }

    pub fn unwatch(&mut self) {
        if self.stream.is_some() {
            self.observe_transport_drops();
            self.take_invalidations();
        }
        if let Some(watch) = self.stream.take() {
            self.closing_stream_client_id = Some(watch.client_id().to_owned());
            self.closing_stream = Some(watch.stop());
            self.sync_drop_watch();
        }
    }

    pub fn stop_before_conversation(&mut self) -> Option<codenomad_client::Receiver<()>> {
        self.unwatch();
        self.closing_stream
            .clone()
            .filter(|reader| !reader.is_closed())
    }

    pub fn require_authentication(&mut self) {
        self.authentication_required = true;
        self.revoke_send_authority();
        self.memory.on_authentication_required();
        self.missions.on_transport_lost();
        self.state.settle_palette_mutation_on_auth_expired();
        self.opencode_install.cancel_check();
        if let Some(target) = &mut self.provider_target {
            target.transport(false);
        }
        self.unwatch();
        self.revision += 1;
        if let Some(wake) = &self.window_wake {
            wake();
        }
    }

    pub fn observe_authentication(&mut self) -> bool {
        if self
            .stream
            .as_ref()
            .is_some_and(PreferencesWatch::take_authentication_required)
        {
            self.require_authentication();
            true
        } else {
            false
        }
    }

    pub(super) fn mission_changes(
        &self,
    ) -> (bool, Vec<codenomad_client::transport::WorkspaceEvent>) {
        self.stream
            .as_ref()
            .map_or_else(Default::default, PreferencesWatch::take_missions)
    }

    #[cfg(test)]
    pub fn invalidate(&mut self, owner: Owner) {
        let server_active = self.show_server || self.show_environment || self.server.unsettled();
        if owner != Owner::Server || server_active {
            self.doc_mut(owner).invalidate();
        }
        if owner == Owner::Config && server_active {
            self.server.invalidate();
        }
    }

    pub fn invalidate_from_sse(&mut self, owner: Owner) {
        let server_active = self.show_server || self.show_environment || self.server.unsettled();
        if owner != Owner::Server || server_active {
            self.doc_mut(owner).invalidate_from_sse();
        }
        if owner == Owner::Config && server_active {
            self.server.invalidate_from_sse();
        }
    }

    fn doc_mut(&mut self, owner: Owner) -> &mut Document {
        match owner {
            Owner::Config => &mut self.config,
            Owner::State => &mut self.state,
            Owner::Server => &mut self.server,
        }
    }

    fn doc(&self, owner: Owner) -> &Document {
        match owner {
            Owner::Config => &self.config,
            Owner::State => &self.state,
            Owner::Server => &self.server,
        }
    }

    pub(super) fn notification_config(&self) -> Option<&Value> {
        self.config.confirmed()
    }

    pub(super) fn notification_config_refreshing(&self) -> bool {
        self.config.refreshing()
    }

    #[cfg(test)]
    pub(super) fn reset_notification_fixture(&mut self) {
        self.config = Default::default();
        self.fixture();
    }

    pub fn saved(&self, owner: Owner) -> Option<&Value> {
        self.doc(owner).snapshot.as_ref()
    }

    pub(super) fn config_loaded(&self) -> bool {
        self.saved(Owner::Config).is_some()
            && !self.config.read_failed()
            && !self.transport_lost
            && self.can_retry()
    }

    pub(super) fn config_read_failed(&self) -> bool {
        self.config.read_failed() || self.transport_lost || self.authentication_required
    }

    #[cfg(test)]
    pub(super) fn apply_mission_config(&mut self, snapshot: Value) {
        self.config.seed_external_snapshot(snapshot);
        self.revision += 1;
        for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
            wake();
        }
    }

    pub(super) fn invalidate_config_for_missions(&mut self) {
        self.config.invalidate_authoritative();
    }

    fn apply_mission_effects(
        &mut self,
        effects: super::missions::ConfigEffects,
    ) -> (bool, bool, bool) {
        if effects.revalidate_transport {
            self.revalidate_transport();
        }
        if effects.invalidate {
            self.invalidate_config_for_missions();
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
        (effects.changed, effects.settled, effects.invalidate)
    }

    fn run_mission_op<R>(
        &mut self,
        op: impl FnOnce(&mut super::missions::Shared, &super::missions::ConfigContext<'_>) -> R,
    ) -> R {
        let can_retry = self.backend.is_some() && !self.authentication_required;
        let config_loaded = self.config.snapshot.is_some()
            && !self.config.read_failed()
            && !self.transport_lost
            && can_retry;
        let ctx = super::missions::ConfigContext {
            backend: self.backend.as_ref(),
            config_loaded,
            config_refreshing: self.config.read_refreshing(),
            config_busy: self.config.busy_for_external_write(),
            config_snapshot: self.config.snapshot.as_ref(),
            prefs_authority: self.authority.clone(),
            doc_epoch: self.config.write_authority(),
            transport_lost: self.transport_lost,
            can_retry,
        };
        op(&mut self.missions, &ctx)
    }

    pub(super) fn poll_missions_writes(&mut self, wake: &rune::Waker) -> bool {
        let effects = self.run_mission_op(|missions, ctx| missions.poll_writes(ctx, false, wake));
        self.apply_mission_effects(effects).0
    }

    pub(super) fn start_mission_defaults_reload(&mut self, _wake: &rune::Waker) {
        let effects = self.run_mission_op(|missions, ctx| missions.start_defaults_reload(ctx));
        self.apply_mission_effects(effects);
    }

    pub(super) fn toggle_mission_delete_sessions(&mut self, next: bool, wake: &rune::Waker) {
        let _ =
            self.run_mission_op(|missions, ctx| missions.toggle_delete_sessions(ctx, next, wake));
    }

    pub(super) fn start_mission_library_reload(&mut self, _wake: &rune::Waker) {
        let effects = self.run_mission_op(|missions, ctx| missions.start_library_reload(ctx));
        self.apply_mission_effects(effects);
    }

    pub(super) fn start_mission_model_remove(
        &mut self,
        id: &str,
        owner: &str,
        expected: codenomad_client::settings::missions::MissionPreferenceExpectation,
        wake: &rune::Waker,
    ) {
        let _ = self.run_mission_op(|missions, ctx| {
            missions.start_model_remove(ctx, id, owner, expected, wake)
        });
    }

    pub(super) fn start_mission_models_reset(
        &mut self,
        owner: &str,
        expected: codenomad_client::settings::missions::MissionPreferenceExpectation,
        wake: &rune::Waker,
    ) {
        let _ = self.run_mission_op(|missions, ctx| {
            missions.start_models_reset(ctx, owner, expected, wake)
        });
    }

    #[cfg(test)]
    pub fn error(&self) -> Option<&'static str> {
        if self.authentication_required {
            Some("rune.connect_error")
        } else if self.contrast_failed() {
            Some("settings.appearance.contrast.saveError")
        } else if self
            .config
            .write_failed_other_than(Choice::NewConversationPermissions)
            || self.state.write_failed()
        {
            Some("settings.preferenceSaveFailed")
        } else if self.config.read_failed() || self.state.read_failed() {
            Some("rune.connect_error")
        } else {
            None
        }
    }

    pub fn poll(&mut self) -> bool {
        let disconnected = self.observe_transport_drops() | self.take_invalidations();
        let polled = self.poll_documents();
        disconnected | polled
    }

    fn take_invalidations(&mut self) -> bool {
        let mut disconnected = false;
        if let Some(stream) = &self.stream {
            if stream.take_disconnected() {
                self.revoke_send_authority();
                self.config.mark_transport_lost();
                self.state.mark_transport_lost();
                self.server.mark_transport_lost();
                self.missions.on_transport_lost();
                disconnected = true;
                if !self.transport_lost {
                    self.transport_lost = true;
                    self.revision += 1;
                }
            }
            let (config, state) = stream.take();
            if config {
                self.config.invalidate_from_sse();
            }
            if (config | stream.take_server_changed())
                && (self.show_server || self.show_environment || self.server.unsettled())
            {
                self.server.invalidate_from_sse();
            }
            if state {
                self.state.invalidate_from_sse();
            }
            if stream.take_memory_changed() {
                self.memory.invalidate();
            }
        }
        if disconnected {
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
        disconnected
    }

    fn poll_documents(&mut self) -> bool {
        let (changed, dropped, _) = self.poll_documents_inner(true);
        changed | dropped
    }

    fn poll_documents_inner(&mut self, revalidate_idle: bool) -> (bool, bool, bool) {
        let install = self.opencode_install.poll();
        let memory_verified = !self.authentication_required
            && !self.transport_lost
            && self
                .backend
                .as_ref()
                .is_some_and(super::ServerOwner::backend_verified);
        let memory_writes = self
            .memory
            .poll_pending_writes(self.authority.load(Ordering::SeqCst), memory_verified);
        if self.authentication_required {
            if memory_writes {
                self.revision += 1;
            }
            return (install | memory_writes, false, false);
        }
        let Some(backend) = self.backend.clone() else {
            if memory_writes {
                self.revision += 1;
            }
            return (install | memory_writes, false, false);
        };
        let active_client_ids = self.active_client_ids(&backend);
        let seen_drops = self.seen_drops_sum(&active_client_ids);
        let (main, window) = (self.main_wake.clone(), self.window_wake.clone());
        #[cfg(not(target_arch = "wasm32"))]
        let (poll_config, poll_state, poll_server) = (
            revalidate_idle
                || self.config.has_unconfirmed()
                || self.missions.needs_config_revalidation(),
            revalidate_idle || self.state.has_unconfirmed(),
            (self.show_server || self.show_environment || self.server.unsettled())
                && (revalidate_idle || self.server.has_unconfirmed()),
        );
        #[cfg(target_arch = "wasm32")]
        let (poll_config, poll_state, poll_server) = (
            true,
            true,
            self.show_server || self.show_environment || self.server.unsettled(),
        );
        let (mut config_changed, mut config_settled) = if poll_config {
            self.config.poll(
                &backend,
                Owner::Config,
                &active_client_ids,
                seen_drops,
                self.transport_lost,
                self.missions.config_write_in_flight(),
                &main,
                &window,
            )
        } else {
            (false, false)
        };
        if self.transport_lost && self.config.transport_revalidated() {
            self.transport_lost = false;
            if revalidate_idle {
                self.state.retry_revalidation(false);
                if self.show_server || self.show_environment || self.server.unsettled() {
                    self.server.retry_revalidation(false);
                }
            }
        }
        let (state_changed, state_settled) = if poll_state {
            self.state.poll(
                &backend,
                Owner::State,
                &active_client_ids,
                seen_drops,
                self.transport_lost,
                false,
                &main,
                &window,
            )
        } else {
            (false, false)
        };
        let (server_changed, server_settled) = if poll_server {
            self.server.poll(
                &backend,
                Owner::Server,
                &active_client_ids,
                seen_drops,
                self.transport_lost,
                false,
                &main,
                &window,
            )
        } else {
            (false, false)
        };
        let (missions_changed, missions_settled, missions_invalidated) = {
            let fallback_wake: rune::Waker;
            let wake = match window.as_ref().or(main.as_ref()) {
                Some(wake) => wake,
                None => {
                    fallback_wake = Arc::new(|| {});
                    &fallback_wake
                }
            };
            let launch_pending_depth = !revalidate_idle || self.provider_target.is_none();
            let effects = self.run_mission_op(|missions, ctx| {
                missions.poll_writes(ctx, launch_pending_depth, wake)
            });
            self.apply_mission_effects(effects)
        };
        if missions_invalidated && poll_config && !self.missions.config_write_in_flight() {
            let (followup_changed, followup_settled) = self.config.poll(
                &backend,
                Owner::Config,
                &active_client_ids,
                seen_drops,
                self.transport_lost,
                false,
                &main,
                &window,
            );
            config_changed |= followup_changed;
            config_settled |= followup_settled;
        }
        let changed = config_changed
            | state_changed
            | server_changed
            | missions_changed
            | memory_writes
            | self.memory.poll(
                &backend,
                self.transport_lost,
                &self.authority,
                &main,
                &window,
            )
            | self.memory.poll_review(
                &backend,
                self.provider_target.as_ref(),
                self.transport_lost,
                &self.authority,
                &main,
                &window,
            )
            | install;
        let settled = config_settled | state_settled | server_settled | missions_settled;
        let dropped_mid_poll = self.observe_transport_drops();
        if changed {
            self.revision += 1;
        }
        (changed, dropped_mid_poll, settled)
    }

    pub fn locale(&self) -> Option<&'static str> {
        let id = self.saved(Owner::Config)?["settings"]["locale"].as_str()?;
        Some(rune_theme_codenomad::catalogue::canonical_locale(id))
    }

    pub fn contrast(&self) -> &'static str {
        let confirmed = self
            .saved(Owner::Config)
            .and_then(|doc| doc["settings"]["highContrast"].as_str());
        let proposed = (!self.contrast_failed())
            .then(|| self.config.requested(Choice::Contrast))
            .flatten();
        match proposed.or(confirmed) {
            Some("on") => "on",
            Some("off") => "off",
            _ => "auto",
        }
    }

    pub(super) fn contrast_failed(&self) -> bool {
        self.config.choice_failed(Choice::Contrast)
    }

    pub(super) fn set_contrast(&mut self, contrast: &'static str) {
        if self.locale_ready()
            && self.can_retry()
            && (contrast != self.contrast() || self.contrast_failed())
        {
            self.config.stage(Choice::Contrast, contrast);
            if let Some(wake) = &self.main_wake {
                wake();
            }
        }
    }

    pub fn locale_display(&self) -> Option<&'static str> {
        self.config
            .requested(Choice::Locale)
            .map(rune_theme_codenomad::catalogue::canonical_locale)
            .or_else(|| self.locale())
    }

    pub fn locale_ready(&self) -> bool {
        !self.authentication_required
            && self.config.snapshot.is_some()
            && !self.config.read_failed()
    }

    pub fn set_locale(&mut self, locale: &'static str) {
        if self.locale_ready() && self.backend.is_some() && Some(locale) != self.locale_display() {
            self.config.stage(Choice::Locale, locale);
        }
    }

    pub(super) fn recent_folders(&self) -> Vec<(String, Option<u64>, Option<String>)> {
        let Some(rows) = self.recent_folders_raw() else {
            return Vec::new();
        };
        rows.iter()
            .filter_map(|row| {
                let path = row.get("path")?.as_str()?.trim();
                if path.is_empty() {
                    return None;
                }
                let last_accessed = row.get("lastAccessed").and_then(Value::as_u64);
                let project_name = row
                    .get("projectName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned);
                Some((path.to_owned(), last_accessed, project_name))
            })
            .collect()
    }

    pub(super) fn recent_folders_raw(&self) -> Option<Vec<Value>> {
        let state = self.saved(Owner::State)?;
        let rows = state.get("recentFolders").and_then(Value::as_array)?;
        Some(rows.clone())
    }

    pub(super) fn apply_recent_folders_snapshot(&mut self, value: &Value) {
        if let Some(recents) = value.get("recentFolders").filter(|v| v.is_array())
            && let Some(state) = self.state.snapshot.as_mut().and_then(Value::as_object_mut)
        {
            state.insert("recentFolders".into(), recents.clone());
            self.revision += 1;
        }
        self.invalidate_from_sse(Owner::State);
    }

    pub(super) fn binding_epoch(&self) -> u64 {
        self.binding_epoch
    }

    pub fn mode(&self) -> &'static str {
        let Some(state) = self.saved(Owner::State) else {
            return "system";
        };
        match state["appearancePreferences"]["mode"].as_str() {
            Some("light") => "light",
            Some("dark") => "dark",
            Some("system") => "system",
            _ => self
                .legacy_scheme(state)
                .map_or("system", |legacy| super::palettes::mode_str(legacy.dark)),
        }
    }

    pub(super) fn dark(&self, system_dark: bool) -> bool {
        match self.mode() {
            "light" => false,
            "dark" => true,
            _ => system_dark,
        }
    }

    pub fn set_mode(&mut self, mode: &'static str) {
        if !self.mode_ready() || self.backend.is_none() || self.mode_display() == mode {
            return;
        }
        // The legacy selection still supplies a missing slot. Only update the
        // mode, so neither defaults nor another window's palette move with it.
        self.state.stage(Choice::Mode, mode);
    }

    pub fn mode_ready(&self) -> bool {
        !self.authentication_required && self.state.snapshot.is_some() && !self.state.read_failed()
    }

    pub fn mode_display(&self) -> &'static str {
        self.state
            .requested(Choice::Mode)
            .unwrap_or_else(|| self.mode())
    }

    fn legacy_scheme(&self, state: &Value) -> Option<super::palettes::LegacyScheme> {
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        super::palettes::legacy_scheme(state, config)
    }

    pub fn palette(&self, dark: bool) -> Option<&'static Palette> {
        let state = self.saved(Owner::State)?;
        let mode = if dark { "dark" } else { "light" };
        let legacy = self.legacy_scheme(state).filter(|l| l.dark == dark);
        let id = state["appearancePreferences"][mode]["scheme"]["id"]
            .as_str()
            .or_else(|| legacy.as_ref().map(|l| l.id));
        let palettes = built_in();
        palettes
            .iter()
            .find(|p| p.dark == dark && Some(p.id) == id)
            .or_else(|| {
                palettes
                    .iter()
                    .find(|p| p.id == if dark { "mist" } else { "porcelain" })
            })
    }

    pub fn set_palette(&mut self, palette: &'static Palette) {
        if !self.palette_ready() || self.backend.is_none() {
            return;
        }
        if self.needs_slot_migration(palette.dark) {
            let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SelectBuiltIn {
                id: palette.id,
                dark: palette.dark,
            });
            self.state.stage_palette_mutation(mutation);
            return;
        }
        self.state.clear_palette_mutation();
        if self.state.requested(Choice::Palette(palette.dark)) != Some(palette.id) {
            self.state.stage(Choice::Palette(palette.dark), palette.id);
        }
    }

    fn needs_slot_migration(&self, dark: bool) -> bool {
        let Some(state) = self.saved(Owner::State) else {
            return false;
        };
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        super::palettes::needs_slot_migration(state, config, dark, None)
    }

    pub(super) fn set_palette_preview(
        &mut self,
        preview: Option<(bool, Option<&'static str>, ColorSchemeColors)>,
    ) {
        if self.palette_preview != preview {
            self.palette_preview = preview;
            self.revision += 1;
        }
    }

    pub(super) fn has_palette_preview(&self) -> bool {
        self.palette_preview.is_some()
    }

    pub(super) fn palette_slot(&self, dark: bool) -> Option<super::palettes::SlotSelection> {
        let state = self.saved(Owner::State)?;
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        let legacy = self.legacy_scheme(state);
        if !self.state.choice_failed(Choice::Palette(dark))
            && let Some(id) = self.state.requested(Choice::Palette(dark))
            && let Some(palette) = built_in().iter().find(|p| p.dark == dark && p.id == id)
        {
            let override_colors = super::palettes::normalize_overrides(state)
                .get(palette.id)
                .cloned();
            return Some(super::palettes::SlotSelection {
                key: format!("builtin:{}", palette.id),
                builtin_id: Some(palette.id),
                preset_id: None,
                dark,
                colors: override_colors,
            });
        }
        Some(super::palettes::resolve_slot(
            state,
            config,
            legacy.as_ref(),
            dark,
        ))
    }

    pub(super) fn resolved_palette(
        &self,
        dark: bool,
        high_contrast: bool,
        include_preview: bool,
    ) -> Option<ResolvedPalette> {
        if include_preview
            && let Some((preview_dark, builtin_id, colors)) = &self.palette_preview
            && *preview_dark == dark
        {
            let id = builtin_id.filter(|id| *id != "custom");
            return Some(custom(id, dark, high_contrast, colors.clone()));
        }
        if let Some(slot) = self.palette_slot(dark) {
            return slot.resolve(high_contrast);
        }
        high_contrast
            .then(|| increased_contrast(None, dark).map(ResolvedPalette::BuiltIn))
            .flatten()
    }

    pub(super) fn palette_display_signature(&self, dark: bool) -> String {
        self.palette_slot(dark)
            .map_or_else(String::new, |slot| slot.display_signature())
    }

    pub(super) fn palette_options(&self, dark: bool) -> Vec<super::palettes::PaletteOption> {
        let Some(state) = self.saved(Owner::State) else {
            return Vec::new();
        };
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        let Some(active) = self.palette_slot(dark) else {
            return Vec::new();
        };
        super::palettes::options(state, config, &active, dark)
    }

    pub(super) fn has_saved_override(&self, builtin_id: &str) -> bool {
        self.saved(Owner::State).is_some_and(|state| {
            super::palettes::normalize_overrides(state).contains_key(builtin_id)
        })
    }

    pub(super) fn preset_count(&self) -> usize {
        self.saved(Owner::State)
            .map_or(0, |state| super::palettes::normalize_presets(state).len())
    }

    pub(super) fn preset_names(&self) -> Vec<String> {
        self.saved(Owner::State).map_or_else(Vec::new, |state| {
            super::palettes::normalize_presets(state)
                .into_iter()
                .map(|p| p.name)
                .collect()
        })
    }

    pub(super) fn palette_saving(&self) -> bool {
        self.state.palette_mutation_pending()
    }

    pub(super) fn palette_save_failed(&self) -> bool {
        self.state.palette_mutation_failed()
    }

    pub(super) fn set_mode_confirmed(&mut self, mode: &'static str) -> bool {
        if !self.mode_ready() || self.backend.is_none() || self.mode_display() == mode {
            return false;
        }
        let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SetMode { mode });
        self.state.stage_palette_mutation(mutation);
        true
    }

    pub(super) fn clear_palette_save_failed(&mut self) {
        self.state.clear_palette_mutation();
    }

    fn wrap_palette_mutation(
        &self,
        op: super::palettes::PaletteOp,
    ) -> super::palettes::PaletteMutation {
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        super::palettes::PaletteMutation {
            op,
            legacy_config: super::palettes::legacy_config_fields(config),
        }
    }

    pub(super) fn select_palette_option(
        &mut self,
        option: &super::palettes::PaletteOption,
        force_mutation: bool,
    ) -> bool {
        if !self.palette_ready() || self.backend.is_none() {
            return false;
        }
        if let Some(preset_id) = &option.preset_id {
            let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SelectPreset {
                preset_id: preset_id.clone(),
                dark: option.dark,
                colors: option.colors.clone(),
            });
            self.state.stage_palette_mutation(mutation);
            return true;
        }
        let Some(id) = option.builtin_id else {
            return false;
        };
        if id == "custom" {
            let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SelectCustom {
                dark: option.dark,
            });
            self.state.stage_palette_mutation(mutation);
            return true;
        }
        if force_mutation || self.needs_slot_migration(option.dark) {
            let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SelectBuiltIn {
                id,
                dark: option.dark,
            });
            self.state.stage_palette_mutation(mutation);
            return true;
        }
        if let Some(palette) = built_in()
            .iter()
            .find(|p| p.id == id && p.dark == option.dark)
        {
            self.set_palette(palette);
            return true;
        }
        false
    }

    pub(super) fn save_palette_override(
        &mut self,
        id: &'static str,
        dark: bool,
        colors: ColorSchemeColors,
    ) -> bool {
        if !self.palette_ready() || self.backend.is_none() {
            return false;
        }
        let op = if id == "custom" {
            super::palettes::PaletteOp::SaveCustom { dark, colors }
        } else {
            super::palettes::PaletteOp::SaveOverride { id, dark, colors }
        };
        let mutation = self.wrap_palette_mutation(op);
        self.state.stage_palette_mutation(mutation);
        true
    }

    pub(super) fn reset_palette_override(&mut self, id: &'static str, dark: bool) -> bool {
        if !self.palette_ready() || self.backend.is_none() {
            return false;
        }
        if id == "custom" {
            let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SaveCustom {
                dark,
                colors: ColorSchemeColors::default_custom(),
            });
            self.state.stage_palette_mutation(mutation);
            return true;
        }
        let Some(palette) = built_in().iter().find(|p| p.id == id && p.dark == dark) else {
            return false;
        };
        let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::ResetOverride {
            id,
            dark,
            default_colors: palette.colors(),
        });
        self.state.stage_palette_mutation(mutation);
        true
    }

    pub(super) fn save_palette_preset(
        &mut self,
        name: &str,
        dark: bool,
        colors: ColorSchemeColors,
        preset_id: Option<String>,
        allow_new_id: bool,
    ) -> Option<String> {
        self.save_palette_preset_fields(name, dark, colors, preset_id, allow_new_id, None)
    }

    pub(super) fn save_palette_preset_fields(
        &mut self,
        name: &str,
        dark: bool,
        colors: ColorSchemeColors,
        preset_id: Option<String>,
        allow_new_id: bool,
        edited_fields: Option<Vec<rune_theme_codenomad::palettes::ColorField>>,
    ) -> Option<String> {
        if !self.palette_ready() || self.backend.is_none() {
            return None;
        }
        let trimmed: String = name
            .trim()
            .chars()
            .take(super::palettes::MAX_PRESET_NAME_LEN)
            .collect();
        if trimmed.is_empty() {
            return None;
        }
        let existing = preset_id.as_ref().is_some_and(|existing_id| {
            self.saved(Owner::State).is_some_and(|state| {
                super::palettes::normalize_presets(state)
                    .iter()
                    .any(|p| p.id == *existing_id)
            })
        });
        if !existing && self.preset_count() >= super::palettes::MAX_PRESETS {
            return None;
        }
        if preset_id.is_some() && !existing && !allow_new_id {
            return None;
        }
        let id = match preset_id {
            Some(id) => id,
            None => codenomad_client::http::client_id().ok()?,
        };
        let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::SavePreset {
            preset_id: id.clone(),
            name: trimmed,
            dark,
            colors,
            allow_new: allow_new_id,
            edited_fields,
        });
        self.state.stage_palette_mutation(mutation);
        Some(id)
    }

    pub(super) fn delete_palette_preset(&mut self, preset_id: &str) -> bool {
        if !self.palette_ready() || self.backend.is_none() {
            return false;
        }
        let Some(state) = self.saved(Owner::State) else {
            return false;
        };
        if !super::palettes::normalize_presets(state)
            .iter()
            .any(|p| p.id == preset_id)
        {
            return false;
        }
        let mutation = self.wrap_palette_mutation(super::palettes::PaletteOp::DeletePreset {
            preset_id: preset_id.to_owned(),
        });
        self.state.stage_palette_mutation(mutation);
        true
    }

    pub fn palette_ready(&self) -> bool {
        self.mode_ready()
            && (self.config.snapshot.is_some()
                || self.config.read_failed()
                || self.state.snapshot.as_ref().is_some_and(|state| {
                    state["appearancePreferences"]["mode"].is_string()
                        || state.get("theme").is_some()
                        || state.get("colorScheme").is_some()
                }))
            && self.state.requested(Choice::Mode).is_none()
    }

    pub fn palette_display(&self, dark: bool) -> Option<&'static Palette> {
        (!self.state.choice_failed(Choice::Palette(dark)))
            .then(|| self.state.requested(Choice::Palette(dark)))
            .flatten()
            .and_then(|id| built_in().iter().find(|p| p.dark == dark && p.id == id))
            .or_else(|| self.palette(dark))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn fixture(&mut self) {
        self.fixture_locale("en");
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn fixture_locale(&mut self, locale: &str) {
        self.config.snapshot = Some(json!({"settings":{"locale":locale}}));
        self.state.snapshot = Some(
            json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":"light"}},"dark":{"scheme":{"id":"classic"}}}}),
        );
    }

    #[cfg(test)]
    pub(super) fn fixture_state(&mut self, value: Value) {
        self.state.snapshot = Some(value);
        self.revision += 1;
    }

    #[cfg(test)]
    pub(super) fn fixture_appearance(
        &mut self,
        light_scheme: &str,
        dark_scheme: &str,
        high_contrast: &str,
    ) {
        self.config.snapshot =
            Some(json!({"settings":{"locale":"en","highContrast":high_contrast}}));
        self.state.snapshot = Some(
            json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":light_scheme}},"dark":{"scheme":{"id":dark_scheme}}}}),
        );
        self.revision += 1;
    }

    #[cfg(test)]
    pub(super) fn fixture_mode(&mut self, mode: &'static str) {
        if let Some(state) = &mut self.state.snapshot {
            state["appearancePreferences"]["mode"] = json!(mode);
            self.revision += 1;
        }
    }

    #[cfg(test)]
    pub(super) fn fixture_config_read_failed(&mut self, failed: bool) {
        self.config.set_read_failed(failed);
        self.revision += 1;
    }

    #[cfg(test)]
    pub(super) fn fixture_usage(&mut self, mode: &str) {
        let config = self
            .config
            .snapshot
            .get_or_insert_with(|| json!({"settings": {}}));
        config["settings"]["showUsageMetrics"] = json!(mode != "hidden");
        config["settings"]["usageMetricsExpansion"] = json!(mode);
    }
}

fn general_config(choice: Choice) -> bool {
    matches!(
        choice,
        Choice::Locale | Choice::Contrast | Choice::GeneralBehavior(_)
    )
}

fn is_transcript(choice: Choice) -> bool {
    matches!(choice, Choice::TranscriptPreset | Choice::TranscriptRow(_))
}

fn general_state(choice: Choice) -> bool {
    matches!(choice, Choice::Mode | Choice::Palette(_))
}

fn is_advanced(choice: Choice) -> bool {
    matches!(choice, Choice::Advanced(toggle) if toggle.supported())
}

fn is_notification(choice: Choice) -> bool {
    matches!(
        choice,
        Choice::NotificationRoute(..) | Choice::NotificationsFocused
    )
}

fn is_shortcut(choice: Choice) -> bool {
    matches!(choice, Choice::Shortcut(_) | Choice::ShortcutReset)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
