use super::{super::directory::Panel, BodyKey, BodyStatus, MAX_WHOLE_BODY_UNITS, view::Scoped};
use crate::strings::{locale, t};
use codenomad_client::missions::{
    ContentSelector, READER_PAGE_SIZE, TaskStatus, body_covers, markdown_page, page_count,
    utf16_len,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout},
    markdown,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn json_list_section<S: 'static>(
    panel: &Panel,
    scoped: &Scoped<S>,
    section_id: &str,
    label_key: &str,
    project_id: &str,
    mission_id: &str,
    selector: ContentSelector,
) -> El {
    let view = panel.reader.body_view(project_id, mission_id, &selector);
    let key = (project_id.to_owned(), mission_id.to_owned(), selector);
    if let Some(loaded) = view.body
        && loaded.utf16_len >= loaded.characters
    {
        let parsed = serde_json::from_str::<Vec<String>>(&loaded.text);
        if let Ok(items) = &parsed
            && items.is_empty()
        {
            if view.status == BodyStatus::Error {
                return col()
                    .full_width()
                    .separate(Space::Xs)
                    .key(format!("mission-reader-section-{section_id}"))
                    .child(text(t(label_key)).role("heading"))
                    .child(body_status_note(BodyStatus::Error, key, section_id, scoped));
            }
            return rune::el();
        }
        let joined = parsed
            .map(|items| items.join("\n\n"))
            .unwrap_or_else(|_| loaded.text.clone());
        let mut section = local_section(panel, scoped, section_id, label_key, &joined, false, true);
        if view.status == BodyStatus::Error {
            section = section.child(body_status_note(BodyStatus::Error, key, section_id, scoped));
        }
        return section;
    }
    col()
        .full_width()
        .separate(Space::Xs)
        .key(format!("mission-reader-section-{section_id}"))
        .child(text(t(label_key)).role("heading"))
        .child(body_status_note(view.status, key, section_id, scoped))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn remote_section<S: 'static>(
    panel: &Panel,
    scoped: &Scoped<S>,
    section_id: &str,
    label_key: &str,
    project_id: &str,
    mission_id: &str,
    selector: ContentSelector,
    raw: bool,
) -> El {
    let view = panel.reader.body_view(project_id, mission_id, &selector);
    let key = (project_id.to_owned(), mission_id.to_owned(), selector);
    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .key(format!("mission-reader-section-{section_id}"))
        .child(text(t(label_key)).role("heading"));

    let mut rendered_page = false;
    if let Some(loaded) = view.body {
        let total = page_count(loaded.characters, READER_PAGE_SIZE);
        let page = panel.reader.page(section_id).min(total.saturating_sub(1));
        let copy_owner = scoped.clone();
        let copy_key = key.clone();
        let copy_digest = loaded.digest.clone();
        let copy_chars = loaded.characters;
        let can_copy = copy_chars <= MAX_WHOLE_BODY_UNITS;
        section = section.child(section_toolbar(
            scoped,
            section_id,
            page,
            total,
            can_copy,
            move |s: &mut S, tx: &mut Tx| {
                if let Some(p) = copy_owner.get(s) {
                    if let Some(text) = p.reader.request_copy(
                        copy_key.clone(),
                        Some(copy_digest.clone()),
                        copy_chars,
                    ) {
                        tx.copy(text);
                    } else {
                        p.wake();
                    }
                }
            },
        ));
        if body_covers(&loaded.text, loaded.characters, page, READER_PAGE_SIZE)
            && let Some(content) = markdown_page(&loaded.text, page, READER_PAGE_SIZE)
        {
            section = section.child(render_page::<S>(
                &content.source_text,
                content.markdown_text.as_deref(),
                raw,
            ));
            rendered_page = true;
        }
    }

    if view.status == BodyStatus::Error {
        section = section.child(body_status_note(BodyStatus::Error, key, section_id, scoped));
    } else if view.status == BodyStatus::Missing {
        section = section.child(theme::note(t("missions.control.reader.missing"), "status"));
    } else if !rendered_page {
        section = section.child(theme::note(t("missions.control.reader.loading"), "status"));
    }
    section
}

pub(super) fn local_section<S: 'static>(
    panel: &Panel,
    scoped: &Scoped<S>,
    section_id: &str,
    label_key: &str,
    source: &str,
    raw: bool,
    can_copy: bool,
) -> El {
    let characters = utf16_len(source) as u64;
    let total = page_count(characters, READER_PAGE_SIZE);
    let page = panel.reader.page(section_id).min(total.saturating_sub(1));
    let copy_text = source.to_owned();
    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .key(format!("mission-reader-section-{section_id}"))
        .child(text(t(label_key)).role("heading"))
        .child(section_toolbar(
            scoped,
            section_id,
            page,
            total,
            can_copy,
            move |_: &mut S, tx: &mut Tx| tx.copy(copy_text.as_str()),
        ));
    if let Some(content) = markdown_page(source, page, READER_PAGE_SIZE) {
        section = section.child(render_page::<S>(
            &content.source_text,
            content.markdown_text.as_deref(),
            raw,
        ));
    }
    section
}

fn section_toolbar<S: 'static>(
    scoped: &Scoped<S>,
    section_id: &str,
    page: usize,
    total: usize,
    can_copy: bool,
    on_copy: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let mut bar = layout::action_row();
    if total > 1 {
        let prev_owner = scoped.clone();
        let prev_id = section_id.to_owned();
        let next_owner = scoped.clone();
        let next_id = section_id.to_owned();
        let page_text = catalogue::format(
            locale(),
            "toolCall.permission.diff.page",
            &[
                ("page", &(page + 1).to_string()),
                ("total", &total.to_string()),
            ],
        );
        bar = bar
            .child(
                layout::button(
                    t("missionsPanel.pages.previous"),
                    page == 0,
                    move |s: &mut S| {
                        if let Some(p) = prev_owner.get(s) {
                            p.reader.set_page(&prev_id, page.saturating_sub(1));
                            p.wake();
                        }
                    },
                )
                .key(format!("mission-reader-prev-{section_id}")),
            )
            .child(text(page_text).text_role(TextRole::Small))
            .child(
                layout::button(
                    t("missionsPanel.pages.next"),
                    page + 1 >= total,
                    move |s: &mut S| {
                        if let Some(p) = next_owner.get(s) {
                            p.reader.set_page(&next_id, (page + 1).min(total - 1));
                            p.wake();
                        }
                    },
                )
                .key(format!("mission-reader-next-{section_id}")),
            );
    }
    if can_copy {
        bar = bar.child(
            markdown::copy_button(t("messageItem.actions.copy"), on_copy)
                .key(format!("mission-reader-copy-{section_id}")),
        );
    }
    bar
}

fn render_page<S: 'static>(source_text: &str, markdown_text: Option<&str>, raw: bool) -> El {
    if raw {
        return markdown::code(source_text, "json", true, true);
    }
    let Some(md) = markdown_text else {
        return markdown::code(source_text, "text", false, true);
    };
    markdown::prose::<S>(
        md,
        false,
        false,
        true,
        None,
        |_, href, tx| crate::chat::open_external(href, tx),
        |_, _, _, _| {},
        |_| None,
        |_, _| true,
        |card, frame| {
            let source = frame.source.to_owned();
            let copy = markdown::copy_button(
                t("markdown.codeBlock.copy.label"),
                move |_: &mut S, tx: &mut Tx| tx.copy(source.as_str()),
            );
            let mut header = layout::action_row();
            if let Some(language) = frame.language {
                header = header.child(text(language));
            }
            col().full_width().child(header.child(copy)).child(card)
        },
        |card, frame| {
            let source = frame.source.to_owned();
            let copy = markdown::copy_button(
                t("markdown.codeBlock.copy.label"),
                move |_: &mut S, tx: &mut Tx| tx.copy(source.as_str()),
            );
            col()
                .full_width()
                .child(
                    layout::action_row()
                        .child(text(t("toolCall.diff.label")))
                        .child(copy),
                )
                .child(card)
        },
    )
}

pub(super) fn body_status_note<S: 'static>(
    status: BodyStatus,
    key: BodyKey,
    section_id: &str,
    scoped: &Scoped<S>,
) -> El {
    match status {
        BodyStatus::Loading | BodyStatus::Ready => {
            theme::note(t("missions.control.reader.loading"), "status")
        }
        BodyStatus::Missing => theme::note(t("missions.control.reader.missing"), "status"),
        BodyStatus::Error => {
            let owner = scoped.clone();
            col()
                .full_width()
                .separate(Space::Xs)
                .child(theme::note(
                    t("missions.control.reader.unavailable"),
                    "alert",
                ))
                .child(
                    layout::button(t("missionsPanel.reader.retry"), false, move |s: &mut S| {
                        if let Some(p) = owner.get(s) {
                            p.reader.retry(&key);
                            p.wake();
                        }
                    })
                    .key(format!("mission-reader-body-retry-{section_id}")),
                )
        }
    }
}

pub(super) fn task_status_label(status: TaskStatus) -> &'static str {
    t(match status {
        TaskStatus::Blocked => "missions.control.task.status.blocked",
        TaskStatus::Ready => "missions.control.task.status.ready",
        TaskStatus::Dispatching => "missions.control.task.status.dispatching",
        TaskStatus::Queued => "missions.control.task.status.queued",
        TaskStatus::Completed => "missions.control.task.status.completed",
        TaskStatus::NeedsInput => "missions.control.task.status.needs-input",
        TaskStatus::Failed => "missions.control.task.status.failed",
        TaskStatus::Withdrawn => "missions.control.task.status.superseded",
    })
}
