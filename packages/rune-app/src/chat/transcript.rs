use super::{actions::Display, document, tool_groups::Groups, tools};
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

pub(super) const PART_LIMIT: usize = 1000;

mod context;
#[cfg(test)]
mod tests;

#[cfg(feature = "test-support")]
pub(crate) fn load_scene(s: &mut State) {
    let native = serde_json::from_str(include_str!("../../fixtures/transcript.json"))
        .expect("transcript fixture JSON");
    s.messages = vec![
        crate::history::decode_message(&native)
            .expect("transcript fixture record")
            .into(),
    ];
    s.phase = crate::Phase::Ready;
    crate::settings::fixture_transcript(
        s,
        serde_json::from_str(include_str!("../../fixtures/transcript-settings.json"))
            .expect("transcript fixture preferences"),
    );
}

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

#[derive(Clone, Copy)]
enum RowSource {
    Committed(usize),
    Pending(usize),
}

pub fn rows(s: &State) -> El {
    let locale = locale();
    let groups = Groups::project(s);
    let visible = s.transcript_display.messages.visible(&s.messages);
    let pending = if s.history_detached {
        &[][..]
    } else {
        s.transcript_display.queue.items()
    };
    let mut order = Vec::with_capacity(visible.len() + pending.len());
    for index in 0..visible.len() {
        order.push(RowSource::Committed(index));
    }
    for (index, item) in pending.iter().enumerate() {
        if !visible.iter().any(|row| row.id == item.id) {
            order.push(RowSource::Pending(index));
        }
    }
    let keys = std::rc::Rc::new(order);
    let rows = keys.clone();
    layout::transcript_rows(
        keys.len(),
        move |s: &State, i| match keys[i] {
            RowSource::Committed(index) => s.messages[index].id.clone().into(),
            RowSource::Pending(index) => {
                s.transcript_display.queue.items()[index].id.clone().into()
            }
        },
        move |s: &State, i| {
            crate::strings::with_locale(locale, || match rows[i] {
                RowSource::Committed(index) => super::reading::row(
                    s,
                    s.messages[index].id.clone(),
                    message_with_groups(s, index, &groups),
                ),
                RowSource::Pending(index) => {
                    let item = &s.transcript_display.queue.items()[index];
                    super::reading::row(s, item.id.clone(), super::queue::message(s, item))
                }
            })
        },
    )
    .key("rows")
    .virtual_rows_version(s.revision)
}

#[cfg(test)]
pub fn message(s: &State, i: usize) -> El {
    message_with_groups(s, i, &Groups::project(s))
}

fn message_with_groups(s: &State, i: usize, groups: &Groups) -> El {
    let m = &s.messages[i];
    if let Some(context) = context::view(s, m) {
        return context;
    }
    if matches!(m.parts.as_slice(), [Part::SubagentReport(_)]) {
        return col().key(m.id.clone());
    }
    let tracks = crate::timeline::demanded(s);
    let blocks = tracks
        .then(|| super::anchors::blocks(m, super::anchors::steps(s, &m.id), false))
        .unwrap_or_default();
    let mut blocks = blocks.into_iter().peekable();
    let mut marker = |index| {
        while blocks.peek().is_some_and(|block| block.part < index) {
            blocks.next();
        }
        blocks
            .next_if(|block| block.part == index)
            .map(|block| block.marker)
    };
    let header = layout::action_row().child(
        text(t(if m.role == "user" {
            "messageItem.speaker.you"
        } else {
            "messageItem.speaker.assistant"
        }))
        .text_role(TextRole::Label),
    );
    let header = super::message_actions::header(s, m, header);
    let mut view = col()
        .key(m.id.clone())
        .full_width()
        .pad(Space::Lg)
        .separate(Space::Sm)
        .child(header);
    let mut ordinal = 0;
    let text_claimed = std::cell::Cell::new(false);
    if (m.role == "user" || m.parts.is_empty()) && !m.body.is_empty() {
        let key = format!("body-{}", m.id);
        view = view.child(super::reading::passage(
            s,
            document::prose_claimed(
                s,
                &m.id,
                key.clone(),
                &m.body,
                false,
                None,
                Some(&text_claimed),
            ),
            &m.id,
            key,
            None,
            marker(None),
        ));
    }
    let gap_key = format!("parts-gap-{}", m.id);
    let (initial, _) = part_window(m.parts.len(), 0);
    let (head, tail) = part_window(m.parts.len(), s.transcript_display.steps(&gap_key));
    let usage_after = super::usage::last_text(m).filter(|&index| index < head || index >= tail);
    let mut reveal_start = (head > initial).then(|| head.saturating_sub(PART_LIMIT));
    let mut group_end = 0;
    let mut hidden_continuation = false;
    let mut shows_content = m.role == "user" || m.parts.is_empty();
    for (index, part) in m.parts.iter().enumerate() {
        if index == head && head < tail {
            shows_content = true;
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
        if index < group_end {
            ordinal += usize::from(matches!(part, Part::Text(_)));
            continue;
        }
        let body = match part {
            Part::Text(body) => {
                let key = format!("fragment-{}:{ordinal}", m.id);
                ordinal += 1;
                if visible && !body.text.trim().is_empty() {
                    Some(super::reading::passage(
                        s,
                        document::prose_claimed(
                            s,
                            &m.id,
                            key.clone(),
                            &body.text,
                            !m.completed && body.provenance != TextProvenance::Closed,
                            body.part_index,
                            Some(&text_claimed),
                        ),
                        &m.id,
                        key,
                        None,
                        marker(Some(index)),
                    ))
                } else {
                    None
                }
            }
            Part::Tool(tool)
                if visible
                    && (tools::visible(s, &m.id, tool) || groups.awaiting(&m.id, &tool.id)) =>
            {
                match groups.get(i, index) {
                    Some(chunk) => {
                        group_end = chunk.end;
                        let body = chunk.view(
                            s,
                            &m.id,
                            m.completed,
                            &m.parts[index..group_end],
                            index,
                            &mut marker,
                        );
                        hidden_continuation |= body.is_none();
                        body
                    }
                    None => Some(super::reading::passage(
                        s,
                        tools::view(s, &m.id, tool),
                        &m.id,
                        tools::tool_key(&m.id, &tool.id),
                        Some(crate::settings::TranscriptRow::tool(&tool.name)),
                        marker(Some(index)),
                    )),
                }
            }
            Part::Tool(_) => None,
            Part::Reasoning(fragment) if visible && fragment.visible() => {
                match groups.get(i, index) {
                    Some(chunk) => {
                        group_end = chunk.end;
                        let body = chunk.view(
                            s,
                            &m.id,
                            m.completed,
                            &m.parts[index..group_end],
                            index,
                            &mut marker,
                        );
                        hidden_continuation |= body.is_none();
                        body
                    }
                    None => None,
                }
            }
            Part::Reasoning(_) => None,
            Part::SubagentReport(_) => None,
            Part::Skill(skill) if visible => Some(super::attachments::skill_chip(skill)),
            Part::File(file) if visible => Some(super::attachments::file_chip(s, file)),
            Part::Skill(_) | Part::File(_) => None,
        };
        if let Some(body) = body {
            shows_content = true;
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
            if usage_after == Some(index) {
                view = view.children(super::usage::message(s, i, index));
            }
        }
    }
    if hidden_continuation && !shows_content {
        col().key(m.id.clone())
    } else {
        view
    }
}
