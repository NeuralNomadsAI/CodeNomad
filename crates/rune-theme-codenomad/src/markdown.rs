use crate::{Space, TextRole, kit, layout::dark, tokens};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use rune::{El, ScrollSpec, rich};
use rune_kit::{CodeFrame, DiffFrame, Markdown, MarkdownStyle, syntax};
use std::borrow::Cow;

pub fn prose_has_match(source: &str, query: crate::timeline::search::Query<'_>) -> bool {
    let source = literal_breaks(source);
    !prose_ranges(&source, query, 1).is_empty()
}

#[allow(clippy::too_many_arguments)]
pub fn prose<S: 'static>(
    source: &str,
    streaming: bool,
    truncated: bool,
    highlight: bool,
    query: Option<crate::timeline::search::Query<'_>>,
    link: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    secondary: impl Fn(&mut S, &str, (f32, f32), &mut rune::Tx) + 'static,
    help: impl Fn(&str) -> Option<String> + 'static,
    wrapped: impl Fn(usize, &str) -> bool + 'static,
    frame: impl Fn(El, &CodeFrame<'_>) -> El + 'static,
    diff_frame: impl Fn(El, &DiffFrame<'_>) -> El + 'static,
) -> El {
    let dark = dark();
    let kit = &*kit(dark);
    let t = tokens(dark);
    let style = MarkdownStyle::from_kit(kit)
        .code_block(t.color("surface-inset"), rune::Color::TRANSPARENT)
        .code_block_radius(0.0)
        .code_block_text(t.color("text-primary"))
        .plain_code_text(t.color("text-primary"))
        .inline_code_bg(t.color("surface-muted"))
        .inline_code_text(t.color("text-primary"))
        .quote(t.color("border-base"), 3.0, 12.0, t.color("text-secondary"))
        .rule(t.color("border-base"))
        .link(t.color("accent-primary"))
        .link_hover(t.color("accent-hover"))
        .link_underline(rune::Color::TRANSPARENT)
        .syntax_highlight(highlight)
        .diagram_max_items(crate::document_reader::MERMAID_MAX_ITEMS);
    let source = literal_breaks_with(source, truncated).into_owned();
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
        .diff_frame(diff_frame)
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
    const MAX_SPANS: usize = 2_048;
    let mut out = Vec::new();
    let mut total_spans = 0usize;
    let mut blocks = 0usize;
    let mut rendered = String::new();
    // (rendered_start, rendered_end, source_start, source_end, verbatim)
    let mut map: Vec<(usize, usize, usize, usize, bool)> = Vec::new();
    let flush = |rendered: &mut String,
                 map: &mut Vec<(usize, usize, usize, usize, bool)>,
                 out: &mut Vec<Vec<std::ops::Range<usize>>>,
                 total_spans: &mut usize,
                 blocks: &mut usize| {
        if rendered.is_empty() {
            map.clear();
            return;
        }
        *blocks += 1;
        if out.len() >= limit || (!out.is_empty() && *total_spans >= MAX_SPANS) {
            rendered.clear();
            map.clear();
            return;
        }
        let mut cursor = 0usize;
        for hit in query.ranges(rendered, limit - out.len()) {
            while cursor < map.len() && map[cursor].1 <= hit.start {
                cursor += 1;
            }
            let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
            let mut idx = cursor;
            while let Some(&(r_start, r_end, s_start, s_end, verbatim)) = map.get(idx) {
                if r_start >= hit.end {
                    break;
                }
                let a = hit.start.max(r_start);
                let b = hit.end.min(r_end);
                if a < b {
                    let span = if verbatim {
                        (s_start + (a - r_start))..(s_start + (b - r_start))
                    } else {
                        s_start..s_end
                    };
                    if let Some(prev) = spans.last_mut().filter(|prev| prev.end >= span.start) {
                        prev.end = prev.end.max(span.end);
                    } else {
                        spans.push(span);
                    }
                }
                idx += 1;
            }
            if !spans.is_empty() {
                if !out.is_empty() && total_spans.saturating_add(spans.len()) > MAX_SPANS {
                    break;
                }
                *total_spans = total_spans.saturating_add(spans.len());
                out.push(spans);
                if out.len() >= limit || *total_spans >= MAX_SPANS {
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
                if text.is_empty() {
                    continue;
                }
                let r_start = rendered.len();
                rendered.push_str(text);
                let src_slice = source.get(range.clone()).unwrap_or_default();
                if matches!(event, Event::Code(_)) {
                    let ticks = src_slice.bytes().take_while(|&b| b == b'`').count();
                    let inner_start = range.start + ticks;
                    let inner = src_slice
                        .get(ticks..src_slice.len().saturating_sub(ticks))
                        .unwrap_or(src_slice);
                    if let Some(off) = inner.find(text.as_ref()) {
                        let start = inner_start + off;
                        map.push((r_start, rendered.len(), start, start + text.len(), true));
                    } else if let Some(runs) = map_inline_code(inner, inner_start, text.as_ref()) {
                        for (rel_r0, rel_r1, s0, s1) in runs {
                            let verbatim = (rel_r1 - rel_r0) == (s1 - s0)
                                && source.get(s0..s1) == text.get(rel_r0..rel_r1);
                            map.push((r_start + rel_r0, r_start + rel_r1, s0, s1, verbatim));
                        }
                    } else {
                        map.push((r_start, rendered.len(), range.start, range.end, false));
                    }
                } else {
                    let verbatim =
                        source.get(range.start..range.start + text.len()) == Some(text.as_ref());
                    let (s_start, s_end) = if verbatim {
                        (range.start, range.start + text.len())
                    } else {
                        (range.start, range.end)
                    };
                    map.push((r_start, rendered.len(), s_start, s_end, verbatim));
                }
            }
            Event::SoftBreak => rendered.push(' '),
            Event::HardBreak => rendered.push('\n'),
            Event::Start(
                Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::List(_)
                | Tag::Item
                | Tag::CodeBlock(_)
                | Tag::BlockQuote(_)
                | Tag::Table(_)
                | Tag::TableRow
                | Tag::TableCell,
            )
            | Event::End(
                pulldown_cmark::TagEnd::Paragraph
                | pulldown_cmark::TagEnd::Heading(_)
                | pulldown_cmark::TagEnd::Item
                | pulldown_cmark::TagEnd::CodeBlock
                | pulldown_cmark::TagEnd::TableCell,
            ) => {
                flush(
                    &mut rendered,
                    &mut map,
                    &mut out,
                    &mut total_spans,
                    &mut blocks,
                );
                if limit == 1 && !out.is_empty() {
                    break;
                }
            }
            _ => {}
        }
    }
    flush(
        &mut rendered,
        &mut map,
        &mut out,
        &mut total_spans,
        &mut blocks,
    );
    if limit > 1 {
        out.truncate((16_384 / blocks.max(1)).clamp(1, limit));
    }
    out
}

fn map_inline_code(
    inner: &str,
    inner_start: usize,
    text: &str,
) -> Option<Vec<(usize, usize, usize, usize)>> {
    let try_from = |mut si: usize| {
        let ib = inner.as_bytes();
        let tb = text.as_bytes();
        let mut ti = 0;
        let mut runs = Vec::new();
        while ti < tb.len() {
            if si >= ib.len() {
                return None;
            }
            if ib[si] == tb[ti] {
                let r0 = ti;
                let s0 = inner_start + si;
                while ti < tb.len() && si < ib.len() && ib[si] == tb[ti] {
                    si += 1;
                    ti += 1;
                }
                runs.push((r0, ti, s0, inner_start + si));
            } else if tb[ti] == b' ' && matches!(ib[si], b'\n' | b'\r') {
                let s0 = inner_start + si;
                if ib[si] == b'\r' && ib.get(si + 1) == Some(&b'\n') {
                    si += 2;
                } else {
                    si += 1;
                }
                // Consume Markdown blockquote continuation prefixes (`> `) on wrapped inline code lines.
                loop {
                    let save = si;
                    while si < ib.len() && matches!(ib[si], b' ' | b'\t') {
                        si += 1;
                    }
                    if ib.get(si) == Some(&b'>') {
                        si += 1;
                        if ib.get(si) == Some(&b' ') {
                            si += 1;
                        }
                    } else {
                        si = save;
                        break;
                    }
                }
                runs.push((ti, ti + 1, s0, inner_start + si));
                ti += 1;
            } else {
                return None;
            }
        }
        let trailing = &ib[si..];
        if trailing.is_empty()
            || (si > 0 && matches!(trailing, [b' '] | [b'\n'] | [b'\r'] | [b'\r', b'\n']))
        {
            Some(runs)
        } else {
            None
        }
    };
    if let Some(runs) = try_from(0) {
        return Some(runs);
    }
    let ib = inner.as_bytes();
    let skip = if ib.starts_with(b"\r\n") {
        2
    } else if matches!(ib.first(), Some(b' ' | b'\n' | b'\r')) {
        1
    } else {
        return None;
    };
    try_from(skip)
}

pub fn link_menu<S: 'static>(
    tx: &mut rune::Tx,
    point: (f32, f32),
    open: &str,
    copy: &str,
    help: Option<String>,
    look: crate::layout::PopupMenuLook,
    pick: impl FnOnce(&mut S, Option<&str>, &mut rune::Tx) + 'static,
) {
    use rune::{PopupItem, PopupMenu};
    let mut menu = PopupMenu::new().style(look.into_style());
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
    literal_breaks_with(source, false)
}

fn literal_breaks_with(source: &str, truncated: bool) -> Cow<'_, str> {
    if !source.contains(['<', '\n']) {
        return Cow::Borrowed(source);
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut last = 0;
    let mut in_list_item = 0usize;
    let mut quote_depth = 0usize;
    let mut result = String::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        match &event {
            Event::Start(Tag::Item) => {
                in_list_item += 1;
                continue;
            }
            Event::End(pulldown_cmark::TagEnd::Item) => {
                in_list_item = in_list_item.saturating_sub(1);
                continue;
            }
            Event::Start(Tag::BlockQuote(_)) => {
                quote_depth += 1;
                continue;
            }
            Event::End(pulldown_cmark::TagEnd::BlockQuote(_)) => {
                quote_depth = quote_depth.saturating_sub(1);
                continue;
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let line_start = source[..range.start].rfind('\n').map_or(0, |i| i + 1);
                let block = &source[range.clone()];
                let truncated_end =
                    truncated && range.end == source.len() && !block.ends_with('\n');
                if let Some((word, replacement)) = diagram_fence(
                    info,
                    &source[line_start..range.start],
                    block,
                    in_list_item > 0,
                    quote_depth,
                    truncated_end,
                ) {
                    let start = range.start + word.start;
                    result.push_str(&source[last..start]);
                    result.push_str(replacement);
                    last = range.start + word.end;
                    continue;
                }
            }
            _ => {}
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

fn diagram_fence(
    info: &str,
    line_prefix: &str,
    block: &str,
    in_list_item: bool,
    quote_depth: usize,
    truncated_end: bool,
) -> Option<(std::ops::Range<usize>, &'static str)> {
    let kit_word = info.split(|c: char| c.is_whitespace() || c == ',').next()?;
    if !(kit_word.eq_ignore_ascii_case("mermaid") || kit_word.eq_ignore_ascii_case("mmd")) {
        return None;
    }
    let line = block.lines().next()?;
    let opening = line.trim_start();
    let marker = opening.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let fence_len = opening.bytes().take_while(|&b| b == marker as u8).count();
    let language = opening[fence_len..].trim_start();
    let word = language.split_whitespace().next()?;
    let start = line.len() - language.len();
    // Kit recognizes comma modifiers; Solid only admits a whitespace-delimited language.
    // Route both forms through the ordinary code frame, retaining Copy even for plain source.
    let replacement = if word.eq_ignore_ascii_case("mermaid") || word.eq_ignore_ascii_case("mmd") {
        if !truncated_end
            && commonmark_closed(
                line_prefix,
                block,
                marker,
                fence_len,
                in_list_item,
                quote_depth,
            )
        {
            "mmd"
        } else {
            "mmd-open"
        }
    } else {
        "text"
    };
    Some((start..start + word.len(), replacement))
}

fn strip_container_prefix<'a>(
    line_prefix: &str,
    last: &'a str,
    in_list_item: bool,
    quote_depth: usize,
) -> Option<(&'a str, usize)> {
    if quote_depth == 0 {
        let indent = if in_list_item || line_prefix.bytes().any(|b| !matches!(b, b' ' | b'\t')) {
            line_prefix.chars().count()
        } else {
            0
        };
        return Some((last, indent));
    }
    let mut lp = line_prefix;
    let mut cur = last;
    for _ in 0..quote_depth {
        let pos = lp.find('>')?;
        let before = &lp[..pos];
        let before_limit = if before.bytes().any(|b| !matches!(b, b' ' | b'\t')) {
            before.chars().count() + 3
        } else {
            3
        };
        let trimmed = cur.trim_start_matches(' ');
        if cur.len() - trimmed.len() > before_limit {
            return None;
        }
        let rest = trimmed.strip_prefix('>')?;
        cur = rest.strip_prefix(' ').unwrap_or(rest);
        let after_lp = &lp[pos + 1..];
        lp = after_lp.strip_prefix(' ').unwrap_or(after_lp);
    }
    let after_indent = if in_list_item || lp.bytes().any(|b| !matches!(b, b' ' | b'\t')) {
        lp.chars().count()
    } else {
        0
    };
    Some((cur, after_indent))
}

fn commonmark_closed(
    line_prefix: &str,
    block: &str,
    marker: char,
    fence_len: usize,
    in_list_item: bool,
    quote_depth: usize,
) -> bool {
    let mut lines = block.lines();
    if lines.next().is_none() {
        return false;
    }
    let Some(last) = lines.last() else {
        return false;
    };
    let Some((tail, container_indent)) =
        strip_container_prefix(line_prefix, last, in_list_item, quote_depth)
    else {
        return false;
    };
    let indent = tail.bytes().take_while(|&b| b == b' ').count();
    if indent > container_indent + 3 {
        return false;
    }
    let rest = &tail[indent..];
    let closing = rest.bytes().take_while(|&b| b == marker as u8).count();
    closing >= fence_len && rest[closing..].bytes().all(|b| matches!(b, b' ' | b'\t'))
}

pub fn language_for_path(path: &str) -> &str {
    syntax::lang_for_path(path).unwrap_or("text")
}

pub fn copy_button<S: 'static>(label: &str, copy: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    let kit = &*kit(dark());
    let action = std::rc::Rc::new(copy);
    let press = action.clone();
    rune_kit::IconButton::new(kit.glyph.copy)
        .variant(rune_kit::IconButtonVariant::GhostMuted)
        .control_size(rune_kit::ControlSize::Small)
        .label(label)
        .help(label)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(kit)
        .on_key(crate::layout::enter_action(action))
}

pub fn hold_frame(key: String, stamp: impl std::hash::Hash, build: impl FnOnce() -> El) -> El {
    rune::memo(key, (crate::layout::appearance_key(), stamp), build)
}

pub const STEP_DETACH_THRESHOLD: f32 = 24.0;

pub fn tool_pane(content: El, large: bool) -> El {
    follow_tool_pane(content, large, false)
}

pub fn follow_tool_pane(content: El, large: bool, stick_bottom: bool) -> El {
    rune::col()
        .w_full()
        .max_h(tool_lines(if large { 30 } else { 15 }))
        .scroll(ScrollSpec { stick_bottom })
        .child(content)
}

#[allow(clippy::too_many_arguments)]
pub fn steps_pane<S: 'static>(
    key: String,
    label: &str,
    count: usize,
    version: u64,
    row_key: impl for<'a> Fn(&'a S, usize) -> std::borrow::Cow<'a, str> + 'static,
    build: impl Fn(&S, usize) -> El + 'static,
    on_visible: impl Fn(&mut S, std::ops::Range<usize>) -> bool + 'static,
    on_at_bottom: impl Fn(&mut S, bool) -> bool + 'static,
    on_selection: impl Fn(&mut S, &rune::SelectionChange, &mut rune::Tx) + 'static,
) -> El {
    let gap = tokens(dark()).space(Space::Sm).px();
    let list = crate::layout::transcript_rows(count, row_key, build)
        .key(format!("{key}-list"))
        .role("list")
        .label(label)
        .gap(gap)
        .virtual_rows_version(version)
        .on_visible_rows(on_visible);
    rune::col()
        .key(key)
        .w_full()
        .max_h(tool_lines(30))
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_anchor()
        .on_at_bottom_if(on_at_bottom)
        .on_selection_change(on_selection)
        .child(list)
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
        syntax::SyntaxTheme::from_kit(&kit(dark))
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

    let entity_terms = vec!["R&D".into()];
    let entity_query = crate::timeline::search::Query {
        terms: &entity_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(prose_has_match("Team R&amp;D roadmap", entity_query));

    let dense_bold = "**hit** ".repeat(4_000);
    let bold_terms = vec!["hit".into()];
    let bold_query = crate::timeline::search::Query {
        terms: &bold_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert_eq!(prose_ranges(&dense_bold, bold_query, 512).len(), 512);

    let many_blocks = "hit\n\n".repeat(2_000);
    let capped = prose_ranges(&many_blocks, bold_query, 512);
    assert!(!capped.is_empty() && capped.len() <= 16);

    let tight_list = "- foo\n  - bar\n";
    let merged_terms = vec!["foobar".into()];
    let merged_query = crate::timeline::search::Query {
        terms: &merged_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(!prose_has_match(tight_list, merged_query));

    let code_nl = "`alpha\nbeta`";
    let alpha_terms = vec!["alpha".into()];
    let alpha_query = crate::timeline::search::Query {
        terms: &alpha_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    let spans = prose_ranges(code_nl, alpha_query, 16);
    assert_eq!(spans, vec![vec![1..6]]);

    let hard_break = "alpha  \nbeta";
    let space_terms = vec!["alpha beta".into()];
    let space_query = crate::timeline::search::Query {
        terms: &space_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(!prose_has_match(hard_break, space_query));
}

#[cfg(test)]
#[test]
fn hold_frame_invalidates_when_palette_or_contrast_changes_at_same_luminance() {
    use crate::palettes::{
        ColorField, ResolvedPalette, built_in, custom, increased_contrast, with_resolved,
    };
    use std::cell::Cell;
    use std::rc::Rc;

    let first = built_in().iter().find(|p| p.dark).expect("dark palette");
    let second = built_in()
        .iter()
        .find(|p| p.dark && p.id != first.id)
        .expect("second dark palette");
    let contrast = increased_contrast(Some(first), true).expect("high-contrast variant");
    let custom_a = custom(Some("card-custom"), true, false, first.colors());
    let custom_b = custom(
        Some("card-custom"),
        true,
        false,
        first
            .colors()
            .with(ColorField::SurfaceBase, "#102820")
            .expect("valid hex"),
    );

    let builds = Rc::new(Cell::new(0usize));
    let mut rt = rune::Runtime::new(
        (Some(ResolvedPalette::BuiltIn(first)), Rc::clone(&builds)),
        |(palette, count), cx| {
            with_resolved(palette.clone(), || {
                crate::layout::render_with_dark(cx, true, |_| {
                    hold_frame("tool-card".into(), 1u8, || {
                        count.set(count.get() + 1);
                        rune::text("ok")
                    })
                })
            })
        },
        (400.0, 200.0),
        rune::Env::new(true, 1.0),
    );

    rt.frame(0.02);
    assert_eq!(builds.get(), 1);

    rt.frame(0.02);
    assert_eq!(builds.get(), 1, "same palette must reuse hold_frame memo");

    rt.update(|state, _| state.0 = Some(ResolvedPalette::BuiltIn(second)));
    rt.frame(0.02);
    assert_eq!(
        builds.get(),
        2,
        "switching built-in dark palette must rebuild"
    );

    rt.update(|state, _| state.0 = Some(ResolvedPalette::BuiltIn(contrast)));
    rt.frame(0.02);
    assert_eq!(builds.get(), 3, "toggling high contrast must rebuild");

    rt.update(|state, _| state.0 = Some(custom_a));
    rt.frame(0.02);
    assert_eq!(builds.get(), 4, "switching to custom palette must rebuild");

    rt.update(|state, _| state.0 = Some(custom_b));
    rt.frame(0.02);
    assert_eq!(
        builds.get(),
        5,
        "editing custom palette colors must rebuild"
    );
}
