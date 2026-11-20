//! Port of fuzzysort 2.0.4 `single` and `go` (with `key` and `limit`), as the
//! reference file search uses them (`filesystem/search.ts`). JavaScript works
//! in UTF-16 code units: lengths, indexes and `indexOf` follow them here too.
//! Parity: `fuzzy-cases.json` from `generate-fuzzy-cases.mjs` (scores bit for
//! bit, exact result order including the priority queue's ties).
use crate::shared::js_space;

/// The easter egg of the reference library: it matches anything.
const FARZHER: &str = "farzher";
/// `charCodeAt` past the end of a lowercased string (NaN): equal to nothing.
const SEARCH_NAN: u32 = 0x1_0000;
const TARGET_NAN: u32 = 0x1_0001;

struct LowerInfo {
    codes: Vec<u32>,
    lower: Vec<u16>,
    bitflags: u32,
    contains_space: bool,
}

/// `prepareLowerInfo`: codes of the lowercased text, as many as the text has units.
fn lower_info(text: &str, nan: u32) -> LowerInfo {
    let length = text.encode_utf16().count();
    let lower: Vec<u16> = text.to_lowercase().encode_utf16().collect();
    let mut codes = Vec::with_capacity(length);
    let (mut bitflags, mut contains_space) = (0u32, false);
    for i in 0..length {
        let code = lower.get(i).map_or(nan, |&c| c as u32);
        codes.push(code);
        if code == 32 {
            contains_space = true;
            continue;
        }
        let bit = match code {
            97..=122 => code - 97,
            48..=57 => 26,
            0..=127 => 30,
            _ => 31,
        };
        bitflags |= 1 << bit;
    }
    LowerInfo { codes, lower, bitflags, contains_space }
}

struct Part {
    codes: Vec<u32>,
    lower: Vec<u16>,
}

pub struct Search {
    farzher: bool,
    empty: bool,
    main: Part,
    bitflags: u32,
    contains_space: bool,
    spaces: Vec<Part>,
}

/// `prepareSearch` (the reference caches it; preparing is deterministic).
pub fn search(text: &str) -> Search {
    let trimmed = text.trim_matches(js_space);
    let info = lower_info(trimmed, SEARCH_NAN);
    let mut spaces = Vec::new();
    if info.contains_space {
        let mut seen = std::collections::HashSet::new();
        for word in trimmed.split(js_space).filter(|w| !w.is_empty()) {
            if seen.insert(word) {
                let part = lower_info(word, SEARCH_NAN);
                spaces.push(Part { codes: part.codes, lower: word.to_lowercase().encode_utf16().collect() });
            }
        }
    }
    Search {
        farzher: text == FARZHER,
        empty: text.is_empty(),
        main: Part { codes: info.codes, lower: info.lower },
        bitflags: info.bitflags,
        contains_space: info.contains_space,
        spaces,
    }
}

pub struct Target {
    units: Vec<u16>,
    codes: Vec<u32>,
    lower: Vec<u16>,
    bitflags: u32,
    next: Option<Vec<usize>>,
}

/// `prepare`.
pub fn target(text: &str) -> Target {
    let info = lower_info(text, TARGET_NAN);
    Target {
        units: text.encode_utf16().collect(),
        codes: info.codes,
        lower: info.lower,
        bitflags: info.bitflags,
        next: None,
    }
}

/// `prepareNextBeginningIndexes` on the original (not lowercased) units.
fn next_beginnings(units: &[u16]) -> Vec<usize> {
    let mut beginnings = Vec::new();
    let (mut was_upper, mut was_alphanum) = (false, false);
    for (i, &code) in units.iter().enumerate() {
        let upper = (65..=90).contains(&code);
        let alphanum = upper || (97..=122).contains(&code) || (48..=57).contains(&code);
        if upper && !was_upper || !was_alphanum || !alphanum {
            beginnings.push(i);
        }
        was_upper = upper;
        was_alphanum = alphanum;
    }
    let len = units.len();
    let mut next = Vec::with_capacity(len);
    let mut last = beginnings.first().copied();
    let mut last_i = 0;
    for i in 0..len {
        if last.is_some_and(|b| b > i) {
            next.push(last.unwrap());
        } else {
            last_i += 1;
            last = beginnings.get(last_i).copied();
            next.push(last.unwrap_or(len));
        }
    }
    next
}

fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    (from..=haystack.len().checked_sub(needle.len())?).find(|&i| haystack[i..i + needle.len()] == *needle)
}

/// `algorithm`: the score and first matched index, or `None` (NULL).
fn algorithm(search: &Part, target: &mut Target) -> Option<(f64, usize)> {
    let (sc, tc) = (&search.codes, &target.codes);
    let (search_len, target_len) = (sc.len(), tc.len());
    if search_len == 0 || target_len == 0 {
        return None;
    }
    let mut simple = Vec::with_capacity(search_len);
    let (mut si, mut ti) = (0, 0);
    loop {
        if sc[si] == tc[ti] {
            simple.push(ti);
            si += 1;
            if si == search_len {
                break;
            }
        }
        ti += 1;
        if ti >= target_len {
            return None;
        }
    }
    let next = target.next.get_or_insert_with(|| next_beginnings(&target.units));
    let mut strict: Vec<usize> = Vec::with_capacity(search_len);
    let mut success_strict = false;
    let mut si = 0;
    let mut ti = if simple[0] == 0 { 0 } else { next[simple[0] - 1] };
    let mut backtrack = 0;
    if ti != target_len {
        loop {
            if ti >= target_len {
                if si == 0 {
                    break;
                }
                backtrack += 1;
                if backtrack > 200 {
                    break;
                }
                si -= 1;
                let last = strict.pop().unwrap();
                ti = next[last];
            } else if sc[si] == tc[ti] {
                strict.push(ti);
                si += 1;
                if si == search_len {
                    success_strict = true;
                    break;
                }
                ti += 1;
            } else {
                ti = next[ti];
            }
        }
    }
    let substring = index_of(&target.lower, &search.lower, simple[0]);
    if let Some(at) = substring {
        if !success_strict {
            for (i, m) in simple.iter_mut().enumerate() {
                *m = at + i;
            }
        }
    }
    // `_nextBeginningIndexes[substringIndex-1]`: undefined at -1 and past the end.
    let substring_beginning = substring.is_some_and(|at| at > 0 && next.get(at - 1) == Some(&at));
    let best = if success_strict { &strict } else { &simple };
    let mut score = 0f64;
    let mut groups = 0f64;
    for i in 1..search_len {
        if best[i] as f64 - best[i - 1] as f64 != 1.0 {
            score -= best[i] as f64;
            groups += 1.0;
        }
    }
    let unmatched = best[search_len - 1] as f64 - best[0] as f64 - (search_len as f64 - 1.0);
    score -= (12.0 + unmatched) * groups;
    if best[0] != 0 {
        score -= best[0] as f64 * best[0] as f64 * 0.2;
    }
    if !success_strict {
        score *= 1000.0;
    } else {
        let mut unique = 1f64;
        let mut i = next[0];
        while i < target_len {
            unique += 1.0;
            i = next[i];
        }
        if unique > 24.0 {
            score *= (unique - 24.0) * 10.0;
        }
    }
    let bonus = 1.0 + search_len as f64 * search_len as f64 * 1.0;
    if substring.is_some() {
        score /= bonus;
    }
    if substring_beginning {
        score /= bonus;
    }
    score -= target_len as f64 - search_len as f64;
    Some((score, best[0]))
}

/// `algorithmSpaces`.
fn algorithm_spaces(search: &Search, target: &mut Target) -> Option<f64> {
    let mut score = 0f64;
    let mut first_seen = 0usize;
    let mut any = false;
    for part in &search.spaces {
        let (s, first) = algorithm(part, target)?;
        any = true;
        score += s;
        if first < first_seen {
            score -= first_seen as f64 - first as f64;
        }
        first_seen = first;
    }
    let whole = algorithm(&search.main, target);
    if let Some((s, _)) = whole {
        if s > score {
            return Some(s);
        }
    }
    // `result.score = score` on the last space search's result (NULL without one).
    if !any { None } else { Some(score) }
}

fn score(search: &Search, target: &mut Target) -> Option<f64> {
    if search.contains_space {
        algorithm_spaces(search, target)
    } else {
        algorithm(&search.main, target).map(|(s, _)| s)
    }
}

/// `fuzzysort.single(search, target)`: the score, `None` for NULL.
pub fn single(search: &Search, text: &str) -> Option<f64> {
    if search.farzher {
        return Some(0.0);
    }
    if search.empty || text.is_empty() {
        return None;
    }
    let mut target = target(text);
    if search.bitflags & target.bitflags != search.bitflags { None } else { score(search, &mut target) }
}

/// The library's hacked FastPriorityQueue: a min-heap on score.
struct Queue(Vec<(f64, usize)>);
impl Queue {
    fn add(&mut self, item: (f64, usize)) {
        let mut a = self.0.len();
        self.0.push(item);
        while a > 0 {
            let parent = (a - 1) >> 1;
            if item.0 < self.0[parent].0 {
                self.0[a] = self.0[parent];
                a = parent;
            } else {
                break;
            }
        }
        self.0[a] = item;
    }
    /// The bottom-up percolation of `v` from the root.
    fn down(&mut self) {
        let o = self.0.len();
        let value = self.0[0];
        let (mut a, mut c) = (0usize, 1usize);
        while c < o {
            let s = c + 1;
            a = c;
            if s < o && self.0[s].0 < self.0[c].0 {
                a = s;
            }
            self.0[(a - 1) >> 1] = self.0[a];
            c = 1 + (a << 1);
        }
        while a > 0 {
            let f = (a - 1) >> 1;
            if value.0 < self.0[f].0 {
                self.0[a] = self.0[f];
                a = f;
            } else {
                break;
            }
        }
        self.0[a] = value;
    }
    fn poll(&mut self) -> (f64, usize) {
        let top = self.0[0];
        let last = self.0.pop().unwrap();
        if !self.0.is_empty() {
            self.0[0] = last;
            self.down();
        }
        top
    }
    fn replace_top(&mut self, item: (f64, usize)) {
        self.0[0] = item;
        self.down();
    }
}

/// `fuzzysort.go(search, targets, {key, limit})`: (index, score) of the
/// results in their final order. A `limit` of 0 means none, as `||` does.
pub fn go<'a>(search: &Search, keys: impl IntoIterator<Item = &'a str>, limit: usize) -> Vec<(usize, f64)> {
    let mut keys = keys.into_iter();
    if search.farzher {
        // `[{…, obj: targets[0]}]`, whatever the targets.
        return keys.next().map(|_| vec![(0, 0.0)]).unwrap_or_default();
    }
    if search.empty {
        return Vec::new();
    }
    let limit = if limit == 0 { usize::MAX } else { limit };
    let mut queue = Queue(Vec::new());
    for (i, key) in keys.enumerate() {
        if key.is_empty() {
            continue;
        }
        let mut target = target(key);
        if search.bitflags & target.bitflags != search.bitflags {
            continue;
        }
        let Some(s) = score(search, &mut target) else { continue };
        if queue.0.len() < limit {
            queue.add((s, i));
        } else if s > queue.0[0].0 {
            queue.replace_top((s, i));
        }
    }
    let mut results = vec![(0, 0.0); queue.0.len()];
    for slot in results.iter_mut().rev() {
        let (s, i) = queue.poll();
        *slot = (i, s);
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn bits(score: f64) -> String {
        format!("{:016x}", score.to_bits())
    }

    #[test]
    fn matches_the_reference_library() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fuzzy-cases.json");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let pool: Vec<&str> = cases["pool"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        // Search keys are `path.toLowerCase()`: Rust's lowercasing must agree.
        for (text, lower) in pool.iter().zip(cases["lower"].as_array().unwrap()) {
            assert_eq!(text.to_lowercase(), lower.as_str().unwrap(), "{text:?}");
        }
        let mut count = 0;
        for case in cases["single"].as_array().unwrap() {
            let (query, target) = (case[0].as_str().unwrap(), pool[case[1].as_u64().unwrap() as usize]);
            let expected = case[2].as_str().map(str::to_owned);
            assert_eq!(single(&search(query), target).map(bits), expected, "single({query:?}, {target:?})");
            count += 1;
        }
        for case in cases["go"].as_array().unwrap() {
            let query = case["search"].as_str().unwrap();
            let targets: Vec<&str> =
                case["targets"].as_array().unwrap().iter().map(|t| pool[t.as_u64().unwrap() as usize]).collect();
            let limit = case["limit"].as_u64().unwrap_or(0) as usize;
            let got: Vec<(usize, String)> =
                go(&search(query), targets.iter().copied(), limit).into_iter().map(|(i, s)| (i, bits(s))).collect();
            let expected: Vec<(usize, String)> = case["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| (r[0].as_u64().unwrap() as usize, r[1].as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(got, expected, "go({query:?}, limit {limit})");
            count += 1;
        }
        assert!(count >= 2000, "{count} parity cases");
    }

    #[test]
    fn header_examples_with_2_0_4_scores() {
        // The library header quotes older scores; these are what 2.0.4 returns.
        assert_eq!(single(&search("fs"), "Fuzzy Search"), Some(-33.0));
        assert_eq!(single(&search("test"), "test"), Some(0.0));
        assert_eq!(single(&search("doesnt exist"), "target"), None);
        let ranked = go(&search("mr"), ["Monitor.cpp", "MeshRenderer.cpp"], 0);
        assert_eq!(ranked, vec![(1, -33.0), (0, -23009.0)]);
    }
}
