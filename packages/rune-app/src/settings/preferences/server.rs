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
            self.server.stage(Choice::LogLevel, value);
        }
    }

    pub(in crate::settings) fn retry_log_level(&mut self) {
        if self.show_server && self.can_retry() {
            self.server.retry();
        }
    }
}
