use super::{Choice, Owner, Preferences};
use crate::settings::advanced::Toggle;
use serde_json::{Value, json};

pub(in crate::settings) const PERMISSION_MODES: [(&str, &str); 2] = [
    ("autonomous", "permissions.mode.autonomous"),
    ("supervised", "permissions.mode.supervised"),
];

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::settings) enum GeneralToggle {
    MessageTimeline,
    ScrollControlsInTimelineCorner,
    DiffViewMode,
    AutoExpandActiveSubsessions,
    FollowUpBehavior,
    KeepComputerAwake,
}

impl GeneralToggle {
    pub(in crate::settings) fn key(self) -> &'static str {
        match self {
            Self::MessageTimeline => "showMessageTimeline",
            Self::ScrollControlsInTimelineCorner => "scrollControlsInTimelineCorner",
            Self::DiffViewMode => "diffViewMode",
            Self::AutoExpandActiveSubsessions => "autoExpandActiveSubsessions",
            Self::FollowUpBehavior => "followUpBehavior",
            Self::KeepComputerAwake => "keepComputerAwake",
        }
    }

    pub(in crate::settings) fn title_key(self) -> &'static str {
        match self {
            Self::MessageTimeline => "settings.behavior.messageTimeline.title",
            Self::ScrollControlsInTimelineCorner => {
                "settings.behavior.scrollControlsInTimelineCorner.title"
            }
            Self::DiffViewMode => "settings.behavior.diffView.title",
            Self::AutoExpandActiveSubsessions => {
                "settings.behavior.autoExpandActiveSubsessions.title"
            }
            Self::FollowUpBehavior => "settings.behavior.followUpBehavior.title",
            Self::KeepComputerAwake => "settings.behavior.keepComputerAwake.title",
        }
    }

    pub(in crate::settings) fn help(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::AutoExpandActiveSubsessions => Some((
                "settings.behavior.autoExpandActiveSubsessions.info",
                "conversations.html#navigate-conversations",
            )),
            Self::KeepComputerAwake => Some((
                "settings.behavior.keepComputerAwake.info",
                "settings.html#keep-computer-awake",
            )),
            _ => None,
        }
    }

    pub(in crate::settings) fn default_value(self) -> bool {
        matches!(
            self,
            Self::MessageTimeline | Self::DiffViewMode | Self::AutoExpandActiveSubsessions
        )
    }

    pub(in crate::settings) fn read(self, settings: &Value) -> bool {
        let value = &settings[self.key()];
        match self {
            Self::MessageTimeline | Self::AutoExpandActiveSubsessions => {
                value.as_bool().unwrap_or(true)
            }
            Self::ScrollControlsInTimelineCorner | Self::KeepComputerAwake => {
                value.as_bool() == Some(true)
            }
            Self::DiffViewMode => value.as_str() != Some("unified"),
            Self::FollowUpBehavior => value.as_str() == Some("queue"),
        }
    }

    pub(in crate::settings) fn json_value(self, enabled: bool) -> Value {
        match self {
            Self::DiffViewMode => json!(if enabled { "split" } else { "unified" }),
            Self::FollowUpBehavior => json!(if enabled { "queue" } else { "steer" }),
            _ => json!(enabled),
        }
    }
}

const CHOICE: Choice = Choice::NewConversationPermissions;

impl Preferences {
    pub(in crate::settings) fn general_toggle(&self, toggle: GeneralToggle) -> Option<bool> {
        Some(toggle.read(&self.saved(Owner::Config)?["settings"]))
    }

    pub(in crate::settings) fn general_toggle_pending(&self, toggle: GeneralToggle) -> bool {
        self.config.choice_pending(Choice::GeneralBehavior(toggle))
    }

    pub(in crate::settings) fn set_general_toggle(&mut self, toggle: GeneralToggle, value: bool) {
        if self.locale_ready()
            && self.can_retry()
            && !self.general_toggle_pending(toggle)
            && self.general_toggle(toggle).is_some_and(|old| old != value)
        {
            self.config.stage(
                Choice::GeneralBehavior(toggle),
                if value { "true" } else { "false" },
            );
            self.revision += 1;
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
    }

    pub(in crate::settings) fn advanced_toggle(&self, toggle: Toggle) -> Option<bool> {
        Some(
            self.saved(Owner::Config)?["settings"][toggle.key()]
                .as_bool()
                .unwrap_or_else(|| toggle.default_value()),
        )
    }

    pub(in crate::settings) fn advanced_pending(&self, toggle: Toggle) -> bool {
        self.config.choice_pending(Choice::Advanced(toggle))
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
            for wake in [&self.main_wake, &self.window_wake].into_iter().flatten() {
                wake();
            }
        }
    }

    pub(in crate::settings) fn auto_cleanup_blank_sessions(&self) -> bool {
        self.advanced_toggle(Toggle::EmptySessions) == Some(true)
    }

    pub(in crate::settings) fn keep_unseen_subagent_idle_status(&self) -> bool {
        self.advanced_toggle(Toggle::UnseenSubagents)
            .unwrap_or_else(|| Toggle::UnseenSubagents.default_value())
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
