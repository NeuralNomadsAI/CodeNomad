//! Tool commands as the bridge receives them, validated again with the reference's texts
//! (`parseDeveloperAction`, `parseBrowserAction`, `page/parse.ts`, `keyChord` refusals).
use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use crate::shared::js_trim;

type Result<T> = std::result::Result<T, String>;
type Object = Map<String, Value>;

const PAGE_TEXT: usize = 200;

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}
fn quote(s: &str) -> String {
    Value::from(s).to_string()
}
/// JS `typeof input === "object"` and truthy: arrays pass without fields.
fn object<'a>(input: &'a Value, refusal: &str) -> Result<&'a Object> {
    static EMPTY: LazyLock<Object> = LazyLock::new(Object::new);
    match input {
        Value::Object(map) => Ok(map),
        Value::Array(_) => Ok(&EMPTY),
        _ => Err(refusal.into()),
    }
}
/// A JSON integer (`Number.isInteger`) within `range`; absent or null takes `default` (`??`).
fn whole(value: Option<&Value>, default: f64, range: std::ops::RangeInclusive<f64>) -> Option<i64> {
    let n = match value {
        None | Some(Value::Null) => default,
        Some(v) => v.as_f64()?,
    };
    (n.fract() == 0.0 && range.contains(&n)).then_some(n as i64)
}

pub fn developer(input: &Value) -> Result<Value> {
    let value = object(input, "Native automation input must be an object")?;
    match value.get("action").and_then(Value::as_str) {
        Some("inspect") => scope(value, "inspect"),
        Some(action @ ("restart" | "screenshot")) => Ok(json!({ "action": action })),
        _ => page(value, "inspection")?.ok_or_else(|| "Unsupported native automation action".into()),
    }
}

pub fn browser(input: &Value) -> Result<Value> {
    let value = object(input, "Browser input must be an object")?;
    match value.get("action").and_then(Value::as_str) {
        Some(action @ ("open" | "navigate")) => match value.get("url") {
            Some(Value::String(url)) => Ok(json!({ "action": action, "url": url })),
            _ => Err(format!("{action} requires url")),
        },
        Some("snapshot") => scope(value, "snapshot"),
        Some("screenshot") => Ok(json!({ "action": "screenshot" })),
        _ => page(value, "snapshot")?.ok_or_else(|| "Unsupported browser action".into()),
    }
}

/// `inspectionScope`: an optional ref and a trimmed-non-empty query.
fn scope(value: &Object, action: &str) -> Result<Value> {
    let mut out = json!({ "action": action });
    match value.get("ref") {
        None => {}
        Some(Value::String(r)) => {
            if !r.is_empty() {
                out["ref"] = json!(r);
            }
        }
        Some(_) => return Err(format!("{action} ref must be a ref from the latest inspection")),
    }
    match value.get("query") {
        None => {}
        Some(Value::String(q)) if units(q) <= PAGE_TEXT => {
            if !js_trim(q).is_empty() {
                out["query"] = json!(q);
            }
        }
        Some(_) => return Err(format!("{action} query must be text of at most {PAGE_TEXT} characters")),
    }
    Ok(out)
}

/// `parsePageAction`; `None` when `action` names no page action.
fn page(value: &Object, inspect: &str) -> Result<Option<Value>> {
    let Some(action) = value.get("action").and_then(Value::as_str) else { return Ok(None) };
    let field = |name: &str| match value.get(name) {
        Some(Value::String(r)) if !r.is_empty() => Ok(r.clone()),
        _ => Err(format!("{action} requires {name}: a ref from the latest {inspect}")),
    };
    let optional = |out: &mut Value| -> Result<()> {
        if value.contains_key("ref") {
            out["ref"] = json!(field("ref")?);
        }
        Ok(())
    };
    let flag = |name: &str| value.get(name).is_some_and(|v| !v.is_boolean());
    Ok(Some(match action {
        "click" => {
            let button = value.get("button");
            if button.is_some_and(|b| *b != "left" && *b != "right") {
                return Err("click button must be left or right".into());
            }
            let mut out = json!({ "action": "click", "ref": field("ref")? });
            if button.is_some_and(|b| *b == "right") {
                out["button"] = json!("right");
            }
            out
        }
        "type" => {
            let Some(text) = value.get("text").filter(|t| t.is_string()) else {
                return Err("type requires ref and text".into());
            };
            if flag("clear") {
                return Err("type clear must be true or false".into());
            }
            json!({ "action": "type", "ref": field("ref")?, "text": text, "clear": value.get("clear") != Some(&json!(false)) })
        }
        "select" => {
            let values = value.get("values").and_then(Value::as_array);
            if !values.is_some_and(|v| v.len() <= 64 && v.iter().all(Value::is_string)) {
                return Err("select requires ref and values: the option labels or values to choose".into());
            }
            json!({ "action": "select", "ref": field("ref")?, "values": values })
        }
        "hover" => json!({ "action": "hover", "ref": field("ref")? }),
        "drag" => json!({ "action": "drag", "ref": field("ref")?, "to": field("to")? }),
        "scroll" => {
            let direction = value.get("direction").and_then(Value::as_str);
            let Some(direction) = direction.filter(|d| ["up", "down", "left", "right"].contains(d)) else {
                return Err("scroll requires direction: up, down, left or right".into());
            };
            let Some(amount) = whole(value.get("amount"), 600.0, 1.0..=10_000.0) else {
                return Err("scroll amount must be a whole number of pixels from 1 to 10000".into());
            };
            let mut out = json!({ "action": "scroll" });
            optional(&mut out)?;
            out["direction"] = json!(direction);
            out["amount"] = json!(amount);
            out
        }
        "press" => {
            let Some(key) = value.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else {
                return Err("press requires key, such as Enter, Escape, Tab, ArrowDown or Control+K".into());
            };
            chord(key)?;
            let mut out = json!({ "action": "press", "key": key });
            optional(&mut out)?;
            out
        }
        "wait" => {
            let text = value.get("text").and_then(Value::as_str);
            let Some(text) = text.filter(|t| !js_trim(t).is_empty() && units(t) <= PAGE_TEXT) else {
                return Err(format!("wait requires text of at most {PAGE_TEXT} characters"));
            };
            if flag("gone") {
                return Err("wait gone must be true or false".into());
            }
            let Some(timeout) = whole(value.get("timeout"), 5_000.0, 0.0..=15_000.0) else {
                return Err("wait timeout must be a whole number of milliseconds from 0 to 15000".into());
            };
            json!({ "action": "wait", "text": text, "gone": value.get("gone") == Some(&json!(true)), "timeout": timeout })
        }
        _ => return Ok(None),
    }))
}

const MODIFIERS: [&str; 8] = ["alt", "option", "control", "ctrl", "meta", "cmd", "command", "shift"];
const NAMED: [&str; 16] = [
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "ContextMenu",
];
const NAMED_ALIASES: [&str; 9] = ["esc", "return", "del", "up", "down", "left", "right", "pgup", "pgdn"];
/// US-layout punctuation with its shifted character, shifted digits.
const PUNCTUATION: &str = "`~-_=+[{]}\\|;:'\",<.>/?)!@#$%^&*(";

/// The refusals of `keyChord`: a chord is modifiers then one key or character.
fn chord(chord: &str) -> Result<()> {
    let parts: Vec<&str> = if chord == "+" { vec!["+"] } else { chord.split('+').map(js_trim).collect() };
    if parts.iter().any(|p| p.is_empty()) || units(chord) > 64 {
        return Err(format!("Unknown key {}", quote(chord)));
    }
    let (main, modifiers) = parts.split_last().expect("split yields a part");
    for part in modifiers {
        let lower = part.to_lowercase();
        if lower != "mod" && !MODIFIERS.contains(&lower.as_str()) {
            return Err(format!(
                "Unknown modifier {} in {}; use Control, Shift, Alt, Meta or Mod",
                quote(part),
                quote(chord)
            ));
        }
    }
    let lower = main.to_lowercase();
    // `Space` is named by its key " ": only its exact name matches.
    let named = NAMED.contains(main)
        || NAMED_ALIASES.contains(&lower.as_str())
        || NAMED.iter().any(|n| *n != "Space" && n.to_lowercase() == lower)
        || (1..=12).any(|n| lower == format!("f{n}"));
    let character = units(main) == 1 && main.chars().all(|c| c.is_ascii_alphanumeric() || PUNCTUATION.contains(c));
    if named || character {
        return Ok(());
    }
    Err(format!("Unknown key {}; use a character or a key name such as Enter, Escape, Tab or ArrowDown", quote(main)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_normalize_like_the_reference() {
        let ok = |v: Value| developer(&v).unwrap();
        assert_eq!(ok(json!({"action":"inspect","ref":"","query":"  "})), json!({"action":"inspect"}));
        assert_eq!(
            ok(json!({"action":"inspect","ref":"e1","query":"Save"})),
            json!({"action":"inspect","ref":"e1","query":"Save"})
        );
        assert_eq!(ok(json!({"action":"click","ref":"e1","button":"left"})), json!({"action":"click","ref":"e1"}));
        assert_eq!(ok(json!({"action":"click","ref":"e1","button":"right"}))["button"], "right");
        assert_eq!(
            ok(json!({"action":"type","ref":"e2","text":"x"})),
            json!({"action":"type","ref":"e2","text":"x","clear":true})
        );
        assert_eq!(
            ok(json!({"action":"scroll","direction":"down","amount":null})),
            json!({"action":"scroll","direction":"down","amount":600})
        );
        assert_eq!(ok(json!({"action":"scroll","direction":"up","amount":1e3,"ref":"e3"}))["amount"], 1000);
        assert_eq!(
            ok(json!({"action":"wait","text":"Done"})),
            json!({"action":"wait","text":"Done","gone":false,"timeout":5000})
        );
        assert_eq!(ok(json!({"action":"restart","extra":1})), json!({"action":"restart"}));
        for key in [
            "Enter",
            "enter",
            "Shift+Tab",
            "Mod+K",
            "ctrl + shift + k",
            "+",
            "F12",
            "f1",
            "Esc",
            "Space",
            "?",
            "~",
            "Alt+0",
        ] {
            assert_eq!(ok(json!({"action":"press","key":key}))["key"], key, "{key}");
        }
        assert_eq!(
            browser(&json!({"action":"open","url":"https://x.invalid"})).unwrap(),
            json!({"action":"open","url":"https://x.invalid"})
        );
        assert_eq!(
            browser(&json!({"action":"snapshot","query":"Save"})).unwrap(),
            json!({"action":"snapshot","query":"Save"})
        );
    }

    #[test]
    fn refusals_keep_the_reference_texts() {
        let refused = |v: Value| developer(&v).unwrap_err();
        assert_eq!(refused(json!("x")), "Native automation input must be an object");
        assert_eq!(refused(json!([1])), "Unsupported native automation action");
        assert_eq!(
            refused(json!({"action":"inspect","ref":null})),
            "inspect ref must be a ref from the latest inspection"
        );
        assert_eq!(
            refused(json!({"action":"inspect","query":"x".repeat(201)})),
            "inspect query must be text of at most 200 characters"
        );
        assert_eq!(refused(json!({"action":"click"})), "click requires ref: a ref from the latest inspection");
        assert_eq!(
            refused(json!({"action":"click","ref":"e1","button":"middle"})),
            "click button must be left or right"
        );
        assert_eq!(refused(json!({"action":"type","ref":"e1"})), "type requires ref and text");
        assert_eq!(
            refused(json!({"action":"type","ref":"e1","text":"","clear":1})),
            "type clear must be true or false"
        );
        assert_eq!(
            refused(json!({"action":"select","ref":"e1","values":[1]})),
            "select requires ref and values: the option labels or values to choose"
        );
        assert_eq!(refused(json!({"action":"drag","ref":"e1"})), "drag requires to: a ref from the latest inspection");
        assert_eq!(
            refused(json!({"action":"scroll","direction":"sideways"})),
            "scroll requires direction: up, down, left or right"
        );
        assert_eq!(
            refused(json!({"action":"scroll","direction":"up","amount":1.5})),
            "scroll amount must be a whole number of pixels from 1 to 10000"
        );
        assert_eq!(
            refused(json!({"action":"scroll","direction":"up","ref":null})),
            "scroll requires ref: a ref from the latest inspection"
        );
        assert_eq!(
            refused(json!({"action":"press","key":""})),
            "press requires key, such as Enter, Escape, Tab, ArrowDown or Control+K"
        );
        assert_eq!(
            refused(json!({"action":"press","key":"Hyper+K"})),
            r#"Unknown modifier "Hyper" in "Hyper+K"; use Control, Shift, Alt, Meta or Mod"#
        );
        assert_eq!(refused(json!({"action":"press","key":"Shift++"})), r#"Unknown key "Shift++""#);
        assert_eq!(
            refused(json!({"action":"press","key":"space"})),
            r#"Unknown key "space"; use a character or a key name such as Enter, Escape, Tab or ArrowDown"#
        );
        assert_eq!(
            refused(json!({"action":"press","key":"é"})),
            r#"Unknown key "é"; use a character or a key name such as Enter, Escape, Tab or ArrowDown"#
        );
        assert_eq!(refused(json!({"action":"wait","text":" "})), "wait requires text of at most 200 characters");
        assert_eq!(refused(json!({"action":"wait","text":"x","gone":null})), "wait gone must be true or false");
        assert_eq!(
            refused(json!({"action":"wait","text":"x","timeout":15001})),
            "wait timeout must be a whole number of milliseconds from 0 to 15000"
        );
        assert_eq!(refused(json!({"action":"nope"})), "Unsupported native automation action");
        assert_eq!(browser(&Value::Null).unwrap_err(), "Browser input must be an object");
        assert_eq!(browser(&json!({"action":"navigate"})).unwrap_err(), "navigate requires url");
        assert_eq!(
            browser(&json!({"action":"click"})).unwrap_err(),
            "click requires ref: a ref from the latest snapshot"
        );
        assert_eq!(browser(&json!({"action":"restart"})).unwrap_err(), "Unsupported browser action");
    }
}
