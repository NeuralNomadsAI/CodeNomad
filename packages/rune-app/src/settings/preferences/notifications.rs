use super::{Choice, Owner, Preferences};
use crate::settings::notification_routing::{self, Category, Destination};

impl Preferences {
    pub(in crate::settings) fn notification_ready(&self) -> bool {
        self.can_retry()
            && self.saved(Owner::Config).is_some()
            && !self.config.read_failed()
            && !self.transport_lost
    }

    pub(in crate::settings) fn notification_route(
        &self,
        category: Category,
        destination: Destination,
    ) -> bool {
        self.notification_value(Choice::NotificationRoute(category, destination))
            .unwrap_or_else(|| {
                notification_routing::route(self.saved(Owner::Config), category)
                    .is_some_and(|route| route.enabled(destination))
            })
    }

    pub(in crate::settings) fn notifications_focused(&self) -> bool {
        self.notification_value(Choice::NotificationsFocused)
            .unwrap_or_else(|| notification_routing::allow_focused(self.saved(Owner::Config)))
    }

    pub(in crate::settings) fn set_notification_route(
        &mut self,
        category: Category,
        destination: Destination,
        enabled: bool,
    ) {
        if self.notification_route(category, destination) != enabled {
            self.stage_notification(Choice::NotificationRoute(category, destination), enabled);
        }
    }

    pub(in crate::settings) fn set_notifications_focused(&mut self, enabled: bool) {
        if self.notifications_focused() != enabled {
            self.stage_notification(Choice::NotificationsFocused, enabled);
        }
    }

    fn notification_value(&self, choice: Choice) -> Option<bool> {
        (!self.config.choice_failed(choice))
            .then(|| self.config.requested(choice).map(|value| value == "true"))
            .flatten()
    }

    fn stage_notification(&mut self, choice: Choice, enabled: bool) {
        if self.notification_ready() {
            self.config
                .stage(choice, if enabled { "true" } else { "false" });
        }
    }
}
