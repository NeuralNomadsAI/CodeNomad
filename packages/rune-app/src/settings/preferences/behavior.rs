use super::{Choice, Owner, Preferences};

pub(in crate::settings) const PERMISSION_MODES: [(&str, &str); 2] = [
    ("autonomous", "permissions.mode.autonomous"),
    ("supervised", "permissions.mode.supervised"),
];

const CHOICE: Choice = Choice::NewConversationPermissions;

impl Preferences {
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
