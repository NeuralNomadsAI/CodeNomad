//! `config/location.ts` and `settings/yaml-doc-store.ts`: where the settings live, authoritative
//! YAML reads, atomic writes through settings links, merge patches and the stable server identity.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{Map, Value};
use uuid::Uuid;

pub type Doc = Map<String, Value>;

/// The settings document could not be read authoritatively (missing is empty, not unreadable).
#[derive(Debug, PartialEq)]
pub struct Unreadable;

pub struct Location {
    pub base: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub instances: PathBuf,
}

impl Location {
    /// `resolveConfigLocation`: a folder, a YAML file or a legacy JSON file (`~/` is the home folder).
    pub fn resolve(raw: &str) -> Location {
        let input = match raw.trim() {
            "" => "~/.config/codenomad/config.json",
            input => input,
        };
        let path = match input.strip_prefix("~/") {
            Some(rest) => home().join(rest),
            None => std::path::absolute(input).unwrap_or_else(|_| input.into()),
        };
        let lower = path.to_string_lossy().to_lowercase();
        let parent = || path.parent().unwrap_or(&path).to_path_buf();
        let (base, config) = if lower.ends_with(".yaml") || lower.ends_with(".yml") {
            (parent(), path.clone())
        } else if lower.ends_with(".json") {
            (parent(), parent().join("config.yaml"))
        } else {
            (path.clone(), path.join("config.yaml"))
        };
        Location { state: base.join("state.yaml"), instances: base.join("instances"), base, config }
    }
}

/// Node's `os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere.
pub fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// `readAuthoritative`: only an actually missing path is empty; anything unreadable or not a
/// mapping (a dangling link, a folder, invalid YAML, an empty file) is refused.
pub fn read(file: &Path) -> Result<Doc, Unreadable> {
    read_with_history_order(file).map(|(doc, _)| doc)
}

/// Quotes unquoted YAML 1.1 binary integer scalars (`[+-]?0b[01]+`) in plain-scalar positions and
/// escapes literal YAML 1.1 Unicode line breaks (U+0085, U+2028, U+2029) inside double-quoted
/// scalars so `serde_norway` matches the TypeScript YAML 1.2 core schema parser.
fn quote_yaml11_binary_scalars(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.as_bytes().windows(2).any(|w| w == b"0b" || w == b"0B")
        && !text.contains(['\u{0085}', '\u{2028}', '\u{2029}'])
    {
        return std::borrow::Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let mut line_start = true;
    let mut line_indent = 0usize;
    let mut flow_depth = 0usize;
    let mut block_indent: Option<usize> = None;
    let mut plain_scalar_indent: Option<usize> = None;
    let mut pending_value_indent: Option<usize> = None;
    let mut can_start_scalar = true;
    while i < bytes.len() {
        if line_start {
            let start = i;
            while i < bytes.len() && bytes[i] == b' ' {
                i += 1;
            }
            let indent = i - start;
            let mut ws = i;
            while ws < bytes.len() && matches!(bytes[ws], b' ' | b'\t') {
                ws += 1;
            }
            let is_blank = ws >= bytes.len() || matches!(bytes[ws], b'\n' | b'\r');
            if let Some(bi) = block_indent {
                if is_blank || indent > bi {
                    while i < bytes.len() && bytes[i] != b'\n' {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    }
                    out.push_str(&text[start..i]);
                    continue;
                }
                block_indent = None;
            }
            line_indent = indent;
            out.push_str(&text[start..i]);
            line_start = false;
            if flow_depth == 0 {
                if let Some(pi) = plain_scalar_indent {
                    if is_blank || (indent > pi && bytes[i] != b'#') {
                        can_start_scalar = false;
                    } else {
                        plain_scalar_indent = None;
                        can_start_scalar = true;
                    }
                } else {
                    can_start_scalar = true;
                }
                if !is_blank && pending_value_indent.is_some_and(|pvi| indent <= pvi) {
                    pending_value_indent = None;
                }
            }
            if i >= bytes.len() {
                break;
            }
        }
        let b = bytes[i];
        if b == b'\n' {
            out.push('\n');
            i += 1;
            line_start = true;
            continue;
        }
        if b == b'\r' {
            out.push('\r');
            i += 1;
            continue;
        }
        if b == b'#' && (i == 0 || matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r')) {
            let start = i;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            out.push_str(&text[start..i]);
            continue;
        }
        if can_start_scalar && b == b'"' {
            out.push('"');
            i += 1;
            let mut seg_start = i;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if bytes[i] == 0xC2 && bytes.get(i + 1) == Some(&0x85) {
                    out.push_str(&text[seg_start..i]);
                    out.push_str("\\u0085");
                    i += 2;
                    seg_start = i;
                    continue;
                }
                if bytes[i] == 0xE2 && bytes.get(i + 1) == Some(&0x80) && matches!(bytes.get(i + 2), Some(0xA8 | 0xA9))
                {
                    out.push_str(&text[seg_start..i]);
                    out.push_str(if bytes[i + 2] == 0xA8 { "\\u2028" } else { "\\u2029" });
                    i += 3;
                    seg_start = i;
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\n' {
                    line_start = true;
                }
                i += 1;
            }
            out.push_str(&text[seg_start..i]);
            plain_scalar_indent = None;
            pending_value_indent = None;
            can_start_scalar = false;
            continue;
        }
        if can_start_scalar && b == b'\'' {
            let start = i;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\'' {
                    if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                if bytes[i] == b'\n' {
                    line_start = true;
                }
                i += 1;
            }
            out.push_str(&text[start..i]);
            plain_scalar_indent = None;
            pending_value_indent = None;
            can_start_scalar = false;
            continue;
        }
        if flow_depth == 0 && can_start_scalar && (b == b'|' || b == b'>') {
            let start = i;
            let mut j = i + 1;
            while j < bytes.len() && matches!(bytes[j], b'+' | b'-' | b'1'..=b'9') {
                j += 1;
            }
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t') {
                j += 1;
            }
            if j >= bytes.len() || matches!(bytes[j], b'\n' | b'\r' | b'#') {
                while j < bytes.len() && bytes[j] != b'\n' {
                    j += 1;
                }
                if j < bytes.len() {
                    j += 1;
                    line_start = true;
                }
                out.push_str(&text[start..j]);
                i = j;
                block_indent = Some(pending_value_indent.take().unwrap_or(line_indent));
                plain_scalar_indent = None;
                continue;
            }
        }
        if can_start_scalar {
            let mut j = i;
            if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
                j += 1;
            }
            if j + 2 < bytes.len() && bytes[j] == b'0' && (bytes[j + 1] == b'b' || bytes[j + 1] == b'B') {
                let mut k = j + 2;
                while k < bytes.len() && (bytes[k] == b'0' || bytes[k] == b'1') {
                    k += 1;
                }
                if k > j + 2 {
                    let mut after = k;
                    while after < bytes.len() && matches!(bytes[after], b' ' | b'\t') {
                        after += 1;
                    }
                    let is_key_colon = bytes.get(k) == Some(&b':')
                        && bytes.get(k + 1).is_none_or(|c| {
                            matches!(c, b' ' | b'\t' | b'\r' | b'\n')
                                || (flow_depth > 0 && matches!(c, b',' | b']' | b'}'))
                        });
                    let should_quote = if flow_depth > 0 {
                        let mut f = after;
                        loop {
                            while f < bytes.len() && matches!(bytes[f], b' ' | b'\t' | b'\r' | b'\n') {
                                f += 1;
                            }
                            if f < bytes.len()
                                && bytes[f] == b'#'
                                && (f == 0 || matches!(bytes[f - 1], b' ' | b'\t' | b'\r' | b'\n'))
                            {
                                while f < bytes.len() && bytes[f] != b'\n' {
                                    f += 1;
                                }
                                continue;
                            }
                            break;
                        }
                        let is_flow_end = f >= bytes.len()
                            || matches!(bytes[f], b',' | b']' | b'}')
                            || (bytes[f] == b':'
                                && bytes
                                    .get(f + 1)
                                    .is_none_or(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}')));
                        is_key_colon || is_flow_end
                    } else {
                        let is_line_end = after >= bytes.len()
                            || matches!(bytes[after], b'\r' | b'\n')
                            || (bytes[after] == b'#' && after > k);
                        let mut continues_next_line = false;
                        if !is_key_colon && after < bytes.len() && matches!(bytes[after], b'\r' | b'\n') {
                            let mut nl = after;
                            loop {
                                while nl < bytes.len() && matches!(bytes[nl], b'\r' | b'\n') {
                                    nl += 1;
                                }
                                let mut next_indent = 0;
                                while nl + next_indent < bytes.len() && bytes[nl + next_indent] == b' ' {
                                    next_indent += 1;
                                }
                                let mut ws = nl + next_indent;
                                while ws < bytes.len() && matches!(bytes[ws], b' ' | b'\t') {
                                    ws += 1;
                                }
                                if ws < bytes.len() && matches!(bytes[ws], b'\r' | b'\n') {
                                    nl = ws;
                                    continue;
                                }
                                let parent_indent = pending_value_indent.unwrap_or(line_indent);
                                if next_indent > parent_indent && bytes.get(ws).is_some_and(|c| *c != b'#') {
                                    continues_next_line = true;
                                }
                                break;
                            }
                        }
                        (is_key_colon || is_line_end) && !continues_next_line
                    };
                    if should_quote {
                        out.push('"');
                        out.push_str(&text[i..k]);
                        out.push('"');
                        i = k;
                        plain_scalar_indent = None;
                        pending_value_indent = None;
                        can_start_scalar = false;
                        continue;
                    }
                }
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
        match ch {
            '[' | '{' if can_start_scalar || flow_depth > 0 => {
                flow_depth += 1;
                plain_scalar_indent = None;
                pending_value_indent = None;
                can_start_scalar = true;
            }
            ']' | '}' if flow_depth > 0 => {
                flow_depth -= 1;
                can_start_scalar = false;
            }
            ',' => {
                can_start_scalar = flow_depth > 0;
            }
            ':' => {
                if bytes.get(i).is_none_or(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')) {
                    can_start_scalar = true;
                    plain_scalar_indent = None;
                    if flow_depth == 0 {
                        pending_value_indent = Some(line_indent);
                    }
                } else {
                    if flow_depth == 0 && can_start_scalar {
                        plain_scalar_indent = Some(pending_value_indent.take().unwrap_or(line_indent));
                    }
                    can_start_scalar = false;
                }
            }
            '-' | '?' if can_start_scalar => {
                if bytes.get(i).is_none_or(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')) {
                    can_start_scalar = true;
                    plain_scalar_indent = None;
                    if flow_depth == 0 {
                        pending_value_indent = Some(line_indent);
                    }
                } else {
                    if flow_depth == 0 {
                        plain_scalar_indent = Some(pending_value_indent.take().unwrap_or(line_indent));
                    }
                    can_start_scalar = false;
                }
            }
            ' ' | '\t' => {}
            _ => {
                if flow_depth == 0 && can_start_scalar {
                    plain_scalar_indent = Some(pending_value_indent.take().unwrap_or(line_indent));
                }
                can_start_scalar = false;
            }
        }
    }
    std::borrow::Cow::Owned(out)
}

/// ECMAScript `Number::toString` for YAML numeric mapping keys (`1e-7` stays `"1e-7"`, `1e21` -> `"1e+21"`, `-0.0` -> `"0"`).
fn js_f64_key(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_owned();
    }
    if v.is_infinite() {
        return if v.is_sign_negative() { "-Infinity" } else { "Infinity" }.to_owned();
    }
    if v == 0.0 {
        return "0".to_owned();
    }
    let abs = v.abs();
    let sci = format!("{abs:e}");
    if let Some((mantissa, exp_str)) = sci.split_once('e')
        && let Ok(exp) = exp_str.parse::<i32>()
    {
        let sign = if v.is_sign_negative() { "-" } else { "" };
        if exp <= -7 {
            return format!("{sign}{mantissa}e{exp}");
        }
        if exp >= 21 {
            return format!("{sign}{mantissa}e+{exp}");
        }
    }
    v.to_string()
}

/// Reads the YAML document once and also extracts `ui.remoteProjectHistory` mapping key order
/// from that exact same snapshot so concurrent writes cannot tear data and key order.
pub fn read_with_history_order(file: &Path) -> Result<(Doc, Vec<String>), Unreadable> {
    use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                && fs::symlink_metadata(file).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) =>
        {
            return Ok((Doc::new(), Vec::new()));
        }
        Err(_) => return Err(Unreadable),
    };
    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    enum KeyKind {
        Str,
        Bool,
        Num,
        Null,
    }
    struct StrictKey;
    impl<'de> Visitor<'de> for StrictKey {
        type Value = (KeyKind, String);
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a YAML scalar mapping key")
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Str, v.to_owned()))
        }
        fn visit_string<E: de::Error>(self, v: String) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Str, v))
        }
        fn visit_bool<E: de::Error>(self, v: bool) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Bool, v.to_string()))
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Num, js_f64_key(v as f64)))
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Num, js_f64_key(v as f64)))
        }
        fn visit_i128<E: de::Error>(self, v: i128) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Num, js_f64_key(v as f64)))
        }
        fn visit_u128<E: de::Error>(self, v: u128) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Num, js_f64_key(v as f64)))
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Num, js_f64_key(v)))
        }
        fn visit_unit<E: de::Error>(self) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Null, "null".to_owned()))
        }
        fn visit_none<E: de::Error>(self) -> Result<(KeyKind, String), E> {
            Ok((KeyKind::Null, "null".to_owned()))
        }
        fn visit_some<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(KeyKind, String), D::Error> {
            deserializer.deserialize_any(self)
        }
    }
    struct KeySeed;
    impl<'de> DeserializeSeed<'de> for KeySeed {
        type Value = (KeyKind, String);
        fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(KeyKind, String), D::Error> {
            deserializer.deserialize_any(StrictKey)
        }
    }
    struct YamlJsonSeed<'a> {
        depth: u8,
        history_order: &'a mut Vec<String>,
    }
    impl<'de> DeserializeSeed<'de> for YamlJsonSeed<'_> {
        type Value = Value;
        fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
            deserializer.deserialize_any(self)
        }
    }
    impl<'de> Visitor<'de> for YamlJsonSeed<'_> {
        type Value = Value;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("any valid YAML value")
        }
        fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_none<E: de::Error>(self) -> Result<Value, E> {
            Ok(Value::Null)
        }
        fn visit_some<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
            deserializer.deserialize_any(self)
        }
        fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
            Ok(Value::Bool(v))
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
            Ok(Value::Number(v.into()))
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
            Ok(Value::Number(v.into()))
        }
        fn visit_i128<E: de::Error>(self, v: i128) -> Result<Value, E> {
            serde_json::Number::from_f64(v as f64)
                .map(Value::Number)
                .ok_or_else(|| de::Error::custom("non-finite integer"))
        }
        fn visit_u128<E: de::Error>(self, v: u128) -> Result<Value, E> {
            serde_json::Number::from_f64(v as f64)
                .map(Value::Number)
                .ok_or_else(|| de::Error::custom("non-finite integer"))
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
            Ok(serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number))
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
            Ok(Value::String(v.to_owned()))
        }
        fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
            Ok(Value::String(v))
        }
        fn visit_enum<A: de::EnumAccess<'de>>(self, data: A) -> Result<Value, A::Error> {
            use de::VariantAccess;
            let (_, variant) = data.variant::<de::IgnoredAny>()?;
            variant.newtype_variant_seed(self)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
            let mut items = Vec::new();
            while let Some(item) =
                seq.next_element_seed(YamlJsonSeed { depth: 3, history_order: self.history_order })?
            {
                items.push(item);
            }
            Ok(Value::Array(items))
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
            let mut out = Map::new();
            let mut seen_keys = std::collections::HashSet::new();
            while let Some((kind, key)) = map.next_key_seed(KeySeed)? {
                if !seen_keys.insert((kind, key.clone())) {
                    return Err(de::Error::custom("duplicate key"));
                }
                let child_depth = match (self.depth, key.as_str()) {
                    (0, "ui") => 1,
                    (1, "remoteProjectHistory") => 2,
                    _ => 3,
                };
                if self.depth == 2 && !out.contains_key(&key) {
                    self.history_order.push(key.clone());
                }
                let value =
                    map.next_value_seed(YamlJsonSeed { depth: child_depth, history_order: self.history_order })?;
                out.insert(key, value);
            }
            Ok(Value::Object(out))
        }
    }
    let normalized = quote_yaml11_binary_scalars(&text);
    let mut history_order = Vec::new();
    let deserializer = serde_norway::Deserializer::from_str(&normalized);
    // Reject multi-document streams and non-mapping roots; allow u128/i128 YAML integers as JS f64.
    let seed = YamlJsonSeed { depth: 0, history_order: &mut history_order };
    match seed.deserialize(deserializer) {
        Ok(Value::Object(doc)) => Ok((doc, history_order)),
        _ => Err(Unreadable),
    }
}

/// `resolveWriteDestination`: a settings link is written through to its final target.
pub fn destination(file: &Path) -> io::Result<PathBuf> {
    let mut current = std::path::absolute(file)?;
    let mut seen = Vec::new();
    loop {
        match fs::symlink_metadata(&current) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(current),
            Err(e) => return Err(e),
            Ok(meta) if !meta.file_type().is_symlink() => return Ok(current),
            Ok(_) if seen.contains(&current) => return Err(io::Error::other("Circular settings symlink")),
            Ok(_) => {
                let target = fs::read_link(&current)?;
                seen.push(current.clone());
                current = std::path::absolute(current.parent().unwrap_or(Path::new("")).join(target))?;
            }
        }
    }
}

type Yaml = serde_norway::Value;

/// `value` as YAML whose mappings keep the key order of `template` (the document on disk), new keys
/// after the known ones, as the reference's merge into its parsed object does. `Doc` itself is
/// sorted: ordering stays local to writes, without `serde_json/preserve_order` for the whole crate.
fn ordered(template: Option<&Yaml>, value: &Value, history_order: Option<&[String]>, depth: u8) -> Yaml {
    match value {
        Value::Object(map) => {
            let old = template.and_then(Yaml::as_mapping);
            let mut keys: Vec<&str> = Vec::with_capacity(map.len());
            if depth == 2
                && let Some(order) = history_order
            {
                let mut seen = std::collections::HashSet::with_capacity(order.len());
                for key in order {
                    if map.contains_key(key.as_str()) && seen.insert(key.as_str()) {
                        keys.push(key.as_str());
                    }
                }
                for key in map.keys() {
                    if seen.insert(key.as_str()) {
                        keys.push(key.as_str());
                    }
                }
            } else {
                keys.extend(
                    old.into_iter().flat_map(|m| m.keys()).filter_map(Yaml::as_str).filter(|k| map.contains_key(*k)),
                );
                keys.extend(map.keys().map(String::as_str).filter(|k| !old.is_some_and(|m| m.contains_key(*k))));
            }
            let child = |key: &str| {
                let child_order = match (depth, key) {
                    (0, "ui") | (1, "remoteProjectHistory") => history_order,
                    _ => None,
                };
                ordered(old.and_then(|m| m.get(key)), &map[key], child_order, depth.saturating_add(1))
            };
            Yaml::Mapping(keys.into_iter().map(|key| (Yaml::from(key), child(key))).collect())
        }
        Value::Array(items) => {
            let old = template.and_then(Yaml::as_sequence);
            Yaml::Sequence(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| ordered(old.and_then(|s| s.get(i)), item, None, depth.saturating_add(1)))
                    .collect(),
            )
        }
        scalar => serde_norway::to_value(scalar).unwrap_or(Yaml::Null),
    }
}

/// `persist`: a temporary file beside the target (the target's mode, else private), then a rename.
pub fn write(file: &Path, doc: &Doc) -> io::Result<()> {
    write_with_history_order(file, doc, None)
}

pub fn write_with_history_order(file: &Path, doc: &Doc, history_order: Option<&[String]>) -> io::Result<()> {
    write_with_history_order_checked(file, doc, history_order, || Ok(()))
}

pub fn write_with_history_order_checked(
    file: &Path,
    doc: &Doc,
    history_order: Option<&[String]>,
    before_rename: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let target = destination(file)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let template = fs::read_to_string(&target)
        .ok()
        .and_then(|text| serde_norway::from_str::<Yaml>(&quote_yaml11_binary_scalars(&text)).ok());
    let doc = ordered(template.as_ref(), &Value::Object(doc.clone()), history_order, 0);
    let mut text = serde_norway::to_string(&doc).map_err(io::Error::other)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let temp = PathBuf::from(format!("{}.{}.{}.tmp", target.display(), std::process::id(), Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = fs::metadata(&target).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600);
            options.mode(mode);
            let mut handle = options.open(&temp)?;
            fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
        }
        #[cfg(not(unix))]
        {
            let mut handle = options.open(&temp)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
        }
        before_rename()?;
        fs::rename(&temp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `applyMergePatch`: objects merge recursively, `null` deletes, anything else replaces
/// (an object replacing a non-object is kept as sent, nested `null`s included).
pub fn merge(current: &Value, patch: &Value) -> Value {
    let Value::Object(patch) = patch else { return patch.clone() };
    let mut base = current.as_object().cloned().unwrap_or_default();
    for (key, value) in patch {
        match (value, base.get(key)) {
            (Value::Null, _) => {
                base.remove(key);
            }
            (Value::Object(_), Some(existing @ Value::Object(_))) => {
                let merged = merge(existing, value);
                base.insert(key.clone(), merged);
            }
            _ => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(base)
}

/// `normalizeDoc`: anything but a mapping is an empty owner.
pub fn owner(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `claimServerIdentity`: one persistent UUID elected through `<config>.server-id`, created
/// exclusively; a writer still publishing its claim is awaited for one second.
pub fn claim_identity(config: &Path) -> io::Result<Uuid> {
    let file = PathBuf::from(format!("{}.server-id", destination(config)?.display()));
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(&file) {
        Ok(mut handle) => handle.write_all(Uuid::new_v4().to_string().as_bytes())?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Ok(id) = Uuid::try_parse(fs::read_to_string(&file)?.trim()) {
            return Ok(id);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("Incomplete or invalid server identity file; explicit repair required"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn locations_follow_the_reference() {
        let dir = crate::shared::test_dir("settings-location");
        let yaml = Location::resolve(dir.join("custom.yml").to_str().unwrap());
        assert_eq!((yaml.config, yaml.state), (dir.join("custom.yml"), dir.join("state.yaml")));
        let json = Location::resolve(dir.join("config.json").to_str().unwrap());
        assert_eq!((json.base.clone(), json.config), (dir.clone(), dir.join("config.yaml")));
        assert_eq!(json.instances, dir.join("instances"));
        let folder = Location::resolve(&format!(" {} ", dir.display()));
        assert_eq!(folder.config, dir.join("config.yaml"));
        assert_eq!(Location::resolve("").base, home().join(".config/codenomad"));
        let bin_file = dir.join("binary-scalar.yaml");
        let folded_val = format!("{} 0b101", "x".repeat(75));
        fs::write(
            &bin_file,
            format!(
                "server:\n  environmentVariables:\n    TOKEN: 0b101\n    BRACKET: prefix[0b101]\n    PATH: /srv/backup[0b101]\n    APOS: it's fine\n    AFTER: 0b11\n    FLOW: [foo\n      0b101, 0b101]\n    FLOW_MAP: {{ CODE: 0b10\n      suffix }}\n    NEL: \"alpha\u{0085}beta\"\n    FOLDED: {}\n      0b101\n    NEXT: 0b10\n",
                "x".repeat(75)
            ),
        )
        .unwrap();
        let bin_doc = read(&bin_file).unwrap();
        assert_eq!(bin_doc["server"]["environmentVariables"]["TOKEN"], json!("0b101"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["BRACKET"], json!("prefix[0b101]"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["PATH"], json!("/srv/backup[0b101]"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["APOS"], json!("it's fine"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["AFTER"], json!("0b11"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["FLOW"], json!(["foo 0b101", "0b101"]));
        assert_eq!(bin_doc["server"]["environmentVariables"]["FLOW_MAP"], json!({"CODE": "0b10 suffix"}));
        assert_eq!(bin_doc["server"]["environmentVariables"]["NEL"], json!("alpha\u{0085}beta"));
        assert_eq!(bin_doc["server"]["environmentVariables"]["FOLDED"], json!(folded_val));
        assert_eq!(bin_doc["server"]["environmentVariables"]["NEXT"], json!("0b10"));
        write(&bin_file, &bin_doc).unwrap();
        let reloaded = read(&bin_file).unwrap();
        assert_eq!(reloaded["server"]["environmentVariables"]["TOKEN"], json!("0b101"));
        assert_eq!(reloaded["server"]["environmentVariables"]["BRACKET"], json!("prefix[0b101]"));
        assert_eq!(reloaded["server"]["environmentVariables"]["PATH"], json!("/srv/backup[0b101]"));
        assert_eq!(reloaded["server"]["environmentVariables"]["FLOW_MAP"], json!({"CODE": "0b10 suffix"}));
        assert_eq!(reloaded["server"]["environmentVariables"]["NEL"], json!("alpha\u{0085}beta"));
        assert_eq!(reloaded["server"]["environmentVariables"]["FOLDED"], json!(folded_val));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_patch_matches_apply_merge_patch() {
        let current = json!({"a": {"b": 1, "c": 2}, "d": [1], "e": "x"});
        let patch = json!({"a": {"b": null, "n": {"z": null}}, "d": {"k": null}, "e": null, "f": {"g": null}});
        assert_eq!(
            merge(&current, &patch),
            json!({"a": {"c": 2, "n": {"z": null}}, "d": {"k": null}, "f": {"g": null}})
        );
        assert_eq!(merge(&current, &json!([1])), json!([1]));
        assert_eq!(merge(&json!("scalar"), &json!({"a": 1})), json!({"a": 1}));
    }

    #[test]
    fn documents_round_trip_and_refuse_unreadable_files() {
        let dir = crate::shared::test_dir("settings-doc");
        let file = dir.join("config.yaml");
        assert_eq!(read(&file), Ok(Doc::new()));
        let doc = json!({"ui": {"settings": {"locale": "fr", "flag": true, "n": 1.5, "list": ["a", "1", "true", ""]}},
            "server": {"serverId": "7c0b9a4e-3a37-4e9b-9d33-2f6f3f8b6c11", "text": "two\nlines"}});
        write(&file, doc.as_object().unwrap()).unwrap();
        assert_eq!(Value::Object(read(&file).unwrap()), doc);
        // The YAML of the reference (`yaml` 2) reads the same way.
        fs::write(
            &file,
            "ui:\n  settings:\n    locale: en\n    count: 3\n    empty: null\n    note: |-\n      a\n      b\n",
        )
        .unwrap();
        assert_eq!(
            Value::Object(read(&file).unwrap()),
            json!({"ui": {"settings": {"locale": "en", "count": 3, "empty": null, "note": "a\nb"}}})
        );
        for broken in ["", "- a\n", "a: [\n", "a: 1\na: 2\n"] {
            fs::write(&file, broken).unwrap();
            assert_eq!(read(&file), Err(Unreadable), "{broken:?}");
        }
        assert_eq!(read(&dir), Err(Unreadable));
        let _ = fs::remove_dir_all(dir);
    }

    /// The reference merges into the object it parsed: known keys stay in place, new ones come last.
    #[test]
    fn writes_keep_the_order_on_disk() {
        let dir = crate::shared::test_dir("settings-order");
        let file = dir.join("config.yaml");
        fs::write(&file, "ui:\n  zeta: 1\n  alpha: 2\nserver:\n  sidecars:\n    - port: 1\n      id: a\n  b: x\n")
            .unwrap();
        let current = Value::Object(read(&file).unwrap());
        let patch = json!({"server": {"memoryEnabled": true, "sidecars": [{"port": 2, "id": "a", "name": "n"}]},
            "ui": {"alpha": 3}, "added": {}});
        write(&file, merge(&current, &patch).as_object().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "ui:\n  zeta: 1\n  alpha: 3\nserver:\n  sidecars:\n  - port: 2\n    id: a\n    name: n\n  b: x\n  memoryEnabled: true\nadded: {}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn identity_is_claimed_once() {
        let dir = crate::shared::test_dir("settings-identity");
        let config = dir.join("config.yaml");
        let first = claim_identity(&config).unwrap();
        assert_eq!(claim_identity(&config).unwrap(), first);
        fs::write(dir.join("config.yaml.server-id"), "not a uuid").unwrap();
        assert!(claim_identity(&config).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
