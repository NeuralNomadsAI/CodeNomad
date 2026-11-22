use crate::{layout::dark, tokens};
use rune::{Color, El, Span};
use std::ops::Range;
use vte::{Params, Perform};

const ESCAPED: [&str; 5] = ["\\u001b", "\\u001B", "\\x1b", "\\x1B", "\\033"];
// Rune reserves the high ink-index bit for synthetic bold.
const SHAPED_RUN_LIMIT: usize = i16::MAX as usize;
const DECORATION_WORK_LIMIT: usize = 1_000_000;

pub fn present(source: &str) -> bool {
    source.contains('\u{1b}') || ESCAPED.iter().any(|escape| source.contains(escape))
}

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
}

#[derive(Default)]
struct Log {
    text: String,
    runs: Vec<(Range<usize>, Style)>,
    start: usize,
    style: Style,
    pending_cr: bool,
}

impl Log {
    fn finish_run(&mut self) {
        if self.start < self.text.len() && self.style != Style::default() {
            self.runs.push((self.start..self.text.len(), self.style));
        }
        self.start = self.text.len();
    }

    fn push(&mut self, c: char) {
        if std::mem::take(&mut self.pending_cr) && c != '\n' {
            self.text.push('\n');
        }
        self.text.push(c);
    }

    fn literal(&mut self, text: &str) {
        for c in text.chars() {
            match c {
                '\r' => self.pending_cr = true,
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
                30..=37 => set.fg = Some(palette((code - 30) as u8)),
                40..=47 => set.bg = Some(palette((code - 40) as u8)),
                90..=97 => set.fg = Some(palette((code - 82) as u8)),
                100..=107 => set.bg = Some(palette((code - 92) as u8)),
                39 => next.fg = None,
                49 => next.bg = None,
                38 | 48 => {
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
                    if let Some(color) = color {
                        if code == 38 {
                            set.fg = Some(color);
                        } else {
                            set.bg = Some(color);
                        }
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

fn parse(mut source: &str) -> Log {
    let mut out = Log::default();
    let mut parser = vte::Parser::new();
    // A transcript is a log, not a terminal. Feed only complete SGR to VTE;
    // unsupported or truncated escapes retain their printable text.
    while let Some(index) = source.find(['\u{1b}', '\\']) {
        out.literal(&source[..index]);
        let rest = &source[index..];
        let escape_len = if rest.starts_with('\u{1b}') {
            1
        } else {
            ESCAPED
                .iter()
                .find(|escape| rest.starts_with(**escape))
                .map_or(1, |escape| escape.len())
        };
        let tail = &rest[escape_len..];
        if (escape_len > 1 || rest.starts_with('\u{1b}')) && tail.starts_with('[') {
            let end = tail.as_bytes()[1..]
                .iter()
                .position(|&byte| !byte.is_ascii_digit() && !matches!(byte, b';' | b':'))
                .map(|index| index + 1);
            if let Some(end) = end.filter(|&index| tail.as_bytes()[index] == b'm') {
                parser.advance(&mut out, b"\x1b");
                parser.advance(&mut out, &tail.as_bytes()[..=end]);
                source = &tail[end + 1..];
                continue;
            }
        }
        out.literal(&rest[..escape_len]);
        source = tail;
    }
    out.literal(source);
    if out.pending_cr {
        out.push('\n');
    }
    out.finish_run();
    out
}

pub fn code(source: &str, wrap: bool) -> El {
    let log = parse(source);
    let mut spans = Vec::with_capacity(log.runs.len());
    let mut strikes = vec![];
    let metrics = tokens(dark());
    let default = metrics.color("text-primary");
    // Rune's range decoration queries revisit the shaped line for each range.
    let mut decorations_left = DECORATION_WORK_LIMIT / log.text.len().max(1);
    let mut shaped_left = SHAPED_RUN_LIMIT;
    for (range, mut style) in log.runs {
        if style.inverse {
            std::mem::swap(&mut style.fg, &mut style.bg);
        }
        let dim = |color: Color| if style.dim { color.alpha(0.7) } else { color };
        let mut span = Span::new(range.start, range.end);
        if style.hidden {
            span = span.color(Color::TRANSPARENT);
        } else {
            if style.fg.is_some() || style.dim {
                span = span.color(dim(style.fg.unwrap_or(default)));
            }
            if let Some(bg) = style.bg.filter(|_| shaped_left > 0) {
                span = span.bg(dim(bg), 0.0);
            }
            if style.underline && decorations_left > 0 && shaped_left > 0 {
                decorations_left -= 1;
                span = span.underline(dim(style.fg.unwrap_or(default)));
            }
            if style.strike && decorations_left > 0 {
                decorations_left -= 1;
                strikes.push((
                    range.start,
                    range.end,
                    Some(dim(style.fg.unwrap_or(default))),
                ));
            }
        }
        if style.bold && shaped_left > 0 {
            span = span.weight(metrics.number("font-weight-semibold").px());
        }
        if style.italic && shaped_left > 0 {
            span = span.italic();
        }
        if span.weight.is_some() || span.italic || span.bg.is_some() || span.underline.is_some() {
            shaped_left -= 1;
        }
        spans.push(span);
    }
    super::markdown::code_body(rune::rich(log.text, spans).strikes(strikes), wrap)
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
    fn color_only_runs_and_conceal_survive_beyond_the_shaping_index_limit() {
        let source = format!(
            "{}\u{1b}[8mhidden\u{1b}[0m\u{1b}[31mEND",
            "\u{1b}[31mA\u{1b}[32mB\n".repeat(16_384)
        );
        let log = parse(&source);
        assert!(log.runs.len() > SHAPED_RUN_LIMIT);
        assert!(log.text.ends_with("\nhiddenEND"));
        assert!(log.runs[log.runs.len() - 2].1.hidden);
        assert_eq!(log.runs.last().unwrap().1.fg, Some(rgb(187, 0, 0)));
    }

    #[test]
    fn an_oversized_sgr_does_not_propagate_hidden_text() {
        let log = parse(&format!(
            "\u{1b}[8mhidden\u{1b}[{}0mvisible",
            "0;".repeat(32)
        ));
        assert_eq!(log.text, "hiddenvisible");
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
        assert_eq!(empty.text, "AB");
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
}
