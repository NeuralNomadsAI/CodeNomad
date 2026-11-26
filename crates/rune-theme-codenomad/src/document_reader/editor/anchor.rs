use super::{drawing_width, metrics};
use rune::TextStyle;
use rune::text::{RichLayoutOptions, TextSystem};
use std::cell::RefCell;

// Matches Rune's text commit slack (crates/rune/src/runtime/commit/text_layout.rs).
const FIT_SLACK: f32 = 1.0 / 256.0;
const LARGE_LINE_BYTES: usize = 8 * 1024;
const EVICT_EVERY: u32 = 512;

/// The logical gutter line, UTF-16 column of its top visible wrapped segment,
/// and sub-line vertical offset within that segment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineAnchor {
    line: usize,
    column: usize,
    subline: f32,
}

#[derive(Clone, Copy, PartialEq)]
pub struct SourceLayout {
    wrap_width: Option<f32>,
    style: TextStyle,
    padding: f32,
}

struct LayoutCache {
    epoch: u64,
    text: TextSystem,
    calls: u32,
}

thread_local! {
    static CACHE: RefCell<Option<LayoutCache>> = const { RefCell::new(None) };
}

fn utf16_units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn byte_at_utf16_column(text: &str, column: usize) -> usize {
    let mut offset = 0;
    let mut units = 0;
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > column {
            break;
        }
        offset += ch.len_utf8();
    }
    offset
}

fn is_plain_single_row(line: &str, wrap_width: Option<f32>) -> bool {
    line.is_empty()
        || (wrap_width.is_none()
            && line.is_ascii()
            && !line.as_bytes().iter().any(|&b| b == 0x0b || b == 0x0c))
}

fn build_text_system(style: TextStyle) -> TextSystem {
    const PROBE: &str = "iW0m ";
    let live = rune::text::advance(PROBE, style);
    let app_families = crate::layout::font_families();
    let build = |families: (&str, &str)| {
        // Guard keeps TextSystem::new from mutating process-wide measure fonts.
        let _guard = rune::text::with_families(families.0, families.1);
        TextSystem::new(&[], families)
    };
    let mut ts = build(app_families);
    let width = ts.layout_rich(PROBE, &[], style, 1.0, None).full_width();
    if (width - live).abs() <= 0.01 || app_families == ("Inter", "Inter") {
        return ts;
    }
    build(("Inter", "Inter"))
}

fn with_line_layout<R>(
    line: &str,
    style: TextStyle,
    wrap_width: Option<f32>,
    f: impl FnOnce(&rune::text::parley::Layout<rune::text::Ink>) -> R,
) -> R {
    let options = RichLayoutOptions::new()
        .direction(rune::Direction::Ltr)
        .wrap_anywhere();
    let max_width = wrap_width.map(|w| w + FIT_SLACK);
    CACHE.with_borrow_mut(|slot| {
        let current = rune::text::font_epoch();
        if slot.as_ref().is_none_or(|cache| cache.epoch != current) {
            let text = build_text_system(style);
            let epoch = rune::text::font_epoch();
            *slot = Some(LayoutCache {
                epoch,
                text,
                calls: 0,
            });
        }
        let cache = slot.as_mut().expect("layout cache initialized");
        cache.calls = cache.calls.wrapping_add(1);
        if cache.calls.is_multiple_of(EVICT_EVERY) {
            cache.text.end_commit();
        }
        let layout = cache
            .text
            .layout_rich_with(line, &[], style, 1.0, max_width, options);
        let result = f(&layout);
        if line.len() >= LARGE_LINE_BYTES {
            cache.text.end_commit();
        }
        result
    })
}

impl SourceLayout {
    pub fn new(dark: bool, text: &str, wrap: bool, width: Option<f32>) -> Self {
        let m = metrics(dark);
        Self {
            wrap_width: width
                .filter(|w| wrap && w.is_finite())
                .map(|w| (drawing_width(dark, text, w) - 2.0 * m.padding).max(1.0)),
            style: m.style,
            padding: m.padding,
        }
    }

    pub fn width_key(self) -> u32 {
        self.wrap_width.map_or(0, f32::to_bits)
    }

    fn line_height(self, line: &str) -> f32 {
        if is_plain_single_row(line, self.wrap_width) {
            return self.style.line_px();
        }
        with_line_layout(line, self.style, self.wrap_width, |layout| {
            layout.height().max(self.style.line_px())
        })
    }

    pub fn capture(self, text: &str, offset: f32) -> Option<LineAnchor> {
        let mut delta = offset - self.padding;
        if !delta.is_finite() || delta < 0.0 {
            return None;
        }
        for (line, raw) in text.split('\n').enumerate() {
            let trimmed = raw.trim_end_matches('\r');
            if is_plain_single_row(trimmed, self.wrap_width) {
                let height = self.style.line_px();
                if delta < height {
                    return Some(LineAnchor {
                        line,
                        column: 0,
                        subline: delta,
                    });
                }
                delta -= height;
                continue;
            }
            let matched = with_line_layout(trimmed, self.style, self.wrap_width, |layout| {
                let height = layout.height().max(self.style.line_px());
                if delta >= height {
                    return Err(height);
                }
                let chosen = layout
                    .lines()
                    .find(|row| delta < row.metrics().block_max_coord)
                    .or_else(|| layout.lines().next_back());
                let (byte, top) = chosen.map_or((0, 0.0), |row| {
                    (
                        row.text_range().start.min(trimmed.len()),
                        row.metrics().block_min_coord,
                    )
                });
                Ok(LineAnchor {
                    line,
                    column: utf16_units(&trimmed[..byte]),
                    subline: (delta - top).max(0.0),
                })
            });
            match matched {
                Ok(anchor) => return Some(anchor),
                Err(height) => delta -= height,
            }
        }
        None
    }

    pub fn restore(self, text: &str, anchor: LineAnchor) -> Option<f32> {
        let mut y = self.padding;
        for (line, raw) in text.split('\n').enumerate() {
            let trimmed = raw.trim_end_matches('\r');
            if line == anchor.line {
                if is_plain_single_row(trimmed, self.wrap_width) {
                    let limit = (self.style.line_px() - 0.001).max(0.0);
                    return Some(y + anchor.subline.clamp(0.0, limit));
                }
                let offset = with_line_layout(trimmed, self.style, self.wrap_width, |layout| {
                    let height = layout.height().max(self.style.line_px());
                    let byte = byte_at_utf16_column(trimmed, anchor.column);
                    let chosen = if anchor.column == 0 {
                        layout.lines().next()
                    } else {
                        layout
                            .lines()
                            .find(|row| {
                                let range = row.text_range();
                                range.contains(&byte) || (range.is_empty() && range.start == byte)
                            })
                            .or_else(|| layout.lines().next_back())
                    };
                    let (row_top, row_h) = chosen.map_or((0.0, self.style.line_px()), |row| {
                        let m = row.metrics();
                        (
                            m.block_min_coord,
                            (m.block_max_coord - m.block_min_coord).max(self.style.line_px()),
                        )
                    });
                    let subline = anchor.subline.clamp(0.0, (row_h - 0.001).max(0.0));
                    (row_top + subline).min((height - 0.001).max(0.0))
                });
                return Some(y + offset);
            }
            y += self.line_height(trimmed);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_rows(
        ts: &mut TextSystem,
        line: &str,
        style: TextStyle,
        width: f32,
    ) -> Vec<(std::ops::Range<usize>, f32)> {
        let options = RichLayoutOptions::new()
            .direction(rune::Direction::Ltr)
            .wrap_anywhere();
        let layout = ts.layout_rich_with(line, &[], style, 1.0, Some(width + FIT_SLACK), options);
        layout
            .lines()
            .map(|l| (l.text_range(), l.metrics().block_min_coord))
            .collect()
    }

    #[test]
    fn segment_anchor_matches_parley_row_starts_across_widths_and_punctuation() {
        let m = metrics(false);
        let style = m.style;
        let inset = m.padding;
        // Initialize measure state before checking font_epoch invariance.
        let _ = rune::text::advance("0", style);
        let epoch_before = rune::text::font_epoch();
        let mut oracle = build_text_system(style);
        let samples = [
            "long prefix ".repeat(25),
            "a".repeat(220),
            format!("aa {} tail", "b".repeat(120)),
            format!("   {} tail", "b".repeat(120)),
            "pre aa?bbbb ".repeat(15),
            "aa fo/bar ".repeat(15),
            "src/components/workspace-file-viewer/very-long-segment-name.tsx ".repeat(8),
            "value -1234567890 offset -9876543210 ".repeat(12),
            "un mot été 🦀 日本語テスト ".repeat(16),
            format!("\t\tindented  {}", "token ".repeat(30)),
        ];
        for sample in &samples {
            for width in [60.0, 120.0, 210.0, 340.0] {
                let rows = layout_rows(&mut oracle, sample, style, width);
                assert!(rows.len() > 2, "sample did not wrap at {width}: {sample}");
                let layout = SourceLayout {
                    wrap_width: Some(width),
                    style,
                    padding: inset,
                };
                for (row, (range, top)) in rows.iter().enumerate() {
                    let y = inset + top + 3.5;
                    let anchor = layout.capture(sample, y).expect("anchor");
                    assert_eq!(anchor.line, 0);
                    assert!(
                        (anchor.subline - 3.5).abs() < 0.01,
                        "width={width} row={row} top={top} subline={} in {sample:?}",
                        anchor.subline
                    );
                    let captured_byte = byte_at_utf16_column(sample, anchor.column);
                    assert_eq!(
                        captured_byte, range.start,
                        "width={width} row={row} range={range:?} captured={captured_byte} in {sample:?}"
                    );
                    for target_width in [50.0, 95.0, 160.0, 260.0, 420.0] {
                        let target_rows = layout_rows(&mut oracle, sample, style, target_width);
                        let expected_top = target_rows
                            .iter()
                            .find(|(r, _)| r.contains(&range.start))
                            .unwrap_or(target_rows.last().unwrap())
                            .1;
                        let target_layout = SourceLayout {
                            wrap_width: Some(target_width),
                            style,
                            padding: inset,
                        };
                        let restored = target_layout.restore(sample, anchor).expect("restored");
                        let expected_y = inset + expected_top + 3.5;
                        assert!(
                            (restored - expected_y).abs() < 0.01,
                            "width={width}->{target_width} row={row} start={} expected_y={expected_y} got {restored} in {sample:?}",
                            range.start
                        );
                    }
                }
            }
        }
        assert_eq!(rune::text::font_epoch(), epoch_before);
    }

    #[test]
    fn segment_anchor_handles_crlf_leading_line_separators_unwrapped_and_non_finite() {
        let m = metrics(false);
        let style = m.style;
        let inset = m.padding;
        let line_height = style.line_px();
        let mut oracle = build_text_system(style);
        let first_line = "alpha beta gamma ".repeat(20);
        let text = format!("{first_line}\r\nsecond");
        let narrow = SourceLayout {
            wrap_width: Some(150.0),
            style,
            padding: inset,
        };
        let wide = SourceLayout {
            wrap_width: Some(320.0),
            style,
            padding: inset,
        };
        let unwrapped = SourceLayout {
            wrap_width: None,
            style,
            padding: inset,
        };
        let row5_top = layout_rows(&mut oracle, &first_line, style, 150.0)[5].1;
        let anchor = narrow.capture(&text, inset + row5_top + 2.0).unwrap();
        assert_eq!(anchor.line, 0);
        assert!(anchor.column > 0);
        assert!((anchor.subline - 2.0).abs() < 0.01);
        let wide_y = wide.restore(&text, anchor).unwrap();
        assert!(wide_y > inset + line_height && wide_y < inset + row5_top);
        assert_eq!(unwrapped.restore(&text, anchor), Some(inset + 2.0));
        let shortened = "short\r\nsecond";
        assert_eq!(narrow.restore(shortened, anchor), Some(inset + 2.0));

        // Leading Unicode line/paragraph separators capture row 1 with its own subline.
        for sep in ['\u{2028}', '\u{2029}'] {
            let line = format!("{sep}x");
            let anchor = unwrapped.capture(&line, inset + line_height + 2.0).unwrap();
            assert_eq!(anchor.line, 0);
            assert_eq!(anchor.column, 1);
            assert!((anchor.subline - 1.5).abs() <= 0.6, "{anchor:?}");
            let replaced = unwrapped.restore("x", anchor).unwrap();
            assert!((replaced - (inset + anchor.subline)).abs() < 0.01);
        }

        // Non-finite inputs fail safely.
        assert!(narrow.capture(&text, f32::NAN).is_none());
        assert!(narrow.capture(&text, f32::INFINITY).is_none());
        assert_eq!(
            SourceLayout::new(false, &text, true, Some(f32::INFINITY)).width_key(),
            0
        );
    }
}
