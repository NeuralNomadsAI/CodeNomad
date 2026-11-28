use super::{actions::Display, document};
use crate::{
    State,
    content::{Reasoning, TextProvenance},
    screen,
    settings::TranscriptRow,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
    timeline::search::Query,
};

#[cfg(test)]
mod tests;

pub(crate) fn block_key(message: &str, ordinal: usize) -> String {
    format!("reasoning-{message}:{ordinal}")
}

pub(super) fn duration_ms(part: &Reasoning) -> u64 {
    part.created
        .zip(part.completed)
        .and_then(|(start, end)| end.checked_sub(start))
        .unwrap_or(0)
}

pub(super) struct Summary<'a> {
    pub title: Option<&'a str>,
    pub body: &'a str,
    stripped_units: usize,
}

fn strip_blank_line(rest: &str) -> Option<&str> {
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))?;
    rest.strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
}

fn bounded_prefix(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > max_units {
            return &text[..index];
        }
        units = next;
    }
    text
}

pub(super) fn parse_summary(text: &str) -> Summary<'_> {
    let leading = text.len() - text.trim_start().len();
    let content = text.trim();
    let trailing_start = leading + content.len();
    let trim_units =
        text[..leading].encode_utf16().count() + text[trailing_start..].encode_utf16().count();
    if let Some(source) = content.strip_prefix("**")
        && let Some((title, rest)) = source.split_once("**")
    {
        let trimmed = title.trim();
        let body = if rest.is_empty() {
            Some("")
        } else {
            strip_blank_line(rest).map(str::trim_end)
        };
        if !trimmed.is_empty()
            && !title.contains(['*', '\n', '\r'])
            && let Some(body) = body
        {
            let prefix_len = content.len() - body.len();
            let stripped_units = trim_units + content[..prefix_len].encode_utf16().count();
            return Summary {
                title: Some(trimmed),
                body,
                stripped_units,
            };
        }
    }
    Summary {
        title: None,
        body: content,
        stripped_units: trim_units,
    }
}

pub(super) fn extract_title(text: &str) -> Option<String> {
    parse_summary(text)
        .title
        .map(|title| bounded_prefix(title, document::TOOL_LIMIT).to_owned())
}

fn body_totals(part: &Reasoning, summary: &Summary<'_>) -> (usize, usize) {
    (
        part.retained_units.saturating_sub(summary.stripped_units),
        part.units.saturating_sub(summary.stripped_units),
    )
}

pub(super) struct GroupView<'a> {
    pub key: &'a str,
    pub keys: &'a [String],
    pub count: usize,
    pub duration_ms: u64,
    pub title: Option<&'a str>,
    pub completed: bool,
    pub message_completed: bool,
    pub expanded: bool,
    pub search_id: Option<u64>,
    pub first: bool,
}

/// Resolve a rail run to the first displayed fragment of its visible segment.
pub(crate) fn run_anchor(
    message: &crate::Message,
    omitted: std::ops::Range<usize>,
    run: usize,
    continuation: bool,
) -> Option<String> {
    use crate::content::Part;
    let mut next = 0;
    let mut current = None;
    let mut emitted = false;
    for (index, part) in message.parts.iter().enumerate() {
        match part {
            Part::Reasoning(part) if part.visible() => {
                let ordinal = *current.get_or_insert_with(|| {
                    let ordinal = next;
                    next += 1;
                    emitted = false;
                    ordinal
                });
                if ordinal == run && !omitted.contains(&index) {
                    let resumed = emitted && index >= omitted.end && !omitted.is_empty();
                    if (!emitted || resumed) && continuation == resumed {
                        return Some(block_key(&message.id, part.ordinal));
                    }
                    emitted = true;
                }
            }
            Part::Reasoning(_) => {}
            Part::Text(text) if text.text.trim().is_empty() => {}
            _ => current = None,
        }
    }
    None
}

pub(super) fn view_chunk<'a>(
    s: &State,
    message: &'a str,
    parts: &[crate::content::Part],
    start: usize,
    group: GroupView<'_>,
    marker: &mut impl FnMut(Option<usize>) -> Option<codenomad_client::timeline::Marker<'a>>,
) -> Option<El> {
    if !super::anchors::reasoning_visible(s) {
        return None;
    }
    if !group.first && !group.expanded {
        return None;
    }
    let mut first_marker = marker(Some(start));
    if group.count == 1 {
        let part = parts.iter().find_map(|part| match part {
            crate::content::Part::Reasoning(part) if part.visible() => Some(part),
            _ => None,
        })?;
        let fragment = block_key(message, part.ordinal);
        let toggle_keys = group.keys.to_vec();
        let expanded = group.expanded;
        let search_id = group.search_id;
        let card = reasoning_card(
            s,
            message,
            &fragment,
            part,
            group.message_completed,
            format!("toggle-{fragment}"),
            None,
            expanded,
            move |s| {
                if let Some(id) = search_id {
                    Display::set_group_search_collapsed(s, id, &toggle_keys, expanded);
                } else {
                    Display::set_group_expanded(s, &toggle_keys, !expanded);
                }
            },
        );
        return Some(super::reading::passage(
            s,
            card,
            message,
            fragment,
            Some(TranscriptRow::Thinking),
            first_marker.take(),
        ));
    }
    if !group.first {
        let mut container = col().full_width().separate(Space::Sm);
        let mut any = false;
        for (offset, part) in parts.iter().enumerate() {
            let crate::content::Part::Reasoning(part) = part else {
                continue;
            };
            if !part.visible() {
                continue;
            }
            let block_marker = if !any {
                first_marker.take()
            } else {
                marker(Some(start + offset))
            };
            any = true;
            let fragment = block_key(message, part.ordinal);
            let card = sub_card(s, message, &fragment, part, group.message_completed);
            container = container.child(super::reading::passage(
                s,
                card,
                message,
                fragment,
                Some(TranscriptRow::Thinking),
                block_marker,
            ));
        }
        return any.then_some(container);
    }
    let base = t(if group.completed {
        "messageBlock.reasoning.thoughtLabel"
    } else {
        "messageBlock.reasoning.thinkingLabel"
    });
    let title = group
        .title
        .unwrap_or_else(|| t("messageBlock.reasoning.thoughtsFallback"));
    let steps = catalogue::format(
        locale(),
        "messageBlock.reasoning.steps.other",
        &[("count", &group.count.to_string())],
    );
    let duration = super::tools::duration::caption(group.duration_ms, false);
    let toggle = group.keys.to_vec();
    let expanded = group.expanded;
    let search_id = group.search_id;
    let header = layout::action_row()
        .child(
            layout::button(
                base,
                false,
                screen::action(&s.input_scope, move |s| {
                    if let Some(id) = search_id {
                        Display::set_group_search_collapsed(s, id, &toggle, expanded);
                    } else {
                        Display::set_group_expanded(s, &toggle, !expanded);
                    }
                }),
            )
            .key(format!("toggle-{}", group.key))
            .expanded(expanded),
        )
        .child(text(title))
        .child(text(steps))
        .children(duration.map(text));
    let mut container = col().full_width().separate(Space::Sm).child(header);
    if expanded {
        let mut is_first_visible = true;
        for (offset, part) in parts.iter().enumerate() {
            let crate::content::Part::Reasoning(part) = part else {
                continue;
            };
            if !part.visible() {
                continue;
            }
            let fragment = block_key(message, part.ordinal);
            let card = sub_card(s, message, &fragment, part, group.message_completed);
            if is_first_visible {
                is_first_visible = false;
                container = container.child(card);
            } else {
                container = container.child(super::reading::passage(
                    s,
                    card,
                    message,
                    fragment,
                    Some(TranscriptRow::Thinking),
                    marker(Some(start + offset)),
                ));
            }
        }
    }
    Some(super::reading::passage(
        s,
        container,
        message,
        group.key.to_owned(),
        Some(TranscriptRow::Thinking),
        first_marker.take(),
    ))
}

fn sub_card(
    s: &State,
    message: &str,
    fragment: &str,
    part: &Reasoning,
    message_completed: bool,
) -> El {
    let card_key = format!("card-{fragment}");
    let query = super::search_hit::query(
        s,
        message,
        codenomad_client::search::Kind::Reasoning,
        part.part_index,
    );
    let search_id = query.filter(|q| q.active).and_then(|_| {
        s.transcript_display
            .search_highlight
            .as_ref()
            .map(|hit| hit.id)
    });
    let expanded = if let Some(id) = search_id {
        s.transcript_display
            .card_search_expanded(id, &card_key, true)
    } else {
        s.transcript_display.expanded(&card_key, true)
    };
    let toggle_state = card_key.clone();
    reasoning_card(
        s,
        message,
        fragment,
        part,
        message_completed,
        format!("toggle-card-{fragment}"),
        Some(card_key),
        expanded,
        move |s| {
            if let Some(id) = search_id {
                Display::set_card_search_expanded(s, id, &toggle_state, !expanded);
            } else {
                Display::set_expanded(s, &toggle_state, !expanded);
            }
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn reasoning_card(
    s: &State,
    message: &str,
    fragment: &str,
    part: &Reasoning,
    message_completed: bool,
    toggle_key: String,
    card_key: Option<String>,
    expanded: bool,
    toggle: impl Fn(&mut State) + 'static,
) -> El {
    let claimed = std::cell::Cell::new(false);
    let query = super::search_hit::query(
        s,
        message,
        codenomad_client::search::Kind::Reasoning,
        part.part_index,
    )
    .map(|q| Query {
        claimed: Some(&claimed),
        ..q
    });
    let summary = parse_summary(&part.text);
    let (retained, total) = body_totals(part, &summary);
    let has_body = !summary.body.is_empty() || total > retained;
    let open = has_body && expanded;
    let title_el = match summary.title {
        Some(title) => {
            let shown = bounded_prefix(title, document::search_limit_for(s, fragment, query));
            rune_theme_codenomad::timeline::search::ink(text(shown), shown, query)
        }
        None => text(t("messageBlock.reasoning.thoughtsFallback")),
    };
    let timing = part
        .created
        .map(|start| (start, part.completed))
        .filter(|(_, end)| {
            end.is_some() || (!message_completed && s.phase == crate::Phase::Streaming)
        });
    let meta = super::tools::duration::view(s, fragment, timing, title_el);
    let header = layout::action_row()
        .child(
            layout::button(
                t("messageBlock.reasoning.thinkingLabel"),
                !has_body,
                screen::action(&s.input_scope, move |s| {
                    if has_body {
                        toggle(s);
                    }
                }),
            )
            .key(toggle_key)
            .expanded(open),
        )
        .child(meta);
    let card = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header)
        .children(open.then(|| {
            body(
                s,
                message,
                fragment,
                part,
                summary.body,
                (retained, total),
                query,
            )
        }));
    match card_key {
        Some(key) => card.key(key),
        None => card,
    }
}

fn body(
    s: &State,
    message: &str,
    key: &str,
    part: &Reasoning,
    body_text: &str,
    totals: (usize, usize),
    query: Option<Query<'_>>,
) -> El {
    crate::chat::reading::inner_scroller(
        markdown::tool_pane(
            document::window_with_total(
                s,
                format!("{key}-body"),
                &[body_text],
                document::search_limit_for(s, key, query),
                Some(totals),
                |shown, units| {
                    let build = || {
                        rune_theme_codenomad::timeline::search::ink(text(shown), shown, query)
                            .full_width()
                            .wrap()
                            .content_direction()
                            .selectable(true)
                    };
                    if part.provenance != TextProvenance::Closed && units > document::TOOL_LIMIT {
                        markdown::hold_frame(
                            format!("{key}-stream"),
                            (
                                s.transcript_display.stream_version(),
                                s.transcript_display.steps(&format!("{key}-body")),
                                std::rc::Rc::as_ptr(&s.input_scope) as usize,
                                query.is_some_and(|q| q.claimed.is_some_and(|c| c.get())),
                                s.transcript_display
                                    .search_highlight
                                    .as_ref()
                                    .filter(|hit| hit.message == message),
                            ),
                            build,
                        )
                    } else {
                        build()
                    }
                },
            ),
            false,
        ),
        false,
    )
}
