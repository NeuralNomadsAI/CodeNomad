use super::{Preferences, State};
use rune::{Chord, ChordKey, ChordMod, Key, KeyEvent, Keybind, PhysicalKeyCode, Tx};
use serde_json::Value;

pub(crate) const FILE_SAVE: &str = "file-save";
pub(super) mod catalog;
pub(super) mod editor;
mod reserved;

fn decode(rule: &Value) -> Option<Chord> {
    let rule = rule.as_object()?;
    let raw = rule.get("key")?.as_str()?;
    let mut chars = raw.chars();
    let single = chars
        .next()
        .filter(|_| chars.next().is_none())
        .filter(|c| !c.is_control());
    let key = raw.to_lowercase();
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
    } else if key == "i\u{307}" {
        Chord::new(ChordKey::Char('İ'))
    } else if let Some(c) = single.filter(|_| !matches!(key, "space" | "plus")) {
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

pub(crate) fn shortcut_label(s: &State, action: &str) -> String {
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

fn canonical_key_name(c: char) -> String {
    let lower: String = c.to_lowercase().collect();
    if lower.chars().count() == 1 {
        lower
    } else {
        c.to_string()
    }
}

pub(super) fn record(event: &KeyEvent, tx: &Tx) -> Option<Value> {
    use serde_json::json;
    let name = if let Some(c) = tx.physical_key().and_then(physical_slot) {
        c.to_string()
    } else {
        match &event.key {
            Key::Command(c) => {
                canonical_key_name(logical_command(*c, event, tx.physical_key(), tx.key_base()))
            }
            Key::Text(text) => {
                let mut chars = text.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) => canonical_key_name(c),
                    _ => text.to_lowercase(),
                }
            }
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
        .any(|chord| matches(*chord, event, tx.physical_key(), tx.key_base()))
}

fn canonical_char(c: char) -> char {
    match c {
        '{' => '[',
        '}' => ']',
        c => c,
    }
}

fn is_unshifted_us_char(c: char) -> bool {
    c.is_ascii_lowercase()
        || c.is_ascii_digit()
        || matches!(
            c,
            '`' | '-' | '=' | '[' | ']' | '\\' | ';' | '\'' | ',' | '.' | '/'
        )
}

fn physical_us_char(key: PhysicalKeyCode) -> Option<char> {
    Some(match key {
        PhysicalKeyCode::KeyA => 'a',
        PhysicalKeyCode::KeyB => 'b',
        PhysicalKeyCode::KeyC => 'c',
        PhysicalKeyCode::KeyD => 'd',
        PhysicalKeyCode::KeyE => 'e',
        PhysicalKeyCode::KeyF => 'f',
        PhysicalKeyCode::KeyG => 'g',
        PhysicalKeyCode::KeyH => 'h',
        PhysicalKeyCode::KeyI => 'i',
        PhysicalKeyCode::KeyJ => 'j',
        PhysicalKeyCode::KeyK => 'k',
        PhysicalKeyCode::KeyL => 'l',
        PhysicalKeyCode::KeyM => 'm',
        PhysicalKeyCode::KeyN => 'n',
        PhysicalKeyCode::KeyO => 'o',
        PhysicalKeyCode::KeyP => 'p',
        PhysicalKeyCode::KeyQ => 'q',
        PhysicalKeyCode::KeyR => 'r',
        PhysicalKeyCode::KeyS => 's',
        PhysicalKeyCode::KeyT => 't',
        PhysicalKeyCode::KeyU => 'u',
        PhysicalKeyCode::KeyV => 'v',
        PhysicalKeyCode::KeyW => 'w',
        PhysicalKeyCode::KeyX => 'x',
        PhysicalKeyCode::KeyY => 'y',
        PhysicalKeyCode::KeyZ => 'z',
        PhysicalKeyCode::Digit0 => '0',
        PhysicalKeyCode::Digit1 => '1',
        PhysicalKeyCode::Digit2 => '2',
        PhysicalKeyCode::Digit3 => '3',
        PhysicalKeyCode::Digit4 => '4',
        PhysicalKeyCode::Digit5 => '5',
        PhysicalKeyCode::Digit6 => '6',
        PhysicalKeyCode::Digit7 => '7',
        PhysicalKeyCode::Digit8 => '8',
        PhysicalKeyCode::Digit9 => '9',
        PhysicalKeyCode::Backquote => '`',
        PhysicalKeyCode::Minus => '-',
        PhysicalKeyCode::Equal => '=',
        PhysicalKeyCode::BracketLeft => '[',
        PhysicalKeyCode::BracketRight => ']',
        PhysicalKeyCode::Backslash => '\\',
        PhysicalKeyCode::Semicolon => ';',
        PhysicalKeyCode::Quote => '\'',
        PhysicalKeyCode::Comma => ',',
        PhysicalKeyCode::Period => '.',
        PhysicalKeyCode::Slash => '/',
        _ => return None,
    })
}

fn logical_command(
    typed: char,
    event: &KeyEvent,
    physical_key: Option<PhysicalKeyCode>,
    base: Option<char>,
) -> char {
    // Rune substitutes the unshifted US-position character for non-ASCII command chords off macOS.
    if cfg!(not(target_os = "macos"))
        && typed.is_ascii()
        && (event.mods.ctrl || event.mods.cmd)
        && !event.mods.alt
        && physical_key.map_or_else(
            || is_unshifted_us_char(typed),
            |key| physical_us_char(key) == Some(typed),
        )
    {
        if event.mods.shift && base == Some('i') && typed != 'i' {
            return 'İ';
        }
        return base
            .filter(|c| {
                !c.is_ascii() && !(event.mods.shift && c.to_uppercase().all(|u| u.is_ascii()))
            })
            .unwrap_or(typed);
    }
    typed
}

fn matches(
    chord: Chord,
    event: &KeyEvent,
    physical_key: Option<PhysicalKeyCode>,
    base: Option<char>,
) -> bool {
    if chord.has(ChordMod::Shift) != event.mods.shift {
        return false;
    }
    let physical = physical_key.and_then(physical_slot);
    // Unlike Rune's menu chords, Solid uses the typed character outside digit/bracket slots.
    if let ChordKey::Char(expected) = chord.key() {
        let char = physical.or_else(|| match &event.key {
            Key::Command(c) => Some(canonical_char(logical_command(
                *c,
                event,
                physical_key,
                base,
            ))),
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

fn physical_slot(key: PhysicalKeyCode) -> Option<char> {
    use PhysicalKeyCode::{
        BracketLeft, BracketRight, Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7,
        Digit8, Digit9,
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
        Some(PhysicalKeyCode::Digit1),
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
            Some(PhysicalKeyCode::Semicolon),
            Some(if shift { 'Ö' } else { 'ö' })
        ));
        assert!(!matches(
            new_tab[0],
            &event,
            Some(PhysicalKeyCode::Semicolon),
            Some('ö')
        ));
        assert!(!bindings_conflict(
            &save,
            &new_tab,
            rune::KeyPlatform::Windows
        ));
        let same_key = [decode(&json!({"key":"Ö","ctrl":true,"shift":shift})).unwrap()];
        assert!(matches(
            same_key[0],
            &event,
            Some(PhysicalKeyCode::Semicolon),
            Some('ö')
        ));
        assert!(bindings_conflict(
            &save,
            &same_key,
            rune::KeyPlatform::Windows
        ));
    }
    // German Ctrl+Shift+? on physical Minus: Windows sends logical '?' while base is 'ß'.
    let german_question = KeyEvent {
        key: Key::Command('?'),
        mods: rune::Mods {
            ctrl: true,
            cmd: true,
            shift: true,
            ..Default::default()
        },
    };
    let next_question = decode(&json!({"key":"?","mod":true,"shift":true})).unwrap();
    let next_eszett = decode(&json!({"key":"ß","mod":true,"shift":true})).unwrap();
    assert!(matches(
        next_question,
        &german_question,
        Some(PhysicalKeyCode::Minus),
        Some('ß')
    ));
    assert!(!matches(
        next_eszett,
        &german_question,
        Some(PhysicalKeyCode::Minus),
        Some('ß')
    ));
    let german_eszett = KeyEvent {
        key: Key::Command('-'),
        mods: rune::Mods {
            ctrl: true,
            cmd: true,
            shift: false,
            ..Default::default()
        },
    };
    let eszett_binding = decode(&json!({"key":"ß","mod":true})).unwrap();
    assert!(matches(
        eszett_binding,
        &german_eszett,
        Some(PhysicalKeyCode::Minus),
        Some('ß')
    ));
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
        Some(PhysicalKeyCode::Digit2),
        None
    ));
    assert!(matches(
        session_tab_2[0],
        &KeyEvent {
            key: Key::Command('@'),
            mods: shift_ctrl,
        },
        Some(PhysicalKeyCode::Digit2),
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

#[cfg(test)]
#[test]
fn turkish_shifted_i_does_not_substitute_dotless_base() {
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
    prefs.fixture_shortcuts(serde_json::json!({
        "instance-next": [{"key": "i", "mod": true, "shift": true}],
        "instance-prev": [{"key": "ı", "mod": true, "shift": true}],
        "session-next": [{"key": "ı", "mod": true}],
    }));
    let next = catalog::resolve(&prefs, "instance-next");
    let prev = catalog::resolve(&prefs, "instance-prev");
    let session_next = catalog::resolve(&prefs, "session-next");
    let shifted_event = KeyEvent {
        key: Key::Command('i'),
        mods: shift_ctrl,
    };
    assert!(matches(
        next[0],
        &shifted_event,
        Some(PhysicalKeyCode::KeyI),
        Some('ı'),
    ));
    assert!(!matches(
        prev[0],
        &shifted_event,
        Some(PhysicalKeyCode::KeyI),
        Some('ı'),
    ));
    if cfg!(not(target_os = "macos")) {
        assert!(matches(
            session_next[0],
            &KeyEvent {
                key: Key::Command('i'),
                mods: ctrl,
            },
            Some(PhysicalKeyCode::KeyI),
            Some('ı'),
        ));
    }
    let dotted_i = decode(&serde_json::json!({"key": "İ", "shift": true})).unwrap();
    let dotted_i_solid = decode(&serde_json::json!({"key": "i\u{307}", "shift": true})).unwrap();
    let shifted_dotted = KeyEvent {
        key: Key::Text("İ".into()),
        mods: rune::Mods {
            shift: true,
            ..Default::default()
        },
    };
    assert!(matches(dotted_i, &shifted_dotted, None, None));
    assert!(matches(dotted_i_solid, &shifted_dotted, None, None));
    if cfg!(not(target_os = "macos")) {
        let ctrl_shift_dotted_i =
            decode(&serde_json::json!({"key": "İ", "mod": true, "shift": true})).unwrap();
        let ctrl_shift_quote =
            decode(&serde_json::json!({"key": "'", "mod": true, "shift": true})).unwrap();
        let turkish_quote_event = KeyEvent {
            key: Key::Command('\''),
            mods: shift_ctrl,
        };
        assert!(matches(
            ctrl_shift_dotted_i,
            &turkish_quote_event,
            Some(PhysicalKeyCode::Quote),
            Some('i'),
        ));
        assert!(!matches(
            ctrl_shift_quote,
            &turkish_quote_event,
            Some(PhysicalKeyCode::Quote),
            Some('i'),
        ));
    }
}

#[cfg(all(test, not(target_os = "macos")))]
#[test]
fn runtime_key_base_records_and_matches_non_ascii_command_chords() {
    use rune::{Env, Mods, Runtime};
    use serde_json::json;

    #[derive(Default)]
    struct Harness {
        prefs: Preferences,
        recorded: Vec<Option<Value>>,
        matched_umlaut: Vec<bool>,
        matched_semicolon: Vec<bool>,
    }

    let mut harness = Harness::default();
    harness.prefs.fixture_shortcuts(json!({
        FILE_SAVE: [{"key": "ö", "mod": true}],
        "instance-next": [{"key": ";", "mod": true}],
    }));
    let mut rt = Runtime::new(harness, |_, _| rune::el(), (120.0, 80.0), Env::default());
    rt.on_key = Some(|s, ev, tx| {
        s.recorded.push(record(ev, tx));
        s.matched_umlaut
            .push(matches_shortcut_in(&s.prefs, FILE_SAVE, ev, tx));
        s.matched_semicolon
            .push(matches_shortcut_in(&s.prefs, "instance-next", ev, tx));
        true
    });
    rt.frame(0.0);

    let ctrl = Mods {
        ctrl: true,
        cmd: true,
        ..Mods::default()
    };
    let web_mac_cmd = Mods {
        cmd: true,
        logo: true,
        ..Mods::default()
    };
    rt.key_with(
        KeyEvent {
            key: Key::Command(';'),
            mods: ctrl,
        },
        PhysicalKeyCode::Semicolon,
        Some('ö'),
    );
    rt.key_with(
        KeyEvent {
            key: Key::Command(';'),
            mods: web_mac_cmd,
        },
        PhysicalKeyCode::Semicolon,
        Some('ö'),
    );
    rt.frame(0.02);

    assert_eq!(
        rt.state.recorded,
        [
            Some(json!([{"key": "ö", "mod": true}])),
            Some(json!([{"key": "ö", "meta": true}])),
        ]
    );
    assert_eq!(rt.state.matched_umlaut, [true, false]);
    assert_eq!(rt.state.matched_semicolon, [false, false]);
}
