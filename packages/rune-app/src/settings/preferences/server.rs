use super::{Choice, Preferences};

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

    pub(in crate::settings) fn show_environment(&mut self, shown: bool) {
        if self.show_environment != shown && shown {
            self.server.invalidate();
        }
        self.show_environment = shown;
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
