use crate::settings::notification_routing::{self, Category};
use serde_json::Value;

/// A session can only publish after its owning read has qualified it as a root.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Session {
    Unknown,
    Root,
    Child,
}

pub(crate) fn system_allowed(
    config: Option<&Value>,
    category: Category,
    session: Session,
    focused: bool,
) -> bool {
    session == Session::Root
        && notification_routing::route(config, category).is_some_and(|route| route.system)
        && (!focused || notification_routing::allow_focused(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_qualified_roots_reach_system_when_unfocused_or_explicitly_allowed() {
        let defaults = json!({});
        let allow = json!({"settings":{"osNotificationsAllowWhenVisible":true}});
        let disabled = json!({"settings":{"notificationRouting":{"needsInput":{"system":false}}}});
        for session in [Session::Unknown, Session::Child] {
            assert!(!system_allowed(
                Some(&allow),
                Category::NeedsInput,
                session,
                false
            ));
        }
        assert!(!system_allowed(
            None,
            Category::NeedsInput,
            Session::Root,
            false
        ));
        assert!(!system_allowed(
            Some(&disabled),
            Category::NeedsInput,
            Session::Root,
            false
        ));
        assert!(!system_allowed(
            Some(&defaults),
            Category::NeedsInput,
            Session::Root,
            true
        ));
        assert!(system_allowed(
            Some(&defaults),
            Category::NeedsInput,
            Session::Root,
            false
        ));
        assert!(system_allowed(
            Some(&allow),
            Category::SessionDone,
            Session::Root,
            true
        ));
    }
}
