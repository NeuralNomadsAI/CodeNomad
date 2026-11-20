//! JSON values with JS semantics (`isDeepStrictEqual`, `Number#toString`, `JSON.stringify`) for the jsonc port.

use crate::subagent_depth::jsonc::{Text, string, utf16};

/// JSON value with JS semantics: f64 numbers, UTF-16 strings, ordered keys.
#[derive(Clone, Debug)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(Text),
    Arr(Vec<J>),
    Obj(Vec<(Text, J)>),
}
impl PartialEq for J {
    /// `util.isDeepStrictEqual` for JSON values: `Object.is` numbers, key order ignored.
    fn eq(&self, other: &J) -> bool {
        match (self, other) {
            (J::Null, J::Null) => true,
            (J::Bool(a), J::Bool(b)) => a == b,
            (J::Num(a), J::Num(b)) => {
                (a == b && a.is_sign_negative() == b.is_sign_negative()) || (a.is_nan() && b.is_nan())
            }
            (J::Str(a), J::Str(b)) => a == b,
            (J::Arr(a), J::Arr(b)) => a == b,
            (J::Obj(a), J::Obj(b)) => {
                a.len() == b.len() && a.iter().all(|(k, v)| b.iter().any(|(k2, v2)| k == k2 && v == v2))
            }
            _ => false,
        }
    }
}
impl J {
    pub fn obj(pairs: &[(&str, J)]) -> J {
        J::Obj(pairs.iter().map(|(k, v)| (utf16(k), v.clone())).collect())
    }
    pub fn s(v: &str) -> J {
        J::Str(utf16(v))
    }
    pub fn get(&self, key: &str) -> Option<&J> {
        let key = utf16(key);
        match self {
            J::Obj(p) => p.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn get_mut(&mut self, key: &[u16]) -> Option<&mut J> {
        match self {
            J::Obj(p) => p.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn keys(&self) -> Vec<String> {
        match self {
            J::Obj(p) => p.iter().map(|(k, _)| string(k)).collect(),
            _ => Vec::new(),
        }
    }
    pub fn is_obj(&self) -> bool {
        matches!(self, J::Obj(_))
    }
    /// JS object assignment: an existing key keeps its position.
    pub fn set(&mut self, key: Text, value: J) {
        if let J::Obj(p) = self {
            if key == utf16("__proto__") {
                return;
            }
            match p.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => p.push((key, value)),
            }
        }
    }
    pub fn from_json(v: &serde_json::Value) -> J {
        use serde_json::Value as V;
        match v {
            V::Null => J::Null,
            V::Bool(b) => J::Bool(*b),
            V::Number(n) => J::Num(n.as_f64().unwrap_or(f64::NAN)),
            V::String(s) => J::Str(utf16(s)),
            V::Array(a) => J::Arr(a.iter().map(J::from_json).collect()),
            V::Object(m) => J::Obj(m.iter().map(|(k, v)| (utf16(k), J::from_json(v))).collect()),
        }
    }
    /// A safe integer (`Number.isSafeInteger`).
    pub fn safe_integer(&self) -> Option<f64> {
        match self {
            J::Num(n) if n.fract() == 0.0 && n.abs() <= 9007199254740991.0 => Some(*n),
            _ => None,
        }
    }
}

pub fn quote(out: &mut Text, s: &[u16]) {
    out.push(34);
    for (i, &c) in s.iter().enumerate() {
        let lone = (0xd800..0xdc00).contains(&c) && !matches!(s.get(i + 1), Some(0xdc00..=0xdfff))
            || (0xdc00..0xe000).contains(&c) && !(i > 0 && (0xd800..0xdc00).contains(&s[i - 1]));
        match c {
            34 => out.extend(utf16("\\\"")),
            92 => out.extend(utf16("\\\\")),
            8 => out.extend(utf16("\\b")),
            12 => out.extend(utf16("\\f")),
            10 => out.extend(utf16("\\n")),
            13 => out.extend(utf16("\\r")),
            9 => out.extend(utf16("\\t")),
            c if c < 0x20 || lone => out.extend(utf16(&format!("\\u{c:04x}"))),
            c => out.push(c),
        }
    }
    out.push(34);
}
/// `Number.prototype.toString` for finite numbers.
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let point = exp.parse::<i32>().unwrap_or(0) + 1;
    let sign = if n < 0.0 { "-" } else { "" };
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let tail = if k > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits.clone() };
        format!("{tail}e{}{}", if e < 0 { "-" } else { "+" }, e.abs())
    };
    format!("{sign}{body}")
}
/// `JSON.stringify(value)` or, with `gap`, `JSON.stringify(value, null, gap)`.
pub fn stringify(value: &J, gap: Option<&[u16]>) -> Text {
    let gap = gap.map(|g| &g[..g.len().min(10)]).filter(|g| !g.is_empty());
    let mut out = Vec::new();
    write_value(&mut out, value, gap, &[]);
    out
}
fn write_value(out: &mut Text, value: &J, gap: Option<&[u16]>, indent: &[u16]) {
    match value {
        J::Null => out.extend(utf16("null")),
        J::Bool(b) => out.extend(utf16(if *b { "true" } else { "false" })),
        J::Num(n) => out.extend(utf16(&js_number(*n))),
        J::Str(s) => quote(out, s),
        J::Arr(items) => {
            if items.is_empty() {
                return out.extend(utf16("[]"));
            }
            let inner = [indent, gap.unwrap_or(&[])].concat();
            out.push(91);
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(44);
                }
                if gap.is_some() {
                    out.push(10);
                    out.extend_from_slice(&inner);
                }
                write_value(out, item, gap, &inner);
            }
            if gap.is_some() {
                out.push(10);
                out.extend_from_slice(indent);
            }
            out.push(93);
        }
        J::Obj(pairs) => {
            if pairs.is_empty() {
                return out.extend(utf16("{}"));
            }
            let inner = [indent, gap.unwrap_or(&[])].concat();
            out.push(123);
            for (i, (key, item)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(44);
                }
                if gap.is_some() {
                    out.push(10);
                    out.extend_from_slice(&inner);
                }
                quote(out, key);
                out.push(58);
                if gap.is_some() {
                    out.push(32);
                }
                write_value(out, item, gap, &inner);
            }
            if gap.is_some() {
                out.push(10);
                out.extend_from_slice(indent);
            }
            out.push(125);
        }
    }
}
