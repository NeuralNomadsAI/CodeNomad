use crate::{
    Space,
    layout::{self, Layout},
    tokens,
};
use rune::{El, ScrollSpec};

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
            if ranges.len() == 512 {
                break;
            }
        }
        at = end;
    }
    ranges
}

pub fn excerpt(text: &str, terms: &[String]) -> El {
    let t = tokens(layout::dark());
    rune::text(text).wrap().text_highlights(
        ranges(text, terms)
            .into_iter()
            .map(|range| rune::TextHighlight::new(range, t.color("selection-neutral-strong-bg"))),
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
