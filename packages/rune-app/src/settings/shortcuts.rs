use super::State;
use rune::{Chord, ChordKey, ChordMod, Key, KeyEvent, Keybind, PhysicalKeyCode, Tx};
use serde_json::Value;

pub(crate) const FILE_SAVE: &str = "file-save";
const DEFAULT_SAVE: Chord = Chord::new(ChordKey::Char('s')).with(ChordMod::Primary);

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

fn file_save(overrides: Option<&[Value]>) -> Vec<Chord> {
    overrides
        .filter(|rules| rules.len() <= 8)
        .and_then(|rules| rules.iter().map(decode).collect())
        .unwrap_or_else(|| vec![DEFAULT_SAVE])
}

pub(crate) fn save_label(s: &State) -> String {
    binding_label(s.settings.shared.borrow().shortcut(FILE_SAVE))
}

pub(super) fn binding_label(overrides: Option<&[Value]>) -> String {
    let platform = rune::KeyPlatform::current();
    file_save(overrides)
        .iter()
        .map(|chord| Keybind::from(*chord).label_on(platform))
        .collect::<Vec<_>>()
        .join(" / ")
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn conflict_label(preferences: &super::Preferences) -> Vec<&'static str> {
    let platform = rune::KeyPlatform::current();
    let save = file_save(preferences.shortcut(FILE_SAVE));
    [
        ("new-instance", 'n', "hotkeys.action.new-instance"),
        ("close-instance", 'w', "hotkeys.action.close-instance"),
    ]
    .into_iter()
    .filter_map(|(id, default, label)| {
        let mut shell = preferences.shortcut(id).map_or_else(
            || vec![Chord::new(ChordKey::Char(default)).with(ChordMod::Primary)],
            |rules| rules.iter().filter_map(decode).collect(),
        );
        shell.retain(|chord| save.iter().any(|save| save.same_keys(chord, platform)));
        (!shell.is_empty()).then_some(label)
    })
    .collect()
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn record(event: &KeyEvent, tx: &Tx) -> Option<Value> {
    use serde_json::json;
    let name = if let Some(c) = physical_slot(tx) {
        c.to_string()
    } else {
        match &event.key {
            Key::Command(c) => c.to_lowercase().to_string(),
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
    let preferences = s.settings.shared.borrow();
    file_save(preferences.shortcut(FILE_SAVE))
        .iter()
        .any(|chord| matches(*chord, event, physical_slot(tx)))
}

fn matches(chord: Chord, event: &KeyEvent, physical: Option<char>) -> bool {
    // Unlike Rune's menu chords, Solid uses the typed character outside digit/bracket slots.
    if let ChordKey::Char(expected) = chord.key() {
        let char = physical.or_else(|| match &event.key {
            Key::Command(c) => Some(*c),
            Key::Text(text) => text.chars().next().filter(|c| c.len_utf8() == text.len()),
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
    assert_eq!(file_save(None), [DEFAULT_SAVE]);
    assert!(file_save(Some(&[])).is_empty());
    assert_eq!(
        file_save(Some(&[json!({"key":"x", "mod":1})])),
        [DEFAULT_SAVE]
    );
    assert_eq!(
        file_save(Some(&[
            json!({"key":"F8"}),
            json!({"key":"Digit1","ctrl":true})
        ])),
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
    assert!(!matches(Chord::parse("shift+.").unwrap(), &event, None));
    assert!(matches(Chord::parse("shift+>").unwrap(), &event, None));
    assert!(matches(Chord::parse("shift+1").unwrap(), &event, Some('1')));
}
