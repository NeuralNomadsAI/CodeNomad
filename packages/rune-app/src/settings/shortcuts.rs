use super::{Preferences, State};
use rune::{Chord, ChordKey, ChordMod, Key, KeyEvent, Keybind, PhysicalKeyCode, Tx};
use serde_json::Value;

pub(crate) const FILE_SAVE: &str = "file-save";
pub(super) mod catalog;
pub(super) mod editor;
mod reserved;

fn decode(rule: &Value) -> Option<Chord> {
    let rule = rule.as_object()?;
    let key = rule.get("key")?.as_str()?;
    let key = key.to_lowercase();
    let key = match key.as_str() {
        "{" | "bracketleft" => "[",
        "}" | "bracketright" => "]",
        " " | "spacebar" => "space",
        "+" => "plus",
        key if key.len() == 6 && key.starts_with("digit") && key.as_bytes()[5].is_ascii_digit() => {
            &key[5..]
        }
        key => key,
    };
    let mut chord = if let Some(c) = key.chars().next().filter(|c| c.len_utf8() == key.len()) {
        if c.is_control() {
            return None;
        }
        Chord::new(ChordKey::Char(c))
    } else {
        let parsed = Chord::parse(key).ok()?;
        // The key field is a key name, never a chord with embedded modifiers.
        if key.contains('+') {
            return None;
        }
        parsed
    };
    for (name, modifier) in [
        ("mod", ChordMod::Primary),
        ("ctrl", ChordMod::Ctrl),
        ("meta", ChordMod::Super),
        ("alt", ChordMod::Alt),
        ("shift", ChordMod::Shift),
    ] {
        if let Some(value) = rule.get(name)
            && value.as_bool()?
        {
            chord = chord.with(modifier);
        }
    }
    Some(chord)
}

pub(crate) fn save_label(s: &State) -> String {
    format_chords(&catalog::resolve(&s.settings.shared.borrow(), FILE_SAVE))
}

fn shortcut_label(s: &State, action: &str) -> String {
    format_chords(&catalog::resolve(&s.settings.shared.borrow(), action))
}

pub(crate) fn with_shortcut_label(s: &State, label: &str, action: &str) -> String {
    let shortcut = shortcut_label(s, action);
    if shortcut.is_empty() {
        label.to_owned()
    } else {
        format!("{label} ({shortcut})")
    }
}

pub(crate) fn with_shortcut_label_excluding(
    s: &State,
    label: &str,
    action: &str,
    shadowed_by: &[&str],
) -> String {
    let prefs = s.settings.shared.borrow();
    let platform = rune::KeyPlatform::current();
    let blocked: Vec<_> = shadowed_by
        .iter()
        .flat_map(|other| catalog::resolve(&prefs, other))
        .collect();
    let visible: Vec<_> = catalog::resolve(&prefs, action)
        .into_iter()
        .filter(|chord| !blocked.iter().any(|other| chord.same_keys(other, platform)))
        .collect();
    let shortcut = format_chords(&visible);
    if shortcut.is_empty() {
        label.to_owned()
    } else {
        format!("{label} ({shortcut})")
    }
}

fn format_chords(bindings: &[Chord]) -> String {
    let platform = rune::KeyPlatform::current();
    bindings
        .iter()
        .map(|chord| Keybind::from(*chord).label_on(platform))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn bindings_conflict(first: &[Chord], second: &[Chord], platform: rune::KeyPlatform) -> bool {
    first
        .iter()
        .any(|a| second.iter().any(|b| a.same_keys(b, platform)))
}

pub(super) fn record(event: &KeyEvent, tx: &Tx) -> Option<Value> {
    use serde_json::json;
    let name = if let Some(c) = physical_slot(tx) {
        c.to_string()
    } else {
        match &event.key {
            Key::Command(c) => logical_command(*c, event, tx.key_base())
                .to_lowercase()
                .to_string(),
            Key::Text(text) => text.to_lowercase(),
            Key::Function(n) => format!("f{n}"),
            Key::Tab => "tab".into(),
            Key::Enter => "enter".into(),
            Key::Backspace => "backspace".into(),
            Key::Delete => "delete".into(),
            Key::Left => "arrowleft".into(),
            Key::Right => "arrowright".into(),
            Key::Up => "arrowup".into(),
            Key::Down => "arrowdown".into(),
            Key::Home => "home".into(),
            Key::End => "end".into(),
            Key::PageUp => "pageup".into(),
            Key::PageDown => "pagedown".into(),
            Key::Insert => "insert".into(),
            Key::ContextMenu => "contextmenu".into(),
            Key::PrintScreen => "printscreen".into(),
            Key::ScrollLock => "scrolllock".into(),
            Key::Pause => "pause".into(),
            _ => return None,
        }
    };
    let mac = rune::KeyPlatform::current() == rune::KeyPlatform::Mac;
    let mods = event.mods;
    let mut rule = json!({"key": name});
    for (key, active) in [
        ("mod", if mac { mods.logo } else { mods.ctrl }),
        ("ctrl", mac && mods.ctrl),
        ("meta", !mac && mods.logo),
        ("shift", mods.shift),
        ("alt", mods.alt),
    ] {
        if active {
            rule[key] = json!(true);
        }
    }
    decode(&rule).map(|_| json!([rule]))
}

pub(crate) fn matches_save(s: &State, event: &KeyEvent, tx: &Tx) -> bool {
    matches_shortcut(s, FILE_SAVE, event, tx)
}

pub(crate) fn matches_shortcut(s: &State, action: &str, event: &KeyEvent, tx: &Tx) -> bool {
    let preferences = s.settings.shared.borrow();
    matches_shortcut_in(&preferences, action, event, tx)
}

pub(super) fn matches_shortcut_in(
    preferences: &Preferences,
    action: &str,
    event: &KeyEvent,
    tx: &Tx,
) -> bool {
    catalog::resolve(preferences, action)
        .iter()
        .any(|chord| matches(*chord, event, physical_slot(tx), tx.key_base()))
}

fn canonical_char(c: char) -> char {
    match c {
        '{' => '[',
        '}' => ']',
        c => c,
    }
}

fn logical_command(typed: char, event: &KeyEvent, base: Option<char>) -> char {
    // Rune substitutes the US-position character for non-ASCII native Ctrl chords.
    if cfg!(not(any(target_os = "macos", target_arch = "wasm32")))
        && typed.is_ascii()
        && event.mods.ctrl
        && !event.mods.alt
    {
        return base.filter(|c| !c.is_ascii()).unwrap_or(typed);
    }
    typed
}

fn matches(chord: Chord, event: &KeyEvent, physical: Option<char>, base: Option<char>) -> bool {
    if chord.has(ChordMod::Shift) != event.mods.shift {
        return false;
    }
    // Unlike Rune's menu chords, Solid uses the typed character outside digit/bracket slots.
    if let ChordKey::Char(expected) = chord.key() {
        let char = physical.or_else(|| match &event.key {
            Key::Command(c) => Some(canonical_char(logical_command(*c, event, base))),
            Key::Text(text) => text
                .chars()
                .next()
                .filter(|c| c.len_utf8() == text.len())
                .map(canonical_char),
            _ => None,
        });
        let Some(key) = char.filter(|actual| actual.to_lowercase().eq(expected.to_lowercase()))
        else {
            return false;
        };
        return chord.matches(&KeyEvent {
            key: Key::Command(key),
            mods: event.mods,
        });
    }
    physical.is_none() && chord.matches(event)
}

fn physical_slot(tx: &Tx) -> Option<char> {
    tx.physical_key().and_then(|key| {
        use PhysicalKeyCode::{
            BracketLeft, BracketRight, Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6,
            Digit7, Digit8, Digit9,
        };
        match key {
            BracketLeft => Some('['),
            BracketRight => Some(']'),
            _ => [
                Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
            ]
            .iter()
            .position(|digit| *digit == key)
            .and_then(|i| char::from_digit(i as u32, 10)),
        }
    })
}

#[cfg(test)]
#[test]
fn resolves_shared_save_overrides() {
    use serde_json::json;
    let default = [Chord::new(ChordKey::Char('s')).with(ChordMod::Primary)];
    let mut prefs = Preferences::default();
    assert_eq!(catalog::resolve(&prefs, FILE_SAVE), default);
    prefs.fixture_shortcuts(json!({ FILE_SAVE: [] }));
    assert!(catalog::resolve(&prefs, FILE_SAVE).is_empty());
    prefs.fixture_shortcuts(json!({ FILE_SAVE: [{"key":"x", "mod":1}] }));
    assert_eq!(catalog::resolve(&prefs, FILE_SAVE), default);
    prefs.fixture_shortcuts(json!({ FILE_SAVE: [{"key":"F8"}, {"key":"Digit1","ctrl":true}] }));
    assert_eq!(
        catalog::resolve(&prefs, FILE_SAVE),
        [
            Chord::new(ChordKey::Function(8)),
            Chord::new(ChordKey::Char('1')).with(ChordMod::Ctrl)
        ]
    );
}

#[cfg(test)]
#[test]
fn logical_punctuation_matches_only_the_character_solid_records() {
    use rune::Mods;
    let event = KeyEvent {
        key: Key::Text(">".to_owned()),
        mods: Mods {
            shift: true,
            ..Mods::default()
        },
    };
    assert!(!matches(
        Chord::parse("shift+.").unwrap(),
        &event,
        None,
        Some('.')
    ));
    assert!(matches(
        Chord::parse("shift+>").unwrap(),
        &event,
        None,
        Some('.')
    ));
    assert!(!matches(
        Chord::parse(">").unwrap(),
        &event,
        None,
        Some('.')
    ));
    assert!(matches(
        Chord::parse("shift+1").unwrap(),
        &event,
        Some('1'),
        None
    ));
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn localized_ctrl_letter_uses_the_key_rune_reports_before_us_fallback() {
    use serde_json::json;
    for shift in [false, true] {
        let event = KeyEvent {
            key: Key::Command(';'),
            mods: rune::Mods {
                ctrl: true,
                cmd: true,
                shift,
                ..Default::default()
            },
        };
        let save = [decode(&json!({"key":"ö","mod":true,"shift":shift})).unwrap()];
        let new_tab = [decode(&json!({"key":";","ctrl":true,"shift":shift})).unwrap()];
        assert!(matches(
            save[0],
            &event,
            None,
            Some(if shift { 'Ö' } else { 'ö' })
        ));
        assert!(!matches(new_tab[0], &event, None, Some('ö')));
        assert!(!bindings_conflict(
            &save,
            &new_tab,
            rune::KeyPlatform::Windows
        ));
        let same_key = [decode(&json!({"key":"Ö","ctrl":true,"shift":shift})).unwrap()];
        assert!(matches(same_key[0], &event, None, Some('ö')));
        assert!(bindings_conflict(
            &save,
            &same_key,
            rune::KeyPlatform::Windows
        ));
    }
    let alt_gr = KeyEvent {
        key: Key::Text("@".to_owned()),
        mods: rune::Mods {
            ctrl: true,
            cmd: true,
            alt: true,
            ..Default::default()
        },
    };
    assert!(!matches(
        Chord::parse("ctrl+alt+q").unwrap(),
        &alt_gr,
        None,
        Some('q')
    ));
}

#[cfg(test)]
#[test]
fn bracket_and_digit_slots_match_physical_and_shifted_logical_keys() {
    let shift_ctrl = rune::Mods {
        ctrl: !cfg!(target_os = "macos"),
        cmd: true,
        logo: cfg!(target_os = "macos"),
        shift: true,
        alt: false,
    };
    let ctrl = rune::Mods {
        shift: false,
        ..shift_ctrl
    };
    let mut prefs = Preferences::default();
    prefs.fixture_shortcuts(serde_json::json!({}));
    let session_prev = catalog::resolve(&prefs, "session-prev");
    let session_next = catalog::resolve(&prefs, "session-next");
    let app_tab_2 = catalog::resolve(&prefs, "app-tab-2");
    let session_tab_2 = catalog::resolve(&prefs, "session-tab-2");
    assert!(matches(
        session_prev[0],
        &KeyEvent {
            key: Key::Command('{'),
            mods: shift_ctrl,
        },
        None,
        None
    ));
    assert!(matches(
        session_next[0],
        &KeyEvent {
            key: Key::Command('}'),
            mods: shift_ctrl,
        },
        None,
        None
    ));
    assert!(matches(
        app_tab_2[0],
        &KeyEvent {
            key: Key::Command('é'),
            mods: ctrl,
        },
        Some('2'),
        None
    ));
    assert!(matches(
        session_tab_2[0],
        &KeyEvent {
            key: Key::Command('@'),
            mods: shift_ctrl,
        },
        Some('2'),
        None
    ));
    let instance_next = catalog::resolve(&prefs, "instance-next");
    assert!(matches(
        instance_next[0],
        &KeyEvent {
            key: Key::Command('}'),
            mods: ctrl,
        },
        None,
        None
    ));
    assert!(!matches(
        instance_next[0],
        &KeyEvent {
            key: Key::Text("}".to_owned()),
            mods: rune::Mods { alt: true, ..ctrl },
        },
        None,
        None
    ));
}
