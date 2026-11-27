use super::notification_routing;
use crate::{State, strings};

pub(crate) enum Delivery {
    Suppressed,
    WaitingForSettings,
    Body(String, notification_routing::Route, bool),
}

pub(crate) enum ConfirmedRoute {
    Unavailable,
    Refreshing,
    Missing,
    Ready(notification_routing::Route, bool),
}

pub(crate) fn notification_route(
    s: &State,
    source: &crate::backend::Backend,
    category: notification_routing::Category,
) -> ConfirmedRoute {
    let prefs = s.settings.shared.borrow();
    if !prefs.can_retry()
        || !prefs.backend.as_ref().is_some_and(|backend| {
            backend.base == source.base && backend.client.same_connection(&source.client)
        })
    {
        return ConfirmedRoute::Unavailable;
    }
    if prefs.notification_config_refreshing() {
        return ConfirmedRoute::Refreshing;
    }
    let config = prefs.notification_config();
    notification_routing::route(config, category).map_or(ConfirmedRoute::Missing, |route| {
        ConfirmedRoute::Ready(route, notification_routing::allow_focused(config))
    })
}

pub(crate) fn system_notification(
    s: &State,
    target: &crate::shell::notifications::Target,
    category: notification_routing::Category,
    focused: bool,
    label: &str,
) -> Delivery {
    let prefs = s.settings.shared.borrow();
    if !prefs.can_retry()
        || !prefs.backend.as_ref().is_some_and(|backend| {
            backend.base == target.backend_url
                && backend.client.server_identity() == target.server.as_deref()
        })
    {
        return Delivery::Suppressed;
    }
    if prefs.notification_config_refreshing() {
        return Delivery::WaitingForSettings;
    }
    let config = prefs.notification_config();
    if let Some(route) = notification_routing::route(config, category)
        && (route.screen
            || route.history
            || route.system && (!focused || notification_routing::allow_focused(config)))
    {
        let key = match category {
            notification_routing::Category::NeedsInput => "sessionEvents.notify.needsInput",
            notification_routing::Category::SessionDone => "sessionEvents.notify.done",
            _ => return Delivery::Suppressed,
        };
        Delivery::Body(
            strings::with_locale(prefs.locale().unwrap_or_else(strings::locale), || {
                strings::t(key).replace("{label}", label)
            }),
            route,
            notification_routing::allow_focused(config),
        )
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

#[cfg(test)]
pub(crate) fn notification_test_config(s: &State, snapshot: impl Into<Option<serde_json::Value>>) {
    s.settings
        .shared
        .borrow_mut()
        .notification_test_config(snapshot.into());
}

#[cfg(test)]
pub(crate) fn notification_fixture_for(
    s: &State,
    backend: crate::backend::Backend,
    snapshot: serde_json::Value,
) {
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.fixture_appearance("default", "default", "standard");
    prefs.backend = Some(backend);
    prefs.reset_notification_fixture();
    prefs.notification_test_config(Some(snapshot));
}
