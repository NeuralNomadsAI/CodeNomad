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
    markdown,
};

pub(super) const PART_LIMIT: usize = 1000;
pub(super) fn part_window(len: usize, steps: usize) -> (usize, usize) {
    let initial = if len > PART_LIMIT {
        PART_LIMIT / 2
    } else {
        len
    };
    (
        initial.saturating_add(steps.saturating_mul(PART_LIMIT)),
        len.saturating_sub(PART_LIMIT / 2),
    )
}

pub fn rows(s: &State) -> El {
    let locale = locale();
    layout::transcript_rows(
        s.messages.len(),
        |s: &State, i| s.messages[i].id.clone().into(),
        move |s: &State, i| {
            crate::strings::with_locale(locale, || {
                super::reading::row(s, s.messages[i].id.clone(), message(s, i))
            })
        },
    )
    .key("rows")
    .virtual_rows_version(s.revision)
}

pub fn message(s: &State, i: usize) -> El {
    let m = &s.messages[i];
    if matches!(m.parts.as_slice(), [Part::SubagentReport(_)]) {
        return col().key(m.id.clone());
    }
    let tracks = crate::timeline::demanded(s);
    let blocks = tracks
        .then(|| super::anchors::blocks(m, super::anchors::steps(s, &m.id), false))
        .unwrap_or_default();
    let mut blocks = blocks.into_iter().peekable();
    let mut track = |index, element| {
        if blocks.peek().is_some_and(|block| block.part == index) {
            return crate::timeline::watch_block(s, blocks.next().unwrap().marker, element);
        }
        element
    };
    if let Some((key, label)) = super::anchors::context(m) {
        return col()
            .key(m.id.clone())
            .full_width()
            .pad(Space::Lg)
            .child(track(
                None,
                col()
                    .key(key.clone())
                    .full_width()
                    .pad(Space::Sm)
                    .inset_surface()
                    .child(text(t(label)).text_role(TextRole::Label))
                    .children((!m.body.is_empty()).then(|| {
                        document::prose(s, &m.id, format!("{key}-content"), &m.body, false)
                    })),
            ));
    }
    let mut header = layout::action_row().child(
        text(t(if m.role == "user" {
            "messageItem.speaker.you"
        } else {
            "messageItem.speaker.assistant"
        }))
        .text_role(TextRole::Label),
    );
    if !m.body.trim().is_empty() {
        let id = m.id.clone();
        header = header.child(
            markdown::copy_button(
                t("messageItem.actions.copy"),
                screen::action_tx(&s.input_scope, move |s, tx| {
                    let Some(row) = s.messages.iter().find(|row| row.id == id) else {
                        return;
                    };
                    if row.role == "user" || row.parts.is_empty() {
                        tx.copy(row.body.as_str());
                    } else {
                        let prose = row
                            .parts
                            .iter()
                            .filter_map(|part| match part {
                                Part::Text(body) if !body.text.trim().is_empty() => {
                                    Some(body.text.as_str())
                                }
                                _ => None,
                            })
                            .collect::<Vec<_>>();
                        tx.copy(prose.join("\n\n"));
                    }
                }),
            )
            .key(format!("copy-message-{}", m.id)),
        );
    }
    let mut view = col()
        .key(m.id.clone())
        .full_width()
        .pad(Space::Lg)
        .separate(Space::Sm)
        .child(header);
    let mut ordinal = 0;
    if (m.role == "user" || m.parts.is_empty()) && !m.body.is_empty() {
        view = view.child(track(
            None,
            document::prose(s, &m.id, format!("body-{}", m.id), &m.body, false),
        ));
    }
    let gap_key = format!("parts-gap-{}", m.id);
    let initial = if m.parts.len() > PART_LIMIT {
        PART_LIMIT / 2
    } else {
        m.parts.len()
    };
    let (head, tail) = part_window(m.parts.len(), s.transcript_display.steps(&gap_key));
    let mut reveal_start = (head > initial).then(|| head.saturating_sub(PART_LIMIT));
    let mut reasoning_end = 0;
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
                                if tx.by_keys() {
                                    tx.focus(format!("{key}-start"), true);
                                }
                                Display::reveal_next(s, &key);
                            }),
                        )
                        .key(format!("reveal-{gap_key}")),
                    ),
            );
        }
        let visible = index < head || index >= tail;
        let body =
            match part {
                Part::Text(body) => {
                    let key = format!("fragment-{}:{ordinal}", m.id);
                    ordinal += 1;
                    if visible && !body.text.trim().is_empty() {
                        Some(document::prose(
                            s,
                            &m.id,
                            key,
                            &body.text,
                            !m.completed && body.provenance != TextProvenance::Closed,
                        ))
                    } else {
                        None
                    }
                }
                Part::Tool(tool) if visible => Some(tools::view(s, &m.id, tool)),
                Part::Tool(_) => None,
                Part::Reasoning(_) if visible && index >= reasoning_end => {
                    let limit = if index < head && head < tail {
                        head
                    } else {
                        m.parts.len()
                    };
                    reasoning_end = index
                    + m.parts[index..limit]
                        .iter()
                        .take_while(|part| matches!(part, Part::Reasoning(_))
                            || matches!(part, Part::Text(text) if text.text.trim().is_empty()))
                        .count();
                    super::reasoning::view(s, &m.id, &m.parts[index..reasoning_end])
                }
                Part::Reasoning(_) => None,
                Part::SubagentReport(_) => None,
                Part::Skill(skill) if visible => Some(super::attachments::skill_chip(skill)),
                Part::File(file) if visible => Some(super::attachments::file_chip(s, file)),
                Part::Skill(_) | Part::File(_) => None,
            };
        if let Some(body) = body {
            // The first fragment of a reasoning run can be blank: its rendered group starts
            // at the first non-blank fragment, though the renderer consumes the full run.
            let selected = if matches!(part, Part::Reasoning(_)) {
                (index..reasoning_end)
                    .find(|&at| matches!(&m.parts[at], Part::Reasoning(p) if p.visible()))
                    .unwrap_or(index)
            } else {
                index
            };
            let body = track(Some(selected), body);
            if reveal_start.is_some_and(|first| index >= first) {
                view = view.child(
                    col()
                        .key(format!("{gap_key}-start"))
                        .focusable(true)
                        .tab_index(-1)
                        .full_width()
                        .child(body),
                );
                reveal_start = None;
            } else {
                view = view.child(body);
            }
        }
    }
    view
}
