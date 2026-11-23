use super::{Choice, Owner, Preferences};
use crate::settings::advanced::Toggle;

pub(in crate::settings) const PERMISSION_MODES: [(&str, &str); 2] = [
    ("autonomous", "permissions.mode.autonomous"),
    ("supervised", "permissions.mode.supervised"),
];

const CHOICE: Choice = Choice::NewConversationPermissions;

impl Preferences {
    pub(in crate::settings) fn advanced_toggle(&self, toggle: Toggle) -> Option<bool> {
        Some(
            self.saved(Owner::Config)?["settings"][toggle.key()]
                .as_bool()
                .unwrap_or_else(|| toggle.default_value()),
        )
    }

    pub(in crate::settings) fn advanced_pending(&self, toggle: Toggle) -> bool {
        let choice = Choice::Advanced(toggle);
        self.config.requested(choice).is_some() && !self.config.choice_failed(choice)
    }

    pub(in crate::settings) fn set_advanced_toggle(&mut self, toggle: Toggle, value: bool) {
        if toggle.supported()
            && self.can_retry()
            && !self.advanced_pending(toggle)
            && self.advanced_toggle(toggle).is_some_and(|old| old != value)
        {
            self.config.stage(
                Choice::Advanced(toggle),
                if value { "true" } else { "false" },
            );
            self.revision += 1;
        }
    }

    pub(in crate::settings) fn new_conversation_permissions(&self) -> &'static str {
        match self
            .saved(Owner::Config)
            .and_then(|doc| doc["settings"]["newConversationPermissions"].as_str())
        {
            Some("supervised") => "supervised",
            _ => "autonomous",
        }
    }

    pub(in crate::settings) fn new_conversation_permissions_failed(&self) -> bool {
        self.config.choice_failed(CHOICE)
    }

    pub(in crate::settings) fn new_conversation_permissions_pending(&self) -> bool {
        self.config.requested(CHOICE).is_some() && !self.new_conversation_permissions_failed()
    }

    pub(in crate::settings) fn set_new_conversation_permissions(&mut self, value: &'static str) {
        if self.locale_ready()
            && self.can_retry()
            && !self.new_conversation_permissions_pending()
            && (value != self.new_conversation_permissions()
                || self.new_conversation_permissions_failed())
            && PERMISSION_MODES.iter().any(|(mode, _)| *mode == value)
        {
            self.config.stage(CHOICE, value);
            if let Some(wake) = &self.main_wake {
                wake();
            }
        }
    }
}
