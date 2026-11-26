//! Native string `format` and `pattern` validation for agent question forms.
//!
//! Uses a bounded Thompson NFA for ECMAScript/HTML `pattern` matching so
//! validation runs identically on native and `wasm32` in guaranteed linear time
//! without external dependencies.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

const MAX_REPEAT: usize = 256;
const MAX_STATES: usize = 2048;
const MAX_NESTING: usize = 32;
const MAX_AST_NODES: usize = 1024;
const MAX_COMPILE_WORK: usize = 4096;
const MAX_CACHE_ENTRIES: usize = 64;

static PATTERN_CACHE: OnceLock<Mutex<HashMap<String, Option<Arc<Pattern>>>>> = OnceLock::new();

fn compile_cached(src: &str) -> Result<Arc<Pattern>, ()> {
    let cache = PATTERN_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock()
        && let Some(entry) = map.get(src)
    {
        return entry.clone().ok_or(());
    }
    let compiled = Pattern::compile(src).ok().map(Arc::new);
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_CACHE_ENTRIES {
            map.clear();
        }
        map.insert(src.to_string(), compiled.clone());
    }
    compiled.ok_or(())
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
        Some(Value::String(raw)) => compile_cached(raw).is_ok(),
        _ => false,
    }
}

pub fn matches_string_constraints(field: &Value, value: &str) -> Result<bool, ()> {
    if let Some(raw) = field.get("format").filter(|v| !v.is_null()) {
        let fmt = raw.as_str().and_then(StringFormat::parse).ok_or(())?;
        if !fmt.matches(value) {
            return Ok(false);
        }
    }
    if let Some(raw) = field.get("pattern").filter(|v| !v.is_null()) {
        let src = raw.as_str().ok_or(())?;
        if !src.is_empty() {
            let pat = compile_cached(src)?;
            if !pat.is_match(value) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn is_valid_email(value: &str) -> bool {
    if value.is_empty() || !value.is_ascii() {
        return false;
    }
    let mut parts = value.split('@');
    let Some(local) = parts.next() else {
        return false;
    };
    let Some(domain) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || local.is_empty() || domain.is_empty() {
        return false;
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    if !local.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'.' | b'_'
                    | b'\''
                    | b'+'
                    | b'-'
                    | b'!'
                    | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'*'
                    | b'/'
                    | b'='
                    | b'?'
                    | b'^'
                    | b'`'
                    | b'{'
                    | b'|'
                    | b'}'
                    | b'~'
            )
    }) {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let tld = labels.last().copied().unwrap_or_default();
    if tld.len() < 2 || !tld.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn is_valid_uri(value: &str) -> bool {
    if value.is_empty()
        || value
            .chars()
            .any(|c| c.is_ascii_control() || c.is_whitespace())
    {
        return false;
    }
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    let mut scheme_bytes = scheme.bytes();
    let Some(first) = scheme_bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic()
        || !scheme_bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return false;
    }
    if let Some(after_slashes) = rest.strip_prefix("//") {
        let end = after_slashes
            .find(['/', '?', '#'])
            .unwrap_or(after_slashes.len());
        let authority = &after_slashes[..end];
        if authority.is_empty() {
            return scheme.eq_ignore_ascii_case("file");
        }
        let hostport = authority
            .rsplit_once('@')
            .map(|(_, hp)| hp)
            .unwrap_or(authority);
        if hostport.is_empty() {
            return false;
        }
        if let Some(rest_v6) = hostport.strip_prefix('[') {
            let Some((addr, after_bracket)) = rest_v6.split_once(']') else {
                return false;
            };
            if addr.is_empty()
                || !addr
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.' | b'%'))
            {
                return false;
            }
            if after_bracket.is_empty() {
                return true;
            }
            let Some(port) = after_bracket.strip_prefix(':') else {
                return false;
            };
            return valid_port(port);
        }
        if hostport.contains(['[', ']']) {
            return false;
        }
        if let Some((host, port)) = hostport.rsplit_once(':') {
            return !host.is_empty() && valid_port(port);
        }
        true
    } else {
        !rest.is_empty()
    }
}

fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit())
        && port.parse::<u16>().is_ok()
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

fn is_valid_date_time(value: &str) -> bool {
    if value.len() < 16 || !value.is_ascii() {
        return false;
    }
    if !is_valid_date(&value[0..10]) {
        return false;
    }
    let b = value.as_bytes();
    if !matches!(b[10], b'T' | b't') || b[13] != b':' {
        return false;
    }
    let Some(hour) = parse_ascii_digits(&value[11..13]) else {
        return false;
    };
    let Some(minute) = parse_ascii_digits(&value[14..16]) else {
        return false;
    };
    if hour > 23 || minute > 59 {
        return false;
    }
    let rest = &value[16..];
    let Some(after_colon) = rest.strip_prefix(':') else {
        return false;
    };
    if after_colon.len() < 2 {
        return false;
    }
    let Some(second) = parse_ascii_digits(&after_colon[0..2]) else {
        return false;
    };
    if second > 59 {
        return false;
    }
    let mut rest = &after_colon[2..];
    if let Some(after_dot) = rest.strip_prefix('.') {
        let frac_len = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        if frac_len == 0 {
            return false;
        }
        rest = &after_dot[frac_len..];
    }
    if rest == "Z" || rest == "z" {
        return true;
    }
    let rb = rest.as_bytes();
    if rb.len() != 6 || !matches!(rb[0], b'+' | b'-') || rb[3] != b':' {
        return false;
    }
    let Some(tz_h) = parse_ascii_digits(&rest[1..3]) else {
        return false;
    };
    let Some(tz_m) = parse_ascii_digits(&rest[4..6]) else {
        return false;
    };
    tz_h <= 23 && tz_m <= 59
}

#[derive(Clone, Debug)]
enum ClassItem {
    Single(char),
    Range(char, char),
    Digit,
    NonDigit,
    Word,
    NonWord,
    Space,
    NonSpace,
}

impl ClassItem {
    fn matches(&self, c: char) -> bool {
        match *self {
            Self::Single(x) => c == x,
            Self::Range(lo, hi) => c >= lo && c <= hi,
            Self::Digit => c.is_ascii_digit(),
            Self::NonDigit => !c.is_ascii_digit(),
            Self::Word => is_word_char(c),
            Self::NonWord => !is_word_char(c),
            Self::Space => is_space_char(c),
            Self::NonSpace => !is_space_char(c),
        }
    }
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_space_char(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

#[derive(Clone, Debug)]
enum Expr {
    Empty,
    Literal(char),
    Any,
    Class {
        negated: bool,
        items: Vec<ClassItem>,
    },
    AssertStart,
    AssertEnd,
    AssertWord(bool),
    Concat(Vec<Expr>),
    Alt(Vec<Expr>),
    Repeat {
        inner: Box<Expr>,
        min: usize,
        max: Option<usize>,
    },
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
    depth: usize,
    nodes: usize,
}

impl Parser {
    fn new(src: &str) -> Self {
        Self {
            chars: src.chars().collect(),
            pos: 0,
            depth: 0,
            nodes: 0,
        }
    }

    fn charge_node(&mut self) -> Result<(), ()> {
        self.nodes += 1;
        if self.nodes > MAX_AST_NODES {
            Err(())
        } else {
            Ok(())
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.pos += 1;
        Some(c)
    }

    fn parse(mut self) -> Result<Expr, ()> {
        let expr = self.parse_alt()?;
        if self.pos != self.chars.len() {
            return Err(());
        }
        Ok(expr)
    }

    fn parse_alt(&mut self) -> Result<Expr, ()> {
        let mut branches = vec![self.parse_seq()?];
        while self.peek() == Some('|') {
            self.pos += 1;
            branches.push(self.parse_seq()?);
        }
        if branches.len() == 1 {
            Ok(branches.pop().unwrap())
        } else {
            Ok(Expr::Alt(branches))
        }
    }

    fn parse_seq(&mut self) -> Result<Expr, ()> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if matches!(c, ')' | '|') {
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

    fn parse_quantified(&mut self) -> Result<Expr, ()> {
        let mut expr = self.parse_atom()?;
        while let Some(c) = self.peek() {
            let (min, max) = match c {
                '*' => {
                    self.pos += 1;
                    (0, None)
                }
                '+' => {
                    self.pos += 1;
                    (1, None)
                }
                '?' => {
                    self.pos += 1;
                    (0, Some(1))
                }
                '{' => {
                    let Some(bounds) = self.try_parse_brace_quantifier()? else {
                        break;
                    };
                    bounds
                }
                _ => break,
            };
            if matches!(
                expr,
                Expr::Empty | Expr::AssertStart | Expr::AssertEnd | Expr::AssertWord(_)
            ) {
                return Err(());
            }
            // Optional lazy `?` suffix does not change boolean match acceptance.
            if self.peek() == Some('?') {
                self.pos += 1;
            }
            self.charge_node()?;
            if min == 0 && max == Some(0) {
                expr = Expr::Empty;
            } else {
                expr = Expr::Repeat {
                    inner: Box::new(expr),
                    min,
                    max,
                };
            }
        }
        Ok(expr)
    }

    fn try_parse_brace_quantifier(&mut self) -> Result<Option<(usize, Option<usize>)>, ()> {
        let saved = self.pos;
        self.pos += 1; // consume '{'
        let Some(min) = self.parse_usize() else {
            self.pos = saved;
            return Ok(None);
        };
        let max = match self.peek() {
            Some('}') => {
                self.pos += 1;
                Some(min)
            }
            Some(',') => {
                self.pos += 1;
                if self.peek() == Some('}') {
                    self.pos += 1;
                    None
                } else {
                    let Some(hi) = self.parse_usize() else {
                        self.pos = saved;
                        return Ok(None);
                    };
                    if self.peek() != Some('}') {
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
        if min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT || m < min) {
            return Err(());
        }
        Ok(Some((min, max)))
    }

    fn parse_usize(&mut self) -> Option<usize> {
        let start = self.pos;
        let mut val: usize = 0;
        while let Some(c) = self.peek().filter(|c| c.is_ascii_digit()) {
            self.pos += 1;
            val = val
                .saturating_mul(10)
                .saturating_add((c as u8 - b'0') as usize);
        }
        (self.pos > start).then_some(val)
    }

    fn parse_atom(&mut self) -> Result<Expr, ()> {
        self.charge_node()?;
        let c = self.next().ok_or(())?;
        match c {
            '^' => Ok(Expr::AssertStart),
            '$' => Ok(Expr::AssertEnd),
            '.' => Ok(Expr::Any),
            '*' | '+' | '?' => Err(()),
            '(' => {
                self.depth += 1;
                if self.depth > MAX_NESTING {
                    return Err(());
                }
                if self.peek() == Some('?') {
                    self.pos += 1;
                    if self.next() != Some(':') {
                        // Lookarounds and unknown group modifiers fail closed.
                        return Err(());
                    }
                }
                let inner = self.parse_alt()?;
                self.depth -= 1;
                if self.next() != Some(')') {
                    return Err(());
                }
                Ok(inner)
            }
            '[' => self.parse_class(),
            '\\' => self.parse_escape(),
            other => Ok(Expr::Literal(other)),
        }
    }

    fn parse_escape(&mut self) -> Result<Expr, ()> {
        let c = self.next().ok_or(())?;
        match c {
            'd' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::Digit],
            }),
            'D' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::NonDigit],
            }),
            'w' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::Word],
            }),
            'W' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::NonWord],
            }),
            's' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::Space],
            }),
            'S' => Ok(Expr::Class {
                negated: false,
                items: vec![ClassItem::NonSpace],
            }),
            'b' => Ok(Expr::AssertWord(true)),
            'B' => Ok(Expr::AssertWord(false)),
            '1'..='9' => Err(()), // backreferences fail closed
            other => Ok(Expr::Literal(self.decode_char_escape(other)?)),
        }
    }

    fn decode_char_escape(&mut self, c: char) -> Result<char, ()> {
        match c {
            'n' => Ok('\n'),
            'r' => Ok('\r'),
            't' => Ok('\t'),
            'f' => Ok('\u{000C}'),
            'v' => Ok('\u{000B}'),
            '0' => Ok('\0'),
            'x' => self.parse_hex_char(2),
            'u' => {
                if self.peek() == Some('{') {
                    self.pos += 1;
                    let mut val: u32 = 0;
                    let mut digits = 0usize;
                    while let Some(h) = self.peek().filter(|c| c.is_ascii_hexdigit()) {
                        self.pos += 1;
                        digits += 1;
                        if digits > 6 {
                            return Err(());
                        }
                        val = (val << 4) | h.to_digit(16).ok_or(())?;
                    }
                    if digits == 0 || self.next() != Some('}') {
                        return Err(());
                    }
                    char::from_u32(val).ok_or(())
                } else {
                    self.parse_hex_char(4)
                }
            }
            'p' | 'P' | 'k' | 'c' => Err(()),
            other => Ok(other),
        }
    }

    fn parse_hex_char(&mut self, count: usize) -> Result<char, ()> {
        let mut val: u32 = 0;
        for _ in 0..count {
            let h = self.next().ok_or(())?;
            val = (val << 4) | h.to_digit(16).ok_or(())?;
        }
        char::from_u32(val).ok_or(())
    }

    fn parse_class(&mut self) -> Result<Expr, ()> {
        let negated = if self.peek() == Some('^') {
            self.pos += 1;
            true
        } else {
            false
        };
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == ']' {
                self.pos += 1;
                return Ok(Expr::Class { negated, items });
            }
            let item = self.parse_class_atom()?;
            if self.peek() == Some('-') && self.chars.get(self.pos + 1).copied() != Some(']') {
                self.pos += 1; // consume '-'
                let end = self.parse_class_atom()?;
                match (item, end) {
                    (ClassItem::Single(lo), ClassItem::Single(hi)) if lo <= hi => {
                        items.push(ClassItem::Range(lo, hi));
                    }
                    _ => return Err(()),
                }
            } else {
                items.push(item);
            }
        }
        Err(())
    }

    fn parse_class_atom(&mut self) -> Result<ClassItem, ()> {
        let c = self.next().ok_or(())?;
        if c != '\\' {
            return Ok(ClassItem::Single(c));
        }
        let esc = self.next().ok_or(())?;
        match esc {
            'd' => Ok(ClassItem::Digit),
            'D' => Ok(ClassItem::NonDigit),
            'w' => Ok(ClassItem::Word),
            'W' => Ok(ClassItem::NonWord),
            's' => Ok(ClassItem::Space),
            'S' => Ok(ClassItem::NonSpace),
            'b' => Ok(ClassItem::Single('\u{0008}')),
            other => Ok(ClassItem::Single(self.decode_char_escape(other)?)),
        }
    }
}

#[derive(Clone, Debug)]
enum Inst {
    Literal(char),
    Any,
    Class {
        negated: bool,
        items: Vec<ClassItem>,
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
    pub fn compile(src: &str) -> Result<Self, ()> {
        let expr = Parser::new(src).parse()?;
        let mut insts = Vec::new();
        let mut work = 0usize;
        compile_expr(&expr, &mut insts, &mut work)?;
        push_inst(&mut insts, Inst::Match)?;
        Ok(Self { insts })
    }

    pub fn is_match(&self, text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        let n = self.insts.len();
        let mut visited = vec![0u32; n];
        let mut stamp = 1u32;
        let mut current = Vec::new();
        let mut next = Vec::new();
        self.add_state(0, 0, &chars, &mut visited, stamp, &mut current);
        if current
            .iter()
            .any(|&pc| matches!(self.insts[pc], Inst::Match))
        {
            return true;
        }
        for (pos, &ch) in chars.iter().enumerate() {
            stamp = stamp.wrapping_add(1);
            if stamp == 0 {
                for slot in &mut visited {
                    *slot = 0;
                }
                stamp = 1;
            }
            next.clear();
            for &pc in &current {
                let matched = match &self.insts[pc] {
                    Inst::Literal(c) => ch == *c,
                    Inst::Any => !matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'),
                    Inst::Class { negated, items } => {
                        let hit = items.iter().any(|item| item.matches(ch));
                        if *negated { !hit } else { hit }
                    }
                    _ => false,
                };
                if matched {
                    self.add_state(pc + 1, pos + 1, &chars, &mut visited, stamp, &mut next);
                }
            }
            // Unanchored ECMAScript RegExp.test semantics: a match may start at any position.
            self.add_state(0, pos + 1, &chars, &mut visited, stamp, &mut next);
            std::mem::swap(&mut current, &mut next);
            if current
                .iter()
                .any(|&pc| matches!(self.insts[pc], Inst::Match))
            {
                return true;
            }
        }
        false
    }

    fn add_state(
        &self,
        start: usize,
        pos: usize,
        chars: &[char],
        visited: &mut [u32],
        stamp: u32,
        out: &mut Vec<usize>,
    ) {
        let mut stack = vec![start];
        while let Some(pc) = stack.pop() {
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
                    if pos == chars.len() {
                        stack.push(pc + 1);
                    }
                }
                Inst::AssertWord(want_boundary) => {
                    let prev = pos.checked_sub(1).and_then(|i| chars.get(i).copied());
                    let curr = chars.get(pos).copied();
                    let is_boundary =
                        prev.is_some_and(is_word_char) != curr.is_some_and(is_word_char);
                    if is_boundary == want_boundary {
                        stack.push(pc + 1);
                    }
                }
                _ => out.push(pc),
            }
        }
    }
}

fn push_inst(insts: &mut Vec<Inst>, inst: Inst) -> Result<usize, ()> {
    if insts.len() >= MAX_STATES {
        return Err(());
    }
    let idx = insts.len();
    insts.push(inst);
    Ok(idx)
}

fn charge_work(work: &mut usize) -> Result<(), ()> {
    *work += 1;
    if *work > MAX_COMPILE_WORK {
        Err(())
    } else {
        Ok(())
    }
}

fn compile_expr(expr: &Expr, insts: &mut Vec<Inst>, work: &mut usize) -> Result<(), ()> {
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
            push_inst(
                insts,
                Inst::Class {
                    negated: *negated,
                    items: items.clone(),
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
