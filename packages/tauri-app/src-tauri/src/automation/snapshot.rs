//! The indented accessibility outline with refs (`page/snapshot.ts`): wrappers and repeated text
//! dropped, fields shown by value, and a character budget that collapses large parts in place.
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(crate) const DEFAULT_BUDGET: usize = 32_000;
const STRING_LIMIT: usize = 120;
const REF_COST: usize = 10;
const SKIPPED: &[&str] = &["InlineTextBox", "ListMarker", "LineBreak"];
const TRANSPARENT: &[&str] = &[
    "RootWebArea",
    "generic",
    "none",
    "presentation",
    "LabelText",
    "MenuListPopup",
    "paragraph",
    "Section",
    "sectionheader",
    "sectionfooter",
    "group",
    "strong",
    "emphasis",
    "mark",
    "subscript",
    "superscript",
    "time",
    "abbr",
    "code",
    "Pre",
    "blockquote",
    "figure",
    "Ruby",
    "DescriptionListDetail",
    "DescriptionListTerm",
];
const DECORATIVE: &[&str] = &[
    "image",
    "img",
    "graphics-symbol",
    "graphics-document",
    "SvgRoot",
    "Canvas",
];
const FIELDS: &[&str] = &[
    "textbox",
    "searchbox",
    "spinbutton",
    "Date",
    "DateTime",
    "InputTime",
];
const CHECKABLE: &[&str] = &[
    "checkbox",
    "radio",
    "switch",
    "menuitemcheckbox",
    "menuitemradio",
];
const NAME_FROM_CONTENTS: &[&str] = &[
    "button",
    "link",
    "tab",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "treeitem",
    "heading",
    "cell",
    "gridcell",
    "columnheader",
    "rowheader",
    "checkbox",
    "radio",
    "switch",
    "tooltip",
    "LabelText",
    "DisclosureTriangle",
];
const INTERACTIVE: &[&str] = &[
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "treeitem",
    "listbox",
];
const TRUE_STATES: &[&str] = &[
    "disabled",
    "focused",
    "required",
    "readonly",
    "multiselectable",
    "modal",
    "busy",
];

pub(crate) struct Options<'a> {
    pub root: Option<u64>,
    pub query: Option<&'a str>,
    pub budget: Option<usize>,
}

pub(crate) struct Snapshot {
    pub text: String,
    pub collapsed: usize,
}

/// The scoped element is no longer in the page.
pub(crate) struct Gone;

#[derive(Clone)]
struct View {
    head: String,
    tail: String,
    role: String,
    searchable: String,
    backend: Option<u64>,
    children: Vec<View>,
    size: usize,
    full: usize,
}

#[derive(Default, Clone)]
struct Context {
    name: String,
    from_contents: bool,
}

/// JS `\s`.
pub(crate) fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn collapse(value: &str) -> String {
    value
        .split(space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn normalize(value: &str) -> String {
    collapse(value).to_lowercase()
}
/// UTF-16 length, as the reference's budgets count.
fn units(value: &str) -> usize {
    value.encode_utf16().count()
}
pub(crate) fn quote(value: &str) -> String {
    Value::from(value).to_string()
}
/// JS `String(number)` for the values Chromium reports.
pub(crate) fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}
/// Chromium reports slider, spinbutton and progress values as numbers.
fn text(value: &Value) -> String {
    match value {
        Value::String(text) => collapse(text),
        Value::Number(n) => n
            .as_f64()
            .filter(|n| n.is_finite())
            .map(number)
            .unwrap_or_default(),
        _ => String::new(),
    }
}
fn clip(value: String) -> String {
    if units(&value) <= STRING_LIMIT {
        return value;
    }
    let (mut kept, mut used) = (String::new(), 0);
    for c in value.chars() {
        used += c.len_utf16();
        if used > STRING_LIMIT - 1 {
            break;
        }
        kept.push(c);
    }
    kept + "…"
}
fn truthy_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true))) || value.and_then(Value::as_str) == Some("true")
}

fn view(role: &str, head: String, tail: String, node: &Value, searchable: &str) -> View {
    let backend = node["node"]
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0)
        .map(|n| n as u64);
    View {
        head,
        tail,
        role: normalize(role),
        searchable: normalize(searchable),
        backend,
        children: vec![],
        size: 1,
        full: 0,
    }
}

fn states(role: &str, properties: &HashMap<&str, &Value>, editable: bool) -> String {
    let mut out = String::new();
    let get = |name: &str| properties.get(name).copied();
    if CHECKABLE.contains(&role) {
        if let Some(checked) = get("checked") {
            out += if truthy_true(Some(checked)) {
                " checked"
            } else if checked == "mixed" {
                " checked=mixed"
            } else {
                " unchecked"
            };
        }
    }
    match get("pressed") {
        pressed if truthy_true(pressed) => out += " pressed",
        Some(pressed) if pressed == "mixed" => out += " pressed=mixed",
        _ => {}
    }
    if let Some(expanded) = get("expanded") {
        out += if truthy_true(Some(expanded)) {
            " expanded"
        } else {
            " collapsed"
        };
    }
    if truthy_true(get("selected")) {
        out += " selected";
    }
    for state in TRUE_STATES {
        if truthy_true(get(state)) {
            out += &format!(" {state}");
        }
    }
    if get("invalid")
        .and_then(Value::as_str)
        .is_some_and(|v| v != "false")
    {
        out += " invalid";
    }
    if editable {
        out += " editable";
    }
    if let Some(level) = get("level")
        .and_then(Value::as_f64)
        .filter(|_| role == "heading")
    {
        out += &format!(" level={}", number(level));
    }
    if let Some(url) = get("url")
        .and_then(Value::as_str)
        .filter(|url| role == "link" && !url.is_empty())
    {
        out += &format!(" url={}", quote(&clip(url.into())));
    }
    out
}

struct Builder<'a> {
    nodes: &'a [Value],
    by_id: HashMap<&'a str, usize>,
    visited: HashSet<usize>,
}

impl Builder<'_> {
    fn kids(&mut self, index: usize, context: &Context) -> Vec<View> {
        let ids: Vec<&str> = self.nodes[index]["children"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let children: Vec<usize> = ids
            .into_iter()
            .filter_map(|id| self.by_id.get(id).copied())
            .collect();
        children
            .into_iter()
            .flat_map(|child| self.build(child, context))
            .collect()
    }
    fn build(&mut self, index: usize, context: &Context) -> Vec<View> {
        if !self.visited.insert(index) {
            return vec![];
        }
        let node = &self.nodes[index];
        let role = text(&node["role"]);
        if SKIPPED.contains(&role.as_str()) {
            return vec![];
        }
        if node["ignored"] == true {
            return self.kids(index, context);
        }
        let (name, value) = (clip(text(&node["name"])), clip(text(&node["value"])));
        if role == "StaticText" {
            // Text repeating its printed parent's name adds nothing: the whole name, or a part of
            // a name computed from contents (a button's label pieces); a region's title keeps it.
            let normalized = normalize(&name);
            let repeats = !context.name.is_empty()
                && (context.name == normalized
                    || context.from_contents && context.name.contains(&normalized));
            if normalized.is_empty() || repeats {
                return vec![];
            }
            return vec![view(
                "text",
                format!("text {}", quote(&name)),
                String::new(),
                node,
                &name,
            )];
        }
        let properties: HashMap<&str, &Value> = node["properties"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| (p["name"].as_str().unwrap_or(""), &p["value"]))
            .collect();
        let editable = properties
            .get("editable")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty());
        if TRANSPARENT.contains(&role.as_str()) && name.is_empty() && value.is_empty() && !editable
        {
            return self.kids(index, context);
        }
        if DECORATIVE.contains(&role.as_str()) && name.is_empty() {
            return vec![];
        }
        // A field shows its content as its value; its inner text nodes would repeat it.
        let field = FIELDS.contains(&role.as_str()) || editable;
        let children = if field {
            vec![]
        } else {
            let inner = Context {
                name: normalize(&name),
                from_contents: NAME_FROM_CONTENTS.contains(&role.as_str()),
            };
            self.kids(index, &inner)
        };
        let interactive = INTERACTIVE.contains(&role.as_str())
            || properties.get("focusable") == Some(&&Value::Bool(true));
        if name.is_empty() && value.is_empty() && children.is_empty() && !interactive {
            return vec![];
        }
        let description = clip(text(&node["description"]));
        let mut tail = String::new();
        if !value.is_empty() && value != name {
            tail += &format!(" value={}", quote(&value));
        }
        if !description.is_empty() && normalize(&description) != normalize(&name) {
            tail += &format!(" description={}", quote(&description));
        }
        tail += &states(
            &role,
            &properties,
            editable && !FIELDS.contains(&role.as_str()),
        );
        let head = if name.is_empty() {
            role.clone()
        } else {
            format!("{role} {}", quote(&name))
        };
        let mut result = view(
            &role,
            head,
            tail,
            node,
            &format!("{name} {value} {description}"),
        );
        result.children = children;
        vec![result]
    }
}

/// A match keeps its whole subtree; other nodes survive only as ancestors of a match.
fn filter(item: &View, query: &str) -> Vec<View> {
    if item.role == query || item.searchable.contains(query) {
        return vec![item.clone()];
    }
    let children: Vec<View> = item
        .children
        .iter()
        .flat_map(|child| filter(child, query))
        .collect();
    if children.is_empty() {
        return vec![];
    }
    vec![View {
        children,
        ..item.clone()
    }]
}
fn measure(items: &mut [View], depth: usize) -> usize {
    let mut count = 0;
    for item in items.iter_mut() {
        item.size = 1 + measure(&mut item.children, depth + 1);
        item.full = own(item, depth) + item.children.iter().map(|c| c.full).sum::<usize>();
        count += item.size;
    }
    count
}
fn own(item: &View, depth: usize) -> usize {
    depth * 2
        + 3
        + units(&item.head)
        + units(&item.tail)
        + if item.backend.is_some() { REF_COST } else { 0 }
}
fn hidden(count: usize) -> String {
    format!(" (+{count} hidden)")
}
fn minimum(item: &View, depth: usize) -> usize {
    own(item, depth)
        + if item.children.is_empty() {
            0
        } else {
            units(&hidden(item.size - 1))
        }
}

enum Emitted<'a> {
    View(&'a View, usize),
    More(usize),
}

/// Shares a budget among siblings: small ones stay whole, large ones are collapsed inside; when
/// even collapsed lines do not fit, the first and last siblings are kept around a gap.
fn allocate(items: &[View], depth: usize, budget: isize) -> Option<Vec<Emitted<'_>>> {
    if items.is_empty() {
        return Some(vec![]);
    }
    let minimums: Vec<usize> = items.iter().map(|item| minimum(item, depth)).collect();
    if minimums.iter().sum::<usize>() as isize <= budget {
        let share = |level: usize| -> usize {
            items
                .iter()
                .zip(&minimums)
                .map(|(item, min)| item.full.min((*min).max(level)))
                .sum()
        };
        let (mut low, mut high) = (0, items.iter().map(|item| item.full).max().unwrap_or(0));
        while low < high {
            let middle = (low + high).div_ceil(2);
            if share(middle) as isize <= budget {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return Some(
            items
                .iter()
                .zip(&minimums)
                .map(|(item, min)| Emitted::View(item, item.full.min((*min).max(low))))
                .collect(),
        );
    }
    let mut used = (depth * 2 + 16) as isize;
    let (mut head, mut tail) = (Vec::new(), Vec::new());
    let (mut front, mut back) = (0isize, items.len() as isize - 1);
    while front <= back {
        let from_front = head.len() <= tail.len();
        let index = if from_front { front } else { back } as usize;
        if used + minimums[index] as isize > budget {
            break;
        }
        used += minimums[index] as isize;
        if from_front {
            head.push(index);
            front += 1;
        } else {
            tail.insert(0, index);
            back -= 1;
        }
    }
    if head.is_empty() && tail.is_empty() {
        return None;
    }
    let omitted = items.len() - head.len() - tail.len();
    let pick = |index: &usize| Emitted::View(&items[*index], minimums[*index]);
    let mut out: Vec<Emitted> = head.iter().map(pick).collect();
    if omitted > 0 {
        out.push(Emitted::More(omitted));
    }
    out.extend(tail.iter().map(pick));
    Some(out)
}

struct Writer<'a> {
    lines: Vec<String>,
    collapsed: usize,
    issue: &'a mut dyn FnMut(u64) -> String,
}

impl Writer<'_> {
    fn line(&mut self, item: &View, depth: usize, suffix: &str) {
        let reference = item
            .backend
            .map(|node| format!(" [{}]", (self.issue)(node)))
            .unwrap_or_default();
        self.lines.push(format!(
            "{}- {}{reference}{}{suffix}",
            "  ".repeat(depth),
            item.head,
            item.tail
        ));
    }
    fn full(&mut self, item: &View, depth: usize) {
        self.line(item, depth, "");
        for child in &item.children {
            self.full(child, depth + 1);
        }
    }
    fn list(&mut self, items: Vec<Emitted>, depth: usize) {
        for item in items {
            match item {
                Emitted::More(count) => {
                    self.lines
                        .push(format!("{}- (+{count} more)", "  ".repeat(depth)));
                    self.collapsed += 1;
                }
                Emitted::View(view, budget) => self.render(view, depth, budget),
            }
        }
    }
    fn render(&mut self, item: &View, depth: usize, budget: usize) {
        if item.full <= budget {
            return self.full(item, depth);
        }
        match allocate(
            &item.children,
            depth + 1,
            budget as isize - own(item, depth) as isize,
        ) {
            None => {
                self.line(item, depth, &hidden(item.size - 1));
                self.collapsed += 1;
            }
            Some(layout) => {
                self.line(item, depth, "");
                self.list(layout, depth + 1);
            }
        }
    }
}

/// `renderSnapshot` over semantic nodes (`id`, `parent`, `children`, `node`, `role`, `name`, ...).
pub(crate) fn render(
    nodes: &[Value],
    issue: &mut dyn FnMut(u64) -> String,
    options: &Options,
) -> Result<Snapshot, Gone> {
    let mut by_id = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        if let Some(id) = node["id"].as_str() {
            by_id.insert(id, index);
        }
    }
    let roots: Vec<usize> = match options.root {
        Some(root) => {
            let matches: Vec<usize> = (0..nodes.len())
                .filter(|i| nodes[*i]["node"].as_f64() == Some(root as f64))
                .collect();
            let found = matches
                .iter()
                .copied()
                .find(|i| nodes[*i]["ignored"] != true)
                .or(matches.first().copied());
            vec![found.ok_or(Gone)?]
        }
        None => (0..nodes.len())
            .filter(|i| {
                nodes[*i]["parent"]
                    .as_str()
                    .is_none_or(|parent| !by_id.contains_key(parent))
            })
            .take(1)
            .collect(),
    };
    let mut builder = Builder {
        nodes,
        by_id,
        visited: HashSet::new(),
    };
    let mut forest: Vec<View> = roots
        .into_iter()
        .flat_map(|root| builder.build(root, &Context::default()))
        .collect();
    let query = normalize(options.query.unwrap_or(""));
    if !query.is_empty() {
        forest = forest
            .iter()
            .flat_map(|item| filter(item, &query))
            .collect();
    }
    measure(&mut forest, 0);
    if forest.is_empty() {
        let text = if query.is_empty() {
            "No accessible elements found".into()
        } else {
            format!(
                "No element matches {}",
                quote(options.query.unwrap_or("").trim_matches(space))
            )
        };
        return Ok(Snapshot { text, collapsed: 0 });
    }
    let mut writer = Writer {
        lines: vec![],
        collapsed: 0,
        issue,
    };
    let budget = options.budget.unwrap_or(DEFAULT_BUDGET).max(200);
    let top = allocate(&forest, 0, budget as isize).unwrap_or_else(|| {
        let mut first = vec![Emitted::View(&forest[0], minimum(&forest[0], 0))];
        if forest.len() > 1 {
            first.push(Emitted::More(forest.len() - 1));
        }
        first
    });
    writer.list(top, 0);
    Ok(Snapshot {
        text: writer.lines.join("\n"),
        collapsed: writer.collapsed,
    })
}
