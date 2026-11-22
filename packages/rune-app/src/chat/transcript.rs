use super::{actions::Display, document, tools};
use crate::{
    State,
    content::{Part, TextProvenance},
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
};

const PART_LIMIT: usize = 1000;

pub fn message(s: &State, i: usize) -> El {
    let m = &s.messages[i];
    let mut view = col()
        .key(m.id.clone())
        .full_width()
        .pad(Space::Lg)
        .separate(Space::Sm)
        .child(
            text(t(if m.role == "user" {
                "messageItem.speaker.you"
            } else {
                "messageItem.speaker.assistant"
            }))
            .text_role(TextRole::Label),
        );
    let mut ordinal = 0;
    if m.parts.is_empty() && !m.body.is_empty() {
        view = view.child(document::prose(s, format!("body-{}", m.id), &m.body, false));
    }
    let gap_key = format!("parts-gap-{}", m.id);
    let initial = if m.parts.len() > PART_LIMIT {
        PART_LIMIT / 2
    } else {
        m.parts.len()
    };
    let tail = m.parts.len().saturating_sub(PART_LIMIT / 2);
    let head = initial.saturating_add(
        s.transcript_display
            .steps(&gap_key)
            .saturating_mul(PART_LIMIT),
    );
    for (index, part) in m.parts.iter().enumerate() {
        if index == head && head < tail {
            let hidden = tail - head;
            let notice = catalogue::format(
                locale(),
                if hidden == 1 {
                    "messageBlock.hiddenParts.one"
                } else {
                    "messageBlock.hiddenParts.other"
                },
                &[("count", &hidden.to_string())],
            );
            let label = catalogue::format(
                locale(),
                "messageBlock.hiddenParts.show",
                &[("count", &hidden.min(PART_LIMIT).to_string())],
            );
            let key = gap_key.clone();
            view = view.child(
                layout::action_row()
                    .key(gap_key.clone())
                    .child(text(notice))
                    .child(
                        layout::button_tx(
                            &label,
                            false,
                            screen::action_tx(&s.input_scope, move |s, tx| {
                                tx.scroll_key_to(format!("{key}-start"), 0.0);
                                Display::reveal_next(s, &key);
                            }),
                        )
                        .key(format!("reveal-{gap_key}")),
                    ),
            );
        }
        let visible = index < head || index >= tail;
        if index == head.saturating_sub(PART_LIMIT) && head > initial {
            view = view.child(rune::el().key(format!("{gap_key}-start")));
        }
        match part {
            Part::Text(body) => {
                let key = format!("body-{}-{ordinal}", m.id);
                ordinal += 1;
                if visible && !body.text.trim().is_empty() {
                    view = view.child(document::prose(
                        s,
                        key,
                        &body.text,
                        !m.completed && body.provenance != TextProvenance::Closed,
                    ));
                }
            }
            Part::Tool(tool) if visible => view = view.child(tools::view(s, &m.id, tool)),
            Part::Tool(_) => {}
        }
    }
    view
}
