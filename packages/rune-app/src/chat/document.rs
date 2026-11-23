use super::{actions::Display, links};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};
use std::borrow::Cow;

pub(super) const PROSE_LIMIT: usize = 50_000;
pub(super) const TOOL_LIMIT: usize = 10_000;
pub(super) const HIGHLIGHT_LIMIT: usize = 100_000;
const STEP: usize = 250_000;

pub(super) fn prose(s: &State, key: String, source: &str, streaming: bool) -> El {
    prose_at(s, key, source, streaming, PROSE_LIMIT)
}

pub(super) fn prose_at(s: &State, key: String, source: &str, streaming: bool, limit: usize) -> El {
    let group = key.clone();
    let scope = s.input_scope.clone();
    let link_scope = scope.clone();
    let unwrapped = s.transcript_display.unwrapped(&key);
    let steps = s.transcript_display.steps(&key);
    let version = s.transcript_display.stream_version();
    let memo_key = format!("{group}-markdown");
    window(s, key, &[source], limit, |shown, units| {
        let stamp = (
            version,
            steps,
            std::rc::Rc::as_ptr(&scope) as usize,
            locale(),
            &unwrapped,
        );
        let build = || {
            markdown::prose(
                shown,
                streaming,
                units
                    <= if streaming {
                        TOOL_LIMIT
                    } else {
                        HIGHLIGHT_LIMIT
                    },
                move |s: &mut State, url, tx| {
                    if s.current_scope(&link_scope) {
                        let _ = tx.open_url(&links::external(url));
                    }
                },
                {
                    let unwrapped = unwrapped.clone();
                    move |index, _| !unwrapped.contains(&index)
                },
                move |card, frame| {
                    let index = frame.index;
                    let source = frame.source.to_owned();
                    let group = group.clone();
                    let copy = markdown::copy_button(
                        t("markdown.codeBlock.copy.label"),
                        screen::action_tx(&scope, move |_, tx| tx.copy(source.as_str())),
                    )
                    .key(format!("{group}-code-{index}-copy"));
                    let wrap = layout::button(
                        t(if frame.wrapped {
                            "markdown.codeBlock.wrap.disable"
                        } else {
                            "markdown.codeBlock.wrap.enable"
                        }),
                        false,
                        screen::action(&scope, {
                            let group = group.clone();
                            move |s| Display::toggle_code(s, &group, index)
                        }),
                    )
                    .key(format!("{group}-code-{index}-wrap"))
                    .checked(frame.wrapped);
                    let mut header = layout::action_row();
                    if let Some(language) = frame.language {
                        header = header.child(text(language));
                    }
                    col()
                        .full_width()
                        .child(header.child(wrap).child(copy))
                        .child(card)
                },
            )
        };
        if streaming && units > TOOL_LIMIT {
            markdown::hold_frame(memo_key, stamp, build)
        } else {
            build()
        }
    })
}

pub(super) fn window(
    s: &State,
    key: String,
    parts: &[&str],
    limit: usize,
    render: impl FnOnce(&str, usize) -> El,
) -> El {
    window_with_total(s, key, parts, limit, None, render)
}

pub(super) fn window_with_total(
    s: &State,
    key: String,
    parts: &[&str],
    limit: usize,
    total: Option<(usize, usize)>,
    render: impl FnOnce(&str, usize) -> El,
) -> El {
    let steps = s.transcript_display.steps(&key);
    let budget = limit.saturating_add(steps.saturating_mul(STEP));
    let retained = total.map_or_else(
        || parts.iter().map(|part| units(part)).sum(),
        |(retained, _)| retained,
    );
    let (shown, units, hidden, more) = prefix_measured(parts, budget, retained);
    let hidden = hidden.max(total.map_or(0, |(_, total)| total).saturating_sub(units));
    let content_key = format!("{key}-content");
    let mut body = col().full_width().separate(Space::Sm).child(
        render(&shown, units)
            .key(content_key.clone())
            .focusable(steps > 0 && hidden == 0)
            .tab_index(-1),
    );
    if hidden > 0 {
        let status = catalogue::format(
            locale(),
            if hidden == 1 {
                "messageBlock.hiddenText.one"
            } else {
                "messageBlock.hiddenText.other"
            },
            &[("count", &hidden.to_string())],
        );
        let label = if more == hidden {
            t("messageBlock.hiddenText.showAll").into()
        } else {
            catalogue::format(
                locale(),
                "messageBlock.hiddenText.showMore",
                &[("count", &more.to_string())],
            )
        };
        let notice = format!("{key}-notice");
        let target = key.clone();
        body = body.child(
            layout::action_row()
                .child(text(status).key(notice.clone()))
                .children((more > 0).then(|| {
                    layout::button_tx(
                        &label,
                        false,
                        screen::action_tx(&s.input_scope, move |s, tx| {
                            tx.keep_on_screen(&content_key);
                            if more == hidden && tx.by_keys() {
                                tx.focus(&content_key, true);
                            }
                            Display::reveal_next(s, &target);
                        }),
                    )
                    .key(format!("reveal-{key}"))
                    .described_by(notice)
                })),
        );
    }
    body.key(key)
}

fn units(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.encode_utf16().count()
    }
}

// Offsets match Solid's UTF-16 counts; Rust slicing always lands on UTF-8 boundaries.
fn end(parts: &[&str], budget: usize) -> (usize, usize) {
    let mut bytes = 0;
    let mut count = 0;
    let mut line = None;
    let min = budget - budget / 10;
    for c in parts.iter().flat_map(|s| s.chars()) {
        let next = count + c.len_utf16();
        if next > budget {
            break;
        }
        count = next;
        bytes += c.len_utf8();
        if c == '\n' && count > min {
            line = Some((bytes, count));
        }
    }
    line.unwrap_or((bytes, count))
}

fn prefix_measured<'a>(
    parts: &[&'a str],
    budget: usize,
    total: usize,
) -> (Cow<'a, str>, usize, usize, usize) {
    let (bytes, count) = if total <= budget {
        (parts.iter().map(|s| s.len()).sum(), total)
    } else {
        end(parts, budget)
    };
    let next_budget = budget.saturating_add(STEP);
    let next = if total <= next_budget {
        total
    } else {
        end(parts, next_budget).1
    };
    let shown = match parts {
        [one] => Cow::Borrowed(&one[..bytes]),
        _ => {
            let mut left = bytes;
            let mut shown = String::with_capacity(bytes);
            for part in parts {
                let take = left.min(part.len());
                shown.push_str(&part[..take]);
                left -= take;
                if left == 0 {
                    break;
                }
            }
            Cow::Owned(shown)
        }
    };
    (shown, count, total - count, next - count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prefix<'a>(parts: &[&'a str], budget: usize) -> (Cow<'a, str>, usize, usize, usize) {
        prefix_measured(parts, budget, parts.iter().map(|part| units(part)).sum())
    }
    #[test]
    fn utf16_windows_keep_line_cuts_and_count_the_next_step() {
        let (shown, width, hidden, more) = prefix(&["$ ", "🦀", "\n", "abc"], 3);
        assert_eq!((&*shown, width, hidden, more), ("$ ", 2, 6, 6));
        let line = format!("{}\n{}", "a".repeat(94), "b".repeat(600_000));
        let (_, width, hidden, more) = prefix(&[&line], 100);
        assert_eq!((width, hidden, more), (95, 600_000, 250_005));
    }
}
