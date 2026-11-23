use crate::{
    Space,
    layout::{self, Layout},
    tokens,
};
use rune::{El, ScrollSpec};
use std::ops::Range;

#[derive(Clone, Copy)]
pub struct Query<'a> {
    pub terms: &'a [String],
    pub ranked: bool,
    pub active: bool,
    pub claimed: Option<&'a std::cell::Cell<bool>>,
}

impl Query<'_> {
    pub fn matches(self, text: &str) -> bool {
        !self.ranges(text, 1).is_empty()
    }

    fn ranges(self, text: &str, limit: usize) -> Vec<Range<usize>> {
        if self.ranked {
            return ranked_ranges(text, self.terms, limit);
        }
        let Some(phrase) = self.terms.first().filter(|term| !term.is_empty()) else {
            return Vec::new();
        };
        let needle = phrase.to_lowercase();
        if text.is_ascii() {
            return text
                .to_ascii_lowercase()
                .match_indices(&needle)
                .take(limit)
                .map(|(start, _)| start..start + needle.len())
                .collect();
        }
        let folded = text.to_lowercase();
        // Map expanding folds back to whole original UTF-8 characters.
        let mut offsets = text
            .char_indices()
            .scan(0, |at, (source, ch)| {
                let start = *at;
                *at += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
                Some((start, *at, source, source + ch.len_utf8()))
            })
            .peekable();
        folded
            .match_indices(&needle)
            .take(limit)
            .filter_map(|(start, _)| {
                let mut first = None;
                let mut last = None;
                while let Some(&(from, to, left, right)) = offsets.peek() {
                    if from >= start + needle.len() {
                        break;
                    }
                    if to > start {
                        first.get_or_insert(left);
                        last = Some(right);
                        if to >= start + needle.len() {
                            break;
                        }
                    }
                    offsets.next();
                }
                Some(first?..last?)
            })
            .collect()
    }
}

/// Paint only the text given by the renderer, after clipping and ANSI decoding.
pub fn ink(el: El, text: &str, query: Option<Query<'_>>) -> El {
    let Some(query) = query else {
        return el;
    };
    let t = tokens(layout::dark());
    el.text_highlights(
        query
            .ranges(text, 512)
            .into_iter()
            .enumerate()
            .map(|(i, range)| {
                if query.active
                    && i == 0
                    && query.claimed.is_none_or(|claimed| !claimed.replace(true))
                {
                    rune::TextHighlight::new(range, t.color("transcript-search-active"))
                        .radius(0.0)
                        .color(t.color("transcript-search-active-ink"))
                        .key("history-search-match")
                } else {
                    rune::TextHighlight::new(range, t.color("transcript-search-mark")).radius(0.0)
                }
            }),
    )
}

pub fn terms(query: &str) -> Vec<String> {
    let mut words: Vec<_> = query
        .split(|ch: char| !word(ch))
        .filter(|part| part.chars().count() > 1)
        .collect();
    words.sort_by_key(|part| std::cmp::Reverse(part.encode_utf16().count()));
    let mut unique = Vec::<String>::new();
    for part in words {
        if !unique
            .iter()
            .any(|old| old.chars().map(fold).eq(part.chars().map(fold)))
        {
            unique.push(part.into());
            if unique.len() == 6 {
                break;
            }
        }
    }
    unique
}

fn fold(ch: char) -> char {
    match ch {
        '\u{17f}' => 's',
        'ς' => 'σ',
        '\u{130}' => '\u{130}',
        _ => ch.to_lowercase().next().unwrap_or(ch),
    }
}
fn word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

pub(crate) fn ranges(text: &str, terms: &[String]) -> Vec<std::ops::Range<usize>> {
    ranked_ranges(text, terms, 512)
}

fn ranked_ranges(text: &str, terms: &[String], limit: usize) -> Vec<Range<usize>> {
    if terms.is_empty() {
        return Vec::new();
    }
    fn end_of_word(text: &str, at: usize) -> usize {
        text[at..]
            .find(|ch: char| !word(ch))
            .map_or(text.len(), |n| at + n)
    }
    let mut ranges = Vec::new();
    let mut at = 0;
    while let Some(next) = text[at..].find(word) {
        at += next;
        let end = end_of_word(text, at);
        if terms
            .iter()
            .any(|term| term.chars().map(fold).eq(text[at..end].chars().map(fold)))
        {
            ranges.push(at..end);
            if ranges.len() == limit {
                break;
            }
        }
        at = end;
    }
    ranges
}

pub fn excerpt(text: &str, terms: &[String]) -> El {
    ink(
        rune::text(text).wrap(),
        text,
        Some(Query {
            terms,
            ranked: true,
            active: false,
            claimed: None,
        }),
    )
}

pub fn result_button(text: &str, terms: &[String], selected: bool) -> El {
    let t = tokens(layout::dark());
    rune::row()
        .w_full()
        .pad(Space::Sm)
        .hover(t.color("surface-hover-overlay"))
        .fill(if selected {
            t.color("surface-hover-overlay")
        } else {
            rune::Color::TRANSPARENT
        })
        .role("button")
        .focusable(true)
        .label(text)
        .child(excerpt(text, terms).a11y_hidden())
}

pub fn panel() -> El {
    let t = tokens(layout::dark());
    // Solid message-section.css:295–304 uses a centred surface capped at 38rem.
    rune::col()
        .w_full()
        .max_w(38.0 * t.number("font-size-base").px())
        .pad(Space::Sm)
        .separate(Space::Sm)
        .fill(t.color("surface-overlay"))
        .border(1.0, t.color("border-base"))
}

pub fn floating(panel: El) -> El {
    let inset = tokens(layout::dark()).space(Space::Md).px();
    rune::col()
        .pin(Some(inset), Some(inset), Some(inset), None)
        .items_center()
        .child(panel)
}

pub fn toggle<S: 'static>(label: &str, press: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    rune_kit::IconButton::new(&crate::shell::icons::SEARCH)
        .label(label)
        .help(label)
        .on_press_tx(press)
        .build(crate::kit(layout::dark()))
}

pub fn results() -> El {
    rune::col()
        .w_full()
        .max_h(18.0 * tokens(layout::dark()).number("font-size-base").px())
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
}

#[cfg(test)]
#[test]
fn unicode_terms_highlight_complete_words_without_rewriting_the_excerpt() {
    let terms = terms("ÉTÉ été Français İstanbul İSTANBUL");
    assert_eq!(terms, ["Français", "İstanbul", "ÉTÉ"]);
    let text = "été, sureté, FRANÇAIS et İstanbul; Istanbul";
    assert_eq!(
        ranges(text, &terms)
            .into_iter()
            .map(|r| &text[r])
            .collect::<Vec<_>>(),
        ["été", "FRANÇAIS", "İstanbul"]
    );
}
