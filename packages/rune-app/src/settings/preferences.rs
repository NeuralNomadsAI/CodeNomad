pub(super) mod behavior;
mod document;
mod notifications;
pub(super) mod server;

use crate::{backend::Backend, platform};
pub(super) use codenomad_client::settings::Owner;
use codenomad_client::settings::PreferencesWatch;
use document::{Choice, Document};
use rune_theme_codenomad::palettes::{Palette, built_in};
use serde_json::Value;
#[cfg(any(test, feature = "test-support"))]
use serde_json::json;

#[derive(Default)]
pub(super) struct Preferences {
    pub(super) backend: Option<Backend>,
    pub(super) provider_target: Option<super::providers::Target>,
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
    authentication_required: bool,
}

impl Preferences {
    pub(super) fn usage_visibility(&self, pending: bool) -> &'static str {
        let settings = self
            .saved(Owner::Config)
            .map(|data| &data["settings"])
            .unwrap_or(&Value::Null);
        let requested = |choice| {
            (pending && !self.config.choice_failed(choice))
                .then(|| self.config.requested(choice))
                .flatten()
        };
        if !requested(Choice::UsageVisible).map_or_else(
            || settings["showUsageMetrics"].as_bool() == Some(true),
            |value| value == "on",
        ) {
            return "hidden";
        }
        match requested(Choice::UsageExpansion)
            .or_else(|| settings["usageMetricsExpansion"].as_str())
        {
            Some("expanded") => "expanded",
            Some("collapsed") => "collapsed",
            _ if settings["toolCallExpansionDefaults"]["preset"] == "everything" => "expanded",
            _ => "collapsed",
        }
    }

    pub(super) fn set_usage_visibility(&mut self, mode: &'static str) {
        if self.saved(Owner::Config).is_none()
            || !self.can_retry()
            || mode == self.usage_visibility(true)
        {
            return;
        }
        self.config.stage(
            Choice::UsageVisible,
            if mode == "hidden" { "off" } else { "on" },
        );
        if mode != "hidden" {
            self.config.stage(Choice::UsageExpansion, mode);
        }
        self.revision += 1;
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

    #[cfg(test)]
    pub(super) fn fixture_shortcuts(&mut self, overrides: Value) {
        self.config.snapshot = Some(json!({"settings": {"hotkeyOverrides": overrides}}));
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn flush(&mut self) -> bool {
        use std::time::Duration;
        if self.backend.is_some() && !self.authentication_required {
            self.take_invalidations();
            self.config.prepare_drain();
            self.state.prepare_drain();
            self.server.prepare_drain();
            // Each lane can finish a PATCH/readback, a retry preflight, and one trailing PATCH/readback.
            if self.documents_draining() {
                platform::block_on(async {
                    let _ = tokio::time::timeout(
                        codenomad_client::http::REQUEST_TIMEOUT * 5 + Duration::from_millis(100),
                        async {
                            while self.documents_draining() {
                                self.poll_documents();
                                if self.config.draining() || self.state.draining() {
                                    platform::sleep(Duration::from_millis(10)).await;
                                }
                            }
                        },
                    )
                    .await;
                });
            }
        }
        !self.config.has_unconfirmed()
            && !self.state.has_unconfirmed()
            && !self.server.has_unconfirmed()
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
        self.config.rebind(same_address);
        self.state.rebind(same_address);
        self.server.rebind(same_address);
        self.memory.bind(same_address);
        self.opencode_install.cancel_check();
        self.backend = owner;
        self.authentication_required = false;
        self.unwatch();
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
    }

    pub(super) fn retry_advanced(&mut self) {
        self.config.retry(is_advanced);
    }

    pub(super) fn advanced_failed(&self) -> bool {
        self.config.any_failure(is_advanced)
    }

    pub(super) fn notifications_failed(&self) -> bool {
        self.config.any_failure(is_notification)
    }

    pub(super) fn retry_notifications(&mut self) {
        self.config.retry(is_notification);
    }

    pub(super) fn retry_shortcuts(&mut self) {
        self.config.retry(is_shortcut);
    }

    pub(super) fn shortcuts_failed(&self) -> bool {
        self.config.any_failure(is_shortcut)
    }

    pub(super) fn general_error(&self) -> Option<&'static str> {
        if self.authentication_required || self.config.read_failed() || self.state.read_failed() {
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
        self.closing_stream = None;
        if self.stream.is_none()
            && let Some(backend) = &self.backend
        {
            let (watch, task) = PreferencesWatch::task(backend.clone(), project, wake.clone());
            self.stream = Some(watch);
            platform::spawn(task);
        }
    }

    pub fn unwatch(&mut self) {
        if let Some(watch) = self.stream.take() {
            self.closing_stream = Some(watch.stop());
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

    pub(super) fn mission_stream_state(&self) -> Option<bool> {
        self.stream
            .as_ref()
            .and_then(PreferencesWatch::take_stream_state)
    }

    pub fn invalidate(&mut self, owner: Owner) {
        if owner != Owner::Server || self.show_server {
            self.doc_mut(owner).invalidate();
        }
        if owner == Owner::Config && self.show_server {
            self.server.invalidate();
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
        self.take_invalidations();
        self.poll_documents()
    }

    fn take_invalidations(&mut self) {
        if let Some(stream) = &self.stream {
            let (config, state) = stream.take();
            if config {
                self.config.invalidate();
            }
            if (config | stream.take_server_changed())
                && (self.show_server || self.show_environment)
            {
                self.server.invalidate();
            }
            if state {
                self.state.invalidate();
            }
            if stream.take_memory_changed() {
                self.memory.invalidate();
            }
        }
    }

    fn poll_documents(&mut self) -> bool {
        let install = self.opencode_install.poll();
        if self.authentication_required {
            return install;
        }
        let Some(backend) = &self.backend else {
            return install;
        };
        let (main, window) = (self.main_wake.clone(), self.window_wake.clone());
        let changed = self.config.poll(backend, Owner::Config, &main, &window)
            | self.state.poll(backend, Owner::State, &main, &window)
            | ((self.show_server || self.show_environment || self.server.unsettled())
                && self.server.poll(backend, Owner::Server, &main, &window))
            | self.memory.poll(backend, &main, &window)
            | self
                .memory
                .poll_review(backend, self.provider_target.as_ref(), &main, &window)
            | install;
        if changed {
            self.revision += 1;
        }
        changed
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

    pub fn mission_delete_sessions(&self) -> Option<bool> {
        if self.authentication_required {
            return None;
        }
        let doc = self.config.confirmed()?;
        Some(
            doc["settings"]["missionDeleteSessions"]
                .as_bool()
                .unwrap_or(false),
        )
    }

    pub(super) fn mission_delete_sessions_display(&self) -> Option<bool> {
        if let Some(requested) = self.config.requested(Choice::MissionDeleteSessions)
            && !self.mission_delete_sessions_failed()
        {
            return Some(requested == "true");
        }
        Some(
            self.saved(Owner::Config)?["settings"]["missionDeleteSessions"]
                .as_bool()
                .unwrap_or(false),
        )
    }

    pub(super) fn mission_delete_sessions_pending(&self) -> bool {
        self.config
            .requested(Choice::MissionDeleteSessions)
            .is_some()
            && !self.mission_delete_sessions_failed()
    }

    pub(super) fn mission_delete_sessions_failed(&self) -> bool {
        self.config.choice_failed(Choice::MissionDeleteSessions)
    }

    pub(super) fn mission_delete_sessions_error(&self) -> Option<&'static str> {
        if self.authentication_required || self.config.read_failed() {
            Some("rune.connect_error")
        } else if self.mission_delete_sessions_failed() {
            Some("settings.preferenceSaveFailed")
        } else {
            None
        }
    }

    pub(super) fn set_mission_delete_sessions(&mut self, value: bool) {
        if self.can_retry()
            && !self.mission_delete_sessions_pending()
            && self
                .mission_delete_sessions()
                .is_some_and(|old| old != value || self.mission_delete_sessions_failed())
        {
            self.config.stage(
                Choice::MissionDeleteSessions,
                if value { "true" } else { "false" },
            );
            self.revision += 1;
            if let Some(wake) = &self.main_wake {
                wake();
            }
        }
    }

    pub(super) fn retry_mission_delete_sessions(&mut self) {
        self.config
            .retry(|choice| choice == Choice::MissionDeleteSessions);
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
    pub(super) fn fixture_mission_delete_sessions(&mut self, enabled: bool) {
        let config = self
            .config
            .snapshot
            .get_or_insert_with(|| json!({"settings": {}}));
        config["settings"]["missionDeleteSessions"] = json!(enabled);
        self.revision += 1;
    }

    #[cfg(any(test, feature = "test-support"))]
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
    matches!(choice, Choice::Locale | Choice::Contrast)
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
