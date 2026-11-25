//! Strict payload parsing, validation and key-order-preserving serialization for plugin provider usage.
use std::collections::HashMap;

use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{MapAccess, Visitor},
};
use serde_json::{Value, json, value::RawValue};

use super::super::shared::Fields;
use crate::shared::{js_trim, now_ms};

pub(super) const RPC_PREFIX: &str = "provider-usage.";
pub(super) const MAX_WINDOWS: usize = 16;
const MAX_EPOCH_MS: f64 = 8_640_000_000_000_000.0;

const FORBIDDEN_KEYS: &[&str] = &[
    "__proto__",
    "prototype",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "toLocaleString",
];

/// JSON object preserving first-seen key order and last-value-wins semantics in O(n) time while
/// leaving uninspected values raw (so overflowing numbers like `1e400` in ignored fields stay valid JSON).
pub(super) struct RawObject {
    pub(super) entries: Vec<(String, Box<RawValue>)>,
    index: HashMap<String, usize>,
}

impl RawObject {
    pub(super) fn get(&self, key: &str) -> Option<&RawValue> {
        self.index.get(key).map(|&pos| self.entries[pos].1.as_ref())
    }
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }
}

impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RawObjectVisitor;
        impl<'de> Visitor<'de> for RawObjectVisitor {
            type Value = RawObject;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries: Vec<(String, Box<RawValue>)> = Vec::new();
                let mut index: HashMap<String, usize> = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if let Some(&pos) = index.get(&key) {
                        entries[pos].1 = value;
                    } else {
                        let pos = entries.len();
                        index.insert(key.clone(), pos);
                        entries.push((key, value));
                    }
                }
                Ok(RawObject { entries, index })
            }
        }
        deserializer.deserialize_map(RawObjectVisitor)
    }
}

pub(super) fn parse_raw_object(raw: &str) -> Option<RawObject> {
    serde_json::from_str::<RawObject>(raw).ok()
}

pub(super) fn parse_raw_string(raw: &RawValue) -> Option<String> {
    serde_json::from_str::<String>(raw.get()).ok()
}

pub(in crate::provider_usage) fn rpc_id(provider_id: &str) -> Option<String> {
    let id = js_trim(provider_id);
    if id.is_empty()
        || id.len() > 100
        || id.contains("..")
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(format!("{RPC_PREFIX}{id}"))
}

fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| matches!(c as u32, 0x00..=0x1f | 0x7f..=0x9f))
}

fn display_text_str(raw: &str, max_utf16: usize) -> Option<String> {
    if has_control_chars(raw) {
        return None;
    }
    let trimmed = js_trim(raw);
    let len = trimmed.encode_utf16().count();
    (1..=max_utf16).contains(&len).then(|| trimmed.to_owned())
}

fn display_text(value: &Value, max_utf16: usize) -> Option<String> {
    display_text_str(value.as_str()?, max_utf16)
}

fn is_forbidden_window_key(label: &str) -> bool {
    if FORBIDDEN_KEYS.contains(&label) {
        return true;
    }
    label.split_once(':').is_some_and(|(base, _)| !base.is_empty() && FORBIDDEN_KEYS.contains(&base))
}

fn is_canonical_window_key(value: &str) -> bool {
    let len = value.encode_utf16().count();
    if !(1..=64).contains(&len) || js_trim(value) != value || has_control_chars(value) || is_forbidden_window_key(value)
    {
        return false;
    }
    match value.split_once(':') {
        None => true,
        Some((base, detail)) => {
            !base.is_empty() && !detail.is_empty() && js_trim(base) == base && js_trim(detail) == detail
        }
    }
}

fn finite_num(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn epoch_ms(value: &Value) -> Option<f64> {
    finite_num(value).filter(|&n| n > 0.0 && n <= MAX_EPOCH_MS)
}

fn normalize_number(value: &Value, n: f64) -> Value {
    if n == 0.0 { json!(0) } else { value.clone() }
}

/// Parse the shortest round-trip decimal string directly so neither binary scaling (`1.005 * 100`)
/// nor intermediate rounding (`99.9949999`) alters hundredths or complement cutoffs.
pub(super) fn to_hundredths(value: f64) -> i64 {
    if value == 0.0 {
        return 0;
    }
    let formatted = format!("{value:e}");
    let (mantissa, exp_part) = formatted.split_once('e').expect("scientific notation contains 'e'");
    let digits: String = mantissa.chars().filter(|&c| c != '.').collect();
    let exp: i32 = exp_part.parse().expect("valid scientific exponent");
    let point = exp + 3;
    if point <= 0 {
        return if point == 0 && digits.as_bytes()[0] >= b'5' { 1 } else { 0 };
    }
    let point = point as usize;
    let mut padded = digits;
    while padded.len() < point {
        padded.push('0');
    }
    let whole: i64 = padded[..point].parse().expect("valid hundredths digits");
    if padded.as_bytes().get(point).copied().unwrap_or(b'0') >= b'5' { whole + 1 } else { whole }
}

fn hundredths_json(hundredths: i64) -> Value {
    if hundredths % 100 == 0 { json!(hundredths / 100) } else { json!(hundredths as f64 / 100.0) }
}

fn parse_window(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "usedPercent"
                | "remainingPercent"
                | "windowSeconds"
                | "resetAt"
                | "valueLabel"
                | "balanceUSD"
                | "limitUSD"
                | "consumption"
        ) {
            return None;
        }
    }
    let used_h = match obj.get("usedPercent") {
        None | Some(Value::Null) => None,
        Some(v) => Some(to_hundredths(finite_num(v).filter(|n| (0.0..=100.0).contains(n))?)),
    };
    let rem_h = match obj.get("remainingPercent") {
        None | Some(Value::Null) => None,
        Some(v) => Some(to_hundredths(finite_num(v).filter(|n| (0.0..=100.0).contains(n))?)),
    };
    if let (Some(u), Some(r)) = (used_h, rem_h)
        && (u + r - 10_000).abs() > 5
    {
        return None;
    }
    let window_seconds = match obj.get("windowSeconds") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => {
            let n = finite_num(v).filter(|&n| n >= 0.0)?;
            normalize_number(v, n)
        }
    };
    let reset_at = match obj.get("resetAt") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => {
            let n = epoch_ms(v)?;
            normalize_number(v, n)
        }
    };
    let value_label = match obj.get("valueLabel") {
        None => None,
        Some(v) => Some(display_text(v, 128)?),
    };
    let balance_usd = match obj.get("balanceUSD") {
        None => None,
        Some(v) => {
            let b = v.as_object()?;
            if b.keys().any(|k| !matches!(k.as_str(), "remaining" | "total")) {
                return None;
            }
            let rem_val = b.get("remaining")?;
            let rem_num = finite_num(rem_val)?;
            let mut clean = Fields::new();
            clean.insert("remaining".into(), normalize_number(rem_val, rem_num));
            if let Some(total_val) = b.get("total") {
                let total_num = finite_num(total_val).filter(|&n| n >= 0.0)?;
                clean.insert("total".into(), normalize_number(total_val, total_num));
            }
            Some(Value::Object(clean))
        }
    };
    let limit_usd = match obj.get("limitUSD") {
        None => None,
        Some(v) => {
            let n = finite_num(v).filter(|&n| n >= 0.0)?;
            Some(normalize_number(v, n))
        }
    };
    let (consumption, is_unlimited) = match obj.get("consumption") {
        None => (None, false),
        Some(v) => {
            let c = v.as_object()?;
            if c.len() == 1 && c.get("unlimited") == Some(&Value::Bool(true)) {
                (Some(json!({ "unlimited": true })), true)
            } else if c.len() == 1
                && let Some(cu_val) = c.get("creditsUsed")
            {
                let cu_num = finite_num(cu_val).filter(|&n| n >= 0.0)?;
                (Some(json!({ "creditsUsed": normalize_number(cu_val, cu_num) })), false)
            } else if c.contains_key("used") && c.keys().all(|k| matches!(k.as_str(), "used" | "limit")) {
                let used_val = c.get("used")?;
                let used_num = finite_num(used_val).filter(|&n| n >= 0.0)?;
                let mut clean = Fields::new();
                clean.insert("used".into(), normalize_number(used_val, used_num));
                if let Some(lim_val) = c.get("limit") {
                    let lim_num = finite_num(lim_val).filter(|&n| n >= 0.0)?;
                    clean.insert("limit".into(), normalize_number(lim_val, lim_num));
                }
                (Some(Value::Object(clean)), false)
            } else {
                return None;
            }
        }
    };
    if is_unlimited && (used_h.is_some() || rem_h.is_some()) {
        return None;
    }
    // The panel shows one value per window: consumption, limitUSD or balanceUSD.
    let display_count =
        usize::from(consumption.is_some()) + usize::from(limit_usd.is_some()) + usize::from(balance_usd.is_some());
    if display_count > 1 {
        return None;
    }
    let normalized_used = used_h.or_else(|| rem_h.map(|r| 10_000 - r));
    let mut out = Fields::new();
    out.insert("usedPercent".into(), normalized_used.map(hundredths_json).unwrap_or(Value::Null));
    out.insert("remainingPercent".into(), normalized_used.map(|u| hundredths_json(10_000 - u)).unwrap_or(Value::Null));
    out.insert("windowSeconds".into(), window_seconds);
    out.insert("resetAt".into(), reset_at);
    if let Some(label) = value_label {
        out.insert("valueLabel".into(), Value::String(label));
    }
    if let Some(balance) = balance_usd {
        out.insert("balanceUSD".into(), balance);
    }
    if let Some(limit) = limit_usd {
        out.insert("limitUSD".into(), limit);
    }
    if let Some(cons) = consumption {
        out.insert("consumption".into(), cons);
    }
    Some(Value::Object(out))
}

struct OrderedWindows<'a>(&'a [(String, Value)]);

impl Serialize for OrderedWindows<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(k, v)| (k.as_str(), v)))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginEnvelope<'a> {
    requested_provider_id: &'a str,
    provider_id: &'a str,
    provider_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<&'a str>,
    supported: bool,
    configured: bool,
    ok: bool,
    windows: OrderedWindows<'a>,
    fetched_at: Value,
}

pub(super) fn parse_output_raw(
    raw_json: &str,
    requested_provider_id: &str,
    provider_id: &str,
    model_id: Option<&str>,
    now: u64,
) -> Option<Box<RawValue>> {
    let obj = parse_raw_object(raw_json)?;
    let configured = serde_json::from_str::<bool>(obj.get("configured")?.get()).ok()?;
    let raw_ok = serde_json::from_str::<bool>(obj.get("ok")?.get()).ok()?;
    let provider_name = match obj.get("providerName") {
        None => None,
        Some(raw) => Some(display_text_str(&parse_raw_string(raw)?, 128)?),
    };
    let fetched_at = match obj.get("fetchedAt") {
        None => json!(now),
        Some(raw) => {
            let val: Value = serde_json::from_str(raw.get()).ok()?;
            let n = epoch_ms(&val)?;
            normalize_number(&val, n)
        }
    };
    let raw_windows = parse_raw_object(obj.get("windows")?.get())?;
    if raw_windows.len() > MAX_WINDOWS {
        return None;
    }
    // Validate every window even when `!ok || !configured` so malformed output is rejected.
    let mut parsed_windows = Vec::with_capacity(raw_windows.len());
    for (label, item_raw) in &raw_windows.entries {
        if !is_canonical_window_key(label) {
            return None;
        }
        let item_val: Value = serde_json::from_str(item_raw.get()).ok()?;
        let normalized = parse_window(&item_val)?;
        if raw_ok && configured {
            parsed_windows.push((label.clone(), normalized));
        }
    }
    // An unconfigured provider has no quota to show, whatever `ok` claims.
    let ok = raw_ok && configured;
    let empty: &[(String, Value)] = &[];
    let envelope = PluginEnvelope {
        requested_provider_id,
        provider_id,
        provider_name: provider_name.as_deref().unwrap_or(provider_id),
        model_id,
        supported: true,
        configured,
        ok,
        windows: OrderedWindows(if ok { &parsed_windows } else { empty }),
        fetched_at,
    };
    serde_json::value::to_raw_value(&envelope).ok()
}

pub(in crate::provider_usage) fn unavailable_raw(provider_id: &str, model_id: Option<&str>) -> Box<RawValue> {
    let envelope = PluginEnvelope {
        requested_provider_id: provider_id,
        provider_id,
        provider_name: provider_id,
        model_id,
        supported: true,
        configured: true,
        ok: false,
        windows: OrderedWindows(&[]),
        fetched_at: json!(now_ms()),
    };
    serde_json::value::to_raw_value(&envelope).expect("plugin unavailable envelope serializes")
}
