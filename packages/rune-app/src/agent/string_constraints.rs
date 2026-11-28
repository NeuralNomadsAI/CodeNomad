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
const MAX_PATTERN_CACHE_BYTES: usize = 64 * 1024;
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
pub enum MatchOutcome {
    Matched,
    NoMatch,
    Deferred,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompileError {
    InvalidSyntax,
    DeferToServer,
}

#[derive(Clone)]
enum CachedPattern {
    Compiled(Arc<Pattern>),
    Deferred { cannot_match_empty: bool },
    InvalidSyntax,
}

struct PatternCacheState {
    entries: HashMap<String, CachedPattern>,
    bytes: usize,
}

static PATTERN_CACHE: OnceLock<Mutex<PatternCacheState>> = OnceLock::new();
static MATCH_CACHE_SEEDS: OnceLock<(RandomState, RandomState)> = OnceLock::new();
static MATCH_CACHE: OnceLock<Mutex<HashMap<(u64, u64), MatchOutcome>>> = OnceLock::new();

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

fn compile_cached(src: &str) -> CachedPattern {
    if src.len() > MAX_PATTERN_BYTES {
        return CachedPattern::Deferred {
            cannot_match_empty: false,
        };
    }
    let cache = PATTERN_CACHE.get_or_init(|| {
        Mutex::new(PatternCacheState {
            entries: HashMap::new(),
            bytes: 0,
        })
    });
    if let Ok(state) = cache.lock()
        && let Some(entry) = state.entries.get(src)
    {
        return entry.clone();
    }
    let compiled = Pattern::compile_cached_entry(src);
    if let Ok(mut state) = cache.lock() {
        if !state.entries.contains_key(src) {
            if state.entries.len() >= MAX_CACHE_ENTRIES
                || state.bytes.saturating_add(src.len()) > MAX_PATTERN_CACHE_BYTES
            {
                state.entries.clear();
                state.bytes = 0;
            }
            state.bytes += src.len();
            state.entries.insert(src.to_string(), compiled.clone());
        }
    }
    compiled
}

#[cfg(test)]
pub(crate) fn pattern_cache_bytes() -> usize {
    PATTERN_CACHE
        .get()
        .and_then(|c| c.lock().ok())
        .map_or(0, |s| s.bytes)
}

fn match_cached(src: &str, pat: &Pattern, value: &str, budget: &mut MatchBudget) -> MatchOutcome {
    let cache = MATCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    // Store only a non-reversible per-process keyed 128-bit digest, never plaintext draft text.
    let key = match_cache_digest(src, value);
    if let Ok(map) = cache.lock()
        && let Some(&hit) = map.get(&key)
    {
        return hit;
    }
    if budget.remaining == 0 {
        return MatchOutcome::Deferred;
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
    let result = match outcome {
        Some(true) => MatchOutcome::Matched,
        Some(false) => MatchOutcome::NoMatch,
        None => {
            if spent >= MAX_SINGLE_MATCH_STEPS
                && let Ok(mut map) = cache.lock()
            {
                if map.len() >= MAX_MATCH_CACHE_ENTRIES {
                    map.clear();
                }
                map.insert(key, MatchOutcome::Deferred);
            }
            return MatchOutcome::Deferred;
        }
    };
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_MATCH_CACHE_ENTRIES {
            map.clear();
        }
        map.insert(key, result);
    }
    result
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

    pub fn classify(self, value: &str) -> MatchOutcome {
        match self {
            Self::Uri => {
                if is_valid_uri(value) {
                    MatchOutcome::Matched
                } else {
                    MatchOutcome::NoMatch
                }
            }
            Self::Email => {
                if is_valid_email(value) {
                    MatchOutcome::Matched
                } else {
                    MatchOutcome::NoMatch
                }
            }
            Self::Date => {
                if is_valid_date(value) {
                    MatchOutcome::Matched
                } else {
                    MatchOutcome::NoMatch
                }
            }
            Self::DateTime => classify_date_time(value),
        }
    }
}

pub fn valid_string_schema(field: &Value) -> bool {
    if field["type"] != "string" {
        return true;
    }
    match field.get("format") {
        None | Some(Value::Null) => {}
        Some(Value::String(raw)) if StringFormat::parse(raw).is_some() => {}
        _ => return false,
    }
    matches!(
        field.get("pattern"),
        None | Some(Value::Null) | Some(Value::String(_))
    )
}

pub fn valid_string_constraints(field: &Value) -> bool {
    if !valid_string_schema(field) {
        return false;
    }
    if field["type"] != "string" || field["required"] != true {
        return true;
    }
    match field.get("pattern") {
        None | Some(Value::Null) => true,
        Some(Value::String(raw)) if raw.is_empty() => true,
        Some(Value::String(raw)) => !matches!(compile_cached(raw), CachedPattern::InvalidSyntax),
        _ => false,
    }
}

pub fn matches_string_constraints_budgeted(
    field: &Value,
    value: &str,
    budget: &mut MatchBudget,
) -> Result<MatchOutcome, ()> {
    let mut deferred = false;
    if let Some(raw) = field.get("format").filter(|v| !v.is_null()) {
        let fmt = raw.as_str().and_then(StringFormat::parse).ok_or(())?;
        match fmt.classify(value) {
            MatchOutcome::Matched => {}
            MatchOutcome::NoMatch => return Ok(MatchOutcome::NoMatch),
            MatchOutcome::Deferred => deferred = true,
        }
    }
    if let Some(raw) = field.get("pattern").filter(|v| !v.is_null()) {
        let src = raw.as_str().ok_or(())?;
        if !src.is_empty() {
            match compile_cached(src) {
                CachedPattern::Compiled(pat) => {
                    return Ok(match match_cached(src, &pat, value, budget) {
                        MatchOutcome::Matched if deferred => MatchOutcome::Deferred,
                        other => other,
                    });
                }
                CachedPattern::Deferred { cannot_match_empty } => {
                    if value.is_empty() && cannot_match_empty {
                        return Ok(MatchOutcome::NoMatch);
                    }
                    return Ok(MatchOutcome::Deferred);
                }
                CachedPattern::InvalidSyntax => return Err(()),
            }
        }
    }
    Ok(if deferred {
        MatchOutcome::Deferred
    } else {
        MatchOutcome::Matched
    })
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
    if !value.is_ascii() {
        return false;
    }
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
    if !value.is_ascii() {
        return None;
    }
    if let Some((year, ylen)) = parse_iso_year_prefix(value)
        && let Some(rest_after_year) = value[ylen..].strip_prefix('-')
        && let Some((month, after_month)) = take_1_or_2_digits(rest_after_year)
        && (1..=12).contains(&month)
        && let Some(after_m_dash) = after_month.strip_prefix('-')
        && let Some((day, after_date)) = take_1_or_2_digits(after_m_dash)
        && (1..=31).contains(&day)
    {
        let b = after_date.as_bytes();
        if !b.is_empty() && matches!(b[0], b'T' | b't' | b' ') {
            if let Some((hour, minute, second, millis, None)) =
                parse_time_and_tz(&after_date[1..], false)
            {
                let (norm_y, norm_m, norm_d) =
                    civil_from_days(days_from_civil(year, i64::from(month), i64::from(day)));
                return Some(ParsedLocalDateTime {
                    year: norm_y,
                    month: i64::from(norm_m),
                    day: i64::from(norm_d),
                    hour: i64::from(hour),
                    minute: i64::from(minute),
                    second: i64::from(second),
                    millis,
                });
            }
        }
        return None;
    }
    if let Some(parsed) = parse_numeric_date_time(value)
        && parsed.has_time
        && parsed.tz_offset_ms.is_none()
    {
        let (norm_y, norm_m, norm_d) = civil_from_days(days_from_civil(
            parsed.year,
            i64::from(parsed.month),
            i64::from(parsed.day),
        ));
        return Some(ParsedLocalDateTime {
            year: norm_y,
            month: i64::from(norm_m),
            day: i64::from(norm_d),
            hour: i64::from(parsed.hour),
            minute: i64::from(parsed.minute),
            second: i64::from(parsed.second),
            millis: parsed.millis,
        });
    }
    None
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

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

fn civil_to_unix_secs(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
}

#[cfg(not(target_arch = "wasm32"))]
fn local_offset_secs<F>(utc_secs: i64, local_clock: &F) -> Option<i64>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32, i32)>,
{
    let (ly, lm, ld, lh, lmin, lsec) = local_clock(utc_secs)?;
    let local_secs = civil_to_unix_secs(
        i64::from(ly),
        i64::from(lm),
        i64::from(ld),
        i64::from(lh),
        i64::from(lmin),
        i64::from(lsec),
    );
    Some(local_secs - utc_secs)
}

#[cfg(not(target_arch = "wasm32"))]
fn equivalent_gregorian_year(year: i64) -> i64 {
    let is_leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let jan1_dow = (days_from_civil(year, 1, 1) + 4).rem_euclid(7);
    for candidate in 2000..=2027 {
        let cand_leap = (candidate % 4 == 0 && candidate % 100 != 0) || candidate % 400 == 0;
        let cand_dow = (days_from_civil(candidate, 1, 1) + 4).rem_euclid(7);
        if cand_leap == is_leap && cand_dow == jan1_dow {
            return candidate;
        }
    }
    2000
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_local_civil_to_utc_secs<F>(parsed: ParsedLocalDateTime, local_clock: F) -> Option<i64>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32, i32)>,
{
    resolve_local_civil_to_utc_secs_inner(parsed, &local_clock, true)
}

#[cfg(not(target_arch = "wasm32"))]
fn resolve_local_civil_to_utc_secs_inner<F>(
    parsed: ParsedLocalDateTime,
    local_clock: &F,
    allow_fallback: bool,
) -> Option<i64>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32, i32)>,
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
        (target_sod % 60) as i32,
    );
    // Sample 36 hours on either side so every timezone (UTC-12..UTC+14) brackets any DST transition.
    if let (Some(off_before), Some(off_mid), Some(off_after)) = (
        local_offset_secs(target_secs - 129_600, local_clock),
        local_offset_secs(target_secs, local_clock),
        local_offset_secs(target_secs + 129_600, local_clock),
    ) {
        let mut candidates = [
            target_secs - off_before,
            target_secs - off_mid,
            target_secs - off_after,
        ];
        candidates.sort_unstable();
        for cand in candidates {
            if local_clock(cand)? == target_civil {
                return Some(cand);
            }
        }
        // Spring-forward DST gap: shift forward using the pre-transition offset, matching ECMAScript Date.
        return Some(target_secs - off_before);
    }
    if !allow_fallback {
        return None;
    }
    // For extreme years outside the host OS `local_clock` range (e.g. negative years or > 30827),
    // resolve the local timezone offset once using ECMAScript's equivalent Gregorian year (2000..=2027).
    let eq_year = equivalent_gregorian_year(parsed.year);
    let eq_parsed = ParsedLocalDateTime {
        year: eq_year,
        ..parsed
    };
    let eq_target_secs = civil_to_unix_secs(
        eq_parsed.year,
        eq_parsed.month,
        eq_parsed.day,
        eq_parsed.hour,
        eq_parsed.minute,
        eq_parsed.second,
    );
    let eq_utc = resolve_local_civil_to_utc_secs_inner(eq_parsed, local_clock, false)?;
    let offset = eq_target_secs - eq_utc;
    Some(target_secs - offset)
}

#[cfg(not(target_arch = "wasm32"))]
fn format_utc_iso(utc_secs: i64, millis: u32) -> Option<String> {
    const MAX_JS_DATE_MS: i128 = 8_640_000_000_000_000;
    let total_ms = i128::from(utc_secs) * 1000 + i128::from(millis);
    if total_ms.abs() > MAX_JS_DATE_MS {
        return None;
    }
    let days = utc_secs.div_euclid(86_400);
    let sod = utc_secs.rem_euclid(86_400);
    let (uy, um, ud) = civil_from_days(days);
    let uh = sod / 3600;
    let umin = (sod % 3600) / 60;
    let usec = sod % 60;
    if (0..=9999).contains(&uy) {
        Some(format!(
            "{uy:04}-{um:02}-{ud:02}T{uh:02}:{umin:02}:{usec:02}.{millis:03}Z"
        ))
    } else if uy > 9999 {
        Some(format!(
            "+{uy:06}-{um:02}-{ud:02}T{uh:02}:{umin:02}:{usec:02}.{millis:03}Z"
        ))
    } else {
        let abs_y = uy.unsigned_abs();
        Some(format!(
            "-{abs_y:06}-{um:02}-{ud:02}T{uh:02}:{umin:02}:{usec:02}.{millis:03}Z"
        ))
    }
}

pub fn is_local_date_time_without_zone(value: &str) -> bool {
    parse_local_date_time_without_zone(trim_es(value)).is_some()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn normalize_local_date_time_with_clock<F>(value: &str, local_clock: F) -> Option<String>
where
    F: Fn(i64) -> Option<(i32, i32, i32, i32, i32, i32)>,
{
    let parsed = parse_local_date_time_without_zone(trim_es(value))?;
    let utc_secs = resolve_local_civil_to_utc_secs(parsed, local_clock)?;
    format_utc_iso(utc_secs, parsed.millis)
}

#[allow(dead_code)]
fn format_iso_year(year: i64) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year > 9999 {
        format!("+{year:06}")
    } else {
        format!("-{:06}", year.unsigned_abs())
    }
}

/// Format a parsed timezone-less local date-time into canonical ECMAScript padded ISO-8601 local
/// syntax (`YYYY-MM-DDTHH:mm:ss.sss` or `±YYYYYY-MM-DDTHH:mm:ss.sss`) so desktop and wasm32 share
/// one exact grammar before converting local time to UTC.
#[allow(dead_code)]
fn format_canonical_local_iso(parsed: ParsedLocalDateTime) -> Option<String> {
    let local_secs = civil_to_unix_secs(
        parsed.year,
        parsed.month,
        parsed.day,
        parsed.hour,
        parsed.minute,
        parsed.second,
    );
    let days = local_secs.div_euclid(86_400);
    let sod = local_secs.rem_euclid(86_400);
    let (ly, lm, ld) = civil_from_days(days);
    let lh = sod / 3600;
    let lmin = (sod % 3600) / 60;
    let lsec = sod % 60;
    let y = format_iso_year(ly);
    Some(format!(
        "{y}-{lm:02}-{ld:02}T{lh:02}:{lmin:02}:{lsec:02}.{:03}",
        parsed.millis
    ))
}

#[cfg(test)]
pub(crate) fn canonical_local_date_time_iso(value: &str) -> Option<String> {
    format_canonical_local_iso(parse_local_date_time_without_zone(trim_es(value))?)
}

/// Convert an edited timezone-less local date-time (e.g. `2026-11-26T14:30` or `2026-2-3T4:30`) to
/// UTC RFC 3339 (`...Z`), matching CodeNomad UI's `normalizeFormStringValue`. Returns `None` when
/// `value` is not a local timezone-less date-time (explicit offsets, date-only values, or invalid
/// strings).
pub fn normalize_edited_local_date_time(value: &str) -> Option<String> {
    let trimmed = trim_es(value);
    let parsed = parse_local_date_time_without_zone(trimmed)?;
    #[cfg(target_arch = "wasm32")]
    {
        let canonical = format_canonical_local_iso(parsed)?;
        let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_str(&canonical));
        if !d.get_time().is_finite() {
            return None;
        }
        d.to_iso_string().as_string()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let utc_secs =
            resolve_local_civil_to_utc_secs(parsed, codenomad_host_process::local_clock_seconds)?;
        format_utc_iso(utc_secs, parsed.millis)
    }
}

struct ParsedDateTime {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    millis: u32,
    tz_offset_ms: Option<i64>,
    has_time: bool,
}

fn parse_tz_offset_ms(raw: &str, allow_short_offset: bool) -> Option<Option<i64>> {
    let tz_raw = raw.trim();
    if tz_raw.is_empty() {
        return Some(None);
    }
    let (tz, has_paren) = if let Some(paren_idx) = tz_raw.find('(') {
        if !tz_raw.ends_with(')') {
            return None;
        }
        let inner = &tz_raw[paren_idx + 1..tz_raw.len() - 1];
        if inner.is_empty()
            || inner
                .chars()
                .any(|c| c == '(' || c == ')' || c.is_control())
        {
            return None;
        }
        (tz_raw[..paren_idx].trim_end(), true)
    } else {
        (tz_raw, false)
    };
    if tz.is_empty() {
        return has_paren.then_some(None);
    }
    if !tz.is_ascii() {
        return None;
    }
    if tz.eq_ignore_ascii_case("Z")
        || tz.eq_ignore_ascii_case("GMT")
        || tz.eq_ignore_ascii_case("UTC")
        || tz.eq_ignore_ascii_case("UT")
    {
        return Some(Some(0));
    }
    match tz.to_ascii_uppercase().as_str() {
        "EDT" => return Some(Some(-4 * 3_600_000)),
        "EST" | "CDT" => return Some(Some(-5 * 3_600_000)),
        "CST" | "MDT" => return Some(Some(-6 * 3_600_000)),
        "MST" | "PDT" => return Some(Some(-7 * 3_600_000)),
        "PST" => return Some(Some(-8 * 3_600_000)),
        _ => {}
    }
    let tz_offset_part = if tz.len() > 3
        && (tz[..3].eq_ignore_ascii_case("GMT") || tz[..3].eq_ignore_ascii_case("UTC"))
    {
        &tz[3..]
    } else {
        tz
    };
    let rb = tz_offset_part.as_bytes();
    let (sign, tz_h_str, tz_m_str) =
        if rb.len() == 6 && matches!(rb[0], b'+' | b'-') && rb[3] == b':' {
            (
                if rb[0] == b'-' { -1i64 } else { 1i64 },
                &tz_offset_part[1..3],
                &tz_offset_part[4..6],
            )
        } else if rb.len() == 5 && matches!(rb[0], b'+' | b'-') {
            (
                if rb[0] == b'-' { -1i64 } else { 1i64 },
                &tz_offset_part[1..3],
                &tz_offset_part[3..5],
            )
        } else if (rb.len() == 2 || rb.len() == 3)
            && matches!(rb[0], b'+' | b'-')
            && (allow_short_offset || tz_offset_part.len() < tz.len())
        {
            (
                if rb[0] == b'-' { -1i64 } else { 1i64 },
                &tz_offset_part[1..],
                "00",
            )
        } else {
            return None;
        };
    let tz_h = parse_ascii_digits(tz_h_str)?;
    let tz_m = parse_ascii_digits(tz_m_str)?;
    if tz_h > 23 || tz_m > 59 {
        return None;
    }
    Some(Some(
        sign * (i64::from(tz_h) * 3600 + i64::from(tz_m) * 60) * 1000,
    ))
}

fn parse_time_and_tz(rest: &str, allow_legacy: bool) -> Option<(u32, u32, u32, u32, Option<i64>)> {
    let (mut hour, after_hour) = take_1_or_2_digits(rest)?;
    let after_h_colon = after_hour.strip_prefix(':')?;
    let (minute, mut tail) = take_1_or_2_digits(after_h_colon)?;
    let mut second = 0u32;
    let mut millis = 0u32;
    if let Some(after_colon) = tail.strip_prefix(':') {
        let (sec, after_sec) = take_1_or_2_digits(after_colon)?;
        if sec > 59 {
            return None;
        }
        second = sec;
        tail = after_sec;
        if let Some(after_dot) = tail.strip_prefix('.') {
            let frac_len = after_dot.bytes().take_while(u8::is_ascii_digit).count();
            if frac_len == 0 {
                return None;
            }
            let frac = &after_dot[..frac_len];
            let mut m = 0u32;
            for i in 0..3 {
                let d = frac.as_bytes().get(i).copied().unwrap_or(b'0') - b'0';
                m = m * 10 + u32::from(d);
            }
            millis = m;
            tail = &after_dot[frac_len..];
        }
    }
    let mut has_ampm = false;
    if allow_legacy && tail.as_bytes().first().is_some_and(u8::is_ascii_whitespace) {
        let trimmed = tail.trim_start();
        let after_meridiem = if trimmed
            .as_bytes()
            .get(..2)
            .is_some_and(|p| p.eq_ignore_ascii_case(b"AM"))
        {
            let rem = &trimmed[2..];
            if rem.is_empty() || rem.as_bytes()[0].is_ascii_whitespace() {
                has_ampm = true;
                if hour > 12 {
                    return None;
                }
                if hour == 12 {
                    hour = 0;
                }
                Some(rem)
            } else {
                None
            }
        } else if trimmed
            .as_bytes()
            .get(..2)
            .is_some_and(|p| p.eq_ignore_ascii_case(b"PM"))
        {
            let rem = &trimmed[2..];
            if rem.is_empty() || rem.as_bytes()[0].is_ascii_whitespace() {
                has_ampm = true;
                if hour > 12 {
                    return None;
                }
                if hour != 12 {
                    hour += 12;
                }
                Some(rem)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(rem) = after_meridiem {
            tail = rem;
        }
    }
    if minute > 59 {
        return None;
    }
    if !has_ampm && (hour > 24 || (hour == 24 && (minute != 0 || second != 0 || millis != 0))) {
        return None;
    }
    let tz_offset_ms = parse_tz_offset_ms(tail, allow_legacy)?;
    Some((hour, minute, second, millis, tz_offset_ms))
}

fn parse_month_name(tok: &str) -> Option<u32> {
    match tok.to_ascii_lowercase().as_str() {
        "jan" | "january" => Some(1),
        "feb" | "february" => Some(2),
        "mar" | "march" => Some(3),
        "apr" | "april" => Some(4),
        "may" => Some(5),
        "jun" | "june" => Some(6),
        "jul" | "july" => Some(7),
        "aug" | "august" => Some(8),
        "sep" | "sept" | "september" => Some(9),
        "oct" | "october" => Some(10),
        "nov" | "november" => Some(11),
        "dec" | "december" => Some(12),
        _ => None,
    }
}

fn is_weekday_name(tok: &str) -> bool {
    matches!(
        tok.to_ascii_lowercase().as_str(),
        "mon"
            | "monday"
            | "tue"
            | "tues"
            | "tuesday"
            | "wed"
            | "wednesday"
            | "thu"
            | "thur"
            | "thurs"
            | "thursday"
            | "fri"
            | "friday"
            | "sat"
            | "saturday"
            | "sun"
            | "sunday"
    )
}

fn parse_year_2_or_4(tok: &str) -> Option<i64> {
    let v = parse_ascii_digits(tok)?;
    match tok.len() {
        4 => Some(i64::from(v)),
        2 => Some(if v < 50 {
            2000 + i64::from(v)
        } else {
            1900 + i64::from(v)
        }),
        _ => None,
    }
}

fn split_first_date_token(s: &str) -> (&str, &str) {
    let idx = s
        .bytes()
        .position(|b| matches!(b, b' ' | b'\t' | b'T' | b't' | b','))
        .unwrap_or(s.len());
    (&s[..idx], &s[idx..])
}

fn parse_numeric_date_time(s: &str) -> Option<ParsedDateTime> {
    let (date_part, after_date) = split_first_date_token(s);
    let sep = if date_part.contains('/') {
        '/'
    } else if date_part.contains('-') {
        '-'
    } else if date_part.contains('.') {
        '.'
    } else {
        return None;
    };
    let mut parts = date_part.split(sep);
    let (Some(p1), Some(p2), Some(p3), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let (year, month, day) = if p1.len() == 4 && sep != '-' {
        let year = i64::from(parse_ascii_digits(p1)?);
        if p2.len() > 2 || p3.len() > 2 {
            return None;
        }
        (year, parse_ascii_digits(p2)?, parse_ascii_digits(p3)?)
    } else if p1.len() <= 2 && p2.len() <= 2 {
        let year = parse_year_2_or_4(p3)?;
        (year, parse_ascii_digits(p1)?, parse_ascii_digits(p2)?)
    } else {
        return None;
    };
    // JavaScript `new Date(...)` accepts days 1..=31 for any valid month (rolling overflow
    // days into the next month) and rejects day 0 or day >= 32.
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let tail = after_date
        .strip_prefix(',')
        .unwrap_or(after_date)
        .trim_start();
    let tail = tail
        .strip_prefix('T')
        .or_else(|| tail.strip_prefix('t'))
        .unwrap_or(tail);
    let (hour, minute, second, millis, tz_offset_ms, has_time) = if tail.is_empty() {
        (0, 0, 0, 0, None, false)
    } else {
        let (h, m, sec, ms, tz) = parse_time_and_tz(tail, true)?;
        (h, m, sec, ms, tz, true)
    };
    let sod_ms = (i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second)) * 1000
        + i64::from(millis);
    if !within_js_date_range(year, month, day, sod_ms, tz_offset_ms.unwrap_or(0)) {
        return None;
    }
    Some(ParsedDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millis,
        tz_offset_ms,
        has_time,
    })
}

fn next_date_piece(s: &str) -> Option<(&str, &str)> {
    let trimmed = s.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
    if trimmed.is_empty() {
        return None;
    }
    let end = trimmed
        .bytes()
        .position(|b| b.is_ascii_whitespace() || b == b',' || b == b'-')
        .unwrap_or(trimmed.len());
    if end == 0 {
        return None;
    }
    let tok = &trimmed[..end];
    let rest = &trimmed[end..];
    let rest = rest.strip_prefix('-').unwrap_or(rest);
    Some((tok, rest))
}

fn parse_named_month_date_time(s: &str) -> Option<ParsedDateTime> {
    let mut rest = s;
    let (mut t1, r1) = next_date_piece(rest)?;
    if is_weekday_name(t1) {
        rest = r1;
        let (nt, nr) = next_date_piece(rest)?;
        t1 = nt;
        rest = nr;
    } else {
        rest = r1;
    }
    let (t2, r2) = next_date_piece(rest)?;
    let (t3, r3) = next_date_piece(r2)?;
    let (year, month, day) = if let Some(m) = parse_month_name(t1) {
        // `Nov 26, 2026` or `Thu Nov 26 2026 ...`
        if t2.len() > 2 {
            return None;
        }
        (parse_year_2_or_4(t3)?, m, parse_ascii_digits(t2)?)
    } else if let Some(m) = parse_month_name(t2) {
        if t1.len() == 4 && t3.len() <= 2 {
            // `2026 Nov 26`
            (
                i64::from(parse_ascii_digits(t1)?),
                m,
                parse_ascii_digits(t3)?,
            )
        } else if t1.len() <= 2 {
            // `26 Nov 2026` / `Thu, 26 Nov 2026 14:30:00 GMT`
            (parse_year_2_or_4(t3)?, m, parse_ascii_digits(t1)?)
        } else {
            return None;
        }
    } else {
        return None;
    };
    if !(1..=31).contains(&day) {
        return None;
    }
    let tail = r3.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
    let (hour, minute, second, millis, tz_offset_ms, has_time) = if tail.is_empty() {
        (0, 0, 0, 0, None, false)
    } else {
        let (h, m, sec, ms, tz) = parse_time_and_tz(tail, true)?;
        (h, m, sec, ms, tz, true)
    };
    let sod_ms = (i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second)) * 1000
        + i64::from(millis);
    if !within_js_date_range(year, month, day, sod_ms, tz_offset_ms.unwrap_or(0)) {
        return None;
    }
    Some(ParsedDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millis,
        tz_offset_ms,
        has_time,
    })
}

fn parse_iso_year_prefix(s: &str) -> Option<(i64, usize)> {
    let b = s.as_bytes();
    if b.len() >= 7 && matches!(b[0], b'+' | b'-') && b[1..7].iter().all(u8::is_ascii_digit) {
        let digits = &s[1..7];
        let mag = digits.parse::<i64>().ok()?;
        if b[0] == b'-' && mag == 0 {
            // ECMAScript Date treats `-000000` as invalid (`NaN`).
            return None;
        }
        let year = if b[0] == b'-' { -mag } else { mag };
        return Some((year, 7));
    }
    if b.len() >= 4
        && b[0..4].iter().all(u8::is_ascii_digit)
        && let Some(year) = parse_ascii_digits(&s[0..4])
    {
        return Some((i64::from(year), 4));
    }
    None
}

fn take_1_or_2_digits(s: &str) -> Option<(u32, &str)> {
    let len = s.bytes().take(2).take_while(u8::is_ascii_digit).count();
    if len == 0 {
        return None;
    }
    Some((parse_ascii_digits(&s[..len])?, &s[len..]))
}

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
    // Require ASCII on the date/time portion before any trailing `(...)` timezone comment so
    // localized timezone names (e.g. `GMT+0100 (GMT+01:00)` or non-ASCII CLDR names) pass safely.
    let prefix = s.find('(').map_or(s, |idx| &s[..idx]);
    if !prefix.is_ascii() {
        return false;
    }
    // Use one deterministic parser across desktop and wasm32 so both targets agree on every
    // ISO-8601 (including reduced-precision YYYY / YYYY-MM with time), numeric slash/hyphen, and
    // RFC 2822 / month-name date-time string.
    if let Some((year, ylen)) = parse_iso_year_prefix(s) {
        let rest_after_year = &s[ylen..];
        if rest_after_year.is_empty() {
            return within_js_date_range(year, 1, 1, 0, 0);
        }
        let first = rest_after_year.as_bytes()[0];
        if first == b'-' {
            let after_y_dash = &rest_after_year[1..];
            let Some((month, after_month)) = take_1_or_2_digits(after_y_dash) else {
                return false;
            };
            if !(1..=12).contains(&month) {
                return false;
            }
            if after_month.is_empty() {
                return within_js_date_range(year, month, 1, 0, 0);
            }
            let (day, after_date) = if let Some(after_m_dash) = after_month.strip_prefix('-') {
                let Some((day, after_d)) = take_1_or_2_digits(after_m_dash) else {
                    return false;
                };
                if !(1..=31).contains(&day) {
                    return false;
                }
                (day, after_d)
            } else {
                (1, after_month)
            };
            if after_date.is_empty() {
                return within_js_date_range(year, month, day, 0, 0);
            }
            return parse_iso_time_tail(year, month, day, after_date);
        }
        if matches!(first, b'T' | b't') {
            return parse_iso_time_tail(year, 1, 1, rest_after_year);
        }
        if matches!(first, b' ' | b',') && parse_iso_time_tail(year, 1, 1, rest_after_year) {
            return true;
        }
    }
    parse_numeric_date_time(s).is_some() || parse_named_month_date_time(s).is_some()
}

fn parse_iso_time_tail(year: i64, month: u32, day: u32, after_date: &str) -> bool {
    let b = after_date.as_bytes();
    if b.is_empty() {
        return within_js_date_range(year, month, day, 0, 0);
    }
    let (time_rest, allow_ampm) = if matches!(b[0], b'T' | b't') {
        (&after_date[1..], false)
    } else if matches!(b[0], b' ' | b',') {
        let trimmed = after_date
            .strip_prefix(',')
            .unwrap_or(after_date)
            .trim_start();
        if trimmed.is_empty() {
            return false;
        }
        (trimmed, true)
    } else {
        return false;
    };
    let Some((hour, minute, second, millis, tz_offset_ms)) =
        parse_time_and_tz(time_rest, allow_ampm)
    else {
        return false;
    };
    let sod_ms = (i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second)) * 1000
        + i64::from(millis);
    within_js_date_range(year, month, day, sod_ms, tz_offset_ms.unwrap_or(0))
}

fn has_date_time_defer_cue(s: &str) -> bool {
    let prefix = s.find('(').map_or(s, |idx| &s[..idx]);
    let bytes = prefix.as_bytes();
    let has_signed_offset = bytes
        .windows(2)
        .any(|w| matches!(w[0], b'+' | b'-') && w[1].is_ascii_digit());
    let has_clock_colon = bytes
        .windows(3)
        .any(|w| w[0].is_ascii_digit() && w[1] == b':' && w[2].is_ascii_digit());
    prefix
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| {
            parse_month_name(tok).is_some()
                || tok.eq_ignore_ascii_case("GMT")
                || tok.eq_ignore_ascii_case("UTC")
                || tok.eq_ignore_ascii_case("UT")
                || tok.eq_ignore_ascii_case("AM")
                || tok.eq_ignore_ascii_case("PM")
                || matches!(
                    tok.to_ascii_uppercase().as_str(),
                    "EST" | "EDT" | "CST" | "CDT" | "MST" | "MDT" | "PST" | "PDT"
                )
        })
        || has_signed_offset
        || has_clock_colon
        || (s.contains('(') && s.ends_with(')'))
}

fn has_invalid_clock_time(s: &str) -> bool {
    let trimmed = s.strip_prefix(',').unwrap_or(s).trim_start();
    let Some((hour, after_hour)) = take_1_or_2_digits(trimmed) else {
        return false;
    };
    let Some(after_h_colon) = after_hour.strip_prefix(':') else {
        return false;
    };
    let Some((minute, mut tail)) = take_1_or_2_digits(after_h_colon) else {
        return true;
    };
    let mut second = 0u32;
    if let Some(after_colon) = tail.strip_prefix(':') {
        let Some((sec, after_sec)) = take_1_or_2_digits(after_colon) else {
            return true;
        };
        if sec > 59 {
            return true;
        }
        second = sec;
        tail = after_sec;
    }
    if minute > 59 || hour > 24 || (hour == 24 && (minute != 0 || second != 0)) {
        return true;
    }
    if tail.as_bytes().first().is_some_and(u8::is_ascii_whitespace) {
        let rem = tail.trim_start();
        let is_ampm = rem.as_bytes().get(..2).is_some_and(|p| {
            (p.eq_ignore_ascii_case(b"AM") || p.eq_ignore_ascii_case(b"PM"))
                && rem.as_bytes().get(2).is_none_or(u8::is_ascii_whitespace)
        });
        if is_ampm && hour > 12 {
            return true;
        }
    }
    false
}

fn looks_like_rejected_known_date_shape(s: &str) -> bool {
    if s.starts_with("-000000") {
        return true;
    }
    // Reject invalid ISO dates (invalid month/day/range/time), except valid ISO dates with a
    // space/comma tail carrying timezone/meridiem/parenthesized cues that JS `Date` can accept.
    if let Some((_year, ylen)) = parse_iso_year_prefix(s) {
        let tail = &s.as_bytes()[ylen..];
        if tail.is_empty() || tail[0] == b'-' {
            let deferrable_iso_tail = s[ylen..]
                .strip_prefix('-')
                .and_then(take_1_or_2_digits)
                .filter(|&(m, _)| (1..=12).contains(&m))
                .and_then(|(_m, rest)| {
                    if let Some(after_m_dash) = rest.strip_prefix('-') {
                        take_1_or_2_digits(after_m_dash)
                            .filter(|&(d, _)| (1..=31).contains(&d))
                            .map(|(_, after_d)| after_d)
                    } else {
                        Some(rest)
                    }
                })
                .is_some_and(|after_d| {
                    let sep_ok = after_d.starts_with(' ') || after_d.starts_with(',');
                    if !sep_ok {
                        return false;
                    }
                    let trimmed = after_d.strip_prefix(',').unwrap_or(after_d).trim_start();
                    parse_tz_offset_ms(trimmed, true).is_some()
                        || (!has_invalid_clock_time(trimmed) && has_date_time_defer_cue(trimmed))
                });
            return !deferrable_iso_tail;
        }
    }
    // Reject invalid numeric `A/B/C` or `A-B-C` dates (`99/99/2026`, `2/32/2026`, `13-01-2026`),
    // while deferring valid numeric dates with unrecognized non-ISO time/offset tails.
    let (date_part, after_date) = split_first_date_token(s);
    let first_sep = date_part.bytes().position(|b| matches!(b, b'/' | b'-'));
    if let Some(sep_idx) = first_sep
        && sep_idx > 0
        && date_part.as_bytes()[..sep_idx]
            .iter()
            .all(u8::is_ascii_digit)
    {
        let sep = date_part.as_bytes()[sep_idx];
        let rest = &date_part[sep_idx + 1..];
        if let Some(second_sep) = rest.bytes().position(|b| b == sep)
            && second_sep > 0
            && rest.as_bytes()[..second_sep].iter().all(u8::is_ascii_digit)
        {
            let p1 = &date_part[..sep_idx];
            let p2 = &rest[..second_sep];
            let p3 = &rest[second_sep + 1..];
            let valid_triple = if p1.len() == 4 && sep != b'-' {
                parse_ascii_digits(p1)
                    .zip(parse_ascii_digits(p2))
                    .zip(parse_ascii_digits(p3))
                    .filter(|&((_, m), _)| p2.len() <= 2 && p3.len() <= 2 && (1..=12).contains(&m))
                    .is_some_and(|((_, _), d)| (1..=31).contains(&d))
            } else if p1.len() <= 2 && p2.len() <= 2 {
                parse_ascii_digits(p1)
                    .zip(parse_ascii_digits(p2))
                    .zip(parse_year_2_or_4(p3))
                    .filter(|&((m, _), _)| (1..=12).contains(&m))
                    .is_some_and(|((_, d), _)| (1..=31).contains(&d))
            } else {
                false
            };
            let trimmed_tail = after_date
                .strip_prefix(',')
                .unwrap_or(after_date)
                .trim_start();
            let deferrable_tail = valid_triple
                && !trimmed_tail.is_empty()
                && !has_invalid_clock_time(trimmed_tail)
                && has_date_time_defer_cue(trimmed_tail);
            return !deferrable_tail;
        }
    }
    // Reject 3-token named-month dates with impossible days (`Jan 99, 2026`, `Feb 32, 2026`).
    if let Some((mut t1, mut rest)) = next_date_piece(s) {
        if is_weekday_name(t1) {
            if let Some((nt, nr)) = next_date_piece(rest) {
                t1 = nt;
                rest = nr;
            }
        }
        if let Some((t2, r2)) = next_date_piece(rest)
            && let Some((t3, _)) = next_date_piece(r2)
        {
            let day_year = if let Some(m) = parse_month_name(t1) {
                parse_ascii_digits(t2)
                    .zip(parse_year_2_or_4(t3))
                    .map(|(d, y)| (y, m, d))
            } else if let Some(m) = parse_month_name(t2) {
                if t1.len() == 4 {
                    parse_ascii_digits(t1)
                        .zip(parse_ascii_digits(t3))
                        .map(|(y, d)| (i64::from(y), m, d))
                } else {
                    parse_ascii_digits(t1)
                        .zip(parse_year_2_or_4(t3))
                        .map(|(d, y)| (y, m, d))
                }
            } else {
                None
            };
            if let Some((_y, _m, d)) = day_year
                && !(1..=31).contains(&d)
            {
                return true;
            }
        }
    }
    false
}

fn classify_date_time(value: &str) -> MatchOutcome {
    let s = trim_es(value);
    let prefix = s.find('(').map_or(s, |idx| &s[..idx]);
    if s.is_empty() || !prefix.is_ascii() || !prefix.bytes().any(|b| b.is_ascii_digit()) {
        return MatchOutcome::NoMatch;
    }
    if is_valid_date_time(s) {
        return MatchOutcome::Matched;
    }
    if looks_like_rejected_known_date_shape(s) {
        return MatchOutcome::NoMatch;
    }
    // Defer unclassified JS Date-like formats (e.g. `Jan 1970`, `1970-01-01 GMT+0100`, or exotic
    // parenthesized timezone annotations) to OpenCode rather than falsely rejecting valid defaults.
    if has_date_time_defer_cue(s) {
        MatchOutcome::Deferred
    } else {
        MatchOutcome::NoMatch
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

    fn matches_icase(&self, u: u16) -> bool {
        match *self {
            Self::Single(x) => eq_u16_icase(u, x),
            Self::Range(lo, hi) => {
                if u >= lo && u <= hi {
                    return true;
                }
                if hi < 128 {
                    if u >= 128 {
                        return false;
                    }
                    let b = u as u8;
                    let cu = u16::from(b.to_ascii_uppercase());
                    let cl = u16::from(b.to_ascii_lowercase());
                    return (cu >= lo && cu <= hi) || (cl >= lo && cl <= hi);
                }
                let cu = es_canonicalize_u16(u);
                (lo..=hi).any(|c| es_canonicalize_u16(c) == cu)
            }
            other => other.matches(u),
        }
    }
}

/// ECMAScript flagless `Canonicalize(ch)` (ECMA-262 22.2.2.8.2): uppercase to a single BMP code
/// unit unless a non-ASCII character would fold into ASCII (e.g. U+017F `ſ` or U+212A `K`).
fn es_canonicalize_u16(u: u16) -> u16 {
    if u < 128 {
        return u16::from((u as u8).to_ascii_uppercase());
    }
    let Some(ch) = char::from_u32(u32::from(u)) else {
        return u;
    };
    let mut upper = ch.to_uppercase();
    let (Some(up), None) = (upper.next(), upper.next()) else {
        return u;
    };
    let up_u32 = u32::from(up);
    if up_u32 < 128 || up_u32 > 0xFFFF {
        return u;
    }
    up_u32 as u16
}

fn eq_u16_icase(a: u16, b: u16) -> bool {
    a == b || es_canonicalize_u16(a) == es_canonicalize_u16(b)
}

fn is_line_terminator_u16(u: u16) -> bool {
    matches!(u, 0x000A | 0x000D | 0x2028 | 0x2029)
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

enum CaptureNameKind {
    Valid(String),
    Defer,
    Invalid,
}

fn decode_capture_name_units(slice: &[u16]) -> Result<Vec<u32>, CaptureNameKind> {
    let mut cps = Vec::with_capacity(slice.len());
    let mut i = 0;
    while i < slice.len() {
        let u = slice[i];
        if u == b'\\' as u16 {
            if slice.get(i + 1).copied() != Some(b'u' as u16) {
                return Err(CaptureNameKind::Invalid);
            }
            if slice.get(i + 2).copied() == Some(b'{' as u16) {
                let mut j = i + 3;
                let mut val: u32 = 0;
                let mut digits = 0usize;
                while j < slice.len() && slice[j] != b'}' as u16 {
                    let Some(h) = hex_nibble_u16(slice[j]) else {
                        return Err(CaptureNameKind::Invalid);
                    };
                    digits += 1;
                    val = val.saturating_mul(16).saturating_add(u32::from(h));
                    if val > 0x10_FFFF {
                        return Err(CaptureNameKind::Invalid);
                    }
                    j += 1;
                }
                if digits == 0 || slice.get(j).copied() != Some(b'}' as u16) {
                    return Err(CaptureNameKind::Invalid);
                }
                cps.push(val);
                i = j + 1;
            } else {
                if i + 6 > slice.len() {
                    return Err(CaptureNameKind::Invalid);
                }
                let mut val: u16 = 0;
                for &d in &slice[i + 2..i + 6] {
                    let Some(h) = hex_nibble_u16(d) else {
                        return Err(CaptureNameKind::Invalid);
                    };
                    val = (val << 4) | h;
                }
                i += 6;
                if (0xD800..=0xDBFF).contains(&val)
                    && i + 6 <= slice.len()
                    && slice[i] == b'\\' as u16
                    && slice[i + 1] == b'u' as u16
                    && slice[i + 2] != b'{' as u16
                {
                    let mut low: u16 = 0;
                    let mut ok_low = true;
                    for &d in &slice[i + 2..i + 6] {
                        if let Some(h) = hex_nibble_u16(d) {
                            low = (low << 4) | h;
                        } else {
                            ok_low = false;
                            break;
                        }
                    }
                    if ok_low && (0xDC00..=0xDFFF).contains(&low) {
                        let cp = 0x1_0000
                            + ((u32::from(val) - 0xD800) << 10)
                            + (u32::from(low) - 0xDC00);
                        cps.push(cp);
                        i += 6;
                        continue;
                    }
                }
                if (0xD800..=0xDFFF).contains(&val) {
                    return Err(CaptureNameKind::Defer);
                }
                cps.push(u32::from(val));
            }
        } else if (0xD800..=0xDBFF).contains(&u) {
            let Some(&low) = slice.get(i + 1) else {
                return Err(CaptureNameKind::Defer);
            };
            if !(0xDC00..=0xDFFF).contains(&low) {
                return Err(CaptureNameKind::Defer);
            }
            let cp = 0x1_0000 + ((u32::from(u) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
            cps.push(cp);
            i += 2;
        } else if (0xDC00..=0xDFFF).contains(&u) {
            return Err(CaptureNameKind::Defer);
        } else {
            cps.push(u32::from(u));
            i += 1;
        }
    }
    Ok(cps)
}

fn classify_capture_name(slice: &[u16]) -> CaptureNameKind {
    if slice.is_empty() {
        return CaptureNameKind::Invalid;
    }
    let cps = match decode_capture_name_units(slice) {
        Ok(cps) => cps,
        Err(kind) => return kind,
    };
    let mut out = String::with_capacity(cps.len());
    for (idx, cp) in cps.into_iter().enumerate() {
        let Some(ch) = char::from_u32(cp) else {
            return CaptureNameKind::Defer;
        };
        if idx == 0 {
            if ch.is_ascii() {
                if !(ch == '_' || ch == '$' || ch.is_ascii_alphabetic()) {
                    return CaptureNameKind::Invalid;
                }
            } else if !ch.is_alphabetic() {
                return CaptureNameKind::Defer;
            }
        } else if ch.is_ascii() {
            if !(ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()) {
                return CaptureNameKind::Invalid;
            }
        } else if !(ch.is_alphanumeric() || matches!(ch, '\u{200C}' | '\u{200D}')) {
            return CaptureNameKind::Defer;
        }
        out.push(ch);
    }
    CaptureNameKind::Valid(out)
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
    Capture {
        index: usize,
        inner: Box<Expr>,
    },
    Backref(usize),
    NamedBackref(String),
    Lookaround {
        positive: bool,
        behind: bool,
        inner: Box<Expr>,
    },
    Flags {
        ignore_case: Option<bool>,
        multiline: Option<bool>,
        dot_all: Option<bool>,
        inner: Box<Expr>,
    },
    Concat(Vec<Expr>),
    Alt(Vec<Expr>),
    Repeat {
        inner: Box<Expr>,
        min: usize,
        max: Option<usize>,
        lazy: bool,
    },
}

struct Parser {
    units: Vec<u16>,
    pos: usize,
    depth: usize,
    nodes: usize,
    captures: usize,
    named_captures: HashMap<String, usize>,
    has_named_captures: bool,
    malformed_k_escape: bool,
    needs_backtrack: bool,
    deferred: bool,
}

impl Parser {
    fn new(src: &str) -> Self {
        Self {
            units: src.encode_utf16().collect(),
            pos: 0,
            depth: 0,
            nodes: 0,
            captures: 0,
            named_captures: HashMap::new(),
            has_named_captures: false,
            malformed_k_escape: false,
            needs_backtrack: false,
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

    fn parse(mut self) -> Result<(Expr, usize, bool, bool), CompileError> {
        let mut expr = self.parse_alt()?;
        if self.pos != self.units.len() {
            return Err(CompileError::InvalidSyntax);
        }
        if self.has_named_captures && self.malformed_k_escape {
            return Err(CompileError::InvalidSyntax);
        }
        resolve_backrefs(
            &mut expr,
            self.captures,
            &self.named_captures,
            self.has_named_captures,
            &mut self.deferred,
        )?;
        Ok((expr, self.captures, self.needs_backtrack, self.deferred))
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
        let lazy = if self.peek() == Some(b'?' as u16) {
            self.pos += 1;
            true
        } else {
            false
        };
        if self
            .peek()
            .is_some_and(|u| u == b'*' as u16 || u == b'+' as u16 || u == b'?' as u16)
            || self.try_parse_brace_quantifier()?.is_some()
        {
            return Err(CompileError::InvalidSyntax);
        }
        self.charge_node()?;
        if (min == 0 && max == Some(0) && !expr_has_captures_or_backrefs(&expr))
            || matches!(expr, Expr::Empty)
        {
            Ok(Expr::Empty)
        } else {
            Ok(Expr::Repeat {
                inner: Box::new(expr),
                min,
                max,
                lazy,
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
            return Ok(Some((min, max)));
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
                enum GroupKind {
                    NonCapturing,
                    Capture(usize),
                    Lookaround {
                        positive: bool,
                        behind: bool,
                    },
                    Flags {
                        ignore_case: Option<bool>,
                        multiline: Option<bool>,
                        dot_all: Option<bool>,
                    },
                }
                let kind = if self.peek() == Some(b'?' as u16) {
                    self.pos += 1;
                    match self.peek() {
                        Some(ch) if ch == b':' as u16 => {
                            self.pos += 1;
                            GroupKind::NonCapturing
                        }
                        Some(ch) if ch == b'=' as u16 || ch == b'!' as u16 => {
                            let positive = ch == b'=' as u16;
                            self.pos += 1;
                            self.needs_backtrack = true;
                            GroupKind::Lookaround {
                                positive,
                                behind: false,
                            }
                        }
                        Some(ch) if ch == b'<' as u16 => {
                            self.pos += 1;
                            if matches!(self.peek(), Some(c) if c == b'=' as u16 || c == b'!' as u16)
                            {
                                let positive = self.peek() == Some(b'=' as u16);
                                self.pos += 1;
                                self.needs_backtrack = true;
                                GroupKind::Lookaround {
                                    positive,
                                    behind: true,
                                }
                            } else {
                                let name_start = self.pos;
                                while let Some(c) = self.peek() {
                                    if c == b'>' as u16 {
                                        break;
                                    }
                                    self.pos += 1;
                                }
                                let name_end = self.pos;
                                if name_end == name_start || self.next() != Some(b'>' as u16) {
                                    return Err(CompileError::InvalidSyntax);
                                }
                                let name_slice = &self.units[name_start..name_end];
                                match classify_capture_name(name_slice) {
                                    CaptureNameKind::Valid(name) => {
                                        self.has_named_captures = true;
                                        self.captures += 1;
                                        let idx = self.captures;
                                        if self.named_captures.insert(name, idx).is_some() {
                                            // ES2025 allows duplicate capture group names in
                                            // disjoint alternatives; defer to OpenCode instead of
                                            // binding `\k<name>` to only one capture slot.
                                            self.deferred = true;
                                        }
                                        GroupKind::Capture(idx)
                                    }
                                    CaptureNameKind::Defer => {
                                        self.has_named_captures = true;
                                        self.deferred = true;
                                        self.captures += 1;
                                        GroupKind::Capture(self.captures)
                                    }
                                    CaptureNameKind::Invalid => {
                                        return Err(CompileError::InvalidSyntax);
                                    }
                                }
                            }
                        }
                        _ => {
                            let mut seen_dash = false;
                            let mut ignore_case: Option<bool> = None;
                            let mut multiline: Option<bool> = None;
                            let mut dot_all: Option<bool> = None;
                            let mut any_flag = false;
                            let mut closed = false;
                            while let Some(c) = self.peek() {
                                if c == b':' as u16 {
                                    self.pos += 1;
                                    closed = any_flag;
                                    break;
                                }
                                if c == b'-' as u16 && !seen_dash {
                                    seen_dash = true;
                                    self.pos += 1;
                                } else if c == b'i' as u16 {
                                    if ignore_case.is_some() {
                                        return Err(CompileError::InvalidSyntax);
                                    }
                                    ignore_case = Some(!seen_dash);
                                    any_flag = true;
                                    self.pos += 1;
                                } else if c == b'm' as u16 {
                                    if multiline.is_some() {
                                        return Err(CompileError::InvalidSyntax);
                                    }
                                    multiline = Some(!seen_dash);
                                    any_flag = true;
                                    self.pos += 1;
                                } else if c == b's' as u16 {
                                    if dot_all.is_some() {
                                        return Err(CompileError::InvalidSyntax);
                                    }
                                    dot_all = Some(!seen_dash);
                                    any_flag = true;
                                    self.pos += 1;
                                } else {
                                    break;
                                }
                            }
                            if !closed {
                                return Err(CompileError::InvalidSyntax);
                            }
                            self.needs_backtrack = true;
                            GroupKind::Flags {
                                ignore_case,
                                multiline,
                                dot_all,
                            }
                        }
                    }
                } else {
                    self.captures += 1;
                    GroupKind::Capture(self.captures)
                };
                let inner = self.parse_alt()?;
                self.depth -= 1;
                if self.next() != Some(b')' as u16) {
                    return Err(CompileError::InvalidSyntax);
                }
                Ok(match kind {
                    GroupKind::NonCapturing => Expr::Group(Box::new(inner)),
                    GroupKind::Capture(index) => Expr::Capture {
                        index,
                        inner: Box::new(inner),
                    },
                    GroupKind::Lookaround { positive, behind } => {
                        if behind && expr_has_captures_or_backrefs(&inner) {
                            // ECMAScript lookbehinds match right-to-left, which changes greedy
                            // capture allocation (e.g. `(?<=([ab]+)([bc]+))\1`). Defer capture-
                            // bearing lookbehinds to OpenCode instead of applying forward captures.
                            self.deferred = true;
                        }
                        Expr::Lookaround {
                            positive,
                            behind,
                            inner: Box::new(inner),
                        }
                    }
                    GroupKind::Flags {
                        ignore_case,
                        multiline,
                        dot_all,
                    } => Expr::Flags {
                        ignore_case,
                        multiline,
                        dot_all,
                        inner: Box::new(inner),
                    },
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
                let mut val = (u - 0x0030) as usize;
                while let Some(d) = self.peek().filter(|&d| is_digit_u16(d)) {
                    self.pos += 1;
                    val = val.saturating_mul(10).saturating_add((d - 0x0030) as usize);
                }
                self.needs_backtrack = true;
                Ok(Expr::Backref(val))
            }
            x if x == b'k' as u16 => {
                if self.peek() == Some(b'<' as u16) {
                    let saved = self.pos;
                    self.pos += 1;
                    let start = self.pos;
                    while let Some(c) = self.peek() {
                        if c == b'>' as u16 {
                            break;
                        }
                        self.pos += 1;
                    }
                    let end = self.pos;
                    if end == start || self.next() != Some(b'>' as u16) {
                        self.pos = saved;
                        self.malformed_k_escape = true;
                        Ok(Expr::Literal(b'k' as u16))
                    } else {
                        match classify_capture_name(&self.units[start..end]) {
                            CaptureNameKind::Valid(name) => {
                                self.needs_backtrack = true;
                                Ok(Expr::NamedBackref(name))
                            }
                            CaptureNameKind::Defer => {
                                self.deferred = true;
                                Ok(Expr::Empty)
                            }
                            CaptureNameKind::Invalid => {
                                self.pos = saved;
                                self.malformed_k_escape = true;
                                Ok(Expr::Literal(b'k' as u16))
                            }
                        }
                    }
                } else {
                    self.malformed_k_escape = true;
                    Ok(Expr::Literal(b'k' as u16))
                }
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

const MAX_BT_CAPTURES: usize = 64;
const MAX_BT_STACK: usize = 4_096;
const MAX_LOOKAROUND_DEPTH: usize = 16;

#[derive(Clone, Copy, Default)]
struct VmFlags {
    ignore_case: bool,
    multiline: bool,
    dot_all: bool,
}

#[derive(Clone, Debug)]
enum VmInst {
    Literal {
        unit: u16,
        ignore_case: bool,
    },
    Any {
        dot_all: bool,
    },
    Class {
        negated: bool,
        items: Arc<[ClassItem]>,
        ignore_case: bool,
    },
    AssertStart {
        multiline: bool,
    },
    AssertEnd {
        multiline: bool,
    },
    AssertWord(bool),
    SaveStart(usize),
    SaveEnd(usize),
    ClearCaps(usize, usize),
    ZeroGuardStart(usize),
    ZeroGuardEnd(usize),
    Backref {
        index: usize,
        ignore_case: bool,
    },
    Lookaround {
        positive: bool,
        behind: bool,
        sub: Arc<[VmInst]>,
        zero_slots: usize,
    },
    Split(usize, usize),
    Jmp(usize),
    Match,
}

enum Pattern {
    Nfa(Vec<Inst>),
    Backtrack {
        insts: Arc<[VmInst]>,
        captures: usize,
        zero_slots: usize,
    },
}

fn resolve_backrefs(
    expr: &mut Expr,
    captures: usize,
    named: &HashMap<String, usize>,
    has_named_captures: bool,
    deferred: &mut bool,
) -> Result<(), CompileError> {
    match expr {
        Expr::Backref(n) => {
            if *n == 0 || *n > captures {
                *deferred = true;
            }
            Ok(())
        }
        Expr::NamedBackref(name) => {
            if let Some(&idx) = named.get(name) {
                *expr = Expr::Backref(idx);
                Ok(())
            } else if !has_named_captures {
                // In flagless ECMAScript RegExp without named capturing groups, `\k` is a valid
                // identity escape (`^\k<id>$` matches `"k<id>"`). Defer to OpenCode so quantifiers
                // and full Annex B semantics match V8.
                *deferred = true;
                Ok(())
            } else if *deferred {
                Ok(())
            } else {
                Err(CompileError::InvalidSyntax)
            }
        }
        Expr::Group(inner)
        | Expr::Capture { inner, .. }
        | Expr::Lookaround { inner, .. }
        | Expr::Flags { inner, .. }
        | Expr::Repeat { inner, .. } => {
            resolve_backrefs(inner, captures, named, has_named_captures, deferred)
        }
        Expr::Concat(items) | Expr::Alt(items) => {
            for item in items {
                resolve_backrefs(item, captures, named, has_named_captures, deferred)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn expr_has_captures_or_backrefs(expr: &Expr) -> bool {
    match expr {
        Expr::Capture { .. } | Expr::Backref(_) | Expr::NamedBackref(_) => true,
        Expr::Group(inner)
        | Expr::Lookaround { inner, .. }
        | Expr::Flags { inner, .. }
        | Expr::Repeat { inner, .. } => expr_has_captures_or_backrefs(inner),
        Expr::Concat(items) | Expr::Alt(items) => items.iter().any(expr_has_captures_or_backrefs),
        _ => false,
    }
}

fn capture_range(expr: &Expr) -> Option<(usize, usize)> {
    match expr {
        Expr::Capture { index, inner } => {
            let mut lo = *index;
            let mut hi = *index;
            if let Some((ilo, ihi)) = capture_range(inner) {
                lo = lo.min(ilo);
                hi = hi.max(ihi);
            }
            Some((lo, hi))
        }
        Expr::Group(inner)
        | Expr::Lookaround { inner, .. }
        | Expr::Flags { inner, .. }
        | Expr::Repeat { inner, .. } => capture_range(inner),
        Expr::Concat(items) | Expr::Alt(items) => {
            let mut bounds: Option<(usize, usize)> = None;
            for item in items {
                if let Some((ilo, ihi)) = capture_range(item) {
                    bounds = Some(match bounds {
                        Some((lo, hi)) => (lo.min(ilo), hi.max(ihi)),
                        None => (ilo, ihi),
                    });
                }
            }
            bounds
        }
        _ => None,
    }
}

fn push_vm_inst(insts: &mut Vec<VmInst>, inst: VmInst) -> Result<usize, CompileError> {
    if insts.len() >= MAX_STATES {
        return Err(CompileError::DeferToServer);
    }
    let idx = insts.len();
    insts.push(inst);
    Ok(idx)
}

fn compile_vm_expr(
    expr: &Expr,
    flags: VmFlags,
    insts: &mut Vec<VmInst>,
    zero_slots: &mut usize,
    work: &mut usize,
) -> Result<(), CompileError> {
    charge_work(work)?;
    match expr {
        Expr::Empty => Ok(()),
        Expr::Literal(unit) => {
            push_vm_inst(
                insts,
                VmInst::Literal {
                    unit: *unit,
                    ignore_case: flags.ignore_case,
                },
            )?;
            Ok(())
        }
        Expr::Any => {
            push_vm_inst(
                insts,
                VmInst::Any {
                    dot_all: flags.dot_all,
                },
            )?;
            Ok(())
        }
        Expr::Class { negated, items } => {
            if flags.ignore_case
                && items.iter().any(|item| {
                    matches!(
                        *item,
                        ClassItem::Range(lo, hi) if hi >= 128 && hi.saturating_sub(lo) > 64
                    )
                })
            {
                return Err(CompileError::DeferToServer);
            }
            charge_work_n(work, items.len())?;
            push_vm_inst(
                insts,
                VmInst::Class {
                    negated: *negated,
                    items: Arc::clone(items),
                    ignore_case: flags.ignore_case,
                },
            )?;
            Ok(())
        }
        Expr::AssertStart => {
            push_vm_inst(
                insts,
                VmInst::AssertStart {
                    multiline: flags.multiline,
                },
            )?;
            Ok(())
        }
        Expr::AssertEnd => {
            push_vm_inst(
                insts,
                VmInst::AssertEnd {
                    multiline: flags.multiline,
                },
            )?;
            Ok(())
        }
        Expr::AssertWord(b) => {
            push_vm_inst(insts, VmInst::AssertWord(*b))?;
            Ok(())
        }
        Expr::Group(inner) => compile_vm_expr(inner, flags, insts, zero_slots, work),
        Expr::Capture { index, inner } => {
            push_vm_inst(insts, VmInst::SaveStart(*index))?;
            compile_vm_expr(inner, flags, insts, zero_slots, work)?;
            push_vm_inst(insts, VmInst::SaveEnd(*index))?;
            Ok(())
        }
        Expr::Backref(index) => {
            push_vm_inst(
                insts,
                VmInst::Backref {
                    index: *index,
                    ignore_case: flags.ignore_case,
                },
            )?;
            Ok(())
        }
        Expr::NamedBackref(_) => Err(CompileError::InvalidSyntax),
        Expr::Lookaround {
            positive,
            behind,
            inner,
        } => {
            let mut sub = Vec::new();
            let mut sub_zeros = 0usize;
            compile_vm_expr(inner, flags, &mut sub, &mut sub_zeros, work)?;
            push_vm_inst(&mut sub, VmInst::Match)?;
            push_vm_inst(
                insts,
                VmInst::Lookaround {
                    positive: *positive,
                    behind: *behind,
                    sub: Arc::from(sub),
                    zero_slots: sub_zeros,
                },
            )?;
            Ok(())
        }
        Expr::Flags {
            ignore_case,
            multiline,
            dot_all,
            inner,
        } => {
            let child_flags = VmFlags {
                ignore_case: ignore_case.unwrap_or(flags.ignore_case),
                multiline: multiline.unwrap_or(flags.multiline),
                dot_all: dot_all.unwrap_or(flags.dot_all),
            };
            compile_vm_expr(inner, child_flags, insts, zero_slots, work)
        }
        Expr::Concat(items) => {
            for item in items {
                compile_vm_expr(item, flags, insts, zero_slots, work)?;
            }
            Ok(())
        }
        Expr::Alt(branches) => {
            let mut jmp_ends = Vec::with_capacity(branches.len());
            for (i, branch) in branches.iter().enumerate() {
                if i + 1 < branches.len() {
                    let split = push_vm_inst(insts, VmInst::Split(0, 0))?;
                    let left = insts.len();
                    compile_vm_expr(branch, flags, insts, zero_slots, work)?;
                    let jmp = push_vm_inst(insts, VmInst::Jmp(0))?;
                    let right = insts.len();
                    insts[split] = VmInst::Split(left, right);
                    jmp_ends.push(jmp);
                } else {
                    compile_vm_expr(branch, flags, insts, zero_slots, work)?;
                }
            }
            let end = insts.len();
            for jmp in jmp_ends {
                insts[jmp] = VmInst::Jmp(end);
            }
            Ok(())
        }
        Expr::Repeat {
            inner,
            min,
            max,
            lazy,
        } => {
            let cap_bounds = capture_range(inner);
            for _ in 0..*min {
                charge_work(work)?;
                if let Some((lo, hi)) = cap_bounds {
                    push_vm_inst(insts, VmInst::ClearCaps(lo, hi))?;
                }
                compile_vm_expr(inner, flags, insts, zero_slots, work)?;
            }
            match max {
                None => {
                    if *zero_slots >= MAX_BT_CAPTURES {
                        return Err(CompileError::DeferToServer);
                    }
                    let slot = *zero_slots;
                    *zero_slots += 1;
                    let split = push_vm_inst(insts, VmInst::Split(0, 0))?;
                    let body = insts.len();
                    push_vm_inst(insts, VmInst::ZeroGuardStart(slot))?;
                    if let Some((lo, hi)) = cap_bounds {
                        push_vm_inst(insts, VmInst::ClearCaps(lo, hi))?;
                    }
                    compile_vm_expr(inner, flags, insts, zero_slots, work)?;
                    push_vm_inst(insts, VmInst::ZeroGuardEnd(slot))?;
                    push_vm_inst(insts, VmInst::Jmp(split))?;
                    let end = insts.len();
                    insts[split] = if *lazy {
                        VmInst::Split(end, body)
                    } else {
                        VmInst::Split(body, end)
                    };
                }
                Some(hi) => {
                    if *hi > *min {
                        if *zero_slots >= MAX_BT_CAPTURES {
                            return Err(CompileError::DeferToServer);
                        }
                        let slot = *zero_slots;
                        *zero_slots += 1;
                        let mut splits = Vec::with_capacity(*hi - *min);
                        for _ in *min..*hi {
                            charge_work(work)?;
                            let split = push_vm_inst(insts, VmInst::Split(0, 0))?;
                            let body = insts.len();
                            push_vm_inst(insts, VmInst::ZeroGuardStart(slot))?;
                            if let Some((lo, hi_cap)) = cap_bounds {
                                push_vm_inst(insts, VmInst::ClearCaps(lo, hi_cap))?;
                            }
                            compile_vm_expr(inner, flags, insts, zero_slots, work)?;
                            push_vm_inst(insts, VmInst::ZeroGuardEnd(slot))?;
                            splits.push((split, body));
                        }
                        let final_end = insts.len();
                        for (split, body) in splits {
                            insts[split] = if *lazy {
                                VmInst::Split(final_end, body)
                            } else {
                                VmInst::Split(body, final_end)
                            };
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

#[derive(Clone)]
struct BtFrame {
    pc: usize,
    pos: usize,
    caps: Vec<Option<(usize, usize)>>,
    open: Vec<Option<usize>>,
    zeros: Vec<Option<usize>>,
}

#[allow(clippy::too_many_arguments)]
fn run_vm(
    insts: &[VmInst],
    captures: usize,
    zero_slots: usize,
    units: &[u16],
    start_pos: usize,
    required_end: Option<usize>,
    init_caps: Option<&[Option<(usize, usize)>]>,
    budget: &mut MatchBudget,
    depth: usize,
) -> Option<Option<Vec<Option<(usize, usize)>>>> {
    if depth > MAX_LOOKAROUND_DEPTH {
        return None;
    }
    let mut stack = Vec::with_capacity(32);
    let mut caps = vec![None; captures];
    if let Some(seed) = init_caps {
        let len = seed.len().min(captures);
        caps[..len].copy_from_slice(&seed[..len]);
    }
    stack.push(BtFrame {
        pc: 0,
        pos: start_pos,
        caps,
        open: vec![None; captures],
        zeros: vec![None; zero_slots],
    });
    while let Some(mut frame) = stack.pop() {
        loop {
            if !budget.consume(1) {
                return None;
            }
            let Some(inst) = insts.get(frame.pc) else {
                break;
            };
            match inst {
                VmInst::Match => {
                    if required_end.is_none_or(|end| frame.pos == end) {
                        return Some(Some(frame.caps));
                    }
                    break;
                }
                VmInst::Jmp(target) => {
                    frame.pc = *target;
                }
                VmInst::Split(first, second) => {
                    if stack.len() >= MAX_BT_STACK {
                        return None;
                    }
                    let mut alt = frame.clone();
                    alt.pc = *second;
                    stack.push(alt);
                    frame.pc = *first;
                }
                VmInst::Literal { unit, ignore_case } => {
                    let Some(&u) = units.get(frame.pos) else {
                        break;
                    };
                    let ok = if *ignore_case {
                        eq_u16_icase(u, *unit)
                    } else {
                        u == *unit
                    };
                    if !ok {
                        break;
                    }
                    frame.pos += 1;
                    frame.pc += 1;
                }
                VmInst::Any { dot_all } => {
                    let Some(&u) = units.get(frame.pos) else {
                        break;
                    };
                    if !*dot_all && is_line_terminator_u16(u) {
                        break;
                    }
                    frame.pos += 1;
                    frame.pc += 1;
                }
                VmInst::Class {
                    negated,
                    items,
                    ignore_case,
                } => {
                    let Some(&u) = units.get(frame.pos) else {
                        break;
                    };
                    if !budget.consume(items.len()) {
                        return None;
                    }
                    let hit = items.iter().any(|item| {
                        if *ignore_case {
                            item.matches_icase(u)
                        } else {
                            item.matches(u)
                        }
                    });
                    if (*negated && hit) || (!*negated && !hit) {
                        break;
                    }
                    frame.pos += 1;
                    frame.pc += 1;
                }
                VmInst::AssertStart { multiline } => {
                    let ok = frame.pos == 0
                        || (*multiline
                            && frame
                                .pos
                                .checked_sub(1)
                                .and_then(|i| units.get(i))
                                .is_some_and(|&u| is_line_terminator_u16(u)));
                    if !ok {
                        break;
                    }
                    frame.pc += 1;
                }
                VmInst::AssertEnd { multiline } => {
                    let ok = frame.pos == units.len()
                        || (*multiline
                            && units
                                .get(frame.pos)
                                .is_some_and(|&u| is_line_terminator_u16(u)));
                    if !ok {
                        break;
                    }
                    frame.pc += 1;
                }
                VmInst::AssertWord(want_boundary) => {
                    let prev = frame.pos.checked_sub(1).and_then(|i| units.get(i).copied());
                    let curr = units.get(frame.pos).copied();
                    let is_boundary =
                        prev.is_some_and(is_word_u16) != curr.is_some_and(is_word_u16);
                    if is_boundary != *want_boundary {
                        break;
                    }
                    frame.pc += 1;
                }
                VmInst::SaveStart(index) => {
                    if let Some(slot) = frame.open.get_mut(index.saturating_sub(1)) {
                        *slot = Some(frame.pos);
                    }
                    frame.pc += 1;
                }
                VmInst::SaveEnd(index) => {
                    let i = index.saturating_sub(1);
                    if let Some(start) = frame.open.get(i).copied().flatten()
                        && let Some(slot) = frame.caps.get_mut(i)
                    {
                        *slot = Some((start, frame.pos));
                    }
                    frame.pc += 1;
                }
                VmInst::ClearCaps(lo, hi) => {
                    for idx in *lo..=*hi {
                        let i = idx.saturating_sub(1);
                        if let Some(slot) = frame.caps.get_mut(i) {
                            *slot = None;
                        }
                        if let Some(slot) = frame.open.get_mut(i) {
                            *slot = None;
                        }
                    }
                    frame.pc += 1;
                }
                VmInst::ZeroGuardStart(slot) => {
                    if let Some(cell) = frame.zeros.get_mut(*slot) {
                        *cell = Some(frame.pos);
                    }
                    frame.pc += 1;
                }
                VmInst::ZeroGuardEnd(slot) => {
                    if frame.zeros.get(*slot).copied().flatten() == Some(frame.pos) {
                        break;
                    }
                    frame.pc += 1;
                }
                VmInst::Backref { index, ignore_case } => {
                    let captured = frame.caps.get(index.saturating_sub(1)).copied().flatten();
                    if let Some((start, end)) = captured {
                        let len = end.saturating_sub(start);
                        if !budget.consume(len.max(1)) {
                            return None;
                        }
                        let Some(target) = units.get(frame.pos..frame.pos + len) else {
                            break;
                        };
                        let source = &units[start..end];
                        let matched = if *ignore_case {
                            source
                                .iter()
                                .zip(target.iter())
                                .all(|(&a, &b)| eq_u16_icase(a, b))
                        } else {
                            source == target
                        };
                        if !matched {
                            break;
                        }
                        frame.pos += len;
                    }
                    frame.pc += 1;
                }
                VmInst::Lookaround {
                    positive,
                    behind,
                    sub,
                    zero_slots: sub_zeros,
                } => {
                    let sub_match = if *behind {
                        let mut found = None;
                        for s in (0..=frame.pos).rev() {
                            if !budget.consume(1) {
                                return None;
                            }
                            let res = run_vm(
                                sub,
                                captures,
                                *sub_zeros,
                                units,
                                s,
                                Some(frame.pos),
                                Some(&frame.caps),
                                budget,
                                depth + 1,
                            )?;
                            if let Some(new_caps) = res {
                                found = Some(new_caps);
                                break;
                            }
                        }
                        found
                    } else {
                        run_vm(
                            sub,
                            captures,
                            *sub_zeros,
                            units,
                            frame.pos,
                            None,
                            Some(&frame.caps),
                            budget,
                            depth + 1,
                        )?
                    };
                    if *positive {
                        let Some(new_caps) = sub_match else {
                            break;
                        };
                        frame.caps = new_caps;
                    } else if sub_match.is_some() {
                        break;
                    }
                    frame.pc += 1;
                }
            }
        }
    }
    Some(None)
}

/// Sound O(AST) lower-bound check: returns `true` only when every match of `expr` MUST consume
/// at least one UTF-16 code unit, so an empty string `""` can never match.
fn ast_cannot_match_empty(expr: &Expr) -> bool {
    match expr {
        Expr::Literal(_) | Expr::Any | Expr::Class { .. } => true,
        Expr::Empty
        | Expr::AssertStart
        | Expr::AssertEnd
        | Expr::AssertWord(_)
        | Expr::Backref(_)
        | Expr::NamedBackref(_)
        | Expr::Lookaround { .. } => false,
        Expr::Group(inner) | Expr::Capture { inner, .. } | Expr::Flags { inner, .. } => {
            ast_cannot_match_empty(inner)
        }
        Expr::Concat(items) => items.iter().any(ast_cannot_match_empty),
        Expr::Alt(branches) => !branches.is_empty() && branches.iter().all(ast_cannot_match_empty),
        Expr::Repeat { inner, min, .. } => *min > 0 && ast_cannot_match_empty(inner),
    }
}

impl Pattern {
    fn compile_cached_entry(src: &str) -> CachedPattern {
        if src.len() > MAX_PATTERN_BYTES {
            return CachedPattern::Deferred {
                cannot_match_empty: false,
            };
        }
        let (expr, captures, needs_backtrack, deferred) = match Parser::new(src).parse() {
            Ok(parsed) => parsed,
            Err(CompileError::InvalidSyntax) => return CachedPattern::InvalidSyntax,
            Err(CompileError::DeferToServer) => {
                return CachedPattern::Deferred {
                    cannot_match_empty: false,
                };
            }
        };
        let cannot_match_empty = ast_cannot_match_empty(&expr);
        if deferred {
            return CachedPattern::Deferred { cannot_match_empty };
        }
        match Self::compile_parsed(&expr, captures, needs_backtrack) {
            Ok(pat) => CachedPattern::Compiled(Arc::new(pat)),
            Err(CompileError::InvalidSyntax) => CachedPattern::InvalidSyntax,
            Err(CompileError::DeferToServer) => CachedPattern::Deferred { cannot_match_empty },
        }
    }

    fn compile_parsed(
        expr: &Expr,
        captures: usize,
        needs_backtrack: bool,
    ) -> Result<Self, CompileError> {
        if !needs_backtrack {
            let mut insts = Vec::new();
            let mut work = 0usize;
            compile_expr(expr, &mut insts, &mut work)?;
            push_inst(&mut insts, Inst::Match)?;
            return Ok(Self::Nfa(insts));
        }
        if captures > MAX_BT_CAPTURES {
            return Err(CompileError::DeferToServer);
        }
        let mut insts = Vec::new();
        let mut zero_slots = 0usize;
        let mut work = 0usize;
        compile_vm_expr(
            expr,
            VmFlags::default(),
            &mut insts,
            &mut zero_slots,
            &mut work,
        )?;
        push_vm_inst(&mut insts, VmInst::Match)?;
        Ok(Self::Backtrack {
            insts: Arc::from(insts),
            captures,
            zero_slots,
        })
    }

    fn is_match_budgeted(&self, text: &str, budget: &mut MatchBudget) -> Option<bool> {
        match self {
            Self::Nfa(insts) => Self::is_match_nfa(insts, text, budget),
            Self::Backtrack {
                insts,
                captures,
                zero_slots,
            } => {
                let units: Vec<u16> = text.encode_utf16().collect();
                for start in 0..=units.len() {
                    let res = run_vm(
                        insts,
                        *captures,
                        *zero_slots,
                        &units,
                        start,
                        None,
                        None,
                        budget,
                        0,
                    )?;
                    if res.is_some() {
                        return Some(true);
                    }
                }
                Some(false)
            }
        }
    }

    fn is_match_nfa(insts: &[Inst], text: &str, budget: &mut MatchBudget) -> Option<bool> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let n = insts.len();
        let mut visited = vec![0u32; n];
        let mut stamp = 1u32;
        let mut current = Vec::with_capacity(n.min(64));
        let mut next = Vec::with_capacity(n.min(64));
        let mut stack = Vec::with_capacity(n.min(64));
        if !Self::add_state(
            insts,
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
        if current.iter().any(|&pc| matches!(insts[pc], Inst::Match)) {
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
                let matched = match &insts[pc] {
                    Inst::Literal(u) => unit == *u,
                    Inst::Any => !is_line_terminator_u16(unit),
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
                    && !Self::add_state(
                        insts,
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
            if !Self::add_state(
                insts,
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
            if current.iter().any(|&pc| matches!(insts[pc], Inst::Match)) {
                return Some(true);
            }
        }
        Some(false)
    }

    #[allow(clippy::too_many_arguments)]
    fn add_state(
        insts: &[Inst],
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
            if pc >= insts.len() || visited[pc] == stamp {
                continue;
            }
            visited[pc] = stamp;
            match insts[pc] {
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
        Expr::Group(inner) | Expr::Capture { inner, .. } => compile_expr(inner, insts, work),
        Expr::Backref(_) | Expr::NamedBackref(_) | Expr::Lookaround { .. } | Expr::Flags { .. } => {
            Err(CompileError::DeferToServer)
        }
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
        Expr::Repeat {
            inner,
            min,
            max,
            lazy: _,
        } => {
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
