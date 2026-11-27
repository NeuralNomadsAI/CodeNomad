//! jsonc-parser 3.3.1 `modify` (`setProperty` with formatting), `format` and `applyEdits` on UTF-16 units.

use crate::subagent_depth::jsonc::{J, Kind, NodeType, Scanner, Seg, Text, parse_tree, quote, slice, stringify, utf16};

#[derive(Clone, Debug, PartialEq)]
pub struct Edit {
    pub offset: i64,
    pub length: i64,
    pub content: Text,
}
pub fn edit(offset: i64, length: i64, content: Text) -> Edit {
    Edit { offset, length, content }
}
fn apply_one(text: &[u16], e: &Edit) -> Text {
    [slice(text, 0, e.offset), &e.content, slice(text, e.offset + e.length, i64::MAX)].concat()
}
/// `applyEdits`; `None` for overlapping edits (the reference throws).
pub fn apply_edits(text: &[u16], edits: &[Edit]) -> Option<Text> {
    let mut sorted = edits.to_vec();
    sorted.sort_by(|a, b| a.offset.cmp(&b.offset).then(a.length.cmp(&b.length)));
    let mut out = text.to_vec();
    let mut last = text.len() as i64;
    for e in sorted.iter().rev() {
        if e.offset + e.length > last {
            return None;
        }
        out = apply_one(&out, e);
        last = e.offset;
    }
    Some(out)
}

pub struct Formatting {
    pub eol: Text,
    pub insert_spaces: bool,
    pub tab_size: usize,
}
fn is_eol(text: &[u16], offset: i64) -> bool {
    // `'\r\n'.indexOf(text.charAt(offset))`: out of range reads "" and matches.
    offset < 0 || offset as usize >= text.len() || matches!(text[offset as usize], 10 | 13)
}
fn format(document: &[u16], offset: i64, length: i64, options: &Formatting) -> Vec<Edit> {
    let range_start = offset;
    let range_end = offset + length;
    let mut start = range_start;
    while start > 0 && !is_eol(document, start - 1) {
        start -= 1;
    }
    let mut end_offset = range_end;
    while end_offset < document.len() as i64 && !is_eol(document, end_offset) {
        end_offset += 1;
    }
    let format_text = slice(document, start, end_offset).to_vec();
    let tab = if options.tab_size == 0 { 4 } else { options.tab_size };
    let mut chars = 0;
    for &c in &format_text {
        match c {
            32 => chars += 1,
            9 => chars += tab,
            _ => break,
        }
    }
    let initial = (chars / tab) as i64;
    let eol: Text = document
        .iter()
        .position(|c| matches!(c, 10 | 13))
        .map(|i| {
            if document[i] == 13 {
                if document.get(i + 1) == Some(&10) { vec![13, 10] } else { vec![13] }
            } else {
                vec![10]
            }
        })
        .unwrap_or_else(|| options.eol.clone());
    let indent: Text = if options.insert_spaces { vec![32; tab] } else { vec![9] };
    let mut level: i64 = 0;
    let mut breaks = 0;
    let new_lines = |level: i64| -> Text {
        let levels = initial + level;
        if indent.len() as i64 * levels == 200 {
            // jsonc-parser's line cache holds 200 entries: index 200 reads `undefined`.
            return utf16("undefined");
        }
        let mut t = eol.clone();
        for _ in 0..levels.max(0) {
            t.extend_from_slice(&indent);
        }
        t
    };
    let mut scanner = Scanner::new(&format_text);
    let mut has_error = false;
    let mut edits: Vec<Edit> = Vec::new();
    let base = start;
    let scan_next = format_scan;
    let add = |edits: &mut Vec<Edit>, has_error: bool, text: Text, s: i64, e: i64| {
        if !has_error && s < range_end && e > range_start && slice(document, s, e) != text.as_slice() {
            edits.push(Edit { offset: s, length: e - s, content: text });
        }
    };
    let mut first = scan_next(&mut scanner, &mut breaks, &mut has_error);
    if first != Kind::Eof {
        let token_start = scanner.offset() as i64 + base;
        let mut initial_indent = Vec::new();
        for _ in 0..initial {
            initial_indent.extend_from_slice(&indent);
        }
        add(&mut edits, has_error, initial_indent, base, token_start);
    }
    while first != Kind::Eof {
        let mut first_end = (scanner.offset() + scanner.length()) as i64 + base;
        let mut second = scan_next(&mut scanner, &mut breaks, &mut has_error);
        let mut replace: Text = Vec::new();
        let mut needs_break = false;
        while breaks == 0 && matches!(second, Kind::LineComment | Kind::BlockComment) {
            let comment_start = scanner.offset() as i64 + base;
            add(&mut edits, has_error, vec![32], first_end, comment_start);
            first_end = (scanner.offset() + scanner.length()) as i64 + base;
            needs_break = second == Kind::LineComment;
            replace = if needs_break { new_lines(level) } else { Vec::new() };
            second = scan_next(&mut scanner, &mut breaks, &mut has_error);
        }
        if second == Kind::CloseBrace {
            if first != Kind::OpenBrace {
                level -= 1;
            }
            if first != Kind::OpenBrace {
                replace = new_lines(level);
            }
        } else if second == Kind::CloseBracket {
            if first != Kind::OpenBracket {
                level -= 1;
            }
            if first != Kind::OpenBracket {
                replace = new_lines(level);
            }
        } else {
            match first {
                Kind::OpenBracket | Kind::OpenBrace => {
                    level += 1;
                    replace = new_lines(level);
                }
                Kind::Comma | Kind::LineComment => replace = new_lines(level),
                Kind::BlockComment => {
                    if breaks > 0 {
                        replace = new_lines(level);
                    } else if !needs_break {
                        replace = vec![32];
                    }
                }
                Kind::Colon => {
                    if !needs_break {
                        replace = vec![32];
                    }
                }
                Kind::Str => {
                    if second == Kind::Colon && !needs_break {
                        replace = Vec::new();
                    }
                }
                Kind::Null | Kind::True | Kind::False | Kind::Num | Kind::CloseBrace | Kind::CloseBracket => {
                    if matches!(second, Kind::LineComment | Kind::BlockComment) && !needs_break {
                        replace = vec![32];
                    } else if second != Kind::Comma && second != Kind::Eof {
                        has_error = true;
                    }
                }
                Kind::Unknown => has_error = true,
                _ => {}
            }
            if breaks > 0 && matches!(second, Kind::LineComment | Kind::BlockComment) {
                replace = new_lines(level);
            }
        }
        if second == Kind::Eof {
            replace = Vec::new();
        }
        let second_start = scanner.offset() as i64 + base;
        add(&mut edits, has_error, replace, first_end, second_start);
        first = second;
    }
    edits
}
fn format_scan(s: &mut Scanner<'_>, breaks: &mut i32, has_error: &mut bool) -> Kind {
    let mut token = s.scan();
    *breaks = 0;
    while matches!(token, Kind::Trivia | Kind::LineBreak) {
        if token == Kind::LineBreak {
            *breaks = 1;
        }
        token = s.scan();
    }
    *has_error = token == Kind::Unknown || s.error() != 0;
    token
}
fn with_formatting(text: &[u16], e: Edit, options: &Formatting) -> Vec<Edit> {
    let mut new_text = apply_one(text, &e);
    let mut begin = e.offset;
    let mut end = e.offset + e.content.len() as i64;
    if e.length == 0 || e.content.is_empty() {
        while begin > 0 && !is_eol(&new_text, begin - 1) {
            begin -= 1;
        }
        while end < new_text.len() as i64 && !is_eol(&new_text, end) {
            end += 1;
        }
    }
    let edits = format(&new_text, begin, end - begin, options);
    for f in edits.iter().rev() {
        new_text = apply_one(&new_text, f);
        begin = begin.min(f.offset);
        end = end.max(f.offset + f.length);
        end += f.content.len() as i64 - f.length;
    }
    let length = text.len() as i64 - (new_text.len() as i64 - end) - begin;
    vec![Edit { offset: begin, length, content: slice(&new_text, begin, end).to_vec() }]
}
/// `modify(text, path, value, { formattingOptions })`; `Err` where the reference throws a plain `Error`.
pub fn modify(text: &[u16], path: &[Seg], value: Option<J>, options: &Formatting) -> Result<Vec<Edit>, ()> {
    let tree = parse_tree(text, false);
    let mut path = path.to_vec();
    let mut value = value;
    let mut parent = None;
    let mut last = None;
    while let Some(segment) = path.pop() {
        parent = tree.find(tree.root, &path);
        let missing = parent.is_none() && value.is_some();
        last = Some(segment.clone());
        if !missing {
            break;
        }
        let inner = value.take().unwrap();
        value = Some(match segment {
            Seg::Key(k) => J::Obj(vec![(k, inner)]),
            Seg::Index(_) => J::Arr(vec![inner]),
        });
    }
    let Some(parent) = parent else {
        let value = value.ok_or(())?;
        let (o, l) = tree.root.map_or((0, 0), |r| (tree.node(r).offset, tree.node(r).length));
        return Ok(with_formatting(text, edit(o, l, stringify(&value, None)), options));
    };
    let p = tree.node(parent);
    match (p.kind, last) {
        (NodeType::Object, Some(Seg::Key(k))) => {
            let existing = tree.find(Some(parent), &[Seg::Key(k.clone())]);
            match (existing, value) {
                (Some(node), None) => {
                    let property = tree.node(node).parent.ok_or(())?;
                    let index = p.children.iter().position(|&c| c == property).ok_or(())?;
                    let mut end = tree.end(property);
                    let begin = if index > 0 {
                        tree.end(p.children[index - 1])
                    } else {
                        if p.children.len() > 1 {
                            end = tree.node(p.children[1]).offset;
                        }
                        p.offset + 1
                    };
                    Ok(with_formatting(text, edit(begin, end - begin, Vec::new()), options))
                }
                (Some(node), Some(v)) => {
                    let n = tree.node(node);
                    Ok(with_formatting(text, edit(n.offset, n.length, stringify(&v, None)), options))
                }
                (None, None) => Ok(Vec::new()),
                (None, Some(v)) => {
                    let mut property = Vec::new();
                    quote(&mut property, &k);
                    property.extend(utf16(": "));
                    property.extend(stringify(&v, None));
                    let e = if let Some(&previous) = p.children.last() {
                        edit(tree.end(previous), 0, [vec![44], property].concat())
                    } else {
                        edit(p.offset + 1, 0, property)
                    };
                    Ok(with_formatting(text, e, options))
                }
            }
        }
        (NodeType::Array, Some(Seg::Index(insert_index))) => {
            if insert_index == -1 {
                let v = value.ok_or(())?;
                let new_property = stringify(&v, None);
                let e = if let Some(&previous) = p.children.last() {
                    edit(tree.end(previous), 0, [vec![44], new_property].concat())
                } else {
                    edit(p.offset + 1, 0, new_property)
                };
                Ok(with_formatting(text, e, options))
            } else if value.is_none() {
                if insert_index < 0 || (insert_index as usize) >= p.children.len() {
                    return Err(());
                }
                let removal_index = insert_index as usize;
                let e = if p.children.len() == 1 {
                    edit(p.offset + 1, p.length - 2, Vec::new())
                } else if p.children.len() - 1 == removal_index {
                    let previous = p.children[removal_index - 1];
                    let offset = tree.end(previous);
                    let parent_end = p.offset + p.length;
                    edit(offset, parent_end - 2 - offset, Vec::new())
                } else {
                    let to_remove = tree.node(p.children[removal_index]);
                    let next = tree.node(p.children[removal_index + 1]);
                    edit(to_remove.offset, next.offset - to_remove.offset, Vec::new())
                };
                Ok(with_formatting(text, e, options))
            } else if insert_index >= 0 {
                let v = value.unwrap();
                let new_property = stringify(&v, None);
                let idx = insert_index as usize;
                let e = if idx < p.children.len() {
                    let to_modify = tree.node(p.children[idx]);
                    edit(to_modify.offset, to_modify.length, new_property)
                } else if p.children.is_empty() || idx == 0 {
                    let content = if p.children.is_empty() { new_property } else { [new_property, vec![44]].concat() };
                    edit(p.offset + 1, 0, content)
                } else {
                    let index = idx.min(p.children.len());
                    let previous = p.children[index - 1];
                    edit(tree.end(previous), 0, [vec![44], new_property].concat())
                };
                Ok(with_formatting(text, e, options))
            } else {
                Err(())
            }
        }
        _ => Err(()),
    }
}
