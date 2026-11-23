use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Category {
    NeedsInput,
    SessionDone,
}

impl Category {
    fn keys(self) -> (&'static str, &'static str) {
        match self {
            Self::NeedsInput => ("needsInput", "notifyOnNeedsInput"),
            Self::SessionDone => ("sessionDone", "notifyOnIdle"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub screen: bool,
    pub history: bool,
    pub system: bool,
}

/// Read the confirmed UI configuration; a missing owner is still loading.
pub(crate) fn route(config: Option<&Value>, category: Category) -> Option<Route> {
    let settings = config?.get("settings").unwrap_or(&Value::Null);
    let (key, legacy) = category.keys();
    let routing = settings["notificationRouting"].as_object();
    let saved = routing
        .and_then(|routing| routing.get(key))
        .unwrap_or(&Value::Null);
    let default_system = routing.is_some()
        || (settings["osNotificationsEnabled"] != false && settings[legacy] != false);
    Some(Route {
        screen: saved["screen"].as_bool().unwrap_or(false),
        history: saved["history"].as_bool().unwrap_or(false),
        system: saved["system"].as_bool().unwrap_or(default_system),
    })
}

pub(crate) fn allow_focused(config: Option<&Value>) -> bool {
    config.is_some_and(|config| config["settings"]["osNotificationsAllowWhenVisible"] == true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_saved_table_overrides_legacy_flags_without_changing_other_destinations() {
        let config = |settings| json!({ "settings": settings });
        let legacy = config(json!({"osNotificationsEnabled": true, "notifyOnIdle": false}));
        assert!(route(None, Category::NeedsInput).is_none());
        assert!(route(Some(&legacy), Category::NeedsInput).unwrap().system);
        assert!(!route(Some(&legacy), Category::SessionDone).unwrap().system);
        let saved = config(json!({
            "notifyOnIdle": false,
            "osNotificationsEnabled": false,
            "osNotificationsAllowWhenVisible": true,
            "notificationRouting": {
                "needsInput": {"screen": true, "history": true, "system": false},
                "sessionDone": {"system": null}
            }
        }));
        assert_eq!(
            route(Some(&saved), Category::NeedsInput),
            Some(Route {
                screen: true,
                history: true,
                system: false
            })
        );
        assert_eq!(
            route(Some(&saved), Category::SessionDone),
            Some(Route {
                screen: false,
                history: false,
                system: true
            })
        );
        assert!(allow_focused(Some(&saved)));
        assert!(!allow_focused(Some(&legacy)));
    }
}
