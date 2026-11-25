pub(super) mod behavior;
#[cfg(not(target_arch = "wasm32"))]
mod close_drain;
mod document;
mod notifications;
pub(super) mod server;

use super::transcript_preset::{self, Row};
use crate::{backend::Backend, platform};
#[cfg(not(target_arch = "wasm32"))]
pub(super) use close_drain::CloseOutcome;
pub(super) use codenomad_client::settings::Owner;
use codenomad_client::settings::PreferencesWatch;
pub(super) use document::env_var_is_masked;
use document::{Choice, Document};
use rune_theme_codenomad::palettes::{Palette, built_in};
use serde_json::Value;
#[cfg(any(test, feature = "test-support"))]
use serde_json::json;

#[derive(Default)]
pub(super) struct Preferences {
    pub(super) backend: Option<Backend>,
    pub(super) provider_target: Option<super::providers::Target>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) open_providers: bool,
    pub(super) memory: super::memory::Setting,
    pub(super) opencode_install: super::opencode::install::Install,
    pub(super) notification_update: Option<String>,
    pub(super) announced_update: Option<String>,
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
    #[cfg(not(target_arch = "wasm32"))]
    close_drain: Option<close_drain::CloseDrain>,
    #[cfg(not(target_arch = "wasm32"))]
    drain_wake: std::sync::Arc<std::sync::Mutex<Option<rune::Waker>>>,
    #[cfg(not(target_arch = "wasm32"))]
    pending_save_warning: Option<&'static str>,
    #[cfg(all(test, not(target_arch = "wasm32")))]
    drain_budgets: Option<(std::time::Duration, std::time::Duration)>,
}

impl Preferences {
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
        let watch_continuously_healthy = self.has_healthy_watch_stream()
            && self.stream.as_ref().is_some_and(|stream| {
                backend.client.transport_drops(stream.client_id())
                    == self.seen_drop(stream.client_id())
            });
        if !healthy_observed.is_empty() {
            ids.extend(healthy_observed);
        } else if !watch_continuously_healthy {
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

    pub(super) fn mark_transport_lost(&mut self) {
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
        self.config.mark_transport_lost();
        self.state.mark_transport_lost();
        self.server.mark_transport_lost();
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
        self.config.prepare_drain(config_rev, retry_failed, atomic);
        self.state.prepare_drain(state_rev, retry_failed, atomic);
        self.server.prepare_drain(server_rev, retry_failed, atomic);
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
    fn documents_draining(&self) -> bool {
        self.config.draining() || self.state.draining() || self.server.draining()
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
                    && old.client.server_identity().is_some()
                    && old.client.server_identity() == new.client.server_identity()
            });
        self.unwatch();
        if !same_address {
            #[cfg(not(target_arch = "wasm32"))]
            if self.close_drain.take().is_some() {
                self.clear_drain_wake();
                if self.has_unconfirmed() {
                    self.pending_save_warning =
                        Some(self.locale().unwrap_or_else(crate::strings::locale));
                }
            }
            self.seen_drops.clear();
            self.closing_stream_client_id = None;
        }
        self.config.rebind(same_address);
        self.state.rebind(same_address);
        self.server.rebind(same_address);
        self.memory.bind(same_address);
        self.opencode_install.cancel_check();
        self.backend = owner;
        self.seen_drop_generation = self
            .backend
            .as_ref()
            .map_or(0, |b| b.client.drop_generation());
        self.authentication_required = false;
        self.transport_lost = same_address;
        self.observed_clients.clear();
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
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(last_revs) = self.close_drain.as_ref().map(|drain| drain.last_revs) {
            let rev_changed = self.preferences_revisions() != last_revs;
            if disconnected || rev_changed {
                self.prepare_all_drains(rev_changed, false);
            }
            let (changed, dropped_mid_poll, settled) = self.poll_documents_inner(false);
            let drain_changed =
                self.step_close_drain(disconnected, rev_changed, dropped_mid_poll, settled);
            return disconnected | changed | dropped_mid_poll | drain_changed;
        }
        let polled = self.poll_documents();
        disconnected | polled
    }

    fn take_invalidations(&mut self) -> bool {
        let mut disconnected = false;
        if let Some(stream) = &self.stream {
            if stream.take_disconnected() {
                self.config.mark_transport_lost();
                self.state.mark_transport_lost();
                self.server.mark_transport_lost();
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
        if self.authentication_required {
            return (install, false, false);
        }
        let Some(backend) = self.backend.clone() else {
            return (install, false, false);
        };
        let active_client_ids = self.active_client_ids(&backend);
        let seen_drops = self.seen_drops_sum(&active_client_ids);
        let (main, window) = (self.main_wake.clone(), self.window_wake.clone());
        #[cfg(not(target_arch = "wasm32"))]
        let (poll_config, poll_state, poll_server) = (
            revalidate_idle || self.config.has_unconfirmed(),
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
        let (config_changed, config_settled) = if poll_config {
            self.config.poll(
                &backend,
                Owner::Config,
                &active_client_ids,
                seen_drops,
                self.transport_lost,
                &main,
                &window,
                #[cfg(not(target_arch = "wasm32"))]
                &self.drain_wake,
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
                &main,
                &window,
                #[cfg(not(target_arch = "wasm32"))]
                &self.drain_wake,
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
                &main,
                &window,
                #[cfg(not(target_arch = "wasm32"))]
                &self.drain_wake,
            )
        } else {
            (false, false)
        };
        let changed = config_changed
            | state_changed
            | server_changed
            | self.memory.poll(&backend, &main, &window)
            | self
                .memory
                .poll_review(&backend, self.provider_target.as_ref(), &main, &window)
            | install;
        let settled = config_settled | state_settled | server_settled;
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

    pub fn mode(&self) -> &'static str {
        let Some(state) = self.saved(Owner::State) else {
            return "system";
        };
        match state["appearancePreferences"]["mode"].as_str() {
            Some("light") => "light",
            Some("dark") => "dark",
            Some("system") => "system",
            _ => self
                .legacy(state)
                .map_or("system", |(appearance, _)| appearance),
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

    fn legacy(&self, state: &Value) -> Option<(&'static str, &'static str)> {
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        let scheme = state
            .get("colorScheme")
            .or_else(|| config.get("colorScheme"));
        if let Some(scheme) = scheme {
            let id = scheme.as_str().or_else(|| scheme["id"].as_str());
            if id == Some("system") {
                return None;
            }
            if id == Some("custom") {
                let appearance = if scheme["appearance"] == "light" {
                    "light"
                } else {
                    "dark"
                };
                return Some((appearance, "custom"));
            }
            if let Some(palette) = built_in().iter().find(|p| Some(p.id) == id) {
                let appearance = if palette.dark { "dark" } else { "light" };
                return Some((appearance, palette.id));
            }
        }
        let (appearance, id) = match state
            .get("theme")
            .or_else(|| config.get("theme"))
            .and_then(Value::as_str)
        {
            Some("light") => ("light", "light"),
            Some("dark") => ("dark", "classic"),
            _ => return None,
        };
        Some((appearance, id))
    }

    pub fn palette(&self, dark: bool) -> Option<&'static Palette> {
        let state = self.saved(Owner::State)?;
        let mode = if dark { "dark" } else { "light" };
        let legacy = self
            .legacy(state)
            .filter(|(appearance, _)| *appearance == mode);
        let id = state["appearancePreferences"][mode]["scheme"]["id"]
            .as_str()
            .or_else(|| legacy.map(|(_, id)| id));
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
        if self.state.requested(Choice::Palette(palette.dark)) != Some(palette.id) {
            self.state.stage(Choice::Palette(palette.dark), palette.id);
        }
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
        self.state
            .requested(Choice::Palette(dark))
            .and_then(|id| built_in().iter().find(|p| p.dark == dark && p.id == id))
            .or_else(|| self.palette(dark))
    }

    pub fn step_palette(&mut self, dark: bool, step: isize) {
        let options: Vec<_> = built_in().iter().filter(|p| p.dark == dark).collect();
        let Some(current) = self.palette_display(dark) else {
            return;
        };
        let next = options
            .iter()
            .position(|p| p.id == current.id)
            .and_then(|index| index.checked_add_signed(step))
            .and_then(|index| options.get(index));
        if let Some(palette) = next {
            self.set_palette(palette);
        }
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
