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

mod mermaid;

pub(super) const PROSE_LIMIT: usize = 50_000;
pub(super) const TOOL_LIMIT: usize = 10_000;
pub(super) const HIGHLIGHT_LIMIT: usize = 100_000;
const STEP: usize = 250_000;

pub(super) fn search_limit(
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> usize {
    TOOL_LIMIT
        + if query.is_some_and(|query| query.active) {
            STEP
        } else {
            0
        }
}

pub(super) fn search_limit_for(
    s: &State,
    card_key: &str,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> usize {
    let revealed =
        query.is_some_and(|query| query.active) || s.transcript_display.search_revealed(card_key);
    TOOL_LIMIT + if revealed { STEP } else { 0 }
}

pub(super) fn bounded_prose_matches(
    s: &State,
    key: &str,
    source: &str,
    limit: usize,
    query: rune_theme_codenomad::timeline::search::Query<'_>,
) -> bool {
    let budget = limit.saturating_add(STEP.saturating_mul(s.transcript_display.steps(key)));
    let (shown, _, _, _) = prefix_measured(&[source], budget, units(source));
    markdown::prose_has_match(&shown, query)
}

pub(super) fn skill_prose_matches(
    s: &State,
    card_key: &str,
    key: &str,
    source: &str,
    query: rune_theme_codenomad::timeline::search::Query<'_>,
) -> bool {
    let revealed = query.active || s.transcript_display.search_revealed(card_key);
    let limit = PROSE_LIMIT + if revealed { STEP } else { 0 };
    bounded_prose_matches(s, key, source, limit, query)
}

pub(super) fn prose(s: &State, message: &str, key: String, source: &str, streaming: bool) -> El {
    prose_for(s, message, key, source, streaming, PROSE_LIMIT, None)
}

pub(super) fn prose_search(
    s: &State,
    message: &str,
    card_key: &str,
    key: String,
    source: &str,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> El {
    prose_pane_search(s, message, card_key, key, source, false, PROSE_LIMIT, query)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prose_pane_search(
    s: &State,
    message: &str,
    card_key: &str,
    key: String,
    source: &str,
    streaming: bool,
    base_limit: usize,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> El {
    let revealed =
        query.is_some_and(|q| q.active) || s.transcript_display.search_revealed(card_key);
    let limit = base_limit + if revealed { STEP } else { 0 };
    prose_for(s, message, key, source, streaming, limit, query)
}

pub(super) fn bounded_prose_matches_for(
    s: &State,
    card_key: &str,
    key: &str,
    source: &str,
    base_limit: usize,
    query: rune_theme_codenomad::timeline::search::Query<'_>,
) -> bool {
    let revealed = query.active || s.transcript_display.search_revealed(card_key);
    let limit = base_limit + if revealed { STEP } else { 0 };
    bounded_prose_matches(s, key, source, limit, query)
}

pub(super) fn prose_at(s: &State, key: String, source: &str, streaming: bool, limit: usize) -> El {
    prose_for(s, "", key, source, streaming, limit, None)
}

fn prose_for(
    s: &State,
    message: &str,
    key: String,
    source: &str,
    streaming: bool,
    limit: usize,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> El {
    let group = key.clone();
    let scope = s.input_scope.clone();
    let link_scope = scope.clone();
    let unwrapped = s.transcript_display.unwrapped(&key);
    let diagram_sources = s.transcript_display.diagram_sources(&key);
    let steps = s.transcript_display.steps(&key);
    let version = s.transcript_display.stream_version();
    let memo_key = format!("{group}-markdown");
    let query = query.or_else(|| {
        s.transcript_display
            .search_highlight
            .as_ref()
            .filter(|hit| hit.message == message)
            .map(|hit| hit.query(None))
    });
    window(s, key, &[source], limit, |shown, units| {
        let claim_active =
            query.is_some_and(|q| q.active && q.claimed.is_none_or(|claimed| !claimed.get()));
        let prose_query = query.map(|q| rune_theme_codenomad::timeline::search::Query {
            active: claim_active,
            claimed: None,
            ..q
        });
        let active_locale = locale();
        let search_id = prose_query
            .filter(|q| q.active)
            .and_then(|_| {
                s.transcript_display
                    .search_highlight
                    .as_ref()
                    .filter(|hit| hit.message == message)
                    .map(|hit| hit.id)
            })
            .unwrap_or(0);
        let search_overrides = s
            .transcript_display
            .diagram_search_overrides(search_id, &group);
        let stamp = (
            version,
            steps,
            std::rc::Rc::as_ptr(&scope) as usize,
            active_locale,
            layout::dark(),
            &unwrapped,
            prose_query.map(|q| (q.terms, q.ranked, q.active)),
            &diagram_sources,
            &search_overrides,
            (!streaming).then_some(shown),
        );
        let build = || {
            let diagram_sources = diagram_sources.clone();
            let search_overrides = search_overrides.clone();
            let search_terms = prose_query
                .filter(|q| q.active)
                .map(|q| (q.terms.to_vec(), q.ranked));
            markdown::prose(
                shown,
                streaming,
                units
                    <= if streaming {
                        TOOL_LIMIT
                    } else {
                        HIGHLIGHT_LIMIT
                    },
                prose_query,
                links::on_open(link_scope.clone()),
                links::on_menu(link_scope, active_locale),
                links::help,
                {
                    let unwrapped = unwrapped.clone();
                    move |index, _| !unwrapped.contains(&index)
                },
                move |card, frame| {
                    let index = frame.index;
                    let group = group.clone();
                    let diagram = frame
                        .language
                        .is_some_and(|language| language.eq_ignore_ascii_case("mmd"));
                    let copy = markdown::copy_button(
                        t("markdown.codeBlock.copy.label"),
                        screen::action_tx(&scope, {
                            let source = frame.source.to_owned();
                            move |_, tx| tx.copy(source.as_str())
                        }),
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
                    if diagram {
                        let search_hit = search_terms.as_ref().is_some_and(|(terms, ranked)| {
                            rune_theme_codenomad::timeline::search::Query {
                                terms,
                                ranked: *ranked,
                                active: true,
                                claimed: None,
                            }
                            .matches(frame.source)
                        });
                        let source_only = if search_hit {
                            search_overrides.get(&index).copied().unwrap_or(true)
                        } else {
                            diagram_sources.contains(&index)
                        };
                        return mermaid::frame(
                            frame.open || streaming,
                            source_only,
                            frame.source,
                            format!("{group}-code-{index}"),
                            screen::action(&scope, move |s| {
                                if search_hit {
                                    Display::set_diagram_search_override(
                                        s,
                                        search_id,
                                        &group,
                                        index,
                                        !source_only,
                                    );
                                } else {
                                    Display::toggle_diagram_source(s, &group, index);
                                }
                            }),
                            card,
                            wrap,
                            copy,
                        );
                    }
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
        if units > TOOL_LIMIT {
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
