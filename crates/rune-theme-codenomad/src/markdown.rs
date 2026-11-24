use crate::{Space, TextRole, kit, layout::dark, tokens};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use rune::{El, ScrollSpec, rich};
use rune_kit::{CodeFrame, Markdown, MarkdownStyle, syntax};
use std::borrow::Cow;

pub fn prose<S: 'static>(
    source: &str,
    streaming: bool,
    highlight: bool,
    query: Option<(&[String], bool)>,
    link: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    wrapped: impl Fn(usize, &str) -> bool + 'static,
    frame: impl Fn(El, &CodeFrame<'_>) -> El + 'static,
) -> El {
    let kit = kit(dark());
    let style = MarkdownStyle::from_kit(kit)
        .code_block(kit.c.bg_deep, kit.c.border_base)
        .link(kit.c.text_accent)
        .syntax_highlight(highlight);
    let source = literal_breaks(source).into_owned();
    let matches = match query {
        Some((terms, true)) => crate::timeline::search::ranges(&source, terms)
            .into_iter()
            .map(|range| vec![range])
            .collect(),
        Some((terms, false)) => terms.first().map_or_else(Vec::new, |phrase| {
            Markdown::find(&source, phrase, rune_kit::markdown::Case::Insensitive)
                .into_iter()
                .take(512)
                .collect()
        }),
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
        .code_wrap(wrapped)
        .code_frame(frame)
        .build(kit)
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

pub fn steps_pane<S: 'static>(
    key: String,
    label: &str,
    rows: Vec<El>,
    on_visible: impl Fn(&mut S, std::ops::Range<usize>) -> bool + 'static,
    on_at_bottom: impl Fn(&mut S, bool) -> bool + 'static,
) -> El {
    let t = tokens(dark());
    let gap = t.space(Space::Sm).px();
    let list = rune::col()
        .key(format!("{key}-list"))
        .w_full()
        .role("list")
        .label(label)
        .gap(gap)
        .growth(rune::GrowthSpec::default())
        .virtualize(t.length(crate::Length::TouchTarget).px())
        .on_visible_rows(on_visible)
        .children(rows);
    rune::col()
        .key(key)
        .w_full()
        .max_h(tool_lines(30))
        .scroll(ScrollSpec { stick_bottom: true })
        .scroll_anchor()
        .on_at_bottom_if(on_at_bottom)
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
