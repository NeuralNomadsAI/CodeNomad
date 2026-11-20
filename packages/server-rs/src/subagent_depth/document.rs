//! `native-setting-document.ts` and the document half of `plugin-control-document.ts`: one known
//! setting path edited in place, comments and foreign properties kept, results parse-checked.

use crate::subagent_depth::jsonc::{self, Edit, J, Kind, Scanner, Seg, Text, edit, slice, utf16};
use sha2::{Digest, Sha256};

const BOM: u16 = 0xfeff;

#[derive(Clone, Debug)]
pub struct Document {
    pub requested: String,
    pub write: String,
    pub exists: bool,
    pub mode: u32,
    pub text: Text,
    pub bom: bool,
}

/// `PluginControlDocumentError` kinds; `Plain` is any other thrown `Error` (route: generic 503).
#[derive(Clone, Debug, PartialEq)]
pub enum DocError {
    Invalid(&'static str),
    Conflict(&'static str),
    Filesystem(&'static str),
    Plain,
}
pub type R<T> = Result<T, DocError>;

const MALFORMED: DocError = DocError::Invalid("OpenCode configuration is malformed");

/// `readPluginControlDocument` after loading: UTF-8, BOM, JSONC object, `plugins` shape.
pub fn decode(requested: String, write: String, exists: bool, mode: u32, contents: &[u8]) -> R<Document> {
    let decoded =
        std::str::from_utf8(contents).map_err(|_| DocError::Invalid("OpenCode configuration is not valid UTF-8"))?;
    let bom = contents.starts_with(&[0xef, 0xbb, 0xbf]);
    let mut text = utf16(decoded);
    if text.first() == Some(&BOM) {
        text.remove(0);
    }
    let tree = jsonc::parse_tree(&text, true);
    let root = tree.root.filter(|_| tree.errors == 0).ok_or(MALFORMED)?;
    if tree.node(root).kind != jsonc::NodeType::Object {
        return Err(MALFORMED);
    }
    let plugins_key = utf16("plugins");
    if tree.node(root).children.iter().filter(|p| tree.key_of(**p) == Some(&plugins_key)).count() > 1 {
        return Err(DocError::Invalid("OpenCode configuration has duplicate plugins keys"));
    }
    match tree.value(root).get("plugins") {
        None => {}
        Some(J::Arr(entries)) => {
            for entry in entries {
                match entry {
                    J::Str(s) if s.is_empty() || *s == utf16("-") => {
                        return Err(DocError::Invalid("OpenCode plugin entry is invalid"));
                    }
                    J::Str(_) => {}
                    J::Obj(_) => {
                        if !matches!(entry.get("package"), Some(J::Str(p)) if !p.is_empty()) {
                            return Err(DocError::Invalid("OpenCode plugin source is invalid"));
                        }
                        if entry.get("options").is_some_and(|o| !o.is_obj()) {
                            return Err(DocError::Invalid("OpenCode plugin options must be an object"));
                        }
                    }
                    _ => return Err(DocError::Invalid("OpenCode plugin source is invalid")),
                }
            }
        }
        Some(_) => return Err(DocError::Invalid("OpenCode plugins must be an array")),
    }
    Ok(Document { requested, write, exists, mode, text, bom })
}

/// `nativeSettingExpectation`: SHA-256 of the reference's JSON tuple.
pub fn expectation(d: &Document) -> String {
    let mut tuple = utf16("[");
    for (i, part) in [
        J::s(&d.requested),
        J::s(&d.write),
        J::Bool(d.exists),
        J::Num(d.mode as f64),
        J::Bool(d.bom),
        J::Str(d.text.clone()),
    ]
    .iter()
    .enumerate()
    {
        if i > 0 {
            tuple.push(44);
        }
        tuple.extend(jsonc::stringify(part, None));
    }
    tuple.push(93);
    format!("{:x}", Sha256::digest(jsonc::string(&tuple).as_bytes()))
}

pub fn full(d: &Document) -> Text {
    if d.bom { [&[BOM], d.text.as_slice()].concat() } else { d.text.clone() }
}
/// `${BOM}${updated}${updated.endsWith("\n") ? "" : eol}` with the document's own line ending.
fn finish(d: &Document, mut updated: Text) -> Text {
    if !jsonc::ends_with_lf(&updated) {
        updated.extend_from_slice(jsonc::eol_of(&d.text));
    }
    if d.bom {
        updated.insert(0, BOM);
    }
    updated
}
/// `withEditedText`: the document holding a full edit result.
pub fn with_text(d: &Document, text: &[u16]) -> Document {
    let text = if d.bom && text.first() == Some(&BOM) { text[1..].to_vec() } else { text.to_vec() };
    Document { text, ..d.clone() }
}
fn tree(d: &Document) -> jsonc::Tree {
    jsonc::parse_tree(&d.text, true)
}
fn segs(keys: &[&str]) -> Vec<Seg> {
    jsonc::keys(keys)
}

pub fn read(d: &Document, keys: &[&str]) -> R<Option<J>> {
    let tree = tree(d);
    let mut node = tree.root;
    for key in keys {
        let Some(n) = node else { return Ok(None) };
        if tree.node(n).kind != jsonc::NodeType::Object {
            return Err(DocError::Invalid("OpenCode setting parent must be an object"));
        }
        let key = utf16(key);
        let matches: Vec<usize> =
            tree.node(n).children.iter().copied().filter(|p| tree.key_of(*p) == Some(&key)).collect();
        if matches.len() > 1 {
            return Err(DocError::Invalid("OpenCode setting has duplicate keys"));
        }
        node = matches.first().and_then(|p| tree.node(*p).children.get(1).copied());
    }
    Ok(node.and_then(|n| {
        let node = tree.node(n);
        jsonc::parse(slice(&d.text, node.offset, node.offset + node.length), false).0
    }))
}

pub fn edit_setting(d: &Document, keys: &[&str], value: Option<J>) -> R<Text> {
    read(d, keys)?;
    let indent = jsonc::first_indent(&d.text).unwrap_or_else(|| utf16("  "));
    let options = jsonc::Formatting {
        eol: jsonc::eol_of(&d.text).to_vec(),
        insert_spaces: !indent.contains(&9),
        tab_size: indent.len(),
    };
    let edits = jsonc::modify(&d.text, &segs(keys), value, &options).map_err(|_| DocError::Plain)?;
    let updated = jsonc::apply_edits(&d.text, &edits).ok_or(DocError::Plain)?;
    Ok(finish(d, updated))
}

/// The first non-trivia token at or after `offset`.
fn next_token(text: &[u16], offset: i64) -> (Kind, i64) {
    let mut s = Scanner::new(text);
    s.set_position(offset.max(0) as usize);
    let mut kind = s.scan();
    while kind.trivia() {
        kind = s.scan();
    }
    (kind, s.offset() as i64)
}
/// The line break ending the line at `offset` when only whitespace and comments precede it.
fn line_break(text: &[u16], offset: i64) -> Option<i64> {
    let mut s = Scanner::new(text);
    s.set_position(offset.max(0) as usize);
    let mut kind = s.scan();
    while kind != Kind::Eof && kind.trivia() {
        if kind == Kind::LineBreak {
            return Some(s.offset() as i64);
        }
        kind = s.scan();
    }
    None
}
fn line_start(text: &[u16], offset: i64) -> i64 {
    // `text.lastIndexOf("\n", offset - 1) + 1`; a negative position searches index 0 only.
    let from = (offset - 1).max(0).min(text.len() as i64 - 1);
    (0..=from).rev().find(|i| text[*i as usize] == 10).map_or(0, |i| i + 1)
}
fn indentation(text: &[u16], offset: i64) -> Text {
    slice(text, line_start(text, offset), i64::MAX).iter().take_while(|c| matches!(c, 32 | 9)).copied().collect()
}
fn navigate<'a>(value: &'a mut J, path: &[Seg]) -> Option<&'a mut J> {
    let mut v = value;
    for s in path {
        v = match (s, v) {
            (Seg::Key(k), v @ J::Obj(_)) => v.get_mut(k)?,
            (Seg::Index(i), J::Arr(a)) => a.get_mut(*i as usize)?,
            _ => return None,
        };
    }
    Some(v)
}

/// `appendNativeSetting` (no `name`) and `appendNativeProperty`.
pub fn append(d: &Document, keys: &[&str], value: &J, comment: Option<&str>, name: Option<&str>) -> R<Text> {
    let container = read(d, keys)?;
    if let Some(c) = &container {
        if name.is_none() && !matches!(c, J::Arr(_)) {
            return Err(DocError::Invalid("OpenCode setting must be a list"));
        }
        if name.is_some() && !c.is_obj() {
            return Err(DocError::Invalid("OpenCode setting must be an object"));
        }
    }
    let Some(container) = container else {
        let created = edit_setting(d, keys, Some(if name.is_none() { J::Arr(vec![]) } else { J::Obj(vec![]) }))?;
        return append(&with_text(d, &created), keys, value, comment, name);
    };
    if let Some(n) = name {
        if container.get(n).is_some() {
            return Err(DocError::Invalid("OpenCode setting already exists"));
        }
    }
    let text = &d.text;
    let eol = jsonc::eol_of(text).to_vec();
    let unit = jsonc::first_indent(text).unwrap_or_else(|| utf16("  "));
    let render = |base: &[u16]| -> Text {
        let rendered = jsonc::stringify(value, Some(&unit));
        let mut lines: Vec<Text> = rendered.split(|c| *c == 10).map(<[u16]>::to_vec).collect();
        if let Some(comment) = comment {
            if lines.len() > 2 && lines[0] == utf16("{") {
                lines.insert(1, [unit.clone(), utf16("// "), utf16(comment)].concat());
            }
        }
        let mut member = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if i > 0 {
                member.extend_from_slice(&eol);
                member.extend_from_slice(base);
            }
            member.extend_from_slice(line);
        }
        match name {
            None => member,
            Some(n) => [jsonc::stringify(&J::s(n), None), utf16(": "), member].concat(),
        }
    };
    let tree = tree(d);
    let node = tree.find(tree.root, &segs(keys)).ok_or(DocError::Plain)?;
    let edits: Vec<Edit> = if let Some(&last) = tree.node(node).children.last() {
        let last_offset = tree.node(last).offset;
        let base = indentation(text, last_offset);
        let end = tree.end(last);
        let following = next_token(text, end);
        let trailing = following.0 == Kind::Comma;
        let after = if trailing { following.1 + 1 } else { end };
        let alone = slice(text, line_start(text, last_offset), last_offset) == base.as_slice();
        let at = if alone { line_break(text, after) } else { None };
        let element = [render(&base), if trailing { utf16(",") } else { vec![] }].concat();
        match at {
            None => vec![edit(after, 0, [utf16(if trailing { " " } else { ", " }), element].concat())],
            Some(at) => {
                let mut v = Vec::new();
                if !trailing {
                    v.push(edit(end, 0, utf16(",")));
                }
                v.push(edit(at, 0, [eol.clone(), base, element].concat()));
                v
            }
        }
    } else {
        let base = indentation(text, tree.node(node).offset);
        let inner = [base.clone(), unit.clone()].concat();
        vec![edit(
            tree.node(node).offset + 1,
            0,
            [eol.clone(), inner.clone(), render(&inner), eol.clone(), base].concat(),
        )]
    };
    let updated = jsonc::apply_edits(text, &edits).ok_or(DocError::Plain)?;
    let mut expected = jsonc::parse(text, true).0.ok_or(DocError::Plain)?;
    let target = navigate(&mut expected, &segs(keys)).ok_or(DocError::Plain)?;
    match (name, target) {
        (None, J::Arr(a)) => a.push(value.clone()),
        (Some(n), t @ J::Obj(_)) => t.set(utf16(n), value.clone()),
        _ => return Err(DocError::Plain),
    }
    let (result, errors) = jsonc::parse(&updated, true);
    if errors || result.as_ref() != Some(&expected) {
        return Err(DocError::Invalid("OpenCode setting could not be appended"));
    }
    Ok(finish(d, updated))
}

/// `value` without the member at `path`; `None` where the reference would throw.
fn without(mut value: J, path: &[Seg]) -> Option<J> {
    let (last, parents) = path.split_last()?;
    let parent = navigate(&mut value, parents)?;
    match (last, parent) {
        (Seg::Index(i), J::Arr(a)) => {
            if (*i as usize) < a.len() {
                a.remove(*i as usize);
            }
        }
        (Seg::Key(k), J::Obj(p)) => p.retain(|(key, _)| key != k),
        (Seg::Key(_), _) => {}
        _ => return None,
    }
    Some(value)
}
/// The edited text when it parses without errors to the original value minus `path`.
fn removal(d: &Document, edits: &[Edit], path: &[Seg]) -> R<Option<Text>> {
    let updated = jsonc::apply_edits(&d.text, edits).ok_or(DocError::Plain)?;
    let (result, errors) = jsonc::parse(&updated, true);
    let original = jsonc::parse(&d.text, true).0.ok_or(DocError::Plain)?;
    let expected = without(original, path).ok_or(DocError::Plain)?;
    if errors || result.as_ref() != Some(&expected) {
        return Ok(None);
    }
    Ok(Some(finish(d, updated)))
}
fn comma_near(text: &[u16], tree: &jsonc::Tree, members: &[usize], index: usize) -> Option<i64> {
    let following = next_token(text, tree.end(members[index]));
    let previous = (index > 0).then(|| next_token(text, tree.end(members[index - 1])));
    if following.0 == Kind::Comma { Some(following.1) } else { previous.filter(|p| p.0 == Kind::Comma).map(|p| p.1) }
}
fn remove_line(d: &Document, start: i64, end: i64, content: Text, comma: Option<i64>, path: &[Seg]) -> R<Option<Text>> {
    let text = &d.text;
    let at = |i: i64| (i >= 0).then(|| text.get(i as usize).copied()).flatten();
    let mut ls = start;
    while ls > 0 && matches!(at(ls - 1), Some(32 | 9)) {
        ls -= 1;
    }
    let starts = if content.is_empty() && at(ls - 1) == Some(10) {
        vec![ls - if at(ls - 2) == Some(13) { 2 } else { 1 }, start]
    } else {
        vec![start]
    };
    for offset in starts {
        let mut edits = vec![edit(offset, end - offset, content.clone())];
        if let Some(c) = comma {
            edits.push(edit(c, 1, vec![]));
        }
        if let Some(updated) = removal(d, &edits, path)? {
            return Ok(Some(updated));
        }
    }
    Ok(None)
}
fn remove_member(d: &Document, tree: &jsonc::Tree, members: &[usize], index: usize, path: &[Seg]) -> R<Option<Text>> {
    let text = &d.text;
    let member = *members.get(index).ok_or(DocError::Plain)?;
    let (offset, end) = (tree.node(member).offset, tree.end(member));
    if let (1, Some(container)) = (members.len(), tree.node(member).parent) {
        let c = tree.node(container);
        let blank = |part: &[u16]| part.iter().all(|ch| jsonc::js_space(*ch) || *ch == 44);
        if blank(slice(text, c.offset + 1, offset)) && blank(slice(text, end, c.offset + c.length - 1)) {
            if let Some(collapsed) = removal(d, &[edit(c.offset + 1, c.length - 2, vec![])], path)? {
                return Ok(Some(collapsed));
            }
        }
    }
    remove_line(d, offset, end, vec![], comma_near(text, tree, members, index), path)
}

pub fn remove_list_element(d: &Document, keys: &[&str], index: usize) -> R<Option<Text>> {
    match read(d, keys)? {
        Some(J::Arr(a)) if index < a.len() => {}
        _ => return Ok(None),
    }
    let tree = tree(d);
    let list = tree.find(tree.root, &segs(keys)).ok_or(DocError::Plain)?;
    let mut path = segs(keys);
    path.push(Seg::Index(index as i64));
    remove_member(d, &tree, &tree.node(list).children.clone(), index, &path)
}
/// The parsed tree, the members of `keys`'s parent and the index of its last key.
fn member(d: &Document, keys: &[&str]) -> R<(jsonc::Tree, Vec<usize>, usize)> {
    let tree = tree(d);
    let (last, parents) = keys.split_last().ok_or(DocError::Plain)?;
    let parent =
        if parents.is_empty() { tree.root } else { tree.find(tree.root, &segs(parents)) }.ok_or(DocError::Plain)?;
    let properties = tree.node(parent).children.clone();
    let index = properties.iter().position(|p| tree.key_of(*p) == Some(&utf16(last))).ok_or(DocError::Plain)?;
    Ok((tree, properties, index))
}
pub fn remove_property(d: &Document, keys: &[&str]) -> R<Option<Text>> {
    if read(d, keys)?.is_none() {
        return Ok(None);
    }
    let (tree, properties, index) = member(d, keys)?;
    remove_member(d, &tree, &properties, index, &segs(keys))
}
fn remove_container(d: &Document, keys: &[&str], removable: &dyn Fn(Option<&J>) -> bool) -> R<Option<Text>> {
    if !removable(read(d, keys)?.as_ref()) {
        return Ok(None);
    }
    let text = &d.text;
    let (tree, properties, index) = member(d, keys)?;
    let property = properties[index];
    let node = *tree.node(property).children.get(1).ok_or(DocError::Plain)?;
    let (start, stop) = (tree.node(node).offset, tree.end(node));
    let mut s = Scanner::new(text);
    s.set_position(start.max(0) as usize);
    let mut comments: Vec<Text> = Vec::new();
    let mut kind = s.scan();
    while kind != Kind::Eof && (s.offset() as i64) < stop {
        if matches!(kind, Kind::LineComment | Kind::BlockComment) {
            let source = slice(text, s.offset() as i64, (s.offset() + s.length()) as i64).to_vec();
            comments.push(if kind == Kind::LineComment {
                let body = jsonc::string(&source[2.min(source.len())..]).replace("*/", "* /");
                utf16(&format!("/*{body} */"))
            } else {
                source
            });
        }
        kind = s.scan();
    }
    let content = comments.join(&32u16);
    remove_line(
        d,
        tree.node(property).offset,
        tree.end(property),
        content,
        comma_near(text, &tree, &properties, index),
        &segs(keys),
    )
}
/// `removeEmptyNativeObject`: `removable` decides on the object's value.
pub fn remove_empty_object(d: &Document, keys: &[&str], removable: &dyn Fn(&J) -> bool) -> R<Option<Text>> {
    remove_container(d, keys, &|v| v.is_some_and(|v| v.is_obj() && removable(v)))
}
pub fn remove_empty_list(d: &Document, keys: &[&str]) -> R<Option<Text>> {
    remove_container(d, keys, &|v| matches!(v, Some(J::Arr(a)) if a.is_empty()))
}
pub fn no_properties(v: &J) -> bool {
    matches!(v, J::Obj(p) if p.is_empty())
}
