//! Keyboard chords for `press` (`page/keys.ts`) as `Input.dispatchKeyEvent` sequences: modifiers
//! held around the key, a shortcut types nothing, releases in reverse.
use serde_json::{json, Value};

struct Key {
    key: String,
    code: String,
    key_code: u32,
    text: Option<String>,
    location: Option<u8>,
}

fn key(key: &str, code: &str, key_code: u32, text: Option<&str>) -> Key {
    Key {
        key: key.into(),
        code: code.into(),
        key_code,
        text: text.map(Into::into),
        location: None,
    }
}

const MODIFIERS: [(&str, &str, u32, u32); 4] = [
    ("Alt", "AltLeft", 18, 1),
    ("Control", "ControlLeft", 17, 2),
    ("Meta", "MetaLeft", 91, 4),
    ("Shift", "ShiftLeft", 16, 8),
];
const NAMED: [(&str, u32); 16] = [
    ("Enter", 13),
    ("Tab", 9),
    ("Escape", 27),
    ("Backspace", 8),
    ("Delete", 46),
    ("Space", 32),
    ("ArrowUp", 38),
    ("ArrowDown", 40),
    ("ArrowLeft", 37),
    ("ArrowRight", 39),
    ("Home", 36),
    ("End", 35),
    ("PageUp", 33),
    ("PageDown", 34),
    ("Insert", 45),
    ("ContextMenu", 93),
];
const NAMED_ALIASES: [(&str, &str); 10] = [
    ("esc", "Escape"),
    ("return", "Enter"),
    ("del", "Delete"),
    ("up", "ArrowUp"),
    ("down", "ArrowDown"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
    ("pgup", "PageUp"),
    ("pgdn", "PageDown"),
    (" ", "Space"),
];
/// US-layout punctuation: character, code, key code, shifted character.
const PUNCTUATION: [(char, &str, u32, char); 11] = [
    ('`', "Backquote", 192, '~'),
    ('-', "Minus", 189, '_'),
    ('=', "Equal", 187, '+'),
    ('[', "BracketLeft", 219, '{'),
    (']', "BracketRight", 221, '}'),
    ('\\', "Backslash", 220, '|'),
    (';', "Semicolon", 186, ':'),
    ('\'', "Quote", 222, '"'),
    (',', "Comma", 188, '<'),
    ('.', "Period", 190, '>'),
    ('/', "Slash", 191, '?'),
];
const SHIFTED_DIGITS: &str = ")!@#$%^&*(";

fn named(name: &str) -> Option<Key> {
    let function = name.strip_prefix('F').and_then(|n| n.parse::<u32>().ok());
    if let Some(n) = function.filter(|n| (1..=12).contains(n) && name == format!("F{n}")) {
        return Some(key(name, name, 111 + n, None));
    }
    let (name, code) = *NAMED.iter().find(|(n, _)| *n == name)?;
    Some(match name {
        "Enter" => key("Enter", "Enter", 13, Some("\r")),
        "Space" => key(" ", "Space", 32, Some(" ")),
        _ => key(name, name, code, None),
    })
}
/// The exact name, an alias, a case-insensitive name (`Space` is named by its key " ", so only its
/// exact name and alias match), else one character.
fn lookup(main: &str) -> Option<Key> {
    let lower = main.to_lowercase();
    let mut names = NAMED
        .iter()
        .map(|(n, _)| n.to_string())
        .chain((1..=12).map(|n| format!("F{n}")));
    named(main)
        .or_else(|| {
            NAMED_ALIASES
                .iter()
                .find(|(a, _)| *a == lower)
                .and_then(|(_, n)| named(n))
        })
        .or_else(|| {
            names
                .find(|n| n != "Space" && n.to_lowercase() == lower)
                .and_then(|n| named(&n))
        })
        .or_else(|| character(main))
}
fn character(value: &str) -> Option<Key> {
    let mut chars = value.chars();
    let c = chars.next()?;
    if chars.next().is_some() || c.len_utf16() != 1 {
        return None;
    }
    let text = Some(value);
    if c.is_ascii_alphabetic() {
        let upper = c.to_ascii_uppercase();
        return Some(key(value, &format!("Key{upper}"), upper as u32, text));
    }
    if c.is_ascii_digit() {
        return Some(key(value, &format!("Digit{c}"), c as u32, text));
    }
    if let Some(digit) = SHIFTED_DIGITS.find(c) {
        return Some(key(
            value,
            &format!("Digit{digit}"),
            48 + digit as u32,
            text,
        ));
    }
    let (_, code, key_code, _) = PUNCTUATION
        .iter()
        .find(|(base, _, _, shifted)| *base == c || *shifted == c)?;
    Some(key(value, code, *key_code, text))
}

fn event(kind: &str, key: &Key, modifiers: u32, text: Option<&str>) -> Value {
    let mut event = json!({"type": kind, "key": key.key, "code": key.code, "windowsVirtualKeyCode": key.key_code, "modifiers": modifiers});
    if let Some(text) = text {
        event["text"] = json!(text);
        event["unmodifiedText"] = json!(text);
    }
    if let Some(location) = key.location {
        event["location"] = json!(location);
    }
    event
}

/// Parses "Enter", "a", "Shift+Tab", "Control+Shift+K" or "Mod+K" (Meta on macOS, Control elsewhere).
pub(crate) fn chord(chord: &str, mac: bool) -> Result<Vec<Value>, String> {
    let space = super::snapshot::space;
    let parts: Vec<&str> = if chord == "+" {
        vec!["+"]
    } else {
        chord.split('+').map(|p| p.trim_matches(space)).collect()
    };
    if parts.iter().any(|p| p.is_empty()) || chord.encode_utf16().count() > 64 {
        return Err(format!("Unknown key {}", super::snapshot::quote(chord)));
    }
    let (main, held) = parts.split_last().expect("one part");
    let mut modifiers: Vec<usize> = Vec::new();
    for part in held {
        let name = match part.to_lowercase().as_str() {
            "mod" if mac => "Meta",
            "mod" => "Control",
            "alt" | "option" => "Alt",
            "control" | "ctrl" => "Control",
            "meta" | "cmd" | "command" => "Meta",
            "shift" => "Shift",
            _ => {
                return Err(format!(
                    "Unknown modifier {} in {}; use Control, Shift, Alt, Meta or Mod",
                    super::snapshot::quote(part),
                    super::snapshot::quote(chord)
                ))
            }
        };
        let index = MODIFIERS
            .iter()
            .position(|m| m.0 == name)
            .expect("known modifier");
        if !modifiers.contains(&index) {
            modifiers.push(index);
        }
    }
    let Some(mut main_key) = lookup(main) else {
        return Err(format!(
            "Unknown key {}; use a character or a key name such as Enter, Escape, Tab or ArrowDown",
            super::snapshot::quote(main)
        ));
    };
    // Shift+a types "A", like a physical keyboard.
    let shift = modifiers.iter().any(|m| MODIFIERS[*m].0 == "Shift");
    if let Some(upper) = main_key
        .text
        .as_ref()
        .filter(|t| shift && t.len() == 1 && t.as_bytes()[0].is_ascii_lowercase())
        .map(|t| t.to_uppercase())
    {
        main_key.key = upper.clone();
        main_key.text = Some(upper);
    }
    let mut events = Vec::new();
    let mut bits = 0;
    for index in &modifiers {
        let (name, code, key_code, bit) = MODIFIERS[*index];
        bits |= bit;
        events.push(event(
            "rawKeyDown",
            &Key {
                location: Some(1),
                ..key(name, code, key_code, None)
            },
            bits,
            None,
        ));
    }
    let text = if bits & !8 != 0 {
        None
    } else {
        main_key.text.clone()
    };
    events.push(event(
        if text.is_some() {
            "keyDown"
        } else {
            "rawKeyDown"
        },
        &main_key,
        bits,
        text.as_deref(),
    ));
    events.push(event("keyUp", &main_key, bits, None));
    for index in modifiers.iter().rev() {
        let (name, code, key_code, bit) = MODIFIERS[*index];
        bits &= !bit;
        events.push(event(
            "keyUp",
            &Key {
                location: Some(1),
                ..key(name, code, key_code, None)
            },
            bits,
            None,
        ));
    }
    Ok(events)
}
