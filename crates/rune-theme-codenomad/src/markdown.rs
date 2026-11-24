use crate::{Space, TextRole, kit, layout::dark, tokens};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use rune::{El, ScrollSpec, rich};
use rune_kit::{CodeFrame, Markdown, MarkdownStyle, syntax};
use std::borrow::Cow;

pub fn prose_has_match(source: &str, query: crate::timeline::search::Query<'_>) -> bool {
    let source = literal_breaks(source);
    !prose_ranges(&source, query, 1).is_empty()
}

pub fn prose<S: 'static>(
    source: &str,
    streaming: bool,
    highlight: bool,
    query: Option<crate::timeline::search::Query<'_>>,
    link: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    secondary: impl Fn(&mut S, &str, (f32, f32), &mut rune::Tx) + 'static,
    help: impl Fn(&str) -> Option<String> + 'static,
    wrapped: impl Fn(usize, &str) -> bool + 'static,
    frame: impl Fn(El, &CodeFrame<'_>) -> El + 'static,
) -> El {
    let dark = dark();
    let kit = kit(dark);
    let t = tokens(dark);
    let style = MarkdownStyle::from_kit(kit)
        .code_block(kit.c.bg_deep, kit.c.border_base)
        .link(kit.c.text_accent)
        .syntax_highlight(highlight);
    let source = literal_breaks(source).into_owned();
    let matches: Vec<(Vec<std::ops::Range<usize>>, rune_kit::markdown::Highlight)> = match query {
        Some(q) => prose_ranges(&source, q, 512)
            .into_iter()
            .enumerate()
            .map(|(i, spans)| {
                let hl =
                    if q.active && i == 0 && q.claimed.is_none_or(|claimed| !claimed.replace(true))
                    {
                        rune_kit::markdown::Highlight::current()
                            .bg(t.color("transcript-search-active"))
                            .fg(t.color("transcript-search-active-ink"))
                            .radius(0.0)
                            .key("history-search-match")
                    } else {
                        rune_kit::markdown::Highlight::new()
                            .bg(t.color("transcript-search-mark"))
                            .radius(0.0)
                    };
                (spans, hl)
            })
            .collect(),
        None => Vec::new(),
    };
    Markdown::new(source)
        .style(style)
        .highlights(matches)
        .selectable(true)
        .tasks_read_only()
        .scroll_wide(true)
        .streaming(streaming)
        .on_link_tx(link)
        .on_link_secondary(move |s, href, press, tx| secondary(s, href, (press.x, press.y), tx))
        .link_help(help)
        .code_wrap(wrapped)
        .code_frame(frame)
        .build(kit)
}

fn prose_ranges(
    source: &str,
    query: crate::timeline::search::Query<'_>,
    limit: usize,
) -> Vec<Vec<std::ops::Range<usize>>> {
    if limit == 0 || source.is_empty() {
        return Vec::new();
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut out = Vec::new();
    let mut rendered = String::new();
    let mut map: Vec<(usize, usize, usize)> = Vec::new();
    let flush = |rendered: &mut String,
                 map: &mut Vec<(usize, usize, usize)>,
                 out: &mut Vec<Vec<std::ops::Range<usize>>>| {
        if rendered.is_empty() || out.len() >= limit {
            rendered.clear();
            map.clear();
            return;
        }
        for hit in query.ranges(rendered, limit - out.len()) {
            let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
            for &(r_start, r_end, s_start) in map.iter() {
                let a = hit.start.max(r_start);
                let b = hit.end.min(r_end);
                if a < b {
                    let span = (s_start + (a - r_start))..(s_start + (b - r_start));
                    if let Some(prev) = spans.last_mut().filter(|prev| prev.end == span.start) {
                        prev.end = span.end;
                    } else {
                        spans.push(span);
                    }
                }
            }
            if !spans.is_empty() {
                out.push(spans);
                if out.len() >= limit {
                    break;
                }
            }
        }
        rendered.clear();
        map.clear();
    };
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        match event {
            Event::Text(ref text) | Event::Code(ref text) => {
                let src_slice = source.get(range.clone()).unwrap_or_default();
                let start = if matches!(event, Event::Code(_)) {
                    src_slice
                        .find(text.as_ref())
                        .map_or(range.start, |off| range.start + off)
                } else {
                    range.start
                };
                if source.get(start..start + text.len()) == Some(text.as_ref()) {
                    let r_start = rendered.len();
                    rendered.push_str(&text);
                    map.push((r_start, rendered.len(), start));
                } else if !text.is_empty() && query.matches(&text) {
                    out.push(vec![range]);
                    if out.len() >= limit {
                        break;
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak => rendered.push(' '),
            Event::End(
                pulldown_cmark::TagEnd::Paragraph
                | pulldown_cmark::TagEnd::Heading(_)
                | pulldown_cmark::TagEnd::Item
                | pulldown_cmark::TagEnd::CodeBlock
                | pulldown_cmark::TagEnd::TableCell,
            ) => {
                flush(&mut rendered, &mut map, &mut out);
                if out.len() >= limit {
                    break;
                }
            }
            _ => {}
        }
    }
    flush(&mut rendered, &mut map, &mut out);
    out
}

pub fn link_menu<S: 'static>(
    tx: &mut rune::Tx,
    point: (f32, f32),
    open: &str,
    copy: &str,
    help: Option<String>,
    pick: impl FnOnce(&mut S, Option<&str>, &mut rune::Tx) + 'static,
) {
    use rune::{PopupItem, PopupMenu};
    let mut menu = PopupMenu::new();
    if let Some(help) = help {
        menu = menu.item(PopupItem::new("link-help", help).enabled(false));
    }
    tx.popup_menu(
        menu.item(PopupItem::new("open", open))
            .item(PopupItem::new("copy-link", copy)),
        point,
        pick,
    );
}

// Normalize only parsed events. Diagram fences stay on Kit's source path so the
// transcript can gate preview on completion and keep source actions on one frame.
pub(crate) fn literal_breaks(source: &str) -> Cow<'_, str> {
    if !source.contains(['<', '\n']) {
        return Cow::Borrowed(source);
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut last = 0;
    let mut result = String::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        if let Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) = &event
            && let Some((word, replacement)) = diagram_fence(info, &source[range.clone()])
        {
            let start = range.start + word.start;
            result.push_str(&source[last..start]);
            result.push_str(replacement);
            last = range.start + word.end;
            continue;
        }
        match event {
            Event::SoftBreak => {
                result.push_str(&source[last..range.start]);
                result.push_str("  \n");
            }
            Event::Html(raw) | Event::InlineHtml(raw) => {
                result.push_str(&source[last..range.start]);
                for c in raw.chars() {
                    match c {
                        '\n' => result.push_str("  \n"),
                        '\r' => {}
                        c if c.is_ascii_punctuation() => {
                            use std::fmt::Write;
                            let _ = write!(result, "&#{};", c as u32);
                        }
                        c => result.push(c),
                    }
                }
            }
            _ => continue,
        }
        last = range.end;
    }
    if last == 0 {
        return Cow::Borrowed(source);
    }
    result.push_str(&source[last..]);
    Cow::Owned(result)
}

fn diagram_fence(info: &str, block: &str) -> Option<(std::ops::Range<usize>, &'static str)> {
    let kit_word = info.split(|c: char| c.is_whitespace() || c == ',').next()?;
    if !(kit_word.eq_ignore_ascii_case("mermaid") || kit_word.eq_ignore_ascii_case("mmd")) {
        return None;
    }
    let line = block.lines().next()?;
    let opening = line.trim_start();
    let marker = opening.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let language = opening.trim_start_matches(marker).trim_start();
    let word = language.split_whitespace().next()?;
    let start = line.len() - language.len();
    // Kit recognizes comma modifiers; Solid only admits a whitespace-delimited language.
    // Route both forms through the ordinary code frame, retaining Copy even for plain source.
    let replacement = if word.eq_ignore_ascii_case("mermaid") || word.eq_ignore_ascii_case("mmd") {
        "mmd"
    } else {
        "text"
    };
    Some((start..start + word.len(), replacement))
}

pub fn language_for_path(path: &str) -> &str {
    syntax::lang_for_path(path).unwrap_or("text")
}

pub fn copy_button<S: 'static>(label: &str, copy: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    let kit = kit(dark());
    rune_kit::IconButton::new(kit.glyph.copy)
        .label(label)
        .help(label)
        .on_press_tx(copy)
        .build(kit)
}

pub fn hold_frame(key: String, stamp: impl std::hash::Hash, build: impl FnOnce() -> El) -> El {
    rune::memo(key, stamp, build)
}

pub fn tool_pane(content: El, large: bool) -> El {
    rune::col()
        .w_full()
        .max_h(tool_lines(if large { 30 } else { 15 }))
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(content)
}

pub fn diff_pane(content: El, lines: usize) -> El {
    rune::col()
        .w_full()
        .h(tool_lines(lines.clamp(2, 30)))
        .child(content)
}

fn tool_lines(lines: usize) -> f32 {
    // tool-call.css: --tool-call-line-unit and --tool-call-lines-{compact,large}.
    lines as f32 * 1.4 * tokens(dark()).text(TextRole::Mono).size
}

pub fn code(source: &str, language: &str, highlight: bool, wrap: bool) -> El {
    search_code(source, language, highlight, wrap, None)
}

pub fn search_code(
    source: &str,
    language: &str,
    highlight: bool,
    wrap: bool,
    query: Option<crate::timeline::search::Query<'_>>,
) -> El {
    let dark = dark();
    let spans = if highlight {
        syntax::SyntaxTheme::from_kit(kit(dark))
            .spans(&syntax::highlight(Some(language), source), 0)
    } else {
        Vec::new()
    };
    code_body(
        crate::timeline::search::ink(rich(source, spans), source, query),
        wrap,
    )
}

pub(crate) fn code_body(body: El, wrap: bool) -> El {
    use crate::layout::Layout;
    let body = body
        .font(tokens(dark()).text(TextRole::Mono))
        .by_line()
        .selectable(true)
        .literal_direction();
    let viewport = if wrap {
        rune::col()
            .full_width()
            .child(body.full_width().wrap_anywhere())
    } else {
        rune::col().full_width().scroll_x().child(body)
    };
    rune::col()
        .full_width()
        .inset_surface()
        .pad(Space::Sm)
        .child(viewport)
}

#[cfg(test)]
#[test]
fn prose_search_bounds_matches_and_skips_link_destinations() {
    let repeated = "abc ".repeat(10_000);
    let terms = vec!["abc".into()];
    let query = crate::timeline::search::Query {
        terms: &terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert_eq!(prose_ranges(&repeated, query, 512).len(), 512);
    assert!(prose_has_match(&repeated, query));

    let link_only = "[Guide](https://example.test/ONLY_IN_URL) **Pro**of";
    let url_terms = vec!["ONLY_IN_URL".into()];
    let url_query = crate::timeline::search::Query {
        terms: &url_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(!prose_has_match(link_only, url_query));

    let split_terms = vec!["Proof".into()];
    let split_query = crate::timeline::search::Query {
        terms: &split_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(prose_has_match(link_only, split_query));
}
