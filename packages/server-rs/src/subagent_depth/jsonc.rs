//! Port of jsonc-parser 3.3.1 (scanner, parseTree, parse, findNodeAtLocation, modify with
//! formatting, applyEdits) on UTF-16 code units, so every offset and every written byte
//! equals the TypeScript reference's. Only what the subagent-depth editor uses is ported.

pub type Text = Vec<u16>;

pub fn utf16(s: &str) -> Text {
    s.encode_utf16().collect()
}
pub fn string(t: &[u16]) -> String {
    String::from_utf16_lossy(t)
}
/// JS `slice`: clamped, never panics.
pub fn slice(t: &[u16], start: i64, end: i64) -> &[u16] {
    let len = t.len() as i64;
    let a = start.clamp(0, len) as usize;
    let b = end.clamp(0, len) as usize;
    if a >= b { &[] } else { &t[a..b] }
}
pub fn contains(t: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || t.windows(needle.len()).any(|w| w == needle)
}
pub fn ends_with_lf(t: &[u16]) -> bool {
    t.last() == Some(&10)
}
/// `text.includes("\r\n") ? "\r\n" : "\n"`.
pub fn eol_of(t: &[u16]) -> &'static [u16] {
    if contains(t, &[13, 10]) { &[13, 10] } else { &[10] }
}
/// JS `\s` (and `String.prototype.trim`) whitespace.
pub fn js_space(c: u16) -> bool {
    char::from_u32(c.into()).is_some_and(crate::shared::js_space)
}
/// `/^([ \t]+)\S/m.exec(text)?.[1]`: the first line starting with blanks then a non-space.
pub fn first_indent(t: &[u16]) -> Option<Text> {
    let mut start = 0;
    while start <= t.len() {
        let mut end = start;
        while end < t.len() && (t[end] == 32 || t[end] == 9) {
            end += 1;
        }
        if end > start && end < t.len() && !js_space(t[end]) {
            return Some(t[start..end].to_vec());
        }
        // JS multiline `^` follows \n, \r, U+2028 and U+2029.
        match t[start..].iter().position(|c| matches!(c, 10 | 13 | 0x2028 | 0x2029)) {
            Some(p) => start += p + 1,
            None => break,
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    OpenBrace,
    CloseBrace,
    OpenBracket,
    CloseBracket,
    Comma,
    Colon,
    Null,
    True,
    False,
    Str,
    Num,
    LineComment,
    BlockComment,
    LineBreak,
    Trivia,
    Unknown,
    Eof,
}
impl Kind {
    pub fn trivia(self) -> bool {
        matches!(self, Kind::Trivia | Kind::LineBreak | Kind::LineComment | Kind::BlockComment)
    }
}

pub struct Scanner<'a> {
    text: &'a [u16],
    pos: usize,
    value: Text,
    offset: usize,
    token: Kind,
    error: u8,
}
fn ws(c: Option<u16>) -> bool {
    matches!(c, Some(32 | 9))
}
fn lb(c: Option<u16>) -> bool {
    matches!(c, Some(10 | 13))
}
fn digit(c: Option<u16>) -> bool {
    matches!(c, Some(48..=57))
}
impl<'a> Scanner<'a> {
    pub fn new(text: &'a [u16]) -> Self {
        Scanner { text, pos: 0, value: Vec::new(), offset: 0, token: Kind::Unknown, error: 0 }
    }
    fn at(&self, i: usize) -> Option<u16> {
        self.text.get(i).copied()
    }
    pub fn set_position(&mut self, p: usize) {
        self.pos = p;
        self.value.clear();
        self.offset = 0;
        self.token = Kind::Unknown;
        self.error = 0;
    }
    pub fn token(&self) -> Kind {
        self.token
    }
    pub fn offset(&self) -> usize {
        self.offset
    }
    pub fn length(&self) -> usize {
        self.pos - self.offset
    }
    pub fn error(&self) -> u8 {
        self.error
    }
    pub fn value(&self) -> &[u16] {
        &self.value
    }
    fn hex4(&mut self) -> i64 {
        let (mut digits, mut value) = (0, 0i64);
        while digits < 4 {
            let v = match self.at(self.pos) {
                Some(c @ 48..=57) => c as i64 - 48,
                Some(c @ 65..=70) => c as i64 - 55,
                Some(c @ 97..=102) => c as i64 - 87,
                _ => break,
            };
            value = value * 16 + v;
            self.pos += 1;
            digits += 1;
        }
        if digits < 4 { -1 } else { value }
    }
    fn number(&mut self) -> Text {
        let start = self.pos;
        if self.at(self.pos) == Some(48) {
            self.pos += 1;
        } else {
            self.pos += 1;
            while digit(self.at(self.pos)) {
                self.pos += 1;
            }
        }
        if self.at(self.pos) == Some(46) {
            self.pos += 1;
            if digit(self.at(self.pos)) {
                self.pos += 1;
                while digit(self.at(self.pos)) {
                    self.pos += 1;
                }
            } else {
                self.error = 3;
                return self.text[start..self.pos].to_vec();
            }
        }
        let mut end = self.pos;
        if matches!(self.at(self.pos), Some(69 | 101)) {
            self.pos += 1;
            if matches!(self.at(self.pos), Some(43 | 45)) {
                self.pos += 1;
            }
            if digit(self.at(self.pos)) {
                self.pos += 1;
                while digit(self.at(self.pos)) {
                    self.pos += 1;
                }
                end = self.pos;
            } else {
                self.error = 3;
            }
        }
        self.text[start..end].to_vec()
    }
    fn string(&mut self) -> Text {
        let len = self.text.len();
        let mut result = Vec::new();
        let mut start = self.pos;
        loop {
            if self.pos >= len {
                result.extend_from_slice(&self.text[start..self.pos]);
                self.error = 2;
                break;
            }
            let ch = self.text[self.pos];
            if ch == 34 {
                result.extend_from_slice(&self.text[start..self.pos]);
                self.pos += 1;
                break;
            }
            if ch == 92 {
                result.extend_from_slice(&self.text[start..self.pos]);
                self.pos += 1;
                if self.pos >= len {
                    self.error = 2;
                    break;
                }
                let ch2 = self.text[self.pos];
                self.pos += 1;
                match ch2 {
                    34 => result.push(34),
                    92 => result.push(92),
                    47 => result.push(47),
                    98 => result.push(8),
                    102 => result.push(12),
                    110 => result.push(10),
                    114 => result.push(13),
                    116 => result.push(9),
                    117 => {
                        let ch3 = self.hex4();
                        if ch3 >= 0 { result.push(ch3 as u16) } else { self.error = 4 }
                    }
                    _ => self.error = 5,
                }
                start = self.pos;
                continue;
            }
            if ch <= 0x1f {
                if ch == 10 || ch == 13 {
                    result.extend_from_slice(&self.text[start..self.pos]);
                    self.error = 2;
                    break;
                }
                self.error = 6;
            }
            self.pos += 1;
        }
        result
    }
    pub fn scan(&mut self) -> Kind {
        self.value.clear();
        self.error = 0;
        self.offset = self.pos;
        let len = self.text.len();
        if self.pos >= len {
            self.offset = len;
            self.token = Kind::Eof;
            return self.token;
        }
        let code = self.text[self.pos];
        if ws(Some(code)) {
            while ws(self.at(self.pos)) {
                self.pos += 1;
            }
            self.token = Kind::Trivia;
            return self.token;
        }
        if lb(Some(code)) {
            self.pos += 1;
            if code == 13 && self.at(self.pos) == Some(10) {
                self.pos += 1;
            }
            self.token = Kind::LineBreak;
            return self.token;
        }
        self.token = match code {
            123 => {
                self.pos += 1;
                Kind::OpenBrace
            }
            125 => {
                self.pos += 1;
                Kind::CloseBrace
            }
            91 => {
                self.pos += 1;
                Kind::OpenBracket
            }
            93 => {
                self.pos += 1;
                Kind::CloseBracket
            }
            58 => {
                self.pos += 1;
                Kind::Colon
            }
            44 => {
                self.pos += 1;
                Kind::Comma
            }
            34 => {
                self.pos += 1;
                self.value = self.string();
                Kind::Str
            }
            47 => {
                if self.at(self.pos + 1) == Some(47) {
                    self.pos += 2;
                    while self.pos < len && !lb(self.at(self.pos)) {
                        self.pos += 1;
                    }
                    Kind::LineComment
                } else if self.at(self.pos + 1) == Some(42) {
                    self.pos += 2;
                    let safe = len.saturating_sub(1);
                    let mut closed = false;
                    while self.pos < safe {
                        let ch = self.text[self.pos];
                        if ch == 42 && self.at(self.pos + 1) == Some(47) {
                            self.pos += 2;
                            closed = true;
                            break;
                        }
                        self.pos += 1;
                        if ch == 13 && self.at(self.pos) == Some(10) {
                            self.pos += 1;
                        }
                    }
                    if !closed {
                        // The reference steps one unit past the end of an unclosed comment.
                        self.pos += 1;
                        self.error = 1;
                    }
                    Kind::BlockComment
                } else {
                    self.pos += 1;
                    Kind::Unknown
                }
            }
            45 => {
                self.value.push(45);
                self.pos += 1;
                if self.pos == len || !digit(self.at(self.pos)) {
                    Kind::Unknown
                } else {
                    let n = self.number();
                    self.value.extend(n);
                    Kind::Num
                }
            }
            48..=57 => {
                self.value = self.number();
                Kind::Num
            }
            _ => {
                let unknown = |c: u16| !matches!(c, 32 | 9 | 10 | 13 | 125 | 93 | 123 | 91 | 34 | 58 | 44 | 47);
                while self.pos < len && unknown(self.text[self.pos]) {
                    self.pos += 1;
                }
                if self.offset != self.pos {
                    self.value = self.text[self.offset..self.pos].to_vec();
                    match string(&self.value).as_str() {
                        "true" => Kind::True,
                        "false" => Kind::False,
                        "null" => Kind::Null,
                        _ => Kind::Unknown,
                    }
                } else {
                    self.pos += 1;
                    Kind::Unknown
                }
            }
        };
        self.token
    }
}

pub use crate::subagent_depth::jsonc_value::{J, quote, stringify};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeType {
    Object,
    Array,
    Property,
    Str,
    Number,
    Boolean,
    Null,
}
#[derive(Clone, Debug)]
pub struct Node {
    pub kind: NodeType,
    pub offset: i64,
    pub length: i64,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub value: Option<J>,
}
pub struct Tree {
    pub nodes: Vec<Node>,
    pub root: Option<usize>,
    pub errors: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Key(Text),
    Index(i64),
}
pub fn key(s: &str) -> Seg {
    Seg::Key(utf16(s))
}
pub fn keys(path: &[&str]) -> Vec<Seg> {
    path.iter().map(|k| key(k)).collect()
}

const MAX_PARSE_DEPTH: usize = 512;

struct Parser<'a> {
    scanner: Scanner<'a>,
    nodes: Vec<Node>,
    current: usize,
    errors: usize,
    trailing: bool,
    depth: usize,
    overflow: bool,
}
impl Parser<'_> {
    fn push(&mut self, kind: NodeType, offset: i64, value: Option<J>) -> usize {
        let parent = self.current;
        self.nodes.push(Node { kind, offset, length: -1, parent: Some(parent), children: Vec::new(), value });
        let id = self.nodes.len() - 1;
        self.nodes[parent].children.push(id);
        id
    }
    fn complete_property(&mut self, end: i64) {
        if self.nodes[self.current].kind == NodeType::Property {
            let n = &mut self.nodes[self.current];
            n.length = end - n.offset;
            self.current = n.parent.unwrap_or(0);
        }
    }
    fn tok(&self) -> (i64, i64) {
        (self.scanner.offset() as i64, self.scanner.length() as i64)
    }
    fn next(&mut self) -> Kind {
        loop {
            let token = self.scanner.scan();
            if matches!(self.scanner.error(), 1..=6) {
                self.errors += 1;
            }
            match token {
                Kind::LineComment | Kind::BlockComment | Kind::Trivia | Kind::LineBreak => {}
                Kind::Unknown => self.errors += 1,
                t => return t,
            }
        }
    }
    fn error(&mut self, until_after: &[Kind], until: &[Kind]) {
        self.errors += 1;
        if until_after.is_empty() && until.is_empty() {
            return;
        }
        let mut token = self.scanner.token();
        while token != Kind::Eof {
            if until_after.contains(&token) {
                self.next();
                break;
            } else if until.contains(&token) {
                break;
            }
            token = self.next();
        }
    }
    fn literal_value(&mut self, value: J) {
        let (o, l) = self.tok();
        let kind = match value {
            J::Null => NodeType::Null,
            J::Bool(_) => NodeType::Boolean,
            J::Num(_) => NodeType::Number,
            _ => NodeType::Str,
        };
        let id = self.push(kind, o, Some(value));
        self.nodes[id].length = l;
        self.complete_property(o + l);
    }
    fn string(&mut self, is_value: bool) {
        let value = self.scanner.value().to_vec();
        if is_value {
            self.literal_value(J::Str(value));
        } else {
            let (o, l) = self.tok();
            let property = self.push(NodeType::Property, o, None);
            self.current = property;
            let id = self.push(NodeType::Str, o, Some(J::Str(value)));
            self.nodes[id].length = l;
        }
        self.next();
    }
    fn literal(&mut self) -> bool {
        let value = match self.scanner.token() {
            Kind::Num => {
                let text = string(self.scanner.value());
                J::Num(text.parse::<f64>().unwrap_or_else(|_| {
                    self.errors += 1;
                    0.0
                }))
            }
            Kind::Null => J::Null,
            Kind::True => J::Bool(true),
            Kind::False => J::Bool(false),
            _ => return false,
        };
        self.literal_value(value);
        self.next();
        true
    }
    fn property(&mut self) -> bool {
        if self.scanner.token() != Kind::Str {
            self.error(&[], &[Kind::CloseBrace, Kind::Comma]);
            return false;
        }
        self.string(false);
        if self.scanner.token() == Kind::Colon {
            self.next();
            if !self.value() {
                self.error(&[], &[Kind::CloseBrace, Kind::Comma]);
            }
        } else {
            self.error(&[], &[Kind::CloseBrace, Kind::Comma]);
        }
        true
    }
    fn separator_comma(&mut self) {
        if self.nodes[self.current].kind == NodeType::Property {
            let (o, _) = self.tok();
            self.complete_property(o);
        }
    }
    fn end(&mut self) {
        let (o, l) = self.tok();
        self.complete_property(o + l);
        let n = &mut self.nodes[self.current];
        n.length = o + l - n.offset;
        self.current = n.parent.unwrap_or(0);
        self.complete_property(o + l);
    }
    fn object(&mut self) -> bool {
        if self.overflow || self.depth >= MAX_PARSE_DEPTH {
            self.errors += 1;
            self.overflow = true;
            return false;
        }
        self.depth += 1;
        let (o, _) = self.tok();
        self.current = self.push(NodeType::Object, o, None);
        self.next();
        let mut needs_comma = false;
        while !self.overflow && !matches!(self.scanner.token(), Kind::CloseBrace | Kind::Eof) {
            if self.scanner.token() == Kind::Comma {
                if !needs_comma {
                    self.error(&[], &[]);
                }
                self.separator_comma();
                self.next();
                if self.scanner.token() == Kind::CloseBrace && self.trailing {
                    break;
                }
            } else if needs_comma {
                self.error(&[], &[]);
            }
            if !self.property() && !self.overflow {
                self.error(&[], &[Kind::CloseBrace, Kind::Comma]);
            }
            needs_comma = true;
        }
        self.end();
        if !self.overflow {
            if self.scanner.token() != Kind::CloseBrace {
                self.error(&[Kind::CloseBrace], &[]);
            } else {
                self.next();
            }
        }
        self.depth -= 1;
        !self.overflow
    }
    fn array(&mut self) -> bool {
        if self.overflow || self.depth >= MAX_PARSE_DEPTH {
            self.errors += 1;
            self.overflow = true;
            return false;
        }
        self.depth += 1;
        let (o, _) = self.tok();
        self.current = self.push(NodeType::Array, o, None);
        self.next();
        let mut needs_comma = false;
        while !self.overflow && !matches!(self.scanner.token(), Kind::CloseBracket | Kind::Eof) {
            if self.scanner.token() == Kind::Comma {
                if !needs_comma {
                    self.error(&[], &[]);
                }
                self.separator_comma();
                self.next();
                if self.scanner.token() == Kind::CloseBracket && self.trailing {
                    break;
                }
            } else if needs_comma {
                self.error(&[], &[]);
            }
            if !self.value() && !self.overflow {
                self.error(&[], &[Kind::CloseBracket, Kind::Comma]);
            }
            needs_comma = true;
        }
        // onArrayEnd does not complete a dangling property before closing.
        let (o, l) = self.tok();
        let n = &mut self.nodes[self.current];
        n.length = o + l - n.offset;
        self.current = n.parent.unwrap_or(0);
        self.complete_property(o + l);
        if !self.overflow {
            if self.scanner.token() != Kind::CloseBracket {
                self.error(&[Kind::CloseBracket], &[]);
            } else {
                self.next();
            }
        }
        self.depth -= 1;
        !self.overflow
    }
    fn value(&mut self) -> bool {
        if self.overflow {
            return false;
        }
        match self.scanner.token() {
            Kind::OpenBracket => self.array(),
            Kind::OpenBrace => self.object(),
            Kind::Str => {
                self.string(true);
                true
            }
            _ => self.literal(),
        }
    }
}
/// `parseTree(text, errors, { allowTrailingComma })`, with the error count.
pub fn parse_tree(text: &[u16], trailing: bool) -> Tree {
    let artificial =
        Node { kind: NodeType::Array, offset: -1, length: -1, parent: None, children: Vec::new(), value: None };
    let mut p = Parser {
        scanner: Scanner::new(text),
        nodes: vec![artificial],
        current: 0,
        errors: 0,
        trailing,
        depth: 0,
        overflow: false,
    };
    p.next();
    if p.scanner.token() == Kind::Eof {
        p.errors += 1;
    } else if !p.value() {
        p.errors += 1;
    } else if p.scanner.token() != Kind::Eof {
        p.errors += 1;
    }
    let root = p.nodes[0].children.first().copied();
    if let Some(r) = root {
        p.nodes[r].parent = None;
    }
    Tree { nodes: p.nodes, root, errors: p.errors }
}
impl Tree {
    pub fn node(&self, id: usize) -> &Node {
        &self.nodes[id]
    }
    pub fn end(&self, id: usize) -> i64 {
        self.nodes[id].offset + self.nodes[id].length
    }
    pub fn key_of(&self, property: usize) -> Option<&[u16]> {
        let first = *self.nodes[property].children.first()?;
        match &self.nodes[first].value {
            Some(J::Str(s)) => Some(s),
            _ => None,
        }
    }
    /// `findNodeAtLocation`.
    pub fn find(&self, from: Option<usize>, path: &[Seg]) -> Option<usize> {
        let mut node = from?;
        for segment in path {
            match segment {
                Seg::Key(k) => {
                    if self.nodes[node].kind != NodeType::Object {
                        return None;
                    }
                    node = *self.nodes[node].children.iter().find_map(|&p| {
                        let c = &self.nodes[p].children;
                        (c.len() == 2 && self.key_of(p) == Some(k)).then(|| &c[1])
                    })?;
                }
                Seg::Index(i) => {
                    let c = &self.nodes[node].children;
                    if self.nodes[node].kind != NodeType::Array || *i < 0 || *i as usize >= c.len() {
                        return None;
                    }
                    node = c[*i as usize];
                }
            }
        }
        Some(node)
    }
    /// The value of a node as `parse` builds it.
    pub fn value(&self, id: usize) -> J {
        let n = &self.nodes[id];
        match n.kind {
            NodeType::Array => J::Arr(n.children.iter().map(|&c| self.value(c)).collect()),
            NodeType::Object => {
                let mut out = J::Obj(Vec::new());
                for &p in &n.children {
                    let c = &self.nodes[p].children;
                    if c.len() >= 2 {
                        if let Some(k) = self.key_of(p) {
                            out.set(k.to_vec(), self.value(c[1]));
                        }
                    }
                }
                out
            }
            _ => n.value.clone().unwrap_or(J::Null),
        }
    }
}
/// `parse(text, errors, { allowTrailingComma })`: the value (if any) and whether it had errors.
pub fn parse(text: &[u16], trailing: bool) -> (Option<J>, bool) {
    let tree = parse_tree(text, trailing);
    (tree.root.map(|r| tree.value(r)), tree.errors > 0)
}

pub use crate::subagent_depth::jsonc_edit::{Edit, Formatting, apply_edits, edit, modify};
