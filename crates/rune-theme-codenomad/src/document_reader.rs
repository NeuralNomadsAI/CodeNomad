use crate::{Length, Space, TextRole, Tokens, kit, layout::Layout, tokens};
use rune::{El, Icon, ScrollSpec, TextStyle};
pub use rune_kit::markdown::CodeFrame;
use rune_kit::markdown::{Block, parse};
use rune_kit::{Markdown, MarkdownStyle, syntax};

pub mod editor;
mod toolbar;
pub use toolbar::wrap_button;

pub fn surface(dark: bool) -> El {
    rune::col()
        .w_full()
        .h_full()
        .min_h(0.0)
        .fill(tokens(dark).color("surface-canvas"))
        .color(tokens(dark).color("text-primary"))
}
pub fn pages(history: El, reader: Option<El>) -> El {
    rune::col()
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(reader.unwrap_or(history))
}
pub use crate::generated_layout::DRAWER_GEOMETRY;
pub fn split(main: El, tree: Option<El>, width: f32, expanded: bool) -> El {
    let minimum = crate::interruption::history_minimum(expanded);
    let main = main.grow(1.0).min_w(0.0).min_h(minimum);
    rune::row()
        .w_full()
        .h_full()
        .min_h(minimum)
        .grow(1.0)
        .child(main)
        .children(tree.map(|tree| rune::col().w(width).h_full().min_h(0.0).child(tree)))
}
pub fn image(image: &rune::Image, label: &str) -> El {
    let Some([width, height]) = image.size() else {
        return rune::el();
    };
    // Intrinsic SVG metadata: https://github.com/anomalyco/rune/issues/1361.
    rune::col()
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .padding(tokens(crate::layout::dark()).space(Space::Lg).px())
        .center()
        .child(
            rune::el()
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fit)
                .aspect_fit(width as f32 / height as f32)
                .max_w(width as f32)
                .max_h(height as f32)
                .role("img")
                .label(label),
        )
}
pub fn header(title: &str, directory: &str, status: Option<&str>, actions: Vec<El>) -> El {
    let t = tokens(crate::layout::dark());
    let metric = |name| t.metric("readerHeader", name).px();
    rune::row()
        .items_center()
        .gap(metric("columnGap"))
        .w_full()
        .flex_wrap()
        .padding(metric("paddingTop"))
        .fill(t.color("surface-chrome"))
        .border_sides(
            [0.0, 0.0, metric("borderBottomWidth"), 0.0],
            t.color("border-divider"),
        )
        .border_layout()
        .child(
            rune::col()
                .grow(1.0)
                .min_w(t.metric("readerHeading", "minWidth").px())
                .gap(t.metric("readerHeading", "rowGap").px())
                .child(rune::text(title).truncate().font(font(t, "readerTitle")))
                .child(
                    rune::text(status.map_or_else(
                        || directory.to_owned(),
                        |label| format!("{directory} · {label}"),
                    ))
                    .truncate()
                    .color(t.color("text-muted"))
                    .font(font(t, "readerDirectory")),
                ),
        )
        .children(actions)
}
fn font(t: &Tokens, role: &str) -> TextStyle {
    TextStyle::new(
        t.metric(role, "fontSize").px(),
        t.metric(role, "fontWeight").px(),
    )
    .lh(t.metric(role, "lineHeight").px())
}
pub fn eye<S: 'static>(
    dark: bool,
    label: &str,
    disabled: bool,
    active: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let k = &*kit(dark);
    let mut selected;
    let k = if active && !disabled {
        selected = k.clone();
        let tint = tokens(dark).color("icon-toggle-active-bg");
        selected.c.hover = tint;
        selected.c.pressed = tint;
        &selected
    } else {
        k
    };
    rune_kit::IconButton::new(k.glyph.eye)
        .label(label)
        .help(label)
        .disabled(disabled)
        .variant(rune_kit::IconButtonVariant::Ghost)
        .state(if active && !disabled {
            rune_kit::State::Pressed
        } else if disabled {
            rune_kit::State::Disabled
        } else {
            rune_kit::State::Rest
        })
        .on_press_tx(press)
        .build(k)
        .checked(active)
}
pub fn viewport(content: El, wrap: bool) -> El {
    let view = rune::col().w_full().grow(1.0).min_h(0.0);
    if wrap {
        view.scroll(ScrollSpec {
            stick_bottom: false,
        })
    } else {
        view.scroll_xy()
    }
    .child(content)
}
pub fn rendered_viewport(dark: bool, content: El) -> El {
    focus_scroll(dark, viewport(content, true))
}
fn focus_scroll(dark: bool, viewport: El) -> El {
    let t = tokens(dark);
    viewport.focusable(true).focus_ring(
        t.metric("windowIconFocus", "outlineWidth").px(),
        t.metric("windowIconFocus", "outlineOffset").px(),
        t.color("focus-ring-color"),
    )
}
fn source_spans(dark: bool, path: &str, text: &str) -> Vec<rune::Span> {
    let t = tokens(dark);
    syntax::highlight(syntax::lang_for_path(path), text)
        .into_iter()
        .filter_map(|(range, paint)| {
            use syntax::Syntax::*;
            let role = match paint {
                syntax::Paint::Kind(Comment | Punctuation) => "text-muted",
                syntax::Paint::Kind(Keyword | Type) => "accent-primary",
                syntax::Paint::Kind(String) => "status-success",
                syntax::Paint::Kind(Number | Attribute) => "status-warning",
                _ => return None,
            };
            let mut span = rune::Span::new(range.start, range.end);
            span.color = Some(t.color(role));
            Some(span)
        })
        .collect()
}
pub fn source(dark: bool, path: &str, text: &str, wrap: bool, view_width: Option<f32>) -> El {
    let source = rune::rich(text, source_spans(dark, path, text))
        .key("file-source-text")
        .selectable(true)
        .literal_direction()
        .font(source_font(dark));
    let source = if wrap {
        source.grow(1.0).min_w(0.0).wrap_anywhere()
    } else {
        source
    };
    rune::row()
        .w_full()
        .literal_direction()
        .child(gutter(dark, text, wrap.then_some(view_width).flatten()))
        .child(source)
}
pub fn source_view(dark: bool, content: El, wrap: bool) -> El {
    let t = tokens(dark);
    focus_scroll(dark, viewport(content, wrap))
        .key("file-source-scroll")
        .fill(t.color("surface-inset"))
        .px(t.space(Space::Sm).px())
}
pub fn source_font(dark: bool) -> TextStyle {
    let t = tokens(dark);
    // Monaco uses 13px and the default 1.5 line height, rounded down.
    let mut style = t.text(TextRole::Mono);
    style.size = 13.0;
    style.line_height = 19.0;
    style
}
fn gutter(dark: bool, contents: &str, view_width: Option<f32>) -> El {
    gutter_style(dark, contents, view_width, source_font(dark), 0.0)
}
fn gutter_width(style: TextStyle, lines: usize) -> f32 {
    rune::text::advance("00000", style).max(rune::text::advance(&lines.to_string(), style))
}
fn wrapped_rows(line: &str, style: TextStyle, width: Option<f32>) -> usize {
    if line.is_empty()
        || (width.is_none() && !line.contains(['\u{b}', '\u{c}', '\u{85}', '\u{2028}', '\u{2029}']))
    {
        return 1;
    }
    let options = rune::text::RichLayoutOptions::new()
        .direction(rune::Direction::Ltr)
        .wrap_anywhere();
    let (_, height) =
        rune::text::measure_with(line.trim_end_matches('\r'), &[], style, width, options);
    ((height / style.line_px()).round() as usize).max(1)
}
fn gutter_palette_key(dark: bool) -> (usize, Option<crate::palettes::PaletteKey>) {
    (
        crate::palette_index(dark),
        crate::palettes::active(dark).map(|palette| palette.cache_key()),
    )
}
fn gutter_style(
    dark: bool,
    contents: &str,
    view_width: Option<f32>,
    style: TextStyle,
    body_inset: f32,
) -> El {
    use std::fmt::Write;
    let lines = contents.as_bytes().iter().filter(|&&c| c == b'\n').count() + 1;
    let t = tokens(dark);
    let width = gutter_width(style, lines);
    let gap = t.space(Space::Lg).px() - body_inset;
    let wrap = view_width.map(|view| (view - width - gap - 2.0 * body_inset).max(1.0));
    rune::memo(
        "file-line-numbers",
        (
            gutter_palette_key(dark),
            wrap.map(f32::to_bits),
            style.line_px().to_bits(),
            gap.to_bits(),
            contents,
        ),
        || {
            let mut numbers = String::new();
            for (i, line) in contents.split('\n').enumerate() {
                if i != 0 {
                    numbers.push('\n');
                }
                let _ = write!(numbers, "{}", i + 1);
                if i + 1 < lines {
                    numbers.extend(std::iter::repeat_n(
                        '\n',
                        wrapped_rows(line, style, wrap) - 1,
                    ));
                }
            }
            rune::text(numbers)
                .a11y_hidden()
                .font(style)
                .w(width)
                .pr(t.space(Space::Sm).px())
                .mr(gap)
                .align(rune::Align::End)
                .color(t.color("text-muted"))
        },
    )
}
pub fn source_width(dark: bool, view: f32) -> f32 {
    view - 2.0 * tokens(dark).space(Space::Sm).px()
}
pub fn mermaid_frame(dark: bool, content: El) -> El {
    rune::col()
        .w_full()
        .fill(tokens(dark).color("surface-inset"))
        .pad(Space::Md)
        .child(content)
}
pub fn mermaid_error(dark: bool, message: &str, source: &str) -> El {
    let t = tokens(dark);
    rune::col()
        .child(
            rune::text(message)
                .role("alert")
                .font(t.text(TextRole::Small))
                .color(t.color("text-secondary")),
        )
        .child(
            rune::text(source)
                .key("file-source-text")
                .selectable(true)
                .literal_direction()
                .font(t.text(TextRole::Mono)),
        )
}
/// Combined Mermaid element cap (`nodes + edges + subgraphs`) covering Solid's `maxEdges: 500`.
pub(crate) const MERMAID_MAX_ITEMS: usize = 1_500;

fn markdown_style(dark: bool) -> MarkdownStyle {
    let t = tokens(dark);
    let mut style = MarkdownStyle::from_kit(&kit(dark))
        .body_font(font(t, "readerMarkdown"))
        .strong_weight(t.number("font-weight-regular").px())
        .link_underline(rune::Color::TRANSPARENT)
        .link_hover(t.color("accent-hover"))
        .code_block(t.color("surface-inset"), t.color("border-muted"))
        .diagram_max_items(MERMAID_MAX_ITEMS);
    for level in 1..=4 {
        style = style.heading_font(level, font(t, &format!("readerHeading{level}")));
    }
    style
}
pub fn markdown<S: 'static>(
    dark: bool,
    text: &str,
    diagram_label: &'static str,
    open: impl Fn(&mut S, &str, &mut rune::Tx) + 'static,
    wrap: impl Fn(usize, &str) -> bool + 'static,
    code_header: impl Fn(&CodeFrame<'_>) -> El + 'static,
    image: impl Fn(&str) -> Option<rune::Image> + 'static,
) -> El {
    Markdown::new(text)
        .style(markdown_style(dark))
        .tasks_read_only()
        .selectable(true)
        .scroll_wide(true)
        .code_wrap(wrap)
        .code_frame(move |body, code| rune::col().w_full().child(code_header(code)).child(body))
        .on_link_tx(open)
        .images(image)
        .diagram_frame(move |diagram, _| diagram.label(diagram_label))
        .build(&kit(dark))
}
pub fn markdown_image_sources(text: &str) -> Vec<String> {
    fn collect(blocks: Vec<Block>, found: &mut Vec<String>) {
        for block in blocks {
            match block {
                Block::Image { src, .. } => found.push(src),
                Block::Quote(items) => collect(items, found),
                Block::List { items, .. } => {
                    for item in items {
                        collect(item, found);
                    }
                }
                _ => {}
            }
        }
    }
    if !text.contains("![") {
        return Vec::new();
    }
    let mut found = Vec::new();
    collect(parse(text), &mut found);
    found
}
pub fn code_header(dark: bool, language: &str, wrap: El, copy: El) -> El {
    let t = tokens(dark);
    rune::row()
        .w_full()
        .items_center()
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .fill(t.color("surface-secondary"))
        .child(
            rune::text(language.to_uppercase())
                .grow(1.0)
                .text_role(TextRole::Small),
        )
        .child(wrap)
        .child(copy)
}
pub fn code_copy<S: 'static>(
    dark: bool,
    label: &str,
    copy: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let copy = std::rc::Rc::new(copy);
    let enter = copy.clone();
    rune_kit::IconButton::new(&workspace_icons::COPY)
        .variant(rune_kit::IconButtonVariant::GhostMuted)
        .label(label)
        .on_press_tx(move |s, tx| copy(s, tx))
        .build(&kit(dark))
        .on_key(move |s: &mut S, key, tx| {
            if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
                return false;
            }
            if !tx.key_repeat() {
                enter(s, tx);
            }
            true
        })
}
use crate::workspace_tree::icons as workspace_icons;
pub fn mermaid(dark: bool, text: &str) -> Option<El> {
    let t = tokens(dark);
    rune_kit::mermaid::render(
        text,
        &markdown_style(dark).diagram_surface(
            t.color("surface-inset"),
            rune::Color::TRANSPARENT,
            t.color("surface-inset"),
        ),
    )
}

#[cfg(test)]
mod mermaid_tests {
    use super::*;

    fn chain_flowchart(edges: usize) -> String {
        let mut source = String::from("flowchart LR\n");
        for i in 0..edges {
            source.push_str(&format!("  N{i} --> N{}\n", i + 1));
        }
        source
    }

    #[test]
    fn mermaid_renders_up_to_1500_items_and_rejects_above() {
        assert!(mermaid(false, &chain_flowchart(500)).is_some());
        // 750 nodes + 749 edges = 1,499 items (< 1,500 ceiling).
        assert!(mermaid(false, &chain_flowchart(749)).is_some());
        assert!(mermaid(false, &chain_flowchart(750)).is_none());

        let md = format!("```mermaid\n{}```", chain_flowchart(500));
        let mut rt = rune::Runtime::new(
            md,
            |md, _| {
                markdown(
                    false,
                    md,
                    "Mermaid diagram",
                    |_: &mut String, _, _| {},
                    |_, _| false,
                    |_| rune::el(),
                    |_| None,
                )
            },
            (880.0, 520.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.02);
        assert!(
            rt.elements()
                .iter()
                .any(|el| el.label.as_deref() == Some("Mermaid diagram")),
            "markdown file reader must render a 500-edge mermaid fence"
        );
    }

    #[test]
    fn gutter_memo_key_invalidates_when_palette_changes_at_same_luminance() {
        use crate::palettes::{
            ColorField, built_in, custom, increased_contrast, with_palette, with_resolved,
        };

        let first = built_in().iter().find(|p| p.dark).expect("dark palette");
        let second = built_in()
            .iter()
            .find(|p| p.dark && p.id != first.id)
            .expect("second dark palette");
        let contrast = increased_contrast(Some(first), true).expect("high-contrast variant");

        let key_first = with_palette(Some(first), || gutter_palette_key(true));
        let key_second = with_palette(Some(second), || gutter_palette_key(true));
        let key_contrast = with_palette(Some(contrast), || gutter_palette_key(true));
        assert_ne!(key_first, key_second);
        assert_ne!(key_first, key_contrast);

        let base_colors = first.colors();
        let muted_colors = base_colors
            .with(ColorField::TextMuted, "#C8A0FF")
            .expect("valid muted color");
        let custom_a = custom(Some("custom-gutter"), true, false, base_colors);
        let custom_b = custom(Some("custom-gutter"), true, false, muted_colors);
        let key_a = with_resolved(Some(custom_a), || gutter_palette_key(true));
        let key_b = with_resolved(Some(custom_b), || gutter_palette_key(true));
        assert_ne!(key_a, key_b);
    }
}
