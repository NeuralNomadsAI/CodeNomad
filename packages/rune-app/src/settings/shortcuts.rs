use crate::State;

pub(crate) fn matches_shortcut(
    s: &State,
    action: &str,
    event: &rune::KeyEvent,
    default: char,
) -> bool {
    let mods = event.mods;
    let settings = s.settings.shared.borrow();
    let Some(overrides) = settings.shortcut(action) else {
        return matches!(event.key, rune::Key::Command(key) if key.eq_ignore_ascii_case(&default))
            && mods.ctrl
            && !mods.shift
            && !mods.alt;
    };
    let function = match event.key {
        rune::Key::Function(n @ 1..=24) => Some(format!("f{n}")),
        _ => None,
    };
    overrides.iter().any(|rule| {
        let enabled = |name| rule[name].as_bool() == Some(true);
        let command = enabled("mod");
        let mac = cfg!(target_os = "macos");
        (mac || !enabled("meta"))
            && mods.ctrl == (enabled("ctrl") || command && !mac)
            && (!mac || mods.cmd == (enabled("meta") || command))
            && mods.shift == enabled("shift")
            && mods.alt == enabled("alt")
            && rule["key"].as_str().is_some_and(|value| match event.key {
                rune::Key::Command(key) => {
                    let mut chars = value.chars();
                    chars
                        .next()
                        .is_some_and(|value| key.eq_ignore_ascii_case(&value))
                        && chars.next().is_none()
                }
                _ => function
                    .as_ref()
                    .is_some_and(|key| key.eq_ignore_ascii_case(value)),
            })
    })
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn shell_shortcuts_use_confirmed_overrides_without_changing_the_default() {
    let s = crate::init();
    let chord = |key| rune::KeyEvent {
        key: rune::Key::Command(key),
        mods: rune::Mods {
            ctrl: true,
            ..Default::default()
        },
    };
    assert!(matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    s.settings
        .shared
        .borrow_mut()
        .fixture_shortcuts(serde_json::json!({
            "close-instance": [],
            "new-instance": [{"key": "t", "mod":true}]
        }));
    assert!(!matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    assert!(!matches_shortcut(&s, "new-instance", &chord('n'), 'n'));
    assert!(matches_shortcut(&s, "new-instance", &chord('t'), 'n'));
    s.settings
        .shared
        .borrow_mut()
        .fixture_shortcuts(serde_json::json!({
            "close-instance": [{"key":"f9","mod":true}],
            "new-instance": [{"key":"f10"}]
        }));
    let f = |n, ctrl| rune::KeyEvent {
        key: rune::Key::Function(n),
        mods: rune::Mods {
            ctrl,
            ..Default::default()
        },
    };
    assert!(matches_shortcut(&s, "close-instance", &f(9, true), 'w'));
    assert!(!matches_shortcut(&s, "close-instance", &f(9, false), 'w'));
    assert!(!matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    assert!(matches_shortcut(&s, "new-instance", &f(10, false), 'n'));
}
