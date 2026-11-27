use super::{
    Choice, Preferences,
    document::{
        OpenCodeBinariesOp, OpenCodeBinaryEntry, normalize_opencode_binary, parse_opencode_binaries,
    },
};

pub(in crate::settings) const LEVELS: [(&str, &str); 4] = [
    ("DEBUG", "settings.opencode.logLevel.option.debug"),
    ("INFO", "settings.opencode.logLevel.option.info"),
    ("WARN", "settings.opencode.logLevel.option.warn"),
    ("ERROR", "settings.opencode.logLevel.option.error"),
];

impl Preferences {
    pub(in crate::settings) fn show_opencode(&mut self) -> bool {
        if std::mem::replace(&mut self.show_server, true) {
            return false;
        }
        self.server.invalidate();
        if let Some(wake) = &self.main_wake {
            wake();
        }
        true
    }

    pub(in crate::settings) fn hide_opencode(&mut self) {
        self.show_server = false;
        self.opencode_install.cancel_check();
    }

    pub(in crate::settings) fn log_level(&self) -> Option<usize> {
        let document = self.server.snapshot.as_ref()?;
        Some(
            LEVELS
                .iter()
                .position(|(value, _)| document["logLevel"] == *value)
                .unwrap_or(0),
        )
    }

    pub(in crate::settings) fn log_level_available(&self) -> bool {
        self.show_server
            && self.can_retry()
            && self.log_level().is_some()
            && !self.server.read_failed()
    }

    pub(in crate::settings) fn log_level_pending(&self) -> bool {
        self.server.requested(Choice::LogLevel).is_some()
            && !self.server.choice_failed(Choice::LogLevel)
    }

    pub(in crate::settings) fn log_level_failed(&self) -> Option<&'static str> {
        if self.server.choice_failed(Choice::LogLevel) {
            Some("settings.preferenceSaveFailed")
        } else if self.server.read_failed() {
            Some("rune.connect_error")
        } else {
            None
        }
    }

    pub(in crate::settings) fn set_log_level(&mut self, index: usize) {
        if self.log_level_available()
            && !self.log_level_pending()
            && self.log_level() != Some(index)
            && let Some(&(value, _)) = LEVELS.get(index)
        {
            if !self.server.transport_revalidated() && !self.server.refreshing() {
                self.server.invalidate();
            }
            self.server.stage(Choice::LogLevel, value);
        }
    }

    pub(in crate::settings) fn retry_log_level(&mut self) {
        if self.show_server && self.can_retry() {
            self.server.retry(|choice| choice == Choice::LogLevel);
        }
    }

    pub(in crate::settings) fn opencode_binary(&self) -> Option<String> {
        let document = self.server.snapshot.as_ref()?;
        Some(normalize_opencode_binary(document))
    }

    pub(in crate::settings) fn opencode_binaries(&self) -> Vec<OpenCodeBinaryEntry> {
        self.state
            .snapshot
            .as_ref()
            .map(parse_opencode_binaries)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| entry.path != "opencode" && entry.path != "opencode2")
            .collect()
    }

    pub(in crate::settings) fn opencode_binary_available(&self) -> bool {
        self.show_server
            && self.can_retry()
            && self.server.snapshot.is_some()
            && !self.server.read_failed()
            && self.state.snapshot.is_some()
            && !self.state.read_failed()
    }

    pub(in crate::settings) fn opencode_binary_pending(&self) -> bool {
        self.server.choice_pending(Choice::OpenCodeBinary)
            || self.state.choice_pending(Choice::OpenCodeBinaries)
    }

    pub(in crate::settings) fn opencode_transport_generation(&self) -> Option<(String, u64)> {
        self.backend
            .as_ref()
            .filter(|_| self.can_retry() && !self.is_transport_lost())
            .map(|backend| (backend.client_id.clone(), self.server.transport_epoch()))
    }

    pub(in crate::settings) fn opencode_binary_failed(&self) -> Option<&'static str> {
        if self.server.choice_failed(Choice::OpenCodeBinary)
            || self.state.choice_failed(Choice::OpenCodeBinaries)
        {
            Some("settings.preferenceSaveFailed")
        } else if self.server.read_failed() || self.state.read_failed() {
            Some("rune.connect_error")
        } else {
            None
        }
    }

    pub(in crate::settings) fn select_opencode_binary(
        &mut self,
        path: &str,
        version: Option<String>,
        last_used: u64,
    ) -> bool {
        if !self.opencode_binary_available() || self.opencode_binary_pending() {
            return false;
        }
        let target = {
            let trimmed = path.trim();
            if trimmed.is_empty() || trimmed == "opencode" {
                "opencode2"
            } else {
                trimmed
            }
        };
        if !self.server.transport_revalidated() && !self.server.refreshing() {
            self.server.invalidate();
        }
        if self.opencode_binary().as_deref() != Some(target) {
            self.server.stage_opencode_binary(target.to_owned());
        }
        if target != "opencode2" {
            if !self.state.transport_revalidated() && !self.state.refreshing() {
                self.state.invalidate();
            }
            self.state
                .stage_opencode_binaries(OpenCodeBinariesOp::Upsert {
                    path: target.to_owned(),
                    version,
                    last_used,
                });
        }
        self.revision += 1;
        if let Some(wake) = &self.main_wake {
            wake();
        }
        true
    }

    pub(in crate::settings) fn remove_opencode_binary(&mut self, path: &str) -> bool {
        if !self.opencode_binary_available() || self.opencode_binary_pending() {
            return false;
        }
        let trimmed = path.trim();
        if trimmed.is_empty() || trimmed == "opencode" || trimmed == "opencode2" {
            return false;
        }
        self.server.clear_failed_opencode_binary(trimmed);
        if !self.state.transport_revalidated() && !self.state.refreshing() {
            self.state.invalidate();
        }
        self.state
            .stage_opencode_binaries(OpenCodeBinariesOp::Remove {
                path: trimmed.to_owned(),
            });
        if self.opencode_binary().as_deref() == Some(trimmed) {
            if !self.server.transport_revalidated() && !self.server.refreshing() {
                self.server.invalidate();
            }
            self.server.stage_opencode_binary("opencode2".to_owned());
        }
        self.revision += 1;
        if let Some(wake) = &self.main_wake {
            wake();
        }
        true
    }

    pub(in crate::settings) fn retry_opencode_binary(&mut self) {
        if self.show_server && self.can_retry() {
            self.server.retry(|choice| choice == Choice::OpenCodeBinary);
            self.state
                .retry(|choice| choice == Choice::OpenCodeBinaries);
        }
    }

    pub(in crate::settings) fn show_environment(&mut self, shown: bool) {
        if self.show_environment != shown && shown {
            self.server.invalidate();
        }
        self.show_environment = shown;
    }

    pub(in crate::settings) fn show_speech(&mut self, shown: bool) {
        if self.show_speech != shown && shown {
            self.server.invalidate();
        }
        self.show_speech = shown;
    }

    pub(in crate::settings) fn speech_server_failed(&self) -> bool {
        self.server.read_failed()
            || (self.server.snapshot.is_some() && !self.server.transport_revalidated())
    }

    pub(in crate::settings) fn speech_server_ready(&self) -> bool {
        self.can_retry()
            && !self.transport_lost
            && self.server.transport_revalidated()
            && self.server.confirmed().is_some()
            && !self.speech.saving()
    }

    pub(in crate::settings) fn refresh_speech_server(&mut self) {
        self.server.invalidate();
    }

    pub(in crate::settings) fn environment_document(&self) -> Option<&serde_json::Value> {
        self.server.snapshot.as_ref().filter(|_| self.can_retry())
    }

    pub(in crate::settings) fn environment_pending(&self) -> bool {
        self.server.environment_pending()
    }

    pub(in crate::settings) fn environment_failed(&self) -> bool {
        self.server.read_failed()
            || self.server.choice_failed(Choice::Environment)
            || (self.server.snapshot.is_some() && !self.server.transport_revalidated())
    }

    pub(in crate::settings) fn environment_ready(&self) -> bool {
        self.can_retry()
            && self.server.transport_revalidated()
            && self.server.confirmed().is_some()
            && !self.environment_pending()
    }

    pub(in crate::settings) fn refresh_environment(&mut self) {
        self.server.invalidate();
    }

    pub(in crate::settings) fn stage_environment(
        &mut self,
        name: String,
        value: Option<String>,
        secret: Option<bool>,
    ) -> bool {
        if !self.environment_ready() {
            if self.server.read_failed() || !self.server.transport_revalidated() {
                self.server.invalidate();
            }
            return false;
        }
        self.server.stage_environment(name, value, secret);
        self.revision += 1;
        true
    }

    pub(in crate::settings) fn supports_atomic_settings_patches(&self) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|backend| backend.client.supports_atomic_settings_patches())
    }

    pub(in crate::settings) fn stage_update_feed(&mut self, feed: &'static str) {
        if self.can_retry() && !self.update_feed_pending() && matches!(feed, "stable" | "preview") {
            if self.server.read_failed()
                || (!self.server.transport_revalidated() && !self.server.refreshing())
            {
                self.server.invalidate();
            }
            self.server.stage(Choice::UpdateFeed, feed);
        }
    }

    pub(in crate::settings) fn update_feed_pending(&self) -> bool {
        self.server.requested(Choice::UpdateFeed).is_some() && !self.update_feed_failed()
    }

    pub(in crate::settings) fn update_feed_failed(&self) -> bool {
        self.server.choice_failed(Choice::UpdateFeed)
    }
}
