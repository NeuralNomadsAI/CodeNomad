use super::notification_routing;
use crate::{State, strings};

pub(crate) enum Delivery {
    Suppressed,
    WaitingForSettings,
    Body(String),
}

pub(crate) fn system_notification(
    s: &State,
    target: &crate::shell::notifications::Target,
    category: notification_routing::Category,
    focused: bool,
    label: &str,
) -> Delivery {
    let prefs = s.settings.shared.borrow();
    if !prefs.backend.as_ref().is_some_and(|backend| {
        backend.base == target.backend_url
            && backend.client.server_identity() == target.server.as_deref()
    }) {
        return Delivery::Suppressed;
    }
    if prefs.notification_config_refreshing() {
        return Delivery::WaitingForSettings;
    }
    let config = prefs.notification_config();
    if crate::shell::notifications::system_allowed(config, category, focused) {
        let key = match category {
            notification_routing::Category::NeedsInput => "sessionEvents.notify.needsInput",
            notification_routing::Category::SessionDone => "sessionEvents.notify.done",
            _ => return Delivery::Suppressed,
        };
        Delivery::Body(strings::with_locale(
            prefs.locale().unwrap_or_else(strings::locale),
            || strings::t(key).replace("{label}", label),
        ))
    } else {
        Delivery::Suppressed
    }
}

#[cfg(test)]
pub(crate) fn notification_fixture(s: &State) {
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.backend = Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    prefs.reset_notification_fixture();
}
