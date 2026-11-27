//! Native string `format` and `pattern` validation for agent question forms.
//!
//! Uses a bounded Thompson NFA for ECMAScript/HTML `pattern` matching so
//! validation runs identically on native and `wasm32` in guaranteed linear time
//! without external dependencies.
use serde_json::Value;
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_PATTERN_BYTES: usize = 2048;
const MAX_REPEAT: usize = 256;
const MAX_STATES: usize = 2048;
const MAX_NESTING: usize = 32;
const MAX_AST_NODES: usize = 1024;
const MAX_COMPILE_WORK: usize = 4096;
const MAX_MATCH_STEPS: usize = 200_000;
const MAX_SINGLE_MATCH_STEPS: usize = 50_000;
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_MATCH_CACHE_ENTRIES: usize = 256;

/// Shared work budget across regex evaluations in a single form render/validation pass.
#[derive(Clone, Debug)]
pub struct MatchBudget {
    remaining: usize,
}

impl Default for MatchBudget {
    fn default() -> Self {
        Self::new()
    }
}

impl MatchBudget {
    pub fn new() -> Self {
        Self {
            remaining: MAX_MATCH_STEPS,
        }
    }

    fn consume(&mut self, cost: usize) -> bool {
        if cost > self.remaining {
            self.remaining = 0;
            false
        } else {
            self.remaining -= cost;
            true
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompileError {
    InvalidSyntax,
    DeferToServer,
}

static PATTERN_CACHE: OnceLock<Mutex<HashMap<String, Result<Arc<Pattern>, CompileError>>>> =
    OnceLock::new();
static MATCH_CACHE_SEEDS: OnceLock<(RandomState, RandomState)> = OnceLock::new();
static MATCH_CACHE: OnceLock<Mutex<HashMap<(u64, u64), bool>>> = OnceLock::new();

fn match_cache_digest(src: &str, value: &str) -> (u64, u64) {
    let (s1, s2) = MATCH_CACHE_SEEDS.get_or_init(|| (RandomState::new(), RandomState::new()));
    let digest_with = |seed: &RandomState| {
        let mut hasher = seed.build_hasher();
        src.len().hash(&mut hasher);
        src.as_bytes().hash(&mut hasher);
        value.len().hash(&mut hasher);
        value.as_bytes().hash(&mut hasher);
        hasher.finish()
    };
    (digest_with(s1), digest_with(s2))
}

fn compile_cached(src: &str) -> Result<Arc<Pattern>, CompileError> {
    let cache = PATTERN_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some(entry) = map.get(src)
    {
        return entry.clone();
    }
    let compiled = Pattern::compile(src).map(Arc::new);
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_CACHE_ENTRIES {
            map.clear();
        }
        map.insert(src.to_string(), compiled.clone());
    }
    compiled
}

fn match_cached(src: &str, pat: &Pattern, value: &str, budget: &mut MatchBudget) -> bool {
    let cache = MATCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    // Store only a non-reversible per-process keyed 128-bit digest, never plaintext draft text.
    let key = match_cache_digest(src, value);
    if let Ok(map) = cache.lock()
        && let Some(&hit) = map.get(&key)
    {
        return hit;
    }
    if budget.remaining == 0 {
        return true;
    }
    // Cap each individual match so one pathological pattern cannot starve the rest of the form,
    // and cache pairs that exhaust the per-match cap on their own so repeated renders do zero work.
    let before = budget.remaining;
    let single_cap = before.min(MAX_SINGLE_MATCH_STEPS);
    let mut call_budget = MatchBudget {
        remaining: single_cap,
    };
    let outcome = pat.is_match_budgeted(value, &mut call_budget);
    let spent = single_cap - call_budget.remaining;
    budget.remaining = before.saturating_sub(spent);
    let matched = match outcome {
        Some(matched) => matched,
        None => {
            if spent >= MAX_SINGLE_MATCH_STEPS
                && let Ok(mut map) = cache.lock()
            {
                if map.len() >= MAX_MATCH_CACHE_ENTRIES {
                    map.clear();
                }
                map.insert(key, true);
            }
            return true;
        }
    };
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_MATCH_CACHE_ENTRIES {
            map.clear();
        }
        map.insert(key, matched);
    }
    matched
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StringFormat {
    Uri,
    Email,
    Date,
    DateTime,
}

impl StringFormat {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "uri" => Some(Self::Uri),
            "email" => Some(Self::Email),
            "date" => Some(Self::Date),
            "date-time" => Some(Self::DateTime),
            _ => None,
        }
    }

    pub fn matches(self, value: &str) -> bool {
        match self {
            Self::Uri => is_valid_uri(value),
            Self::Email => is_valid_email(value),
            Self::Date => is_valid_date(value),
            Self::DateTime => is_valid_date_time(value),
        }
    }
}

pub fn valid_string_constraints(field: &Value) -> bool {
    if field["type"] != "string" {
        return true;
    }
    match field.get("format") {
        None | Some(Value::Null) => {}
        Some(Value::String(raw)) if StringFormat::parse(raw).is_some() => {}
        _ => return false,
    }
    match field.get("pattern") {
        None | Some(Value::Null) => true,
        Some(Value::String(raw)) if raw.is_empty() => true,
        Some(Value::String(raw)) => {
            !matches!(compile_cached(raw), Err(CompileError::InvalidSyntax))
        }
        _ => false,
    }
}

pub fn matches_string_constraints_budgeted(
    field: &Value,
    value: &str,
    budget: &mut MatchBudget,
) -> Result<bool, ()> {
    if let Some(raw) = field.get("format").filter(|v| !v.is_null()) {
        let fmt = raw.as_str().and_then(StringFormat::parse).ok_or(())?;
        if !fmt.matches(value) {
            return Ok(false);
        }
    }
    if let Some(raw) = field.get("pattern").filter(|v| !v.is_null()) {
        let src = raw.as_str().ok_or(())?;
        if !src.is_empty() {
            match compile_cached(src) {
                Ok(pat) => {
                    if !match_cached(src, &pat, value, budget) {
                        return Ok(false);
                    }
                }
                Err(CompileError::DeferToServer) => {}
                Err(CompileError::InvalidSyntax) => return Err(()),
            }
        }
    }
    Ok(true)
}

pub fn is_es_whitespace(c: char) -> bool {
    u16::try_from(c as u32).is_ok_and(is_space_u16)
}

pub fn trim_es(value: &str) -> &str {
    value.trim_matches(is_es_whitespace)
}

fn is_valid_email(value: &str) -> bool {
    // Match OpenCode's ECMAScript email predicate `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
    if value.is_empty() || value.chars().any(is_es_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || local.is_empty() || domain.len() < 3 {
        return false;
    }
    domain
        .char_indices()
        .any(|(idx, ch)| ch == '.' && idx > 0 && idx + 1 < domain.len())
}

fn is_valid_uri(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        reqwest::Url::parse(value).is_ok()
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::Url::new(value).is_ok()
    }
}

fn parse_ascii_digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn is_valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let Some(year) = parse_ascii_digits(&value[0..4]) else {
        return false;
    };
    let Some(month) = parse_ascii_digits(&value[5..7]) else {
        return false;
    };
    let Some(day) = parse_ascii_digits(&value[8..10]) else {
        return false;
    };
    (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day)
}

#[derive(Clone, Copy)]
struct ParsedLocalDateTime {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: u32,
}

fn parse_local_date_time_without_zone(value: &str) -> Option<ParsedLocalDateTime> {
    if value.len() < 16 || !value.is_ascii() || !is_valid_date(&value[0..10]) {
        return None;
    }
    let b = value.as_bytes();
    if !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' {
        return None;
    }
    let year = parse_ascii_digits(&value[0..4])? as i64;
    let month = parse_ascii_digits(&value[5..7])? as i64;
    let day = parse_ascii_digits(&value[8..10])? as i64;
    let hour = parse_ascii_digits(&value[11..13])? as i64;
    let minute = parse_ascii_digits(&value[14..16])? as i64;
    if hour > 24 || minute > 59 || (hour == 24 && minute != 0) {
        return None;
    }
    let mut second = 0i64;
    let mut millis = 0u32;
    let mut rest = &value[16..];
    if let Some(after_colon) = rest.strip_prefix(':') {
        if after_colon.len() < 2 {
            return None;
        }
        second = parse_ascii_digits(&after_colon[0..2])? as i64;
        if second > 59 || (hour == 24 && second != 0) {
            return None;
        }
        rest = &after_colon[2..];
        if let Some(after_dot) = rest.strip_prefix('.') {
            let frac_len = after_dot.bytes().take_while(u8::is_ascii_digit).count();
            if frac_len == 0 {
                return None;
            }
            let frac = &after_dot[..frac_len];
            if hour == 24 && !frac.bytes().all(|d| d == b'0') {
                return None;
            }
            let mut m = 0u32;
            for i in 0..3 {
                let d = frac.as_bytes().get(i).copied().unwrap_or(b'0') - b'0';
                m = m * 10 + u32::from(d);
            }
            millis = m;
            rest = &after_dot[frac_len..];
        }
    }
    if !rest.is_empty() {
        return None;
    }
    Some(ParsedLocalDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millis,
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(not(target_arch = "wasm32"))]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + i64::from(m <= 2);
    (y, m as u32, d as u32)
}

#[cfg(not(target_arch = "wasm32"))]
fn civil_to_unix_secs(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
}

#[cfg(not(target_arch = "wasm32"))]
fn local_offset_secs<F>(utc_secs: i64, local_clock: &F) -> Option<i64>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32)>,
{
    let (ly, lm, ld, lh, lmin) = local_clock(utc_secs)?;
    let local_min_secs = civil_to_unix_secs(
        i64::from(ly),
        i64::from(lm),
        i64::from(ld),
        i64::from(lh),
        i64::from(lmin),
        0,
    );
    let utc_min_secs = utc_secs - utc_secs.rem_euclid(60);
    Some(local_min_secs - utc_min_secs)
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_local_civil_to_utc_secs<F>(parsed: ParsedLocalDateTime, local_clock: F) -> Option<i64>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32)>,
{
    let target_secs = civil_to_unix_secs(
        parsed.year,
        parsed.month,
        parsed.day,
        parsed.hour,
        parsed.minute,
        parsed.second,
    );
    let target_days = target_secs.div_euclid(86_400);
    let target_sod = target_secs.rem_euclid(86_400);
    let (ty, tm, td) = civil_from_days(target_days);
    let target_civil = (
        ty as i32,
        tm as i32,
        td as i32,
        (target_sod / 3600) as i32,
        ((target_sod % 3600) / 60) as i32,
    );
    // Sample 36 hours on either side so every timezone (UTC-12..UTC+14) brackets any DST transition.
    let off_before = local_offset_secs(target_secs - 129_600, &local_clock)?;
    let off_mid = local_offset_secs(target_secs, &local_clock)?;
    let off_after = local_offset_secs(target_secs + 129_600, &local_clock)?;
    let mut candidates = [
        target_secs - off_before,
        target_secs - off_mid,
        target_secs - off_after,
    ];
    candidates.sort_unstable();
    // Exact wall-clock match (normal time, or earlier instant for fall-back overlaps).
    for cand in candidates {
        if local_clock(cand)? == target_civil {
            return Some(cand);
        }
    }
    // Spring-forward DST gap: shift forward using the pre-transition offset, matching ECMAScript Date.
    Some(target_secs - off_before)
}

#[cfg(not(target_arch = "wasm32"))]
fn format_utc_iso(utc_secs: i64, millis: u32) -> Option<String> {
    let days = utc_secs.div_euclid(86_400);
    let sod = utc_secs.rem_euclid(86_400);
    let (uy, um, ud) = civil_from_days(days);
    let uh = sod / 3600;
    let umin = (sod % 3600) / 60;
    let usec = sod % 60;
    if !(0..=9999).contains(&uy) {
        return None;
    }
    Some(format!(
        "{uy:04}-{um:02}-{ud:02}T{uh:02}:{umin:02}:{usec:02}.{millis:03}Z"
    ))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn normalize_local_date_time_with_clock<F>(value: &str, local_clock: F) -> Option<String>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32)>,
{
    let parsed = parse_local_date_time_without_zone(trim_es(value))?;
    let utc_secs = resolve_local_civil_to_utc_secs(parsed, local_clock)?;
    format_utc_iso(utc_secs, parsed.millis)
}

/// Convert an edited timezone-less local date-time (e.g. `2026-11-26T14:30`) to UTC RFC 3339
/// (`...Z`), matching CodeNomad UI's `normalizeFormStringValue`. Returns `None` when `value` is
/// not a local timezone-less date-time (explicit offsets, date-only values, or invalid strings).
pub fn normalize_edited_local_date_time(value: &str) -> Option<String> {
    let trimmed = trim_es(value);
    let parsed = parse_local_date_time_without_zone(trimmed)?;
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (
            parsed.year,
            parsed.month,
            parsed.day,
            parsed.hour,
            parsed.minute,
            parsed.second,
            parsed.millis,
        );
        let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_str(trimmed));
        if !d.get_time().is_finite() {
            return None;
        }
        d.to_iso_string().as_string()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let utc_secs =
            resolve_local_civil_to_utc_secs(parsed, codenomad_host_process::local_clock)?;
        format_utc_iso(utc_secs, parsed.millis)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn contains_js_month_name(s: &str) -> bool {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    s.split(|c: char| !c.is_ascii_alphabetic()).any(|tok| {
        tok.len() >= 3 && {
            let prefix = tok[..3].to_ascii_lowercase();
            MONTHS.contains(&prefix.as_str())
        }
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn looks_like_slash_date(s: &str) -> bool {
    let mut parts = s.split('/');
    let Some(a) = parts.next() else {
        return false;
    };
    let Some(b) = parts.next() else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && a.bytes().all(|x| x.is_ascii_digit())
        && b.bytes().next().is_some_and(|x| x.is_ascii_digit())
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_iso_year_prefix(s: &str) -> Option<(i64, usize)> {
    let b = s.as_bytes();
    if b.len() >= 7 && matches!(b[0], b'+' | b'-') {
        let digits = &s[1..7];
        if digits.bytes().all(|x| x.is_ascii_digit()) {
            let mag = digits.parse::<i64>().ok()?;
            if b[0] == b'-' && mag == 0 {
                // ECMAScript Date treats `-000000` as invalid (`NaN`).
                return None;
            }
            let year = if b[0] == b'-' { -mag } else { mag };
            return Some((year, 7));
        }
    }
    if b.len() >= 4
        && let Some(year) = parse_ascii_digits(&s[0..4])
    {
        return Some((i64::from(year), 4));
    }
    None
}

#[cfg(not(target_arch = "wasm32"))]
fn days_in_month_i64(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn take_1_or_2_digits(s: &str) -> Option<(u32, &str)> {
    let len = s.bytes().take(2).take_while(u8::is_ascii_digit).count();
    if len == 0 {
        return None;
    }
    Some((parse_ascii_digits(&s[..len])?, &s[len..]))
}

#[cfg(not(target_arch = "wasm32"))]
fn within_js_date_range(year: i64, month: u32, day: u32, sod_ms: i64, tz_offset_ms: i64) -> bool {
    const MAX_JS_DATE_MS: i128 = 8_640_000_000_000_000;
    let days = days_from_civil(year, i64::from(month), i64::from(day));
    let ms = i128::from(days) * 86_400_000 + i128::from(sod_ms) - i128::from(tz_offset_ms);
    ms.abs() <= MAX_JS_DATE_MS
}

fn is_valid_date_time(value: &str) -> bool {
    let s = trim_es(value);
    if s.is_empty() {
        return false;
    }
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::new(&wasm_bindgen::JsValue::from_str(s))
            .get_time()
            .is_finite()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        if !s.is_ascii() {
            return false;
        }
        // OpenCode validates `date-time` via `new Date(value)`: standard 4-digit and ECMAScript
        // 6-digit extended ISO years (`±YYYYYY`), including unpadded `YYYY-M-D` forms accepted
        // by JavaScript `Date.parse`, are valid.
        let iso_candidate = parse_iso_year_prefix(s).filter(|&(_, ylen)| {
            let tail = &s.as_bytes()[ylen..];
            tail.is_empty() || tail[0] == b'-'
        });
        let Some((year, ylen)) = iso_candidate else {
            // Defer non-ISO JavaScript `Date.parse` formats (e.g. RFC 2822
            // `"Thu, 26 Nov 2026 14:30:00 GMT"`, `"Nov 26, 2026"`, `"2026/11/26"`) to OpenCode
            // instead of falsely blocking valid protocol defaults on desktop.
            let has_digit = s.bytes().any(|b| b.is_ascii_digit());
            return has_digit && (contains_js_month_name(s) || looks_like_slash_date(s));
        };
        let rest_after_year = &s[ylen..];
        if rest_after_year.is_empty() {
            return within_js_date_range(year, 1, 1, 0, 0);
        }
        let Some(after_y_dash) = rest_after_year.strip_prefix('-') else {
            return false;
        };
        let Some((month, after_month)) = take_1_or_2_digits(after_y_dash) else {
            return false;
        };
        if !(1..=12).contains(&month) {
            return false;
        }
        if after_month.is_empty() {
            return within_js_date_range(year, month, 1, 0, 0);
        }
        let Some(after_m_dash) = after_month.strip_prefix('-') else {
            return false;
        };
        let Some((day, after_date)) = take_1_or_2_digits(after_m_dash) else {
            return false;
        };
        if !(1..=days_in_month_i64(year, month)).contains(&day) {
            return false;
        }
        if after_date.is_empty() {
            return within_js_date_range(year, month, day, 0, 0);
        }
        let b = after_date.as_bytes();
        if !matches!(b[0], b'T' | b't' | b' ') {
            return false;
        }
        let Some((hour, after_hour)) = take_1_or_2_digits(&after_date[1..]) else {
            return false;
        };
        let Some(after_h_colon) = after_hour.strip_prefix(':') else {
            return false;
        };
        let Some((minute, mut rest)) = take_1_or_2_digits(after_h_colon) else {
            return false;
        };
        if hour > 24 || minute > 59 || (hour == 24 && minute != 0) {
            return false;
        }
        let mut second = 0u32;
        let mut millis = 0u32;
        if let Some(after_colon) = rest.strip_prefix(':') {
            let Some((sec, after_sec)) = take_1_or_2_digits(after_colon) else {
                return false;
            };
            if sec > 59 || (hour == 24 && sec != 0) {
                return false;
            }
            second = sec;
            rest = after_sec;
            if let Some(after_dot) = rest.strip_prefix('.') {
                let frac_len = after_dot.bytes().take_while(u8::is_ascii_digit).count();
                if frac_len == 0 {
                    return false;
                }
                let frac = &after_dot[..frac_len];
                if hour == 24 && !frac.bytes().all(|d| d == b'0') {
                    return false;
                }
                let mut m = 0u32;
                for i in 0..3 {
                    let d = frac.as_bytes().get(i).copied().unwrap_or(b'0') - b'0';
                    m = m * 10 + u32::from(d);
                }
                millis = m;
                rest = &after_dot[frac_len..];
            }
        }
        let sod_ms = (i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second)) * 1000
            + i64::from(millis);
        let tz = rest.trim_start();
        if tz.is_empty()
            || tz.eq_ignore_ascii_case("Z")
            || tz.eq_ignore_ascii_case("GMT")
            || tz.eq_ignore_ascii_case("UTC")
        {
            return within_js_date_range(year, month, day, sod_ms, 0);
        }
        let rb = tz.as_bytes();
        let (sign, tz_h_str, tz_m_str) =
            if rb.len() == 6 && matches!(rb[0], b'+' | b'-') && rb[3] == b':' {
                (
                    if rb[0] == b'-' { -1i64 } else { 1i64 },
                    &tz[1..3],
                    &tz[4..6],
                )
            } else if rb.len() == 5 && matches!(rb[0], b'+' | b'-') {
                (
                    if rb[0] == b'-' { -1i64 } else { 1i64 },
                    &tz[1..3],
                    &tz[3..5],
                )
            } else {
                return false;
            };
        let Some(tz_h) = parse_ascii_digits(tz_h_str) else {
            return false;
        };
        let Some(tz_m) = parse_ascii_digits(tz_m_str) else {
            return false;
        };
        if tz_h > 23 || tz_m > 59 {
            return false;
        }
        let tz_offset_ms = sign * (i64::from(tz_h) * 3600 + i64::from(tz_m) * 60) * 1000;
        within_js_date_range(year, month, day, sod_ms, tz_offset_ms)
    }
}

#[derive(Clone, Copy, Debug)]
enum ClassItem {
    Single(u16),
    Range(u16, u16),
    Digit,
    NonDigit,
    Word,
    NonWord,
    Space,
    NonSpace,
    Deferred,
}

impl ClassItem {
    fn matches(&self, u: u16) -> bool {
        match *self {
            Self::Single(x) => u == x,
            Self::Range(lo, hi) => u >= lo && u <= hi,
            Self::Digit => is_digit_u16(u),
            Self::NonDigit => !is_digit_u16(u),
            Self::Word => is_word_u16(u),
            Self::NonWord => !is_word_u16(u),
            Self::Space => is_space_u16(u),
            Self::NonSpace => !is_space_u16(u),
            Self::Deferred => false,
        }
    }
}

fn is_digit_u16(u: u16) -> bool {
    (0x0030..=0x0039).contains(&u)
}

fn is_word_u16(u: u16) -> bool {
    matches!(u, 0x0030..=0x0039 | 0x0041..=0x005A | 0x0061..=0x007A | 0x005F)
}

fn is_space_u16(u: u16) -> bool {
    matches!(
        u,
        0x0009..=0x000D
            | 0x0020
            | 0x00A0
            | 0x1680
            | 0x2000..=0x200A
            | 0x2028
            | 0x2029
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF
    )
}

fn hex_nibble_u16(u: u16) -> Option<u16> {
    match u {
        0x0030..=0x0039 => Some(u - 0x0030),
        0x0041..=0x0046 => Some(u - 0x0041 + 10),
        0x0061..=0x0066 => Some(u - 0x0061 + 10),
        _ => None,
    }
}

#[derive(Clone, Debug)]
enum Expr {
    Empty,
    Literal(u16),
    Any,
    Class {
        negated: bool,
        items: Arc<[ClassItem]>,
    },
    AssertStart,
    AssertEnd,
    AssertWord(bool),
    Group(Box<Expr>),
    Concat(Vec<Expr>),
    Alt(Vec<Expr>),
    Repeat {
        inner: Box<Expr>,
        min: usize,
        max: Option<usize>,
    },
}

struct Parser {
    units: Vec<u16>,
    pos: usize,
    depth: usize,
    nodes: usize,
    deferred: bool,
}

impl Parser {
    fn new(src: &str) -> Self {
        Self {
            units: src.encode_utf16().collect(),
            pos: 0,
            depth: 0,
            nodes: 0,
            deferred: false,
        }
    }

    fn charge_node(&mut self) -> Result<(), CompileError> {
        self.nodes += 1;
        if self.nodes > MAX_AST_NODES {
            Err(CompileError::DeferToServer)
        } else {
            Ok(())
        }
    }

    fn peek(&self) -> Option<u16> {
        self.units.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<u16> {
        let u = self.peek()?;
        self.pos += 1;
        Some(u)
    }

    fn parse(mut self) -> Result<Expr, CompileError> {
        let expr = self.parse_alt()?;
        if self.pos != self.units.len() {
            return Err(CompileError::InvalidSyntax);
        }
        if self.deferred {
            return Err(CompileError::DeferToServer);
        }
        Ok(expr)
    }

    fn parse_alt(&mut self) -> Result<Expr, CompileError> {
        let mut branches = vec![self.parse_seq()?];
        while self.peek() == Some(b'|' as u16) {
            self.pos += 1;
            branches.push(self.parse_seq()?);
        }
        if branches.len() == 1 {
            Ok(branches.pop().unwrap())
        } else {
            Ok(Expr::Alt(branches))
        }
    }

    fn parse_seq(&mut self) -> Result<Expr, CompileError> {
        let mut items = Vec::new();
        while let Some(u) = self.peek() {
            if u == b')' as u16 || u == b'|' as u16 {
                break;
            }
            items.push(self.parse_quantified()?);
        }
        Ok(match items.len() {
            0 => Expr::Empty,
            1 => items.pop().unwrap(),
            _ => Expr::Concat(items),
        })
    }

    fn try_parse_quantifier(&mut self) -> Result<Option<(usize, Option<usize>)>, CompileError> {
        let Some(u) = self.peek() else {
            return Ok(None);
        };
        if u == b'*' as u16 {
            self.pos += 1;
            Ok(Some((0, None)))
        } else if u == b'+' as u16 {
            self.pos += 1;
            Ok(Some((1, None)))
        } else if u == b'?' as u16 {
            self.pos += 1;
            Ok(Some((0, Some(1))))
        } else if u == b'{' as u16 {
            self.try_parse_brace_quantifier()
        } else {
            Ok(None)
        }
    }

    fn parse_quantified(&mut self) -> Result<Expr, CompileError> {
        let expr = self.parse_atom()?;
        let Some((min, max)) = self.try_parse_quantifier()? else {
            return Ok(expr);
        };
        if matches!(
            expr,
            Expr::AssertStart | Expr::AssertEnd | Expr::AssertWord(_)
        ) {
            return Err(CompileError::InvalidSyntax);
        }
        // Optional lazy `?` suffix does not change boolean match acceptance.
        if self.peek() == Some(b'?' as u16) {
            self.pos += 1;
        }
        if self
            .peek()
            .is_some_and(|u| u == b'*' as u16 || u == b'+' as u16 || u == b'?' as u16)
            || self.try_parse_brace_quantifier()?.is_some()
        {
            return Err(CompileError::InvalidSyntax);
        }
        self.charge_node()?;
        if (min == 0 && max == Some(0)) || matches!(expr, Expr::Empty) {
            Ok(Expr::Empty)
        } else {
            Ok(Expr::Repeat {
                inner: Box::new(expr),
                min,
                max,
            })
        }
    }

    fn try_parse_brace_quantifier(
        &mut self,
    ) -> Result<Option<(usize, Option<usize>)>, CompileError> {
        let saved = self.pos;
        if self.peek() != Some(b'{' as u16) {
            return Ok(None);
        }
        self.pos += 1; // consume '{'
        let Some(min) = self.parse_usize() else {
            self.pos = saved;
            return Ok(None);
        };
        let max = match self.peek() {
            Some(u) if u == b'}' as u16 => {
                self.pos += 1;
                Some(min)
            }
            Some(u) if u == b',' as u16 => {
                self.pos += 1;
                if self.peek() == Some(b'}' as u16) {
                    self.pos += 1;
                    None
                } else {
                    let Some(hi) = self.parse_usize() else {
                        self.pos = saved;
                        return Ok(None);
                    };
                    if self.peek() != Some(b'}' as u16) {
                        self.pos = saved;
                        return Ok(None);
                    }
                    self.pos += 1;
                    Some(hi)
                }
            }
            _ => {
                self.pos = saved;
                return Ok(None);
            }
        };
        if max.is_some_and(|m| m < min) {
            return Err(CompileError::InvalidSyntax);
        }
        if min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT) {
            self.deferred = true;
            return Ok(Some((0, Some(0))));
        }
        Ok(Some((min, max)))
    }

    fn parse_usize(&mut self) -> Option<usize> {
        let start = self.pos;
        let mut val: usize = 0;
        while let Some(u) = self.peek().filter(|&u| is_digit_u16(u)) {
            self.pos += 1;
            val = val.saturating_mul(10).saturating_add((u - 0x0030) as usize);
        }
        (self.pos > start).then_some(val)
    }

    fn parse_atom(&mut self) -> Result<Expr, CompileError> {
        self.charge_node()?;
        let u = self.next().ok_or(CompileError::InvalidSyntax)?;
        match u {
            x if x == b'^' as u16 => Ok(Expr::AssertStart),
            x if x == b'$' as u16 => Ok(Expr::AssertEnd),
            x if x == b'.' as u16 => Ok(Expr::Any),
            x if x == b'*' as u16 || x == b'+' as u16 || x == b'?' as u16 => {
                Err(CompileError::InvalidSyntax)
            }
            x if x == b'(' as u16 => {
                self.depth += 1;
                if self.depth > MAX_NESTING {
                    return Err(CompileError::DeferToServer);
                }
                let mut deferred_group = false;
                if self.peek() == Some(b'?' as u16) {
                    self.pos += 1;
                    match self.peek() {
                        Some(ch) if ch == b':' as u16 => {
                            self.pos += 1;
                        }
                        Some(ch) if ch == b'=' as u16 || ch == b'!' as u16 => {
                            self.pos += 1;
                            self.deferred = true;
                            deferred_group = true;
                        }
                        Some(ch) if ch == b'<' as u16 => {
                            self.pos += 1;
                            if matches!(self.peek(), Some(c) if c == b'=' as u16 || c == b'!' as u16)
                            {
                                self.pos += 1;
                            } else {
                                let name_start = self.pos;
                                while let Some(c) = self.peek() {
                                    if c == b'>' as u16 {
                                        break;
                                    }
                                    self.pos += 1;
                                }
                                if self.pos == name_start || self.next() != Some(b'>' as u16) {
                                    return Err(CompileError::InvalidSyntax);
                                }
                            }
                            self.deferred = true;
                            deferred_group = true;
                        }
                        _ => {
                            let saved = self.pos;
                            let mut seen_dash = false;
                            let mut valid_mods = false;
                            while let Some(c) = self.peek() {
                                if c == b':' as u16 {
                                    self.pos += 1;
                                    valid_mods = self.pos > saved + 1;
                                    break;
                                }
                                if c == b'-' as u16 && !seen_dash {
                                    seen_dash = true;
                                    self.pos += 1;
                                } else if matches!(c, 0x0069 | 0x006D | 0x0073) {
                                    self.pos += 1;
                                } else {
                                    break;
                                }
                            }
                            if !valid_mods {
                                return Err(CompileError::InvalidSyntax);
                            }
                            self.deferred = true;
                            deferred_group = true;
                        }
                    }
                }
                let inner = self.parse_alt()?;
                self.depth -= 1;
                if self.next() != Some(b')' as u16) {
                    return Err(CompileError::InvalidSyntax);
                }
                Ok(if deferred_group {
                    Expr::Empty
                } else {
                    Expr::Group(Box::new(inner))
                })
            }
            x if x == b'[' as u16 => self.parse_class(),
            x if x == b'\\' as u16 => self.parse_escape(),
            other => Ok(Expr::Literal(other)),
        }
    }

    fn parse_escape(&mut self) -> Result<Expr, CompileError> {
        let u = self.next().ok_or(CompileError::InvalidSyntax)?;
        match u {
            x if x == b'd' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::Digit]),
            }),
            x if x == b'D' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::NonDigit]),
            }),
            x if x == b'w' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::Word]),
            }),
            x if x == b'W' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::NonWord]),
            }),
            x if x == b's' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::Space]),
            }),
            x if x == b'S' as u16 => Ok(Expr::Class {
                negated: false,
                items: Arc::from([ClassItem::NonSpace]),
            }),
            x if x == b'b' as u16 => Ok(Expr::AssertWord(true)),
            x if x == b'B' as u16 => Ok(Expr::AssertWord(false)),
            0x0031..=0x0039 => {
                self.deferred = true;
                Ok(Expr::Empty)
            }
            other => Ok(match self.decode_u16_escape(other)? {
                Some(ch) => Expr::Literal(ch),
                None => Expr::Empty,
            }),
        }
    }

    fn decode_u16_escape(&mut self, u: u16) -> Result<Option<u16>, CompileError> {
        match u {
            x if x == b'n' as u16 => Ok(Some(0x000A)),
            x if x == b'r' as u16 => Ok(Some(0x000D)),
            x if x == b't' as u16 => Ok(Some(0x0009)),
            x if x == b'f' as u16 => Ok(Some(0x000C)),
            x if x == b'v' as u16 => Ok(Some(0x000B)),
            x if x == b'0' as u16 => {
                if self.peek().is_some_and(is_digit_u16) {
                    self.deferred = true;
                    return Ok(None);
                }
                Ok(Some(0x0000))
            }
            x if x == b'x' as u16 => match self.try_parse_hex_u16(2) {
                Some(v) => Ok(Some(v)),
                None => {
                    self.deferred = true;
                    Ok(None)
                }
            },
            x if x == b'u' as u16 => {
                if self.peek() == Some(b'{' as u16) {
                    self.deferred = true;
                    return Ok(None);
                }
                match self.try_parse_hex_u16(4) {
                    Some(v) => Ok(Some(v)),
                    None => {
                        self.deferred = true;
                        Ok(None)
                    }
                }
            }
            x if x == b'p' as u16 || x == b'P' as u16 || x == b'k' as u16 || x == b'c' as u16 => {
                self.deferred = true;
                Ok(None)
            }
            other => Ok(Some(other)),
        }
    }

    fn try_parse_hex_u16(&mut self, count: usize) -> Option<u16> {
        let saved = self.pos;
        let mut val: u16 = 0;
        for _ in 0..count {
            let Some(h) = self.next().and_then(hex_nibble_u16) else {
                self.pos = saved;
                return None;
            };
            val = (val << 4) | h;
        }
        Some(val)
    }

    fn parse_class(&mut self) -> Result<Expr, CompileError> {
        let negated = if self.peek() == Some(b'^' as u16) {
            self.pos += 1;
            true
        } else {
            false
        };
        let mut items = Vec::new();
        while let Some(u) = self.peek() {
            if u == b']' as u16 {
                self.pos += 1;
                return Ok(Expr::Class {
                    negated,
                    items: Arc::from(items),
                });
            }
            self.charge_node()?;
            let item = self.parse_class_atom()?;
            if self.peek() == Some(b'-' as u16)
                && self.units.get(self.pos + 1).copied() != Some(b']' as u16)
            {
                self.pos += 1; // consume '-'
                self.charge_node()?;
                let end = self.parse_class_atom()?;
                match (item, end) {
                    (ClassItem::Single(lo), ClassItem::Single(hi)) if lo <= hi => {
                        items.push(ClassItem::Range(lo, hi));
                    }
                    (ClassItem::Single(_), ClassItem::Single(_)) => {
                        return Err(CompileError::InvalidSyntax);
                    }
                    _ => {
                        self.deferred = true;
                    }
                }
            } else {
                items.push(item);
            }
        }
        Err(CompileError::InvalidSyntax)
    }

    fn parse_class_atom(&mut self) -> Result<ClassItem, CompileError> {
        let u = self.next().ok_or(CompileError::InvalidSyntax)?;
        if u != b'\\' as u16 {
            return Ok(ClassItem::Single(u));
        }
        let esc = self.next().ok_or(CompileError::InvalidSyntax)?;
        match esc {
            x if x == b'd' as u16 => Ok(ClassItem::Digit),
            x if x == b'D' as u16 => Ok(ClassItem::NonDigit),
            x if x == b'w' as u16 => Ok(ClassItem::Word),
            x if x == b'W' as u16 => Ok(ClassItem::NonWord),
            x if x == b's' as u16 => Ok(ClassItem::Space),
            x if x == b'S' as u16 => Ok(ClassItem::NonSpace),
            x if x == b'b' as u16 => Ok(ClassItem::Single(0x0008)),
            0x0031..=0x0039 => {
                self.deferred = true;
                Ok(ClassItem::Deferred)
            }
            other => Ok(match self.decode_u16_escape(other)? {
                Some(ch) => ClassItem::Single(ch),
                None => ClassItem::Deferred,
            }),
        }
    }
}

#[derive(Clone, Debug)]
enum Inst {
    Literal(u16),
    Any,
    Class {
        negated: bool,
        items: Arc<[ClassItem]>,
    },
    AssertStart,
    AssertEnd,
    AssertWord(bool),
    Split(usize, usize),
    Jmp(usize),
    Match,
}

pub struct Pattern {
    insts: Vec<Inst>,
}

impl Pattern {
    fn compile(src: &str) -> Result<Self, CompileError> {
        if src.len() > MAX_PATTERN_BYTES {
            return Err(CompileError::DeferToServer);
        }
        let expr = Parser::new(src).parse()?;
        let mut insts = Vec::new();
        let mut work = 0usize;
        compile_expr(&expr, &mut insts, &mut work)?;
        push_inst(&mut insts, Inst::Match)?;
        Ok(Self { insts })
    }

    fn is_match_budgeted(&self, text: &str, budget: &mut MatchBudget) -> Option<bool> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let n = self.insts.len();
        let mut visited = vec![0u32; n];
        let mut stamp = 1u32;
        let mut current = Vec::with_capacity(n.min(64));
        let mut next = Vec::with_capacity(n.min(64));
        let mut stack = Vec::with_capacity(n.min(64));
        if !self.add_state(
            0,
            0,
            &units,
            &mut visited,
            stamp,
            &mut current,
            &mut stack,
            budget,
        ) {
            return None;
        }
        if current
            .iter()
            .any(|&pc| matches!(self.insts[pc], Inst::Match))
        {
            return Some(true);
        }
        for (pos, &unit) in units.iter().enumerate() {
            stamp = stamp.wrapping_add(1);
            if stamp == 0 {
                for slot in &mut visited {
                    *slot = 0;
                }
                stamp = 1;
            }
            next.clear();
            for &pc in &current {
                if !budget.consume(1) {
                    return None;
                }
                let matched = match &self.insts[pc] {
                    Inst::Literal(u) => unit == *u,
                    Inst::Any => !matches!(unit, 0x000A | 0x000D | 0x2028 | 0x2029),
                    Inst::Class { negated, items } => {
                        if !budget.consume(items.len()) {
                            return None;
                        }
                        let hit = items.iter().any(|item| item.matches(unit));
                        if *negated { !hit } else { hit }
                    }
                    _ => false,
                };
                if matched
                    && !self.add_state(
                        pc + 1,
                        pos + 1,
                        &units,
                        &mut visited,
                        stamp,
                        &mut next,
                        &mut stack,
                        budget,
                    )
                {
                    return None;
                }
            }
            // Unanchored ECMAScript RegExp.test semantics: a match may start at any UTF-16 offset.
            if !self.add_state(
                0,
                pos + 1,
                &units,
                &mut visited,
                stamp,
                &mut next,
                &mut stack,
                budget,
            ) {
                return None;
            }
            std::mem::swap(&mut current, &mut next);
            if current
                .iter()
                .any(|&pc| matches!(self.insts[pc], Inst::Match))
            {
                return Some(true);
            }
        }
        Some(false)
    }

    #[allow(clippy::too_many_arguments)]
    fn add_state(
        &self,
        start: usize,
        pos: usize,
        units: &[u16],
        visited: &mut [u32],
        stamp: u32,
        out: &mut Vec<usize>,
        stack: &mut Vec<usize>,
        budget: &mut MatchBudget,
    ) -> bool {
        stack.clear();
        stack.push(start);
        while let Some(pc) = stack.pop() {
            if !budget.consume(1) {
                return false;
            }
            if pc >= self.insts.len() || visited[pc] == stamp {
                continue;
            }
            visited[pc] = stamp;
            match self.insts[pc] {
                Inst::Jmp(target) => stack.push(target),
                Inst::Split(a, b) => {
                    stack.push(b);
                    stack.push(a);
                }
                Inst::AssertStart => {
                    if pos == 0 {
                        stack.push(pc + 1);
                    }
                }
                Inst::AssertEnd => {
                    if pos == units.len() {
                        stack.push(pc + 1);
                    }
                }
                Inst::AssertWord(want_boundary) => {
                    let prev = pos.checked_sub(1).and_then(|i| units.get(i).copied());
                    let curr = units.get(pos).copied();
                    let is_boundary =
                        prev.is_some_and(is_word_u16) != curr.is_some_and(is_word_u16);
                    if is_boundary == want_boundary {
                        stack.push(pc + 1);
                    }
                }
                _ => out.push(pc),
            }
        }
        true
    }
}

fn push_inst(insts: &mut Vec<Inst>, inst: Inst) -> Result<usize, CompileError> {
    if insts.len() >= MAX_STATES {
        return Err(CompileError::DeferToServer);
    }
    let idx = insts.len();
    insts.push(inst);
    Ok(idx)
}

fn charge_work(work: &mut usize) -> Result<(), CompileError> {
    charge_work_n(work, 1)
}

fn charge_work_n(work: &mut usize, cost: usize) -> Result<(), CompileError> {
    *work = work.saturating_add(cost);
    if *work > MAX_COMPILE_WORK {
        Err(CompileError::DeferToServer)
    } else {
        Ok(())
    }
}

fn compile_expr(expr: &Expr, insts: &mut Vec<Inst>, work: &mut usize) -> Result<(), CompileError> {
    charge_work(work)?;
    match expr {
        Expr::Empty => Ok(()),
        Expr::Literal(c) => {
            push_inst(insts, Inst::Literal(*c))?;
            Ok(())
        }
        Expr::Any => {
            push_inst(insts, Inst::Any)?;
            Ok(())
        }
        Expr::Class { negated, items } => {
            charge_work_n(work, items.len())?;
            push_inst(
                insts,
                Inst::Class {
                    negated: *negated,
                    items: Arc::clone(items),
                },
            )?;
            Ok(())
        }
        Expr::AssertStart => {
            push_inst(insts, Inst::AssertStart)?;
            Ok(())
        }
        Expr::AssertEnd => {
            push_inst(insts, Inst::AssertEnd)?;
            Ok(())
        }
        Expr::AssertWord(b) => {
            push_inst(insts, Inst::AssertWord(*b))?;
            Ok(())
        }
        Expr::Group(inner) => compile_expr(inner, insts, work),
        Expr::Concat(items) => {
            for item in items {
                compile_expr(item, insts, work)?;
            }
            Ok(())
        }
        Expr::Alt(branches) => {
            let mut jmp_ends = Vec::with_capacity(branches.len());
            for (i, branch) in branches.iter().enumerate() {
                if i + 1 < branches.len() {
                    let split = push_inst(insts, Inst::Split(0, 0))?;
                    let left = insts.len();
                    compile_expr(branch, insts, work)?;
                    let jmp = push_inst(insts, Inst::Jmp(0))?;
                    let right = insts.len();
                    insts[split] = Inst::Split(left, right);
                    jmp_ends.push(jmp);
                } else {
                    compile_expr(branch, insts, work)?;
                }
            }
            let end = insts.len();
            for jmp in jmp_ends {
                insts[jmp] = Inst::Jmp(end);
            }
            Ok(())
        }
        Expr::Repeat { inner, min, max } => {
            for _ in 0..*min {
                charge_work(work)?;
                compile_expr(inner, insts, work)?;
            }
            match max {
                None => {
                    let split = push_inst(insts, Inst::Split(0, 0))?;
                    let body = insts.len();
                    compile_expr(inner, insts, work)?;
                    push_inst(insts, Inst::Jmp(split))?;
                    let end = insts.len();
                    insts[split] = Inst::Split(body, end);
                }
                Some(hi) => {
                    for _ in *min..*hi {
                        charge_work(work)?;
                        let split = push_inst(insts, Inst::Split(0, 0))?;
                        let body = insts.len();
                        compile_expr(inner, insts, work)?;
                        let end = insts.len();
                        insts[split] = Inst::Split(body, end);
                    }
                }
            }
            Ok(())
        }
    }
}
