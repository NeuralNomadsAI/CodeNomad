use crate::{Space, TextRole, kit, layout::dark, tokens};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use rune::{El, ScrollSpec, rich};
pub use rune_kit::markdown::ImageFrame;
use rune_kit::markdown::{Block, parse};
use rune_kit::{CodeFrame, DiffFrame, Markdown, MarkdownStyle, syntax};
use std::borrow::Cow;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiftedImage {
    pub src: String,
    pub alt: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImageSearch {
    /// Keep the image's alt text in prose search (non-lifted or unresolved images).
    Inline,
    /// Rendered image pixels: omit highlight spans while keeping its accessible label discoverable
    /// for visibility checks.
    Hidden { label: String },
    /// Match against a custom fallback label rendered by `image_frame`.
    Fallback { key: String, label: String },
}

pub fn prose_has_match(source: &str, query: crate::timeline::search::Query<'_>) -> bool {
    let source = literal_breaks(source);
    let (ranges, active_image, unhighlighted_image) =
        prose_ranges_with_images(&source, query, 1, &|_| ImageSearch::Inline);
    !ranges.is_empty() || active_image.is_some() || unhighlighted_image
}

pub fn prose_has_match_with_images(
    source: &str,
    truncated: bool,
    query: crate::timeline::search::Query<'_>,
    fallback_label: &dyn Fn(&str, bool) -> Option<String>,
    image_search_text: &dyn Fn(&str) -> ImageSearch,
) -> bool {
    let source = literal_breaks_with_images(source, truncated, fallback_label);
    let (ranges, active_image, unhighlighted_image) =
        prose_ranges_with_images(&source, query, 1, image_search_text);
    !ranges.is_empty() || active_image.is_some() || unhighlighted_image
}

pub fn prose_has_highlight_with_images(
    source: &str,
    truncated: bool,
    query: crate::timeline::search::Query<'_>,
    fallback_label: &dyn Fn(&str, bool) -> Option<String>,
    image_search_text: &dyn Fn(&str) -> ImageSearch,
) -> bool {
    let source = literal_breaks_with_images(source, truncated, fallback_label);
    let (ranges, active_image, _) = prose_ranges_with_images(&source, query, 1, image_search_text);
    !ranges.is_empty() || active_image.is_some()
}

/// Returns every lifted `Block::Image` occurrence and its normalized plain alt text in document
/// order. Non-liftable and nested images are flattened before parsing so discovery, search and
/// rendering share the same block order and fallback labels.
pub fn prose_lifted_images(source: &str, truncated: bool) -> Vec<LiftedImage> {
    fn collect(
        blocks: Vec<Block>,
        alts: &mut std::collections::HashMap<String, std::collections::VecDeque<String>>,
        found: &mut Vec<LiftedImage>,
    ) {
        for block in blocks {
            match block {
                Block::Image { src, alt, .. } => {
                    let normalized_alt = alts
                        .get_mut(&src)
                        .and_then(std::collections::VecDeque::pop_front)
                        .unwrap_or(alt);
                    found.push(LiftedImage {
                        src,
                        alt: normalized_alt,
                    });
                }
                Block::Quote(items) => collect(items, alts, found),
                Block::List { items, .. } => {
                    for item in items {
                        collect(item, alts, found);
                    }
                }
                _ => {}
            }
        }
    }
    if !source.contains("![") {
        return Vec::new();
    }
    let normalized = literal_breaks_with_images(source, truncated, &|_, liftable| {
        (!liftable).then(String::new)
    });
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut alts: std::collections::HashMap<String, std::collections::VecDeque<String>> =
        std::collections::HashMap::new();
    let mut depth = 0usize;
    let mut current_src = String::new();
    let mut current_alt = String::new();
    for event in Parser::new_ext(&normalized, options) {
        if depth > 0 {
            match event {
                Event::Start(Tag::Image { .. }) => depth += 1,
                Event::End(pulldown_cmark::TagEnd::Image) => {
                    depth -= 1;
                    if depth == 0 {
                        alts.entry(std::mem::take(&mut current_src))
                            .or_default()
                            .push_back(std::mem::take(&mut current_alt));
                    }
                }
                Event::Text(text)
                | Event::Code(text)
                | Event::InlineHtml(text)
                | Event::Html(text) => current_alt.push_str(&text),
                Event::SoftBreak | Event::HardBreak => current_alt.push(' '),
                _ => {}
            }
            continue;
        }
        if let Event::Start(Tag::Image { dest_url, .. }) = event
            && !dest_url.is_empty()
        {
            depth = 1;
            current_src.clear();
            current_src.push_str(&dest_url);
            current_alt.clear();
        }
    }
    let mut found = Vec::new();
    collect(parse(&normalized), &mut alts, &mut found);
    found
}

pub fn prose_image(image: El) -> El {
    image.radius(0.0).cursor(rune::Cursor::Default)
}

pub fn prose_image_placeholder([width, height]: [u32; 2], max_h: f32, label: &str) -> El {
    let ratio = if width > 0 && height > 0 {
        width as f32 / height as f32
    } else {
        1.0
    };
    rune::el()
        .aspect_fit(ratio)
        .max_w(width.max(1) as f32)
        .max_h(if max_h > 0.0 { max_h } else { 512.0 })
        .radius(0.0)
        .role("img")
        .label(label)
}

pub fn prose_fallback_text(label: &str, query: Option<crate::timeline::search::Query<'_>>) -> El {
    crate::timeline::search::ink(rune::text(label.to_owned()).selectable(true), label, query)
}

pub fn blank_pixel(wake: rune::Waker) -> rune::Image {
    rune::ImageCache::new(wake).rgba(1, 1, [0_u8, 0, 0, 0])
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
    prose_with_images(
        source,
        streaming,
        truncated,
        highlight,
        query,
        link,
        secondary,
        help,
        wrapped,
        frame,
        diff_frame,
        &|_, _| None,
        &|_| ImageSearch::Inline,
        |_| None,
        |el, _, _| prose_image(el),
    )
}

#[inline(never)]
fn prose_style(kit: &rune_kit::Kit, dark: bool, highlight: bool) -> Box<MarkdownStyle> {
    let t = tokens(dark);
    let style = Box::new(
        MarkdownStyle::from_kit(kit)
            .code_block(t.color("surface-inset"), t.color("border-base"))
            .code_block_radius(0.0)
            .code_block_text(t.color("text-primary"))
            .plain_code_text(t.color("text-primary")),
    );
    let style = prose_style_inline(style, dark);
    prose_style_misc(style, dark, highlight)
}

#[inline(never)]
fn prose_style_inline(style: Box<MarkdownStyle>, dark: bool) -> Box<MarkdownStyle> {
    let t = tokens(dark);
    Box::new(
        (*style)
            .inline_code_bg(t.color("surface-muted"))
            .inline_code_text(t.color("text-primary"))
            .quote(t.color("border-base"), 3.0, 12.0, t.color("text-secondary"))
            .rule(t.color("border-base")),
    )
}

#[inline(never)]
fn prose_style_misc(style: Box<MarkdownStyle>, dark: bool, highlight: bool) -> Box<MarkdownStyle> {
    let t = tokens(dark);
    Box::new(
        (*style)
            .link(t.color("accent-primary"))
            .link_hover(t.color("accent-hover"))
            .link_underline(rune::Color::TRANSPARENT)
            .syntax_highlight(highlight)
            .diagram_max_items(crate::document_reader::MERMAID_MAX_ITEMS),
    )
}

type ProseHighlights = (
    Vec<(Vec<std::ops::Range<usize>>, rune_kit::markdown::Highlight)>,
    Option<String>,
);

#[inline(never)]
fn prose_highlights(
    source: &str,
    dark: bool,
    query: Option<crate::timeline::search::Query<'_>>,
    image_search_text: &dyn Fn(&str) -> ImageSearch,
) -> ProseHighlights {
    let Some(q) = query else {
        return (Vec::new(), None);
    };
    let t = tokens(dark);
    let (ranges, first_image, _) = prose_ranges_with_images(source, q, 512, image_search_text);
    let active_image = if q.active
        && first_image.is_some()
        && q.claimed.is_none_or(|claimed| !claimed.replace(true))
    {
        first_image
    } else {
        None
    };
    let matches = ranges
        .into_iter()
        .enumerate()
        .map(|(i, spans)| {
            let hl = if active_image.is_none()
                && q.active
                && i == 0
                && q.claimed.is_none_or(|claimed| !claimed.replace(true))
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
        .collect();
    (matches, active_image)
}

#[inline(never)]
fn prose_markdown_base(
    source: String,
    style: Box<MarkdownStyle>,
    matches: Vec<(Vec<std::ops::Range<usize>>, rune_kit::markdown::Highlight)>,
    streaming: bool,
) -> Box<Markdown> {
    let md = Box::new(Markdown::new(source).style(*style).highlights(matches));
    prose_markdown_flags(md, streaming)
}

#[inline(never)]
fn prose_markdown_flags(md: Box<Markdown>, streaming: bool) -> Box<Markdown> {
    Box::new(
        (*md)
            .selectable(true)
            .tasks_read_only()
            .scroll_wide(true)
            .streaming(streaming),
    )
}

#[inline(never)]
fn prose_markdown_links<S: 'static>(
    md: Box<Markdown>,
    link: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    secondary: impl Fn(&mut S, &str, (f32, f32), &mut rune::Tx) + 'static,
    help: impl Fn(&str) -> Option<String> + 'static,
) -> Box<Markdown> {
    Box::new(
        (*md)
            .on_link_tx(link)
            .on_link_secondary(move |s, href, press, tx| secondary(s, href, (press.x, press.y), tx))
            .link_help(help),
    )
}

#[inline(never)]
fn prose_markdown_media(
    md: Box<Markdown>,
    image: impl Fn(&str) -> Option<rune::Image> + 'static,
    image_frame: impl Fn(El, &ImageFrame<'_>, Option<&str>) -> El + 'static,
    active_image_key: Option<String>,
) -> Box<Markdown> {
    Box::new(
        (*md)
            .images(image)
            .image_frame(move |el, frame| image_frame(el, frame, active_image_key.as_deref())),
    )
}

#[inline(never)]
fn prose_markdown_frames(
    md: Box<Markdown>,
    wrapped: impl Fn(usize, &str) -> bool + 'static,
    frame: impl Fn(El, &CodeFrame<'_>) -> El + 'static,
    diff_frame: impl Fn(El, &DiffFrame<'_>) -> El + 'static,
    kit: &rune_kit::Kit,
) -> El {
    (*md)
        .code_wrap(wrapped)
        .code_frame(frame)
        .diff_frame(diff_frame)
        .build(kit)
}

#[allow(clippy::too_many_arguments)]
pub fn prose_with_images<S: 'static>(
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
    fallback_label: &dyn Fn(&str, bool) -> Option<String>,
    image_search_text: &dyn Fn(&str) -> ImageSearch,
    image: impl Fn(&str) -> Option<rune::Image> + 'static,
    image_frame: impl Fn(El, &ImageFrame<'_>, Option<&str>) -> El + 'static,
) -> El {
    let dark = dark();
    let kit = &*kit(dark);
    let style = prose_style(kit, dark, highlight);
    let source = literal_breaks_with_images(source, truncated, fallback_label).into_owned();
    let (matches, active_image_key) = prose_highlights(&source, dark, query, image_search_text);
    let md = prose_markdown_base(source, style, matches, streaming);
    let md = prose_markdown_links(md, link, secondary, help);
    let md = prose_markdown_media(md, image, image_frame, active_image_key);
    prose_markdown_frames(md, wrapped, frame, diff_frame, kit)
}

#[cfg(test)]
fn prose_ranges(
    source: &str,
    query: crate::timeline::search::Query<'_>,
    limit: usize,
) -> Vec<Vec<std::ops::Range<usize>>> {
    prose_ranges_with_images(source, query, limit, &|_| ImageSearch::Inline).0
}

fn prose_ranges_with_images(
    source: &str,
    query: crate::timeline::search::Query<'_>,
    limit: usize,
    image_search_text: &dyn Fn(&str) -> ImageSearch,
) -> (Vec<Vec<std::ops::Range<usize>>>, Option<String>, bool) {
    if limit == 0 || source.is_empty() {
        return (Vec::new(), None, false);
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    const MAX_SPANS: usize = 2_048;
    let mut out = Vec::new();
    let mut first_image_hit: Option<String> = None;
    let mut unhighlighted_image_match = false;
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
    let mut non_liftable_depth = 0usize;
    let mut skipped_image_depth = 0usize;
    let mut skipped_image_fallback: Option<(String, String)> = None;
    let mut skipped_image_collect_alt = false;
    let mut skipped_image_alt = String::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        if skipped_image_depth > 0 {
            match event {
                Event::Start(Tag::Image { .. }) => skipped_image_depth += 1,
                Event::End(pulldown_cmark::TagEnd::Image) => {
                    skipped_image_depth = skipped_image_depth.saturating_sub(1);
                    if skipped_image_depth == 0 {
                        if let Some((slot_key, label)) = skipped_image_fallback.take() {
                            if out.is_empty() && first_image_hit.is_none() && query.matches(&label)
                            {
                                first_image_hit = Some(slot_key);
                                if limit == 1 {
                                    break;
                                }
                            }
                        } else if skipped_image_collect_alt {
                            if !unhighlighted_image_match
                                && !skipped_image_alt.is_empty()
                                && query.matches(&skipped_image_alt)
                            {
                                unhighlighted_image_match = true;
                            }
                            skipped_image_alt.clear();
                            skipped_image_collect_alt = false;
                        }
                    }
                }
                Event::Text(ref text)
                | Event::Code(ref text)
                | Event::InlineHtml(ref text)
                | Event::Html(ref text)
                    if skipped_image_collect_alt =>
                {
                    skipped_image_alt.push_str(text);
                }
                Event::SoftBreak | Event::HardBreak if skipped_image_collect_alt => {
                    skipped_image_alt.push(' ');
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Image { ref dest_url, .. })
                if !dest_url.is_empty() && non_liftable_depth == 0 =>
            {
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
                skipped_image_depth = 1;
                match image_search_text(dest_url) {
                    ImageSearch::Inline => {
                        skipped_image_fallback = None;
                        skipped_image_collect_alt = true;
                        skipped_image_alt.clear();
                    }
                    ImageSearch::Hidden { label } => {
                        skipped_image_fallback = None;
                        skipped_image_collect_alt = false;
                        if !unhighlighted_image_match && !label.is_empty() && query.matches(&label)
                        {
                            unhighlighted_image_match = true;
                        }
                    }
                    ImageSearch::Fallback { key, label } => {
                        skipped_image_fallback = Some((key, label));
                        skipped_image_collect_alt = false;
                    }
                }
            }
            Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. }) => {
                non_liftable_depth += 1;
            }
            Event::End(
                pulldown_cmark::TagEnd::Emphasis
                | pulldown_cmark::TagEnd::Strong
                | pulldown_cmark::TagEnd::Strikethrough
                | pulldown_cmark::TagEnd::Link,
            ) => {
                non_liftable_depth = non_liftable_depth.saturating_sub(1);
            }
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
            Event::Start(Tag::Heading { .. } | Tag::TableCell) => {
                non_liftable_depth += 1;
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
            Event::End(pulldown_cmark::TagEnd::Heading(_) | pulldown_cmark::TagEnd::TableCell) => {
                non_liftable_depth = non_liftable_depth.saturating_sub(1);
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
            Event::Start(
                Tag::Paragraph
                | Tag::List(_)
                | Tag::Item
                | Tag::CodeBlock(_)
                | Tag::BlockQuote(_)
                | Tag::Table(_)
                | Tag::TableRow,
            )
            | Event::End(
                pulldown_cmark::TagEnd::Paragraph
                | pulldown_cmark::TagEnd::Item
                | pulldown_cmark::TagEnd::CodeBlock,
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
    (out, first_image_hit, unhighlighted_image_match)
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
    literal_breaks_with_images(source, false, &|_, _| None)
}

fn push_escaped_markdown(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '\n' => out.push_str("  \n"),
            '\r' => {}
            c if c.is_ascii_punctuation() => {
                use std::fmt::Write;
                let _ = write!(out, "&#{};", c as u32);
            }
            c => out.push(c),
        }
    }
}

fn push_escaped_image_fallback(out: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    // Empty-destination Markdown images stay inline plain text in Rune Kit and are skipped by its
    // URL autolinker, while keeping searchable text spans aligned for prose_ranges.
    out.push_str("![");
    for c in text.chars() {
        match c {
            '\n' => out.push(' '),
            '\r' => {}
            c if c.is_ascii_punctuation() => {
                use std::fmt::Write;
                let _ = write!(out, "&#{};", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push_str("]()");
}

fn literal_breaks_with_images<'a>(
    source: &'a str,
    truncated: bool,
    fallback_label: &dyn Fn(&str, bool) -> Option<String>,
) -> Cow<'a, str> {
    if !source.contains(['<', '\n']) && !source.contains("![") {
        return Cow::Borrowed(source);
    }
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut last = 0;
    let mut in_list_item = 0usize;
    let mut quote_depth = 0usize;
    let mut non_liftable_depth = 0usize;
    let mut kept_image_depth = 0usize;
    let mut stripped_image_depth = 0usize;
    let mut stripped_fallback = String::new();
    let mut stripped_alt = String::new();
    let mut result = String::new();
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        if stripped_image_depth > 0 {
            match event {
                Event::Start(Tag::Image { .. }) => stripped_image_depth += 1,
                Event::End(pulldown_cmark::TagEnd::Image) => {
                    stripped_image_depth -= 1;
                    if stripped_image_depth == 0 {
                        let shown =
                            if stripped_alt.trim().is_empty() && !stripped_fallback.is_empty() {
                                stripped_fallback.as_str()
                            } else {
                                stripped_alt.as_str()
                            };
                        push_escaped_image_fallback(&mut result, shown);
                        stripped_alt.clear();
                        stripped_fallback.clear();
                        last = range.end;
                    }
                }
                Event::Text(text)
                | Event::Code(text)
                | Event::InlineHtml(text)
                | Event::Html(text) => stripped_alt.push_str(&text),
                Event::SoftBreak | Event::HardBreak => stripped_alt.push(' '),
                _ => {}
            }
            continue;
        }
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
            Event::Start(
                Tag::Heading { .. }
                | Tag::TableCell
                | Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Link { .. },
            ) => {
                non_liftable_depth += 1;
                continue;
            }
            Event::End(
                pulldown_cmark::TagEnd::Heading(_)
                | pulldown_cmark::TagEnd::TableCell
                | pulldown_cmark::TagEnd::Emphasis
                | pulldown_cmark::TagEnd::Strong
                | pulldown_cmark::TagEnd::Strikethrough
                | pulldown_cmark::TagEnd::Link,
            ) => {
                non_liftable_depth = non_liftable_depth.saturating_sub(1);
                continue;
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                if kept_image_depth > 0 {
                    // Flatten every image nested inside a kept image's alt text (regardless of its
                    // destination) so discovery, search and rendering share the same lifted blocks.
                    result.push_str(&source[last..range.start]);
                    stripped_image_depth = 1;
                    stripped_alt.clear();
                    stripped_fallback.clear();
                    continue;
                }
                if let Some(fallback) = fallback_label(dest_url, non_liftable_depth == 0) {
                    result.push_str(&source[last..range.start]);
                    stripped_image_depth = 1;
                    stripped_alt.clear();
                    stripped_fallback = fallback;
                    continue;
                }
                kept_image_depth += 1;
                continue;
            }
            Event::End(pulldown_cmark::TagEnd::Image) => {
                kept_image_depth = kept_image_depth.saturating_sub(1);
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
                push_escaped_markdown(&mut result, &raw);
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
    rune_kit::IconButton::new(kit.glyph.copy)
        .label(label)
        .help(label)
        .on_press_tx(copy)
        .build(kit)
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
fn literal_breaks_with_images_strips_only_selected_images_and_escapes_alt_text() {
    let source = "See ![*Chart* [1]](missing.png) and ![Ok](found.png) and ![](empty.png)\n\n## ![Head](found.png)\n\nOk again";
    let rewritten = literal_breaks_with_images(source, false, &|src, liftable| {
        if !liftable || src != "found.png" {
            Some(src.to_owned())
        } else {
            None
        }
    });
    assert_eq!(
        rewritten,
        "See ![Chart &#91;1&#93;]() and ![Ok](found.png) and ![empty&#46;png]()\n\n## ![Head]()\n\nOk again"
    );
    let terms = vec!["Chart".into()];
    let query = crate::timeline::search::Query {
        terms: &terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    let chart_spans = prose_ranges(&rewritten, query, 8);
    assert_eq!(chart_spans.len(), 1);
    assert_eq!(&rewritten[chart_spans[0][0].clone()], "Chart");
    let url_alt = literal_breaks_with_images(
        "![https://example.test/a.png](missing.png)",
        false,
        &|src, _| Some(src.to_owned()),
    );
    assert!(matches!(
        parse(&url_alt).as_slice(),
        [Block::Para(inline)] if inline.links.is_empty() && inline.text == "https://example.test/a.png"
    ));
    let ok_terms = vec!["Ok".into()];
    let ok_query = crate::timeline::search::Query {
        terms: &ok_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    let (ok_spans, _, _) = prose_ranges_with_images(&rewritten, ok_query, 8, &|src| {
        if src == "found.png" {
            ImageSearch::Hidden { label: "Ok".into() }
        } else {
            ImageSearch::Inline
        }
    });
    assert_eq!(ok_spans.len(), 1);
    assert_eq!(&rewritten[ok_spans[0][0].clone()], "Ok");
    assert!(ok_spans[0][0].start > rewritten.find("## ![Head]()").unwrap());
    let remote_terms = vec!["Plan réseau".into()];
    let remote_query = crate::timeline::search::Query {
        terms: &remote_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(prose_has_match(
        "# ![Plan réseau](https://example.test/plan.png)",
        remote_query
    ));
    assert!(prose_has_match(
        "![Plan réseau](https://example.test/plan.png)",
        remote_query
    ));
    let heading_remote = "# ![Plan réseau](https://example.test/plan.png)";
    let heading_spans = prose_ranges(heading_remote, remote_query, 8);
    assert_eq!(heading_spans.len(), 1);
    assert_eq!(&heading_remote[heading_spans[0][0].clone()], "Plan réseau");
    // A lifted remote image stays searchable but must not claim the active highlight span from
    // subsequent paintable prose.
    let lifted_then_prose = "![Plan réseau](https://example.test/plan.png)\n\nPlan réseau";
    let lifted_spans = prose_ranges(lifted_then_prose, remote_query, 8);
    assert_eq!(lifted_spans.len(), 1);
    assert_eq!(
        &lifted_then_prose[lifted_spans[0][0].clone()],
        "Plan réseau"
    );
    assert!(lifted_spans[0][0].start > lifted_then_prose.find("\n\n").unwrap());
    assert!(!prose_has_highlight_with_images(
        "![Plan réseau](https://example.test/plan.png)",
        false,
        remote_query,
        &|_, _| None,
        &|_| ImageSearch::Inline,
    ));
    // Rendered local image pixels keep their accessible label discoverable for hidden-input
    // visibility checks without claiming a highlight span (including empty-alt filename labels).
    assert!(prose_has_match_with_images(
        "![Plan réseau](local.png)",
        false,
        remote_query,
        &|_, _| None,
        &|_| ImageSearch::Hidden {
            label: "Plan réseau".into(),
        },
    ));
    assert!(!prose_has_highlight_with_images(
        "![Plan réseau](local.png)",
        false,
        remote_query,
        &|_, _| None,
        &|_| ImageSearch::Hidden {
            label: "Plan réseau".into(),
        },
    ));
    assert!(prose_has_match_with_images(
        "![](local.png)",
        false,
        remote_query,
        &|_, _| None,
        &|_| ImageSearch::Hidden {
            label: "Plan réseau".into(),
        },
    ));
    let html_alt = literal_breaks_with_images("![<chart>](missing.png)", false, &|src, _| {
        Some(src.to_owned())
    });
    assert_eq!(html_alt, "![&#60;chart&#62;]()");
    let html_terms = vec!["<chart>".into()];
    let html_query = crate::timeline::search::Query {
        terms: &html_terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(prose_has_match(&html_alt, html_query));
    assert_eq!(
        prose_lifted_images(
            "![A](a.png)\n\n## ![B](b.png)\n\n*![C](c.png)*\n\n[![D](d.png)](https://example.test)\n\n> ![E](e.png)\n\n![outer ![inner](https://example.test/x.png) `code`](outer.png)\n\n![left![ ](https://example.test/i.png)right](ws.png)",
            false
        ),
        vec![
            LiftedImage {
                src: "a.png".into(),
                alt: "A".into(),
            },
            LiftedImage {
                src: "e.png".into(),
                alt: "E".into(),
            },
            LiftedImage {
                src: "outer.png".into(),
                alt: "outer inner code".into(),
            },
            LiftedImage {
                src: "ws.png".into(),
                alt: "left right".into(),
            },
        ]
    );
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
