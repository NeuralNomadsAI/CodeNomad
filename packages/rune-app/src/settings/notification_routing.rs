use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Category {
    NeedsInput,
    SessionDone,
    Updates,
    Files,
    Projects,
    Sessions,
    Opencode,
    Copy,
    Settings,
}

impl Category {
    pub const ALL: [Self; 9] = [
        Self::NeedsInput,
        Self::SessionDone,
        Self::Updates,
        Self::Files,
        Self::Projects,
        Self::Sessions,
        Self::Opencode,
        Self::Copy,
        Self::Settings,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            Self::NeedsInput => "needsInput",
            Self::SessionDone => "sessionDone",
            Self::Updates => "updates",
            Self::Files => "files",
            Self::Projects => "projects",
            Self::Sessions => "sessions",
            Self::Opencode => "opencode",
            Self::Copy => "copy",
            Self::Settings => "settings",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Destination {
    Screen,
    History,
    System,
}

impl Destination {
    pub const ALL: [Self; 3] = [Self::Screen, Self::History, Self::System];

    pub const fn key(self) -> &'static str {
        match self {
            Self::Screen => "screen",
            Self::History => "history",
            Self::System => "system",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub screen: bool,
    pub history: bool,
    pub system: bool,
}

impl Route {
    pub fn enabled(&self, destination: Destination) -> bool {
        match destination {
            Destination::Screen => self.screen,
            Destination::History => self.history,
            Destination::System => self.system,
        }
    }
}

pub(crate) fn route(config: Option<&Value>, category: Category) -> Option<Route> {
    let settings = &config?["settings"];
    let routing = settings["notificationRouting"].as_object();
    let saved = routing
        .and_then(|routing| routing.get(category.key()))
        .unwrap_or(&Value::Null);
    let mut system = matches!(
        category,
        Category::NeedsInput | Category::SessionDone | Category::Updates
    );
    if routing.is_none() {
        system &= settings["osNotificationsEnabled"] != false
            && match category {
                Category::NeedsInput => settings["notifyOnNeedsInput"] != false,
                Category::SessionDone => settings["notifyOnIdle"] != false,
                _ => true,
            };
    }
    Some(Route {
        screen: saved["screen"].as_bool().unwrap_or(!matches!(
            category,
            Category::NeedsInput | Category::SessionDone
        )),
        history: saved["history"].as_bool().unwrap_or(matches!(
            category,
            Category::Updates | Category::Files | Category::Projects | Category::Opencode
        )),
        system: saved["system"].as_bool().unwrap_or(system),
    })
}

pub(crate) fn allow_focused(config: Option<&Value>) -> bool {
    config.is_some_and(|config| config["settings"]["osNotificationsAllowWhenVisible"] == true)
}

pub(super) fn seed(config: &Value) -> Value {
    let mut table = json!({});
    for category in Category::ALL {
        if let Some(route) = route(Some(config), category) {
            for destination in Destination::ALL {
                table[category.key()][destination.key()] = json!(route.enabled(destination));
            }
        }
    }
    table
}

#[cfg(test)]
#[test]
fn defaults_and_legacy_flags_follow_the_solid_table() {
    let fixture = json!({});
    let defaults: Vec<_> = Category::ALL
        .map(|category| {
            let Route {
                screen,
                history,
                system,
            } = route(Some(&fixture), category).unwrap();
            [screen, history, system]
        })
        .into();
    assert_eq!(
        defaults,
        [
            [false, false, true],
            [false, false, true],
            [true, true, true],
            [true, true, false],
            [true, true, false],
            [true, false, false],
            [true, true, false],
            [true, false, false],
            [true, false, false],
        ]
    );
    let legacy = json!({"settings":{"notifyOnIdle":false,"osNotificationsEnabled":false}});
    let seeded = seed(&legacy);
    assert_eq!(seeded["sessionDone"]["system"], false);
    assert_eq!(seeded["updates"]["system"], false);
    let saved = json!({"settings":{"notifyOnIdle":false,"notificationRouting":{"sessionDone":{"system":null}}}});
    assert!(route(Some(&saved), Category::SessionDone).unwrap().system);
    assert!(route(None, Category::SessionDone).is_none());
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
