//! The file search query exactly as the reference reads it: Fastify's parser
//! (fast-querystring: `+` as space, strict percent decoding that keeps the raw
//! text when invalid, repeated keys as arrays) then `WorkspaceFileSearchQuerySchema`
//! (zod 4). A refusal is the ZodError message, the 400 body's `error`.
//! Parity: `search-query-cases.json` from `generate-search-query-cases.mjs`.
use crate::shared::js_space;

#[derive(Debug, PartialEq)]
enum Field {
    One(String),
    Many(usize),
}

#[derive(Debug, PartialEq)]
pub struct Query {
    pub directory: Option<String>,
    pub q: String,
    pub limit: Option<u32>,
    pub kind: Option<&'static str>,
    pub refresh: Option<bool>,
}

fn part(text: &str) -> String {
    let text = if text.contains('+') { text.replace('+', " ") } else { text.to_owned() };
    // `fastDecode(text) || text`
    match crate::shared::decode_component(&text) {
        Some(decoded) if !decoded.is_empty() => decoded,
        _ => text,
    }
}

/// fast-querystring `parse`, keeping only the keys the schema reads.
fn fields(raw: &str) -> [Option<Field>; 5] {
    const KEYS: [&str; 5] = ["directory", "q", "limit", "type", "refresh"];
    let mut out: [Option<Field>; 5] = Default::default();
    for segment in raw.split('&') {
        let (key, value) = match segment.split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None if segment.is_empty() => continue,
            None => (segment, None),
        };
        let key = if key.contains(['%', '+']) { part(key) } else { key.to_owned() };
        let Some(slot) = KEYS.iter().position(|k| *k == key) else { continue };
        let value = value.map(|v| if v.contains(['%', '+', '=']) { part(v) } else { v.to_owned() }).unwrap_or_default();
        out[slot] = Some(match out[slot].take() {
            None => Field::One(value),
            Some(Field::One(_)) => Field::Many(2),
            Some(Field::Many(n)) => Field::Many(n + 1),
        });
    }
    out
}

/// JavaScript `Number(text)`.
fn number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0f64, |n, c| n * radix as f64 + c.to_digit(radix).unwrap() as f64);
        }
    }
    let unsigned = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let valid = digits(whole)
        && digits(fraction)
        && !(whole.is_empty() && fraction.is_empty())
        && exponent.is_none_or(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && digits(e)
        });
    if !valid { f64::NAN } else { t.parse().unwrap_or(f64::NAN) }
}

const SAFE: f64 = 9_007_199_254_740_991.0;

fn issue(pairs: &[(&str, String)], key: &str) -> String {
    let mut lines = Vec::new();
    for (name, value) in pairs {
        if *name == "path" {
            lines.push(format!("    \"path\": [\n      \"{key}\"\n    ]"));
        } else {
            lines.push(format!("    \"{name}\": {value}"));
        }
    }
    format!("  {{\n{}\n  }}", lines.join(",\n"))
}
fn text(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn expected_string(key: &str, received: &str) -> String {
    issue(
        &[
            ("expected", text("string")),
            ("code", text("invalid_type")),
            ("path", String::new()),
            ("message", text(&format!("Invalid input: expected string, received {received}"))),
        ],
        key,
    )
}
fn too_short(key: &str, message: &str) -> String {
    issue(
        &[
            ("origin", text("string")),
            ("code", text("too_small")),
            ("minimum", "1".into()),
            ("inclusive", "true".into()),
            ("path", String::new()),
            ("message", text(message)),
        ],
        key,
    )
}

/// A trimmed `z.string().trim().min(1)`: the value, or its issue.
fn string(field: Option<&Field>, key: &str, short: &str, issues: &mut Vec<String>) -> Option<String> {
    match field {
        None => None,
        Some(Field::Many(_)) => {
            issues.push(expected_string(key, "array"));
            None
        }
        Some(Field::One(v)) => {
            let v = v.trim_matches(js_space);
            if v.is_empty() {
                issues.push(too_short(key, short));
                return None;
            }
            Some(v.to_owned())
        }
    }
}

fn limit(field: Option<&Field>, issues: &mut Vec<String>) -> Option<u32> {
    let n = match field? {
        Field::One(v) => number(v),
        Field::Many(_) => f64::NAN,
    };
    let key = "limit";
    if n.is_nan() || n.is_infinite() {
        let received = if n.is_nan() {
            "NaN"
        } else if n > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        };
        issues.push(issue(
            &[
                ("expected", text("number")),
                ("code", text("invalid_type")),
                ("received", text(received)),
                ("path", String::new()),
                ("message", text(&format!("Invalid input: expected number, received {received}"))),
            ],
            key,
        ));
        return None;
    }
    if n.fract() != 0.0 {
        issues.push(issue(
            &[
                ("expected", text("int")),
                ("format", text("safeint")),
                ("code", text("invalid_type")),
                ("path", String::new()),
                ("message", text("Invalid input: expected int, received number")),
            ],
            key,
        ));
        return None;
    }
    let before = issues.len();
    let note = text("Integers must be within the safe integer range.");
    if n > SAFE {
        issues.push(issue(
            &[
                ("code", text("too_big")),
                ("maximum", "9007199254740991".into()),
                ("note", note.clone()),
                ("origin", text("int")),
                ("inclusive", "true".into()),
                ("path", String::new()),
                ("message", text("Too big: expected int to be <=9007199254740991")),
            ],
            key,
        ));
    } else if n < -SAFE {
        issues.push(issue(
            &[
                ("code", text("too_small")),
                ("minimum", "-9007199254740991".into()),
                ("note", note),
                ("origin", text("int")),
                ("inclusive", "true".into()),
                ("path", String::new()),
                ("message", text("Too small: expected int to be >=-9007199254740991")),
            ],
            key,
        ));
    }
    if n <= 0.0 {
        issues.push(issue(
            &[
                ("origin", text("number")),
                ("code", text("too_small")),
                ("minimum", "0".into()),
                ("inclusive", "false".into()),
                ("path", String::new()),
                ("message", text("Too small: expected number to be >0")),
            ],
            key,
        ));
    }
    if n > 200.0 {
        issues.push(issue(
            &[
                ("origin", text("number")),
                ("code", text("too_big")),
                ("maximum", "200".into()),
                ("inclusive", "true".into()),
                ("path", String::new()),
                ("message", text("Too big: expected number to be <=200")),
            ],
            key,
        ));
    }
    (issues.len() == before).then_some(n as u32)
}

/// Parses and validates; `Err` carries the ZodError message.
pub fn parse(raw: Option<&str>) -> Result<Query, String> {
    let fields = fields(raw.unwrap_or_default());
    let mut issues = Vec::new();
    let directory =
        string(fields[0].as_ref(), "directory", "Too small: expected string to have >=1 characters", &mut issues);
    let q = match &fields[1] {
        None => {
            issues.push(expected_string("q", "undefined"));
            None
        }
        field => string(field.as_ref(), "q", "Query is required", &mut issues),
    };
    let limit = limit(fields[2].as_ref(), &mut issues);
    let kind = match &fields[3] {
        None => None,
        Some(Field::One(v)) if matches!(v.as_str(), "all" | "file" | "directory") => Some(match v.as_str() {
            "all" => "all",
            "file" => "file",
            _ => "directory",
        }),
        Some(_) => {
            issues.push(issue(
                &[
                    ("code", text("invalid_value")),
                    ("values", "[\n      \"all\",\n      \"file\",\n      \"directory\"\n    ]".into()),
                    ("path", String::new()),
                    ("message", text("Invalid option: expected one of \"all\"|\"file\"|\"directory\"")),
                ],
                "type",
            ));
            None
        }
    };
    let refresh = match &fields[4] {
        None => None,
        Some(Field::One(v)) => Some(v == "true"),
        Some(Field::Many(_)) => {
            issues.push(expected_string("refresh", "array"));
            None
        }
    };
    if !issues.is_empty() {
        return Err(format!("[\n{}\n]", issues.join(",\n")));
    }
    Ok(Query { directory, q: q.unwrap_or_default(), limit, kind, refresh })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn matches_fastify_and_zod() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/search-query-cases.json");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 100);
        for case in cases {
            let raw = case["query"].as_str().unwrap();
            match parse(Some(raw)) {
                Ok(q) => {
                    let mut got = json!({"q": q.q});
                    if let Some(d) = q.directory {
                        got["directory"] = json!(d)
                    }
                    if let Some(l) = q.limit {
                        got["limit"] = json!(l)
                    }
                    if let Some(k) = q.kind {
                        got["type"] = json!(k)
                    }
                    if let Some(r) = q.refresh {
                        got["refresh"] = json!(r)
                    }
                    assert_eq!(Some(&got), case.get("ok"), "{raw:?}");
                }
                Err(message) => {
                    assert_eq!(Some(message.as_str()), case["error"].as_str(), "{raw:?}")
                }
            }
        }
    }
}
