use crate::{layout::dark, tokens};
use rune::{Color, El, Span};
use std::ops::Range;
use vte::{Params, Perform};

mod stream;
pub use stream::{Stream, present};
use stream::{parse, parse_bounded};

// Ink spans use Rune's u32 ink tables and skip HTML copy; layout-affecting spans
// (background, underline, bold, italic) and non-ASCII font routes consume Parley's u16
// per-paragraph style table; partial strikes and overlines scan visual-line runs in
// range_boxes (O(R^2 + L) via Parley's visual_offset) and filter per paragraph.
const INK_SPAN_LIMIT: usize = 131_072;
const LAYOUT_SPAN_LIMIT: usize = 16_384;
const MAX_LINE_NON_ASCII: usize = 8_192;
const PARLEY_STYLE_LIMIT: usize = 48_000;
const PARLEY_STYLES_PER_NON_ASCII: usize = 4;
const PARLEY_STYLES_PER_SPAN: usize = 8;
const DECORATION_RUN_LIMIT: usize = 4_096;
const DECORATION_LINE_WORK_LIMIT: usize = 2_000_000;
const DECORATION_WINDOW_WORK_LIMIT: usize = 16_000_000;

// The same 16 named colors as Solid's ansi-sequence-parser.
const COLORS: [u32; 16] = [
    0x000000, 0xbb0000, 0x00bb00, 0xbbbb00, 0x0000bb, 0xff00ff, 0x00bbbb, 0xeeeeee, 0x555555,
    0xff5555, 0x00ff00, 0xffff55, 0x5555ff, 0xff55ff, 0x55ffff, 0xffffff,
];

fn palette(index: u8) -> Color {
    match index {
        0..=15 => {
            let value = COLORS[index as usize];
            rgb(value >> 16, value >> 8 & 255, value & 255)
        }
        16..=231 => {
            let value = u32::from(index - 16);
            let step = |n| if n == 0 { 0 } else { 55 + 40 * n };
            rgb(step(value / 36), step(value / 6 % 6), step(value % 6))
        }
        _ => {
            let level = 8 + u32::from(index - 232) * 10;
            rgb(level, level, level)
        }
    }
}

fn rgb(red: u32, green: u32, blue: u32) -> Color {
    let linear = |byte: u32| rune::color::srgb_decode(byte as f32 / 255.0);
    Color {
        r: linear(red),
        g: linear(green),
        b: linear(blue),
        a: 1.0,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Style {
    fg: Option<Color>,
    bg: Option<Color>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
    hidden: bool,
    strike: bool,
    overline: bool,
}

fn is_regional_indicator(c: char) -> bool {
    matches!(c, '\u{1F1E6}'..='\u{1F1FF}')
}

fn is_grapheme_extender(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{200C}'..='\u{200D}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FE20}'..='\u{FE2F}'
            | '\u{1F3FB}'..='\u{1F3FF}'
            | '\u{E0020}'..='\u{E007F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

#[derive(Clone, Default)]
struct Log {
    text: String,
    runs: Vec<(Range<usize>, Style)>,
    start: usize,
    style: Style,
    pending_cr: bool,
    column: usize,
    line_non_ascii: usize,
    prev_char: char,
    regional_indicator_odd: bool,
    text_limit: Option<usize>,
}

impl Log {
    fn at_limit(&self) -> bool {
        self.text_limit
            .is_some_and(|limit| self.text.len() >= limit)
    }

    fn finish_run(&mut self) {
        let mut style = self.style;
        if style.inverse {
            std::mem::swap(&mut style.fg, &mut style.bg);
            style.inverse = false;
        }
        if self.start < self.text.len() && style != Style::default() {
            self.runs.push((self.start..self.text.len(), style));
        }
        self.start = self.text.len();
    }

    fn push(&mut self, c: char) {
        if self.at_limit() {
            return;
        }
        if std::mem::take(&mut self.pending_cr) && c != '\n' {
            self.newline();
            if self.at_limit() {
                return;
            }
        }
        match c {
            '\t' => {
                // Expand terminal tabs to 4-column stops.
                let spaces = 4 - self.column % 4;
                let spaces = self.text_limit.map_or(spaces, |limit| {
                    spaces.min(limit.saturating_sub(self.text.len()))
                });
                self.text.extend(std::iter::repeat_n(' ', spaces));
                self.column = 0;
                self.prev_char = '\t';
                self.regional_indicator_odd = false;
            }
            '\n' => self.newline(),
            _ => {
                if self.style.hidden {
                    // Mask concealed characters with one ASCII space per character so tab
                    // alignment holds and concealed text never enters display, search, or copy.
                    self.text.push(' ');
                    self.column += 1;
                    self.prev_char = ' ';
                    self.regional_indicator_odd = false;
                    return;
                }
                let ri = is_regional_indicator(c);
                let safe_break = self.prev_char != '\u{200D}'
                    && !is_grapheme_extender(c)
                    && !(ri && self.regional_indicator_odd);
                // Split display lines at grapheme boundaries before non-ASCII font routing
                // can exhaust Parley's u16 per-paragraph style table.
                if self.text_limit.is_none()
                    && self.line_non_ascii >= MAX_LINE_NON_ASCII
                    && (c.is_ascii()
                        || (safe_break && self.line_non_ascii >= MAX_LINE_NON_ASCII + 64))
                {
                    self.newline();
                }
                if let Some(limit) = self.text_limit
                    && self.text.len() + c.len_utf8() > limit
                {
                    self.text_limit = Some(self.text.len());
                    return;
                }
                self.text.push(c);
                self.column += 1;
                if !c.is_ascii() && safe_break {
                    self.line_non_ascii += 1;
                }
                self.prev_char = c;
                self.regional_indicator_odd = ri && !self.regional_indicator_odd;
            }
        }
    }

    fn newline(&mut self) {
        if self.at_limit() {
            return;
        }
        self.finish_run();
        self.text.push('\n');
        self.start = self.text.len();
        self.column = 0;
        self.line_non_ascii = 0;
        self.prev_char = '\n';
        self.regional_indicator_odd = false;
    }

    fn literal(&mut self, text: &str) {
        for c in text.chars() {
            match c {
                '\r' => {
                    if self.pending_cr {
                        self.newline();
                    }
                    self.pending_cr = true;
                }
                '\n' | '\t' => self.push(c),
                c if !c.is_control() => self.push(c),
                _ => {}
            }
        }
    }
}

impl Perform for Log {
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if action != 'm' || !intermediates.is_empty() {
            return;
        }
        if ignore {
            self.finish_run();
            self.style = Style::default();
            return;
        }
        let mut next = self.style;
        // Match Solid's token application: reset existing style, then apply this sequence's sets.
        let mut set = Style::default();
        let mut params = params.iter();
        while let Some(param) = params.next() {
            let Some(&code) = param.first() else {
                continue;
            };
            match code {
                0 => next = Style::default(),
                1 => set.bold = true,
                2 => set.dim = true,
                3 => set.italic = true,
                4 if param.get(1) != Some(&0) => set.underline = true,
                4 | 24 => next.underline = false,
                7 => set.inverse = true,
                8 => set.hidden = true,
                9 => set.strike = true,
                21 => next.bold = false,
                22 => {
                    next.bold = false;
                    next.dim = false;
                }
                23 => next.italic = false,
                27 => next.inverse = false,
                28 => next.hidden = false,
                29 => next.strike = false,
                53 => set.overline = true,
                55 => next.overline = false,
                30..=37 => set.fg = Some(palette((code - 30) as u8)),
                40..=47 => set.bg = Some(palette((code - 40) as u8)),
                90..=97 => set.fg = Some(palette((code - 82) as u8)),
                100..=107 => set.bg = Some(palette((code - 92) as u8)),
                39 => next.fg = None,
                49 => next.bg = None,
                38 | 48 | 58 => {
                    let color = if let Some((&mode, values)) = param[1..].split_first() {
                        // ISO RGB separates the optional color-space slot from its three channels.
                        let values = if mode == 2 && values.len() == 4 {
                            &values[1..]
                        } else {
                            values
                        };
                        color(mode, values.iter().copied())
                    } else if let Some(&[mode]) = params.next() {
                        color(
                            mode,
                            params.by_ref().map_while(|part| match part {
                                [n] => Some(*n),
                                _ => None,
                            }),
                        )
                    } else {
                        None
                    };
                    match (code, color) {
                        (38, Some(color)) => set.fg = Some(color),
                        (48, Some(color)) => set.bg = Some(color),
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        next = Style {
            fg: set.fg.or(next.fg),
            bg: set.bg.or(next.bg),
            bold: next.bold || set.bold,
            dim: next.dim || set.dim,
            italic: next.italic || set.italic,
            underline: next.underline || set.underline,
            inverse: next.inverse || set.inverse,
            hidden: next.hidden || set.hidden,
            strike: next.strike || set.strike,
            overline: next.overline || set.overline,
        };
        if next != self.style {
            self.finish_run();
            self.style = next;
        }
    }
}

fn color(mode: u16, mut values: impl Iterator<Item = u16>) -> Option<Color> {
    match mode {
        5 => Some(palette(u8::try_from(values.next()?).ok()?)),
        2 => {
            let mut channel = || values.next().map(|value| u32::from(value.min(255)));
            Some(rgb(channel()?, channel()?, channel()?))
        }
        _ => None,
    }
}

pub fn plain_text(source: &str) -> String {
    if present(source) {
        parse(source).text
    } else {
        source.to_owned()
    }
}

pub fn plain_text_bounded(source: &str, max_bytes: usize) -> String {
    if present(source) {
        parse_bounded(source, Some(max_bytes)).text
    } else {
        let cut = source.floor_char_boundary(source.len().min(max_bytes));
        source[..cut].to_owned()
    }
}

pub fn code(source: &str, wrap: bool) -> El {
    search_code(source, wrap, None)
}

pub fn search_code(
    source: &str,
    wrap: bool,
    query: Option<crate::timeline::search::Query<'_>>,
) -> El {
    render(parse(source), wrap, query)
}

fn render(log: Log, wrap: bool, query: Option<crate::timeline::search::Query<'_>>) -> El {
    let (text, spans, strikes, overlines) = styled(log);
    let body = rune::rich(&text, spans)
        .strikes(strikes)
        .overlines(overlines);
    super::markdown::code_body(crate::timeline::search::ink(body, &text, query), wrap)
}

type Strike = (usize, usize, Option<Color>);

fn joins(end: usize, style: &Style, next: &(Range<usize>, Style)) -> bool {
    end == next.0.start && *style == next.1
}

fn affects_layout(span: &Span) -> bool {
    span.weight.is_some()
        || span.mono
        || span.size.is_some()
        || span.italic
        || span.bg.is_some()
        || span.underline.is_some()
}

fn style_affects_layout(style: &Style) -> bool {
    !style.hidden && (style.bg.is_some() || style.underline || style.bold || style.italic)
}

#[allow(clippy::too_many_arguments)]
fn flush_decoration(
    pending: &mut Option<Strike>,
    list: &mut Vec<Strike>,
    other_len: usize,
    text: &[u8],
    line: &Range<usize>,
    line_content_end: usize,
    line_shaped_runs: usize,
    line_budget: &mut usize,
    window_budget: &mut usize,
) {
    let Some((start, end, ink)) = pending.take() else {
        return;
    };
    // Full-line ranges take range_boxes's per-visual-row fast path (linear in line length);
    // partial-line ranges walk shaped runs with O(R^2) visual_offset cost plus cluster scan.
    let cost = if start == line.start && end == line_content_end {
        line.len().max(1)
    } else {
        line_shaped_runs
            .saturating_mul(line_shaped_runs)
            .saturating_add(line.len())
    };
    if cost > *line_budget || cost > *window_budget {
        return;
    }
    if let Some(last) = list
        .last_mut()
        .filter(|last| last.2 == ink && matches!(text.get(last.1..start), Some(b"" | b"\n")))
    {
        *line_budget -= cost;
        *window_budget -= cost;
        last.1 = end;
    } else if list.len() + other_len < DECORATION_RUN_LIMIT {
        *line_budget -= cost;
        *window_budget -= cost;
        list.push((start, end, ink));
    }
}

fn styled(log: Log) -> (String, Vec<Span>, Vec<Strike>, Vec<Strike>) {
    let mut spans: Vec<Span> = Vec::with_capacity(log.runs.len().min(INK_SPAN_LIMIT));
    let mut strikes: Vec<Strike> = vec![];
    let mut overlines: Vec<Strike> = vec![];
    let mut pending_strike: Option<Strike> = None;
    let mut pending_overline: Option<Strike> = None;
    let metrics = tokens(dark());
    let default = metrics.color("text-primary");
    let mut layout_spans = 0_usize;
    let mut line_layout_spans = 0_usize;
    let mut line_layout_cap = 0_usize;
    let mut line_shaped_runs = 1_usize;
    let mut decoration_window_budget = DECORATION_WINDOW_WORK_LIMIT;
    let mut decoration_line_budget = DECORATION_LINE_WORK_LIMIT;
    let mut line = 0..0;
    let mut line_content_end = 0;
    let mut previous_content_end = 0;
    let text = log.text.as_bytes();
    let mut runs = log.runs.as_slice();
    while let Some(((range, style), tail)) = runs.split_first() {
        let mut range = range.clone();
        if range.start >= line.end {
            flush_decoration(
                &mut pending_strike,
                &mut strikes,
                overlines.len(),
                text,
                &line,
                line_content_end,
                line_shaped_runs,
                &mut decoration_line_budget,
                &mut decoration_window_budget,
            );
            flush_decoration(
                &mut pending_overline,
                &mut overlines,
                strikes.len(),
                text,
                &line,
                line_content_end,
                line_shaped_runs,
                &mut decoration_line_budget,
                &mut decoration_window_budget,
            );
            while range.start >= line.end {
                // Remember the last nonempty line's end, excluding its newline.
                if line.len() > 1 {
                    previous_content_end = line.end - 1;
                }
                let start = line.end;
                let end = text[start..]
                    .iter()
                    .position(|&byte| byte == b'\n')
                    .map_or(text.len(), |newline| start + newline + 1);
                line = start..end;
            }
            line_content_end = if line.end > line.start && text[line.end - 1] == b'\n' {
                line.end - 1
            } else {
                line.end
            };
            let line_non_ascii = text[line.clone()]
                .iter()
                .filter(|&&byte| byte >= 0xc0)
                .count();
            line_layout_spans = 0;
            line_layout_cap = PARLEY_STYLE_LIMIT
                .saturating_sub(line_non_ascii.saturating_mul(PARLEY_STYLES_PER_NON_ASCII))
                / PARLEY_STYLES_PER_SPAN;
            let line_end_idx = runs.partition_point(|(r, _)| r.start < line.end);
            let planned_layout_runs = runs[..line_end_idx]
                .iter()
                .filter(|(_, s)| style_affects_layout(s))
                .count()
                .min(line_layout_cap)
                .min(LAYOUT_SPAN_LIMIT.saturating_sub(layout_spans));
            // Conservative upper bound on shaped runs on this line for range_boxes's O(R^2)
            // visual_offset walk when drawing partial-line strikes or overlines.
            line_shaped_runs = line_non_ascii
                .saturating_mul(2)
                .saturating_add(planned_layout_runs.saturating_mul(2))
                .max(1);
            decoration_line_budget = DECORATION_LINE_WORK_LIMIT;
        }
        runs = tail;
        while let Some((next, tail)) = runs.split_first() {
            if !joins(range.end, style, next) {
                break;
            }
            range.end = next.0.end;
            runs = tail;
        }
        if style.hidden {
            continue;
        }
        let dim = |color: Color| if style.dim { color.alpha(0.7) } else { color };
        let mut span = Span::new(range.start, range.end);
        if style.fg.is_some() || style.dim {
            span = span.color(dim(style.fg.unwrap_or(default)));
        }
        if let Some(bg) = style.bg {
            span = span.bg(dim(bg), 0.0);
        }
        if style.underline {
            span = span.underline(dim(style.fg.unwrap_or(default)));
        }
        if style.bold {
            span = span.weight(metrics.number("font-weight-semibold").px());
        }
        if style.italic {
            span = span.italic();
        }
        if span != Span::new(range.start, range.end) {
            let can_merge = |last: &Span, candidate: &Span| {
                (last.end == candidate.start
                    || (range.start == line.start && last.end as usize == previous_content_end))
                    && *candidate
                        == (Span {
                            start: candidate.start,
                            end: candidate.end,
                            ..last.clone()
                        })
            };
            let layout_ok = !affects_layout(&span)
                || (layout_spans < LAYOUT_SPAN_LIMIT && line_layout_spans < line_layout_cap);
            let same_line_merge = spans
                .last()
                .is_some_and(|last| last.end == span.start && can_merge(last, &span));
            if same_line_merge {
                if let Some(last) = spans.last_mut() {
                    last.end = span.end;
                }
            } else if layout_ok
                && let Some(last) = spans.last_mut().filter(|last| can_merge(last, &span))
            {
                // Cross-line merge still produces a clipped span on this paragraph.
                if affects_layout(&span) {
                    line_layout_spans += 1;
                }
                last.end = span.end;
            } else {
                if !layout_ok {
                    // Past the shaping-run or per-line Parley style cap, keep foreground ink
                    // without splitting further shaping runs.
                    span = match span.color {
                        Some(color) => Span::new(range.start, range.end).color(color),
                        None => Span::new(range.start, range.end),
                    };
                }
                if span != Span::new(range.start, range.end) {
                    if let Some(last) = spans.last_mut().filter(|last| can_merge(last, &span)) {
                        last.end = span.end;
                    } else if spans.len() < INK_SPAN_LIMIT {
                        if affects_layout(&span) {
                            layout_spans += 1;
                            line_layout_spans += 1;
                        }
                        spans.push(span);
                    }
                }
            }
        }
        if style.strike {
            let ink = Some(dim(style.fg.unwrap_or(default)));
            if let Some(pending) = pending_strike
                .as_mut()
                .filter(|pending| pending.1 == range.start && pending.2 == ink)
            {
                pending.1 = range.end;
            } else {
                flush_decoration(
                    &mut pending_strike,
                    &mut strikes,
                    overlines.len(),
                    text,
                    &line,
                    line_content_end,
                    line_shaped_runs,
                    &mut decoration_line_budget,
                    &mut decoration_window_budget,
                );
                pending_strike = Some((range.start, range.end, ink));
            }
        }
        if style.overline {
            let ink = Some(dim(style.fg.unwrap_or(default)));
            if let Some(pending) = pending_overline
                .as_mut()
                .filter(|pending| pending.1 == range.start && pending.2 == ink)
            {
                pending.1 = range.end;
            } else {
                flush_decoration(
                    &mut pending_overline,
                    &mut overlines,
                    strikes.len(),
                    text,
                    &line,
                    line_content_end,
                    line_shaped_runs,
                    &mut decoration_line_budget,
                    &mut decoration_window_budget,
                );
                pending_overline = Some((range.start, range.end, ink));
            }
        }
    }
    flush_decoration(
        &mut pending_strike,
        &mut strikes,
        overlines.len(),
        text,
        &line,
        line_content_end,
        line_shaped_runs,
        &mut decoration_line_budget,
        &mut decoration_window_budget,
    );
    flush_decoration(
        &mut pending_overline,
        &mut overlines,
        strikes.len(),
        text,
        &line,
        line_content_end,
        line_shaped_runs,
        &mut decoration_line_budget,
        &mut decoration_window_budget,
    );
    (log.text, spans, strikes, overlines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_controls_and_preserves_the_declared_colors() {
        let log = parse(
            "\u{1b}[31mrouge\\x1B[0m \u{1b}[38;5;46m🦀\u{1b}[0m\r\n\u{1b}[48:2::1:2:3mback\u{1b}[0m",
        );
        assert_eq!(log.text, "rouge 🦀\nback");
        assert_eq!(log.runs.len(), 3);
        assert_eq!(
            log.runs[0],
            (
                0..5,
                Style {
                    fg: Some(rgb(187, 0, 0)),
                    ..Style::default()
                }
            )
        );
        assert_eq!(log.runs[1].0, 6..10);
        assert_eq!(log.runs[1].1.fg, Some(rgb(0, 255, 0)));
        assert_eq!(log.runs[2].1.bg, Some(rgb(1, 2, 3)));
    }

    #[test]
    fn incomplete_or_unsupported_sequences_never_consume_printable_lines() {
        for source in [
            "Example \\x1b]0;not a title\nÉchec visible",
            "Example \u{1b}]0;not a title\nÉchec visible",
            "Example \u{1b}[31\nÉchec visible",
        ] {
            assert!(parse(source).text.ends_with("\nÉchec visible"));
        }
        assert_eq!(parse("before \\x1b]0;title").text, "before \\x1b]0;title");
        assert_eq!(parse("partial \\x1b[31").text, "partial \\x1b[31");
    }

    #[test]
    fn rgb_channels_are_not_reinterpreted_as_sgr_attributes() {
        let log = parse("\u{1b}[38;2;256;0;8mVisible");
        assert_eq!(log.text, "Visible");
        assert_eq!(log.runs[0].1.fg, Some(rgb(255, 0, 8)));
        assert!(!log.runs[0].1.hidden);
    }

    #[test]
    fn color_only_runs_and_conceal_survive_beyond_the_old_u16_index_limit() {
        let source = format!(
            "{}\u{1b}[8mhidden\u{1b}[0m\u{1b}[31mEND",
            "\u{1b}[31mA\u{1b}[32mB\n".repeat(32_768)
        );
        let (text, spans, _, _) = styled(parse(&source));
        assert_eq!(spans.len(), 65_537);
        assert!(text.ends_with("\n      END"));
        assert!(!text.contains("hidden"));
        assert_eq!(spans.last().unwrap().color, Some(rgb(187, 0, 0)));
    }

    #[test]
    fn an_oversized_sgr_does_not_propagate_hidden_text() {
        let log = parse(&format!(
            "\u{1b}[8mhidden\u{1b}[{}0mvisible",
            "0;".repeat(32)
        ));
        assert_eq!(log.text, "      visible");
        assert_eq!(log.runs.len(), 1);
        assert_eq!(log.runs[0].0, 0..6);
        assert!(log.runs[0].1.hidden);
    }

    #[test]
    fn history_retains_solids_reset_order() {
        let bold = parse("\u{1b}[1mA\u{1b}[21mB");
        assert!(bold.runs[0].1.bold);
        assert_eq!(bold.runs[0].0, 0..1);
        let mixed = parse("\u{1b}[31;39mA");
        assert_eq!(mixed.runs[0].1.fg, Some(rgb(187, 0, 0)));
    }

    #[test]
    fn empty_sgr_resets_including_conceal() {
        let empty = parse("\u{1b}[8;31mA\u{1b}[mB");
        assert_eq!(empty.text, " B");
        assert_eq!(empty.runs.len(), 1);
        assert_eq!(empty.runs[0].0, 0..1);
    }

    #[test]
    fn a_long_unwrapped_decorated_line_builds_in_the_runtime() {
        let source = format!("\u{1b}[4;9m{}", "\u{1b}[31mA\u{1b}[32mB".repeat(16_000));
        let mut rt = rune::Runtime::new(
            source,
            |source, _| code(source, false),
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains(&"AB".repeat(16_000))
        );
    }

    #[test]
    fn excess_ink_spans_cannot_panic_or_reveal_concealed_text() {
        // Above Rune's old 65,535 u16 ink index: renders without panic and masks concealed bytes.
        let above_u16 = format!(
            "{}\u{1b}[31mA\u{1b}[8m🦀SECRET\u{1b}[0m\u{1b}[32mEND",
            "\u{1b}[31mA\u{1b}[32mB".repeat(32_768)
        );
        let (text, spans, _, _) = styled(parse(&above_u16));
        assert!(spans.len() > 65_536);
        assert_eq!(spans.last().unwrap().color, Some(rgb(0, 187, 0)));
        assert!(!text.contains("SECRET"));
        assert!(text.ends_with("       END"));
        let mut rt = rune::Runtime::new(
            above_u16,
            |source, _| code(source, false),
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("END"));
        assert!(!tree.contains("SECRET"));

        // Beyond INK_SPAN_LIMIT: concealed text remains masked with one space per character.
        let over_cap = format!(
            "{}\u{1b}[8m🦀SECRET\u{1b}[0mEND",
            "\u{1b}[31mA\u{1b}[32mB\n".repeat(INK_SPAN_LIMIT / 2 + 1)
        );
        let (capped_text, capped_spans, _, _) = styled(parse(&over_cap));
        assert_eq!(capped_spans.len(), INK_SPAN_LIMIT);
        assert!(!capped_text.contains("SECRET"));
        assert!(capped_text.ends_with("\n       END"));
    }

    #[test]
    fn combined_ansi_layout_spans_and_emoji_routes_never_overflow_parley_styles() {
        // Verify the per-paragraph Parley style budget invariant on extreme combined inputs
        // (10,000 alternating ANSI bg spans + 56,000 emoji pairs, and 66,000 emoji pairs).
        let huge_combined = format!(
            "{}{}END",
            "\u{1b}[44mA\u{1b}[45mB".repeat(5_000),
            "A🦀".repeat(56_000)
        );
        let huge_emoji = format!("\u{1b}[31m{}END", "A🦀".repeat(66_000));
        for source in [&huge_combined, &huge_emoji] {
            let (text, spans, _, _) = styled(parse(source));
            assert!(text.ends_with("END"));
            assert!(text.contains('\n'), "dense non-ASCII line must split");
            let mut offset = 0;
            for line in text.split('\n') {
                let end = offset + line.len();
                let non_ascii = line.bytes().filter(|&b| b >= 0xc0).count();
                let layout_on_line = spans
                    .iter()
                    .filter(|s| {
                        affects_layout(s) && (s.start as usize) < end && (s.end as usize) > offset
                    })
                    .count();
                let estimated_styles = non_ascii * PARLEY_STYLES_PER_NON_ASCII
                    + layout_on_line * PARLEY_STYLES_PER_SPAN;
                assert!(
                    estimated_styles <= PARLEY_STYLE_LIMIT + 64 * PARLEY_STYLES_PER_NON_ASCII,
                    "paragraph exceeded Parley style budget: non_ascii={non_ascii}, layout={layout_on_line}"
                );
                offset = end + 1;
            }
        }
        // Exercise the real Rune/Parley runtime across both line-layout capping and line splitting.
        let runtime_source = format!(
            "{}{}END",
            "\u{1b}[44mA\u{1b}[45mB".repeat(5_000),
            "A🦀".repeat(MAX_LINE_NON_ASCII + 256)
        );
        let mut rt = rune::Runtime::new(
            runtime_source,
            |source, _| code(source, false),
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        assert!(rt.accessibility_json().to_string().contains("END"));
    }

    #[test]
    fn active_search_cannot_reveal_concealed_ansi_text() {
        let mut rt = rune::Runtime::new(
            (
                "\u{1b}[8mTOPSECRET\u{1b}[0m visible".to_owned(),
                vec!["TOPSECRET".to_owned()],
                std::cell::Cell::new(false),
            ),
            |(source, terms, claimed), _| {
                let query = crate::timeline::search::Query {
                    terms,
                    ranked: false,
                    active: true,
                    claimed: Some(claimed),
                };
                search_code(source, false, Some(query))
            },
            (640.0, 200.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("visible"));
        assert!(!tree.contains("TOPSECRET"));
        assert!(!rt.state.2.get());
    }

    #[test]
    fn tab_stops_expand_without_costing_a_styled_rune_lookup() {
        let log = parse("A\u{1b}[41m\tB\t\r\nC\tD");
        assert_eq!(log.text, "A   B   \nC   D");
        // Concealed multi-byte characters mask to one space each so tab alignment holds.
        let concealed_tab = parse("\u{1b}[8mé\u{1b}[0m\tX");
        assert_eq!(concealed_tab.text, "    X");
    }

    #[test]
    fn dense_non_ascii_line_breaks_never_split_zwj_or_combining_graphemes() {
        let zwj = format!("{}👩\u{200d}💻after", "é".repeat(MAX_LINE_NON_ASCII + 63));
        let zwj_text = parse(&zwj).text;
        assert!(
            zwj_text.contains("👩\u{200d}💻"),
            "ZWJ emoji sequence must stay intact across paragraph splits"
        );
        let combining = format!("e{}", "\u{0301}".repeat(MAX_LINE_NON_ASCII + 65));
        let combining_text = parse(&combining).text;
        assert!(
            !combining_text.contains('\n'),
            "a single combining grapheme must not be split by synthetic line breaks"
        );
    }

    #[test]
    fn sgr_53_and_55_toggle_ansi_overline_decorations() {
        let plain = "top plain red";
        let overlined = "\u{1b}[53mtop\u{1b}[55m plain \u{1b}[31;53mred\u{1b}[0m";
        let (text, _, strikes, overlines) = styled(parse(overlined));
        assert_eq!(text, plain);
        assert!(strikes.is_empty());
        assert_eq!(
            overlines
                .iter()
                .map(|&(start, end, _)| &text[start..end])
                .collect::<Vec<_>>(),
            vec!["top", "red"],
            "SGR 55 must clear overline before ' plain ' and SGR 53 must re-enable it on 'red'"
        );
        assert_eq!(overlines[1].2, Some(rgb(187, 0, 0)));
        let paint_count = |source: &'static str| {
            let mut rt = rune::Runtime::new(
                source,
                |source, _| code(source, false),
                (480.0, 200.0),
                rune::Env::new(false, 1.0),
            );
            rt.frame(0.0);
            rt.instances
                .iter()
                .filter(|inst| inst.rect[2] > 4.0 && inst.rect[3] > 0.0 && inst.rect[3] <= 2.5)
                .count()
        };
        let base_lines = paint_count(plain);
        let with_overlines = paint_count(overlined);
        assert!(
            with_overlines >= base_lines + 2,
            "SGR 53/55 must paint overline rules over the two overlined spans: base={base_lines}, with={with_overlines}"
        );
        // Concealed text with SGR 53 must not paint a visible overline rule.
        let hidden_overlined = "\u{1b}[8;53msecret\u{1b}[0m";
        let (_, _, _, hidden_ov) = styled(parse(hidden_overlined));
        assert!(hidden_ov.is_empty());
        assert_eq!(paint_count(hidden_overlined), 0);
    }

    #[test]
    fn unsupported_underline_color_keeps_its_parameters_atomic() {
        let log = parse("\u{1b}[58;5;8mErreur");
        assert_eq!(log.text, "Erreur");
        assert!(log.runs.is_empty());
    }

    #[test]
    fn an_unstyled_long_line_does_not_suppress_a_bounded_underline() {
        let source = format!(
            "\u{1b}[4m{}\u{1b}[0m\n{}",
            "A".repeat(1001),
            "x".repeat(7000)
        );
        let (_, spans, _, _) = styled(parse(&source));
        assert_eq!(spans[0].end, 1001);
        assert!(spans[0].underline.is_some());
    }

    #[test]
    fn mixed_script_layout_runs_stay_bounded_and_preserve_foreground_ink() {
        let source = format!(
            "{}\u{1b}[31;44;4mTAIL",
            "\u{1b}[32;44mA\u{1b}[33;45m🦀\n".repeat(LAYOUT_SPAN_LIMIT / 2 + 64)
        );
        let (text, spans, _, _) = styled(parse(&source));
        assert!(text.ends_with("TAIL"));
        let layout_count = spans.iter().filter(|span| affects_layout(span)).count();
        assert_eq!(layout_count, LAYOUT_SPAN_LIMIT);
        // Past the layout-run cap, foreground color still renders without splitting Parley runs.
        let tail = spans.last().unwrap();
        assert_eq!(&text[tail.start as usize..tail.end as usize], "TAIL");
        assert_eq!(tail.color, Some(rgb(187, 0, 0)));
        assert!(tail.bg.is_none() && tail.underline.is_none());
    }

    #[test]
    fn mixed_script_underline_stays_coalesced_and_renders_in_runtime() {
        let source = format!(
            "\u{1b}[4m{}\u{1b}[0m \u{1b}[31;4mFAILED\u{1b}[0m",
            "A🦀".repeat(3_250)
        );
        let (text, spans, _, _) = styled(parse(&source));
        assert_eq!(spans.len(), 2);
        assert!(spans[0].underline.is_some());
        assert_eq!(
            &text[spans[1].start as usize..spans[1].end as usize],
            "FAILED"
        );
        assert!(spans[1].underline.is_some());
        let mut rt = rune::Runtime::new(
            source,
            |source, _| code(source, false),
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        assert!(rt.accessibility_json().to_string().contains("FAILED"));
    }

    #[test]
    fn bounded_styles_do_not_expose_conceal_after_the_limit() {
        let source = format!(
            "{}\u{1b}[8mhidden\u{1b}[0mEND",
            "\u{1b}[31mA\u{1b}[32mB\n".repeat(INK_SPAN_LIMIT / 2 + 1)
        );
        let (text, spans, strikes, overlines) = styled(parse(&source));
        assert_eq!(spans.len(), INK_SPAN_LIMIT);
        assert!(strikes.is_empty() && overlines.is_empty());
        assert!(text.ends_with("\n      END"));
    }

    fn copy_selection(
        text: &str,
        spans: Vec<Span>,
        strikes: Vec<Strike>,
    ) -> rune::ClipboardContent {
        let mut rt = rune::Runtime::new(
            (text.to_owned(), spans, strikes),
            |(text, spans, strikes), _| {
                rune::rich(text.as_str(), spans.clone())
                    .strikes(strikes.iter().copied())
                    .selectable(true)
                    .key("log")
            },
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        let clipboard = rune::clipboard::memory();
        rt.use_clipboard(&clipboard);
        rt.frame(0.0);
        rt.update(|_, tx| tx.select_all_text("log"));
        rt.frame(0.0);
        rt.key(rune::KeyEvent {
            key: rune::Key::Command('c'),
            mods: rune::Mods {
                cmd: true,
                ctrl: true,
                ..Default::default()
            },
        });
        rt.frame(0.0);
        clipboard.content().unwrap()
    }

    #[test]
    fn dense_log_can_copy_a_real_runtime_selection() {
        let (text, spans, strikes, _) = styled(parse(&"\u{1b}[31mA\u{1b}[32mB\n".repeat(16_384)));
        assert_eq!(spans.len(), 32_768);
        let copied = copy_selection(&text, spans, strikes);
        assert_eq!(copied.text(), text);
        // Paint-only ANSI color spans skip inline markup in HTML copy.
        assert_eq!(
            copied.html().unwrap(),
            format!("<p>{}</p>", "AB<br>".repeat(16_384))
        );
    }

    #[test]
    fn rich_ansi_attributes_and_selection_copy_preserve_plain_text_and_markup() {
        let source = "\u{1b}[38;5;46;1;3;4;9;53mBoldStrike\u{1b}[0m \u{1b}[38;2;12;34;56;2mDimRgb\u{1b}[0m \u{1b}[31;44;7mInv\u{1b}[0m \u{1b}[8mSecret\u{1b}[0m";
        let (text, spans, strikes, overlines) = styled(parse(source));
        assert_eq!(text, "BoldStrike DimRgb Inv       ");
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].color, Some(rgb(0, 255, 0)));
        assert!(spans[0].weight.is_some() && spans[0].italic && spans[0].underline.is_some());
        assert_eq!(strikes, vec![(0, 10, Some(rgb(0, 255, 0)))]);
        assert_eq!(overlines, vec![(0, 10, Some(rgb(0, 255, 0)))]);
        assert_eq!(spans[1].color, Some(rgb(12, 34, 56).alpha(0.7)));
        assert_eq!(spans[2].color, Some(rgb(0, 0, 187)));
        assert_eq!(spans[2].bg, Some(rgb(187, 0, 0)));
        let copied = copy_selection(&text, spans, strikes);
        assert_eq!(copied.text(), text);
        let html = copied.html().unwrap();
        assert!(html.contains("<strong><em><s>BoldStrike</s></em></strong>"));
        assert!(html.contains("DimRgb Inv"));
        assert!(!html.contains("Secret"));
    }

    #[test]
    fn a_uniform_ascii_line_stays_underlined_and_consecutive_crs_stay_distinct() {
        let source = format!("\u{1b}[4m{}\u{1b}[24m\r\r\nB", "A".repeat(1500));
        let (text, spans, _, _) = styled(parse(&source));
        assert!(text.ends_with("\n\nB"));
        assert_eq!(spans[0].end, 1500);
        assert!(spans[0].underline.is_some());
    }

    #[test]
    fn a_uniform_multiline_color_preserves_the_following_warning() {
        for (prefix, line) in [
            ("32", "OK\n"),
            ("32", "OK\n\n"),
            ("9", "OK\n"),
            ("32;9", "OK\n"),
        ] {
            let source = format!(
                "\u{1b}[{prefix}m{}\u{1b}[0m\u{1b}[31;4mFAILED\u{1b}[0m",
                line.repeat(1024)
            );
            let (text, spans, strikes, _) = styled(parse(&source));
            let warning = spans.last().unwrap();
            assert_eq!(
                &text[warning.start as usize..warning.end as usize],
                "FAILED"
            );
            assert_eq!(warning.color, Some(rgb(187, 0, 0)));
            assert!(warning.underline.is_some());
            let end = line.len() * 1023 + 2;
            if prefix.starts_with("32") {
                assert_eq!(spans.len(), 2);
                assert_eq!(spans[0].end as usize, end);
            }
            if prefix.ends_with('9') {
                assert_eq!(strikes.len(), 1);
                assert_eq!(strikes[0].1, end);
            }
        }
    }

    #[test]
    fn an_unpainted_control_cannot_displace_a_visible_style() {
        let line = "\u{1b}[7mA\u{1b}[mB".repeat(512);
        let (text, spans, _, _) = styled(parse(&format!("{line}\n{line}\n\u{1b}[31;4mFAILED")));
        assert_eq!(spans.len(), 1);
        let warning = &spans[0];
        assert_eq!(
            &text[warning.start as usize..warning.end as usize],
            "FAILED"
        );
        assert_eq!(warning.color, Some(rgb(187, 0, 0)));
        assert!(warning.underline.is_some());
    }

    #[test]
    fn empty_lines_are_not_merged_into_strikethrough() {
        let (_, _, strikes, _) = styled(parse("\u{1b}[9mA\n\nB"));
        assert_eq!(
            strikes.iter().map(|&(a, b, _)| a..b).collect::<Vec<_>>(),
            [0..1, 3..4]
        );
    }

    #[test]
    fn initial_dense_colors_preserve_the_following_warning() {
        for prefix in ["", "\u{1b}[9m"] {
            let source = format!(
                "{prefix}{}\u{1b}[0m\u{1b}[31;4mFAILED",
                "\u{1b}[31mA\u{1b}[32mB\n".repeat(512)
            );
            let (text, spans, _, _) = styled(parse(&source));
            let warning = spans.last().unwrap();
            assert_eq!(
                &text[warning.start as usize..warning.end as usize],
                "FAILED"
            );
            assert_eq!(warning.color, Some(rgb(187, 0, 0)));
            assert!(warning.underline.is_some());
        }
    }

    #[test]
    fn equivalent_reverse_colors_do_not_fragment_a_uniform_underline() {
        let ascii = format!(
            "\u{1b}[4;31;44m{}{}",
            "A".repeat(3000),
            "\u{1b}[34;41;7mA\u{1b}[31;44;27mA".repeat(180)
        );
        let unicode = format!(
            "\u{1b}[4;31;44m{}\u{1b}[34;41;7m{}",
            "é".repeat(700),
            "é".repeat(10)
        );
        for (source, bytes) in [(ascii, 3360), (unicode, 1420)] {
            let (text, spans, _, _) = styled(parse(&source));
            assert_eq!(text.len(), bytes);
            assert_eq!(spans.len(), 1);
            assert_eq!(spans[0].end as usize, bytes);
            assert!(spans[0].underline.is_some());
        }
    }

    #[test]
    fn underline_on_a_long_ascii_line_leaves_work_for_later_styles() {
        let source = format!(
            "\u{1b}[4m{}\u{1b}[0m{}\u{1b}[31;4mFAILED\u{1b}[0m{}",
            "A".repeat(1500),
            "\u{1b}[31mA\u{1b}[32mB".repeat(100),
            "x".repeat(3094)
        );
        let (text, spans, _, _) = styled(parse(&source));
        assert!(spans[0].underline.is_some());
        let warning = spans.last().unwrap();
        assert_eq!(
            &text[warning.start as usize..warning.end as usize],
            "FAILED"
        );
        assert_eq!(warning.color, Some(rgb(187, 0, 0)));
        assert!(warning.underline.is_some());
    }

    #[test]
    fn unicode_underline_stays_underlined_alongside_a_later_short_run() {
        for (count, warning, trailing) in [(1100, "\u{1b}[4m", 0), (990, "\u{1b}[31;4m", 32)] {
            let source = format!(
                "\u{1b}[4m{}\u{1b}[0m{warning}FAILED\u{1b}[0m{}",
                "é".repeat(count),
                "x".repeat(trailing)
            );
            let (text, spans, _, _) = styled(parse(&source));
            assert!(spans[0].underline.is_some());
            let last = spans.last().unwrap();
            assert!(last.underline.is_some());
            if count == 1100 {
                assert_eq!(spans.len(), 1);
                assert_eq!(
                    &text[last.start as usize..last.end as usize],
                    format!("{}FAILED", "é".repeat(count))
                );
            } else {
                assert_eq!(spans.len(), 2);
                assert_eq!(&text[last.start as usize..last.end as usize], "FAILED");
                assert_eq!(last.color, Some(rgb(187, 0, 0)));
            }
        }
    }

    #[test]
    fn paint_reservation_counts_joined_runs() {
        let source = format!(
            "\u{1b}[4mÉCHEC\u{1b}[m{}{}",
            "\u{1b}[34;41;7mA\u{1b}[31;44;27mB".repeat(170),
            "x".repeat(5654)
        );
        let (_, spans, _, _) = styled(parse(&source));
        assert_eq!(spans.len(), 2);
        assert!(spans[0].underline.is_some());
    }

    #[test]
    fn a_strike_without_other_ink_can_use_the_last_range() {
        let head = "\u{1b}[9mA\u{1b}[29mB\n".repeat(DECORATION_RUN_LIMIT - 1);
        let tail = "OK\n".repeat(1000);
        let (text, spans, strikes, _) = styled(parse(&format!("{head}\u{1b}[9m{tail}")));
        assert!(spans.is_empty());
        assert_eq!(strikes.len(), DECORATION_RUN_LIMIT);
        let &(start, end, _) = strikes.last().unwrap();
        assert_eq!(&text[start..end], tail.trim_end());
        let expected = format!("<s>{}</s>", tail.trim_end().replace('\n', "<br>"));
        assert!(
            copy_selection(&text, spans, strikes)
                .html()
                .unwrap()
                .contains(&expected)
        );
    }

    #[test]
    fn color_spans_do_not_consume_the_strike_or_overline_quota() {
        let colors = "\u{1b}[31mA\u{1b}[32mB\n".repeat(DECORATION_RUN_LIMIT);
        let source = format!("{colors}\u{1b}[9;53mDONE\u{1b}[0m");
        let (text, spans, strikes, overlines) = styled(parse(&source));
        assert_eq!(spans.len(), DECORATION_RUN_LIMIT * 2);
        assert_eq!(strikes.len(), 1);
        assert_eq!(overlines.len(), 1);
        assert_eq!(&text[strikes[0].0..strikes[0].1], "DONE");
        assert_eq!(&text[overlines[0].0..overlines[0].1], "DONE");
    }

    #[test]
    fn partial_and_full_line_strikes_and_overlines_respect_work_bounds() {
        // Partial strikes/overlines on one long line stay bounded by DECORATION_LINE_WORK_LIMIT.
        let partial = "\u{1b}[9;53mA\u{1b}[29;55mB".repeat(2_000);
        let (partial_text, _, partial_strikes, partial_overlines) = styled(parse(&partial));
        assert_eq!(partial_text.len(), 4_000);
        assert!(
            (partial_strikes.len() + partial_overlines.len()) * partial_text.len()
                <= DECORATION_LINE_WORK_LIMIT
        );
        assert!(!partial_strikes.is_empty() && !partial_overlines.is_empty());

        // Full-line strikes/overlines take range_boxes's O(1) fast path and are not throttled by line length.
        let line = format!("\u{1b}[9;53m{}\u{1b}[0m\n", "X".repeat(3_000));
        let full = line.repeat(3);
        let (full_text, _, full_strikes, full_overlines) = styled(parse(&full));
        assert_eq!(full_strikes.len(), 1);
        assert_eq!(full_overlines.len(), 1);
        assert_eq!(
            &full_text[full_strikes[0].0..full_strikes[0].1],
            full_text.trim_end()
        );
        assert_eq!(
            &full_text[full_overlines[0].0..full_overlines[0].1],
            full_text.trim_end()
        );

        // A single partial strike/overline on a heavily fragmented line (Latin/emoji or dense
        // layout spans later on the same line) is throttled before range_boxes's O(R^2) walk,
        // while a full-line strike on the same fragmented line still uses the O(1) fast path.
        let fragmented_partial = format!("\u{1b}[9;53mHIT\u{1b}[29;55m{}", "A🦀".repeat(1_000));
        let (_, _, frag_strikes, frag_overlines) = styled(parse(&fragmented_partial));
        assert!(frag_strikes.is_empty() && frag_overlines.is_empty());

        let leading_partial_before_dense_bg = format!(
            "\u{1b}[9mLEAD\u{1b}[29m{}",
            "\u{1b}[44mA\u{1b}[45mB".repeat(500)
        );
        let (_, _, lead_strikes, _) = styled(parse(&leading_partial_before_dense_bg));
        assert!(lead_strikes.is_empty());

        let fragmented_full = format!("\u{1b}[9m{}\u{1b}[0m", "A🦀".repeat(1_000));
        let (ff_text, _, ff_strikes, _) = styled(parse(&fragmented_full));
        assert_eq!(ff_strikes.len(), 1);
        assert_eq!(&ff_text[ff_strikes[0].0..ff_strikes[0].1], ff_text);

        // Contiguous same-color strike/overline across many alternating bg runs coalesces into
        // one full-line range per decoration before budgeting.
        let coalesced_bg = format!("\u{1b}[9;53m{}", "\u{1b}[44mA\u{1b}[45mB".repeat(500));
        let (cb_text, _, cb_strikes, cb_overlines) = styled(parse(&coalesced_bg));
        assert_eq!(cb_strikes.len(), 1);
        assert_eq!(cb_overlines.len(), 1);
        assert_eq!(&cb_text[cb_strikes[0].0..cb_strikes[0].1], cb_text);
        assert_eq!(&cb_text[cb_overlines[0].0..cb_overlines[0].1], cb_text);

        // Full-line decorations still charge linear line length so huge wrapped paragraphs
        // cannot bypass DECORATION_WINDOW_WORK_LIMIT.
        let huge_line = format!("\u{1b}[9m{}\u{1b}[0m\n", "x".repeat(100_000));
        let huge_source = huge_line.repeat(200);
        let (_, _, huge_strikes, _) = styled(parse(&huge_source));
        assert_eq!(huge_strikes.len(), 1);
        assert!(
            huge_strikes[0].1 <= DECORATION_WINDOW_WORK_LIMIT,
            "full-line wrapped strikes must respect linear window work budget: end={}",
            huge_strikes[0].1
        );
    }

    #[test]
    fn a_full_quota_can_merge_over_blank_lines_but_not_visible_text() {
        let dense = "\u{1b}[31mA\u{1b}[32mB\n".repeat(INK_SPAN_LIMIT / 2);
        let blank = "\n".repeat(2_000);
        let tail = "\u{1b}[31mA\u{1b}[32mB\n".repeat(100);
        let source = format!("{dense}{blank}B{tail}");
        let (_, spans, _, _) = styled(parse(&source));
        assert_eq!(spans.len(), INK_SPAN_LIMIT);
        assert_eq!(
            spans.last().unwrap().end as usize,
            INK_SPAN_LIMIT / 2 * 3 + blank.len() + 1
        );
    }
}
