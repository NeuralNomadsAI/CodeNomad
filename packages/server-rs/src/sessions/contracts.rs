//! The fixed, ref-free schemas emitted from the pinned Zod contracts. Request paths never
//! compile a general JSON Schema metaschema or keep payloads.
use serde_json::Value;

pub fn valid(schema: &Value, value: &Value) -> bool {
    match schema {
        Value::Bool(b) => return *b,
        Value::Object(_) => {}
        _ => return false,
    }
    let integer =
        |v: &Value| v.as_i64().is_some() || v.as_u64().is_some() || v.as_f64().is_some_and(|n| n.fract() == 0.0);
    let string = value.as_str();
    for (key, rule) in schema.as_object().unwrap() {
        let ok = match key.as_str() {
            "$schema" | "properties" | "additionalProperties" => true,
            "type" => match rule.as_str() {
                Some("object") => value.is_object(),
                Some("array") => value.is_array(),
                Some("string") => string.is_some(),
                Some("number") => value.is_number(),
                Some("integer") => integer(value),
                Some("boolean") => value.is_boolean(),
                Some("null") => value.is_null(),
                _ => false,
            },
            "const" => value == rule,
            "enum" => rule.as_array().is_some_and(|items| items.contains(value)),
            "anyOf" => rule.as_array().is_some_and(|items| items.iter().any(|s| valid(s, value))),
            "oneOf" => {
                rule.as_array().is_some_and(|items| items.iter().filter(|s| valid(s, value)).take(2).count() == 1)
            }
            "required" => rule.as_array().is_some_and(|items| {
                value
                    .as_object()
                    .is_some_and(|obj| items.iter().all(|k| k.as_str().is_some_and(|k| obj.contains_key(k))))
            }),
            "propertyNames" => {
                value.as_object().is_some_and(|obj| obj.keys().all(|key| valid(rule, &Value::String(key.clone()))))
            }
            "items" => value.as_array().is_some_and(|items| items.iter().all(|item| valid(rule, item))),
            "minItems" | "maxItems" => value.as_array().is_some_and(|xs| {
                rule.as_u64()
                    .is_some_and(|n| if key == "minItems" { xs.len() as u64 >= n } else { xs.len() as u64 <= n })
            }),
            "minLength" | "maxLength" => string.is_some_and(|s| {
                rule.as_u64().is_some_and(|n| {
                    let length = s.encode_utf16().count() as u64;
                    if key == "minLength" { length >= n } else { length <= n }
                })
            }),
            "minimum" | "maximum" => {
                value.as_f64().zip(rule.as_f64()).is_some_and(|(v, n)| if key == "minimum" { v >= n } else { v <= n })
            }
            "pattern" => string.is_some_and(|s| match rule.as_str() {
                Some("^[a-f0-9]{64}$") => {
                    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
                }
                Some("^(?:[RTX]{0,1000}|[RTX]{0,500}-[RTX]{0,500})$") => {
                    let markers = |s: &str, max| s.len() <= max && s.bytes().all(|b| matches!(b, b'R' | b'T' | b'X'));
                    s.split_once('-').map_or_else(|| markers(s, 1000), |(a, b)| markers(a, 500) && markers(b, 500))
                }
                _ => false,
            }),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    if let Some(object) = value.as_object() {
        return object.iter().all(|(key, value)| {
            schema["properties"]
                .get(key)
                .or_else(|| schema.get("additionalProperties"))
                .is_none_or(|rule| valid(rule, value))
        });
    }
    true
}

macro_rules! schema {
    ($name:literal) => {{
        static SCHEMA: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
            serde_json::from_str(include_str!(concat!("../../contracts/", $name, ".json"))).expect("pinned contract")
        });
        &*SCHEMA
    }};
}
pub fn get(name: &str, output: bool) -> &Value {
    match (name, output) {
        ("pending", _) => schema!("pending"),
        ("outline", false) => schema!("outline-input"),
        ("outline", true) => schema!("outline-output"),
        ("outlinePreview", false) => schema!("outlinePreview-input"),
        ("outlinePreview", true) => schema!("outlinePreview-output"),
        ("window", false) => schema!("window-input"),
        ("window", true) => schema!("window-output"),
        _ => unreachable!("fixed route"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pinned_outline_layout_and_object_bounds() {
        let schema = get("outline", true);
        let output = |layout| {
            json!({"status":"outline","total":1,"cursor":null,"checkpoints":[],
            "entries":[{"id":"m","seq":0,"type":"assistant","tools":0,"reasoning":0,"layout":layout}]})
        };
        for n in [499, 500, 501, 1000, 1001] {
            assert_eq!(valid(schema, &output("R".repeat(n))), n <= 1000);
            assert_eq!(valid(schema, &output(format!("{}-T", "R".repeat(n)))), n <= 500);
        }
        assert!(!valid(schema, &output("R--T".into())));
        assert!(!valid(get("window", false), &json!({"sessionID":"s","target":{"kind":"latest","unknown":true}})));
    }
}
