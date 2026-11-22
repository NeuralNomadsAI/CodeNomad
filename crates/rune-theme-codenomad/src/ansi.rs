use crate::{layout::dark, tokens};
use rune::{Color, El, Span};
use std::ops::Range;
use vte::{Params, Perform};

const ESCAPED: [&str; 5] = ["\\u001b", "\\u001B", "\\x1b", "\\x1B", "\\033"];
// Rune's selection-to-HTML path scans every range at each style boundary.
// Keep both color and decoration ranges for the initial 10,000-unit window.
const COPY_RUN_LIMIT: usize = 4096;
const LINE_WORK_LIMIT: usize = 2_000_000;
const WINDOW_WORK_LIMIT: usize = 16_000_000;

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
    column: usize,
}

impl Log {
    fn finish_run(&mut self) {
        let mut style = self.style;
        if style.inverse {
            std::mem::swap(&mut style.fg, &mut style.bg);
            style.inverse = false;
        }
        if self.start < self.text.len() && style != Style::default() {
            if let Some((range, _)) = self
                .runs
                .last_mut()
                .filter(|(range, previous)| range.end == self.start && *previous == style)
            {
                range.end = self.text.len();
            } else {
                self.runs.push((self.start..self.text.len(), style));
            }
        }
        self.start = self.text.len();
    }

    fn push(&mut self, c: char) {
        if std::mem::take(&mut self.pending_cr) && c != '\n' {
            self.newline();
        }
        match c {
            '\t' => {
                // Expanding here avoids Rune's per-tab scan of every span.
                self.text
                    .extend(std::iter::repeat_n(' ', 4 - self.column % 4));
                self.column = 0;
            }
            '\n' => self.newline(),
            _ => {
                self.text.push(c);
                self.column += 1;
            }
        }
    }

    fn newline(&mut self) {
        self.finish_run();
        self.text.push('\n');
        self.start = self.text.len();
        self.column = 0;
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
    let (text, spans, strikes) = styled(parse(source));
    super::markdown::code_body(rune::rich(text, spans).strikes(strikes), wrap)
}

type Strike = (usize, usize, Option<Color>);

fn separated_only_by_newlines(text: &[u8], end: usize, start: usize) -> bool {
    text.get(end..start)
        .is_some_and(|gap| gap.iter().all(|&byte| byte == b'\n'))
}

fn styled(log: Log) -> (String, Vec<Span>, Vec<Strike>) {
    let mut spans: Vec<Span> = Vec::with_capacity(log.runs.len().min(COPY_RUN_LIMIT));
    let mut strikes: Vec<Strike> = vec![];
    let metrics = tokens(dark());
    let default = metrics.color("text-primary");
    let mut window_budget = WINDOW_WORK_LIMIT;
    let mut line_budget = LINE_WORK_LIMIT;
    let mut line = 0..0;
    let mut ascii_runs = None;
    let mut text = log.text.into_bytes();
    for (index, (range, style)) in log.runs.iter().cloned().enumerate() {
        while range.start >= line.end {
            let start = line.end;
            let end = text[start..]
                .iter()
                .position(|&byte| byte == b'\n')
                .map_or(text.len(), |newline| start + newline + 1);
            line = start..end;
            line_budget = LINE_WORK_LIMIT;
            // Printable ASCII in the monospace face does not itemize by script or emoji.
            ascii_runs = text[line.clone()].is_ascii().then(|| {
                let styled = log.runs[index..].partition_point(|(range, _)| range.start < line.end);
                styled.saturating_mul(2).saturating_add(1)
            });
        }
        // Rune can revisit the shaped line for every span, even for foreground-only ink.
        let mut charge = |cost| {
            if cost > line_budget || cost > window_budget {
                return false;
            }
            line_budget -= cost;
            window_budget -= cost;
            true
        };
        if !charge(line.len()) {
            // The native source stays available to Copy; keep conceal even without ink.
            if style.hidden {
                text[range].fill(b' ');
            }
            continue;
        }
        let dim = |color: Color| if style.dim { color.alpha(0.7) } else { color };
        let mut span = Span::new(range.start, range.end);
        if style.hidden {
            span = span.color(Color::TRANSPARENT);
        } else {
            if style.fg.is_some() || style.dim {
                span = span.color(dim(style.fg.unwrap_or(default)));
            }
            if let Some(bg) = style.bg {
                span = span.bg(dim(bg), 0.0);
            }
            // Underline bounds are queried for each glyph run in the decorated range.
            let underline_runs = ascii_runs.unwrap_or_else(|| range.len()).min(range.len());
            if style.underline && charge(underline_runs.saturating_mul(line.len())) {
                span = span.underline(dim(style.fg.unwrap_or(default)));
            }
            if style.strike && charge(line.len()) {
                let ink = Some(dim(style.fg.unwrap_or(default)));
                if let Some(last) = strikes.last_mut().filter(|last| {
                    last.2 == ink && matches!(text.get(last.1..range.start), Some(b"" | b"\n"))
                }) {
                    last.1 = range.end;
                } else if spans.len() + strikes.len() + 1 < COPY_RUN_LIMIT {
                    strikes.push((range.start, range.end, ink));
                }
            }
        }
        if style.bold {
            span = span.weight(metrics.number("font-weight-semibold").px());
        }
        if style.italic {
            span = span.italic();
        }
        if span == Span::new(range.start, range.end) {
            continue;
        }
        if let Some(last) = spans.last_mut()
            && separated_only_by_newlines(&text, last.end as usize, span.start as usize)
            && span
                == (Span {
                    start: span.start,
                    end: span.end,
                    ..last.clone()
                })
        {
            last.end = span.end;
        } else if spans.len() + strikes.len() < COPY_RUN_LIMIT {
            spans.push(span);
        } else if style.hidden {
            text[range].fill(b' ');
        }
    }
    (String::from_utf8(text).unwrap_or_default(), spans, strikes)
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
        assert!(log.runs.len() > COPY_RUN_LIMIT);
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

    #[test]
    fn excess_ink_spans_cannot_panic_or_reveal_concealed_text() {
        let source = format!(
            "{}\u{1b}[31mA\u{1b}[8m🦀SECRET\u{1b}[0mEND",
            "\u{1b}[31mA\u{1b}[32mB".repeat(32_767)
        );
        let mut rt = rune::Runtime::new(
            source,
            |source, _| code(source, false),
            (640.0, 360.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("END"));
        assert!(!tree.contains("SECRET"));
    }

    #[test]
    fn tab_stops_expand_without_costing_a_styled_rune_lookup() {
        let log = parse("A\u{1b}[41m\tB\t\r\nC\tD");
        assert_eq!(log.text, "A   B   \nC   D");
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
        let (_, spans, _) = styled(parse(&source));
        assert_eq!(spans[0].end, 1001);
        assert!(spans[0].underline.is_some());
    }

    #[test]
    fn mixed_script_ink_cannot_reach_quadratic_shaping() {
        let source = "\u{1b}[44mA\u{1b}[45m🦀".repeat(16_000);
        let (text, spans, _) = styled(parse(&source));
        assert_eq!(text, "A🦀".repeat(16_000));
        assert!(!spans.is_empty());
        assert!(spans.len() * text.len() <= LINE_WORK_LIMIT);
    }

    #[test]
    fn bounded_styles_do_not_expose_conceal_after_the_limit() {
        let source = format!(
            "{}\u{1b}[8mhidden\u{1b}[0mEND",
            "\u{1b}[31mA\u{1b}[32mB\n".repeat(16_384)
        );
        let (text, spans, strikes) = styled(parse(&source));
        assert_eq!(spans.len() + strikes.len(), COPY_RUN_LIMIT);
        assert!(text.ends_with("\n      END"));
    }

    #[test]
    fn dense_log_can_copy_a_real_runtime_selection() {
        let (text, spans, strikes) = styled(parse(&"\u{1b}[31mA\u{1b}[32mB\n".repeat(4096)));
        let mut rt = rune::Runtime::new(
            (text, spans, strikes),
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
        assert_eq!(
            clipboard.text().as_deref().map(String::as_str),
            Some(rt.state.0.as_str())
        );
    }

    #[test]
    fn a_uniform_ascii_line_stays_underlined_and_consecutive_crs_stay_distinct() {
        let source = format!("\u{1b}[4m{}\u{1b}[24m\r\r\nB", "A".repeat(1500));
        let (text, spans, _) = styled(parse(&source));
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
            let (text, spans, strikes) = styled(parse(&source));
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
        let (text, spans, _) = styled(parse(&format!("{line}\n{line}\n\u{1b}[31;4mFAILED")));
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
        let (_, _, strikes) = styled(parse("\u{1b}[9mA\n\nB"));
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
            let (text, spans, _) = styled(parse(&source));
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
        let source = format!(
            "\u{1b}[4;31;44m{}{}",
            "A".repeat(3000),
            "\u{1b}[34;41;7mA\u{1b}[31;44;27mA".repeat(180)
        );
        let (text, spans, _) = styled(parse(&source));
        assert_eq!(text.len(), 3360);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].end, 3360);
        assert!(spans[0].underline.is_some());
    }
}
