use super::{
    super::{
        detail::Snapshot,
        directory::{Panel, title},
        view::status,
    },
    BodyKey, BodyStatus, ReaderTarget,
};
use crate::{
    components::window_close_button,
    strings::{locale, t},
};
use codenomad_client::missions::{
    BriefingDoc, BriefingItem, ContentSelector, READER_PAGE_SIZE, ReportOutcome, Task, TaskStatus,
    body_covers, markdown_page, page_count, utf16_len,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout, dark},
    markdown,
};
use std::collections::HashSet;

type PanelOwner<S> = fn(&mut S) -> Option<&mut Panel>;

struct Scoped<S> {
    owner: PanelOwner<S>,
    scope: std::rc::Rc<()>,
}

impl<S> Clone for Scoped<S> {
    fn clone(&self) -> Self {
        Self {
            owner: self.owner,
            scope: self.scope.clone(),
        }
    }
}

impl<S> Scoped<S> {
    fn get<'a>(&self, state: &'a mut S) -> Option<&'a mut Panel> {
        (self.owner)(state).filter(|panel| std::rc::Rc::ptr_eq(&panel.scope, &self.scope))
    }
}

pub(crate) fn view<S: 'static>(
    panel: &Panel,
    owner: PanelOwner<S>,
    on_close: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    let Some(target) = panel.reader.target() else {
        return rune::el();
    };
    let scoped = Scoped {
        owner,
        scope: panel.scope.clone(),
    };
    let snapshot = panel
        .detail
        .snapshot
        .as_ref()
        .filter(|s| s.header.root.id == target.mission_id());
    let (heading, subtitle) = header_text(panel, target, snapshot);
    let close_owner = scoped.clone();
    let close_handler = on_close;
    let close_btn = window_close_button::scoped_close_button(
        &panel.reader.close,
        "mission-reader-close",
        dark(),
        Some(t("missions.control.reader.close")),
        move |s: &mut S| close_owner.get(s).map(|p| &mut p.reader.close),
        move |s: &mut S, tx| close_handler(s, tx),
    );
    let header = theme::chrome()
        .child(
            col()
                .remaining()
                .separate(Space::Xs)
                .child(theme::clipped(&heading, TextRole::Body).role("heading"))
                .child(theme::clipped(&subtitle, TextRole::Label)),
        )
        .child(close_btn);

    let mut content = col().full_width().pad(Space::Md).separate(Space::Md);
    if let Some(snapshot) = snapshot {
        let project_id = snapshot.header.root.project_id();
        match target {
            ReaderTarget::Overview { mission_id } => {
                content = overview_body(content, panel, snapshot, project_id, mission_id, &scoped);
            }
            ReaderTarget::Task {
                mission_id,
                task_id,
                task_key,
            } => {
                if let Some(task) = snapshot.tasks.find_by_id_or_key(task_id, task_key) {
                    content = task_body(
                        content, panel, snapshot, project_id, mission_id, task, &scoped,
                    );
                } else {
                    content =
                        content.child(theme::note(t("missions.control.reader.missing"), "status"));
                }
            }
        }
    } else if panel.detail.failed {
        let retry_owner = scoped.clone();
        content = content
            .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
            .child(
                layout::button(t("missionsPanel.reader.retry"), false, move |s: &mut S| {
                    if let Some(p) = retry_owner.get(s) {
                        p.detail.retry();
                    }
                })
                .key("mission-reader-detail-retry"),
            );
    } else {
        content = content.child(theme::note(t("missions.control.loading"), "status"));
    }

    col()
        .full_width()
        .full_height()
        .reading_surface()
        .key("mission-reader")
        .role("region")
        .label(heading)
        .child(header)
        .child(theme::scroll().remaining().child(content))
}

fn header_text(
    panel: &Panel,
    target: &ReaderTarget,
    snapshot: Option<&Snapshot>,
) -> (String, String) {
    match target {
        ReaderTarget::Overview { mission_id } => {
            if let Some(snap) = snapshot {
                let root = &snap.header.root;
                let name = root
                    .title
                    .as_deref()
                    .filter(|t| !t.is_empty())
                    .or_else(|| {
                        panel
                            .summaries
                            .iter()
                            .find(|row| row.id == root.id)
                            .map(title)
                    })
                    .unwrap_or(t("missions.control.overview"));
                (
                    name.to_owned(),
                    status(root.status, root.run_state).to_owned(),
                )
            } else {
                let fallback = panel
                    .summaries
                    .iter()
                    .find(|row| row.id == *mission_id)
                    .map(title)
                    .unwrap_or(t("missions.control.overview"));
                (
                    fallback.to_owned(),
                    t("missions.control.overview").to_owned(),
                )
            }
        }
        ReaderTarget::Task {
            task_id, task_key, ..
        } => {
            if let Some(task) = snapshot.and_then(|s| s.tasks.find_by_id_or_key(task_id, task_key))
            {
                let heading = if task.title.is_empty() {
                    task.key.clone()
                } else {
                    task.title.clone()
                };
                let subtitle = format!(
                    "{} · {} · {}",
                    task.key,
                    task.role(),
                    task_status_label(task.status)
                );
                (heading, subtitle)
            } else {
                (
                    task_key.clone(),
                    t("missions.control.task.details").to_owned(),
                )
            }
        }
    }
}

fn overview_body<S: 'static>(
    mut body: El,
    panel: &Panel,
    snapshot: &Snapshot,
    project_id: &str,
    mission_id: &str,
    scoped: &Scoped<S>,
) -> El {
    let root = &snapshot.header.root;
    let has_summary = root.body("summary").is_some_and(|b| b.characters > 0);
    let has_briefing = !has_summary && root.body("briefing").is_some_and(|b| b.characters > 0);

    if has_briefing {
        let selector = ContentSelector::mission("briefing");
        let view = panel.reader.body_view(project_id, mission_id, &selector);
        let key = (project_id.to_owned(), mission_id.to_owned(), selector);
        if let Some(loaded) = view.body
            && loaded.utf16_len >= loaded.characters
            && let Ok(doc) = serde_json::from_str::<BriefingDoc>(&loaded.text)
        {
            if root.revision > doc.based_on_revision.saturating_add(1) {
                body = body.child(theme::note(t("missions.briefing.changed"), "status"));
            }
            if !doc.summary.is_empty() {
                body = body.child(local_section(
                    panel,
                    scoped,
                    "briefing-summary",
                    "missions.control.summary",
                    &doc.summary,
                    false,
                ));
            }
            for (name, label, items) in [
                ("achieved", "missions.briefing.achieved", &doc.achieved),
                ("ongoing", "missions.briefing.ongoing", &doc.ongoing),
                ("obstacles", "missions.briefing.obstacles", &doc.obstacles),
                ("next", "missions.briefing.next", &doc.next),
            ] {
                if let Some(el) =
                    briefing_section(panel, snapshot, mission_id, scoped, name, label, items)
                {
                    body = body.child(el);
                }
            }
        } else {
            body = body.child(body_status_note(view.status, key, scoped));
        }
    } else if has_summary {
        body = body.child(remote_section(
            panel,
            scoped,
            "summary",
            "missions.control.summary",
            project_id,
            mission_id,
            ContentSelector::mission("summary"),
            false,
        ));
    }

    if root.body("objective").is_some() {
        body = body.child(remote_section(
            panel,
            scoped,
            "objective",
            "missions.control.objective",
            project_id,
            mission_id,
            ContentSelector::mission("objective"),
            false,
        ));
    } else if !root.excerpt.is_empty() {
        body = body.child(local_section(
            panel,
            scoped,
            "objective",
            "missions.control.objective",
            &root.excerpt,
            false,
        ));
    }

    if root.body("notes").is_some_and(|b| b.characters > 0) {
        body = body.child(remote_section(
            panel,
            scoped,
            "notes",
            "missions.control.notes",
            project_id,
            mission_id,
            ContentSelector::mission("notes"),
            false,
        ));
    }
    body
}

fn briefing_section<S: 'static>(
    panel: &Panel,
    snapshot: &Snapshot,
    mission_id: &str,
    scoped: &Scoped<S>,
    name: &str,
    label: &str,
    items: &[BriefingItem],
) -> Option<El> {
    let lines: Vec<&str> = items
        .iter()
        .map(|item| item.text.as_str())
        .filter(|text| !text.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let joined = lines.join("\n\n");
    let mut section = local_section(
        panel,
        scoped,
        &format!("briefing-{name}"),
        label,
        &joined,
        false,
    );
    let mut seen = HashSet::new();
    let mut buttons = Vec::new();
    for item in items {
        for key in &item.task_keys {
            if !seen.insert(key.as_str()) {
                continue;
            }
            if let Some(task) = snapshot.tasks.find_by_key(key) {
                let label = if task.title.is_empty() {
                    task.key.clone()
                } else {
                    task.title.clone()
                };
                let mid = mission_id.to_owned();
                let tid = task.id.clone();
                let tkey = task.key.clone();
                let owner = scoped.clone();
                buttons.push(
                    layout::button(&label, false, move |s: &mut S| {
                        if let Some(p) = owner.get(s) {
                            p.reader.open_task(mid.clone(), tid.clone(), tkey.clone());
                        }
                    })
                    .key(format!("mission-reader-briefing-{name}-{}", task.key)),
                );
            }
        }
    }
    if !buttons.is_empty() {
        let mut row = layout::action_row();
        for btn in buttons {
            row = row.child(btn);
        }
        section = section.child(row);
    }
    Some(section)
}

fn task_body<S: 'static>(
    mut body: El,
    panel: &Panel,
    snapshot: &Snapshot,
    project_id: &str,
    mission_id: &str,
    task: &Task,
    scoped: &Scoped<S>,
) -> El {
    if !task.blocked_by.is_empty() {
        let mut deps = layout::action_row();
        for dep_key in &task.blocked_by {
            let target = snapshot.tasks.find_by_key(dep_key);
            let name = target
                .map(|t| {
                    if t.title.is_empty() {
                        t.key.as_str()
                    } else {
                        t.title.as_str()
                    }
                })
                .unwrap_or(dep_key.as_str());
            let label = catalogue::format(
                locale(),
                "missions.control.task.blockedBy",
                &[("tasks", name)],
            );
            let owner = scoped.clone();
            let mid = mission_id.to_owned();
            let target_ids = target.map(|t| (t.id.clone(), t.key.clone()));
            let disabled = target_ids.is_none();
            deps = deps.child(
                layout::button(&label, disabled, move |s: &mut S| {
                    if let Some((tid, tkey)) = &target_ids
                        && let Some(p) = owner.get(s)
                    {
                        p.reader.open_task(mid.clone(), tid.clone(), tkey.clone());
                    }
                })
                .key(format!("mission-reader-dep-{dep_key}")),
            );
        }
        body = body.child(deps);
    }

    if let Some(report) = task.report() {
        let outcome = t(match report.outcome {
            ReportOutcome::Completed => "missions.control.report.outcome.completed",
            ReportOutcome::Blocked => "missions.control.report.outcome.blocked",
            ReportOutcome::Failed => "missions.control.report.outcome.failed",
        });
        body = body.child(text(outcome).text_role(TextRole::Small));
        if report.is_late() {
            body = body.child(text(t("missions.control.report.late")).text_role(TextRole::Small));
        }
        if report.body("summary").is_some_and(|b| b.characters > 0) {
            body = body.child(remote_section(
                panel,
                scoped,
                "report-summary",
                "missions.control.summary",
                project_id,
                mission_id,
                ContentSelector::report(report.id.clone(), "summary"),
                false,
            ));
        } else if let Some(excerpt) = report.excerpt()
            && !excerpt.is_empty()
        {
            body = body.child(local_section(
                panel,
                scoped,
                "report-summary",
                "missions.control.summary",
                excerpt,
                false,
            ));
        }
        if report.body("next").is_some_and(|b| b.characters > 0) {
            body = body.child(json_list_section(
                panel,
                scoped,
                "report-next",
                "missions.control.report.next",
                project_id,
                mission_id,
                ContentSelector::report(report.id.clone(), "next"),
            ));
        }
        if report.body("evidence").is_some_and(|b| b.characters > 0) {
            body = body.child(json_list_section(
                panel,
                scoped,
                "report-evidence",
                "missions.control.report.evidence",
                project_id,
                mission_id,
                ContentSelector::report(report.id.clone(), "evidence"),
            ));
        }
        if report.body("artifact").is_some_and(|b| b.characters > 0) {
            body = body.child(remote_section(
                panel,
                scoped,
                "report-artifact",
                "missions.control.artifact",
                project_id,
                mission_id,
                ContentSelector::report(report.id.clone(), "artifact"),
                true,
            ));
        }
    }

    if task.body("brief").is_some() {
        body = body.child(remote_section(
            panel,
            scoped,
            "brief",
            "missions.control.brief",
            project_id,
            mission_id,
            ContentSelector::task(task.key.clone(), "brief"),
            false,
        ));
    }
    body
}

#[allow(clippy::too_many_arguments)]
fn json_list_section<S: 'static>(
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
        let joined = serde_json::from_str::<Vec<String>>(&loaded.text)
            .map(|items| items.join("\n\n"))
            .unwrap_or_else(|_| loaded.text.clone());
        return local_section(panel, scoped, section_id, label_key, &joined, false);
    }
    col()
        .full_width()
        .separate(Space::Xs)
        .key(format!("mission-reader-section-{section_id}"))
        .child(text(t(label_key)).role("heading"))
        .child(body_status_note(view.status, key, scoped))
}

#[allow(clippy::too_many_arguments)]
fn remote_section<S: 'static>(
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
        section = section.child(section_toolbar(
            scoped,
            section_id,
            page,
            total,
            move |s: &mut S, tx: &mut Tx| {
                if let Some(p) = copy_owner.get(s)
                    && let Some(text) = p.reader.request_copy(copy_key.clone())
                {
                    tx.copy(text);
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
        section = section.child(body_status_note(BodyStatus::Error, key, scoped));
    } else if view.status == BodyStatus::Missing {
        section = section.child(theme::note(t("missions.control.reader.missing"), "status"));
    } else if !rendered_page {
        section = section.child(theme::note(t("missions.control.reader.loading"), "status"));
    }
    section
}

fn local_section<S: 'static>(
    panel: &Panel,
    scoped: &Scoped<S>,
    section_id: &str,
    label_key: &str,
    source: &str,
    raw: bool,
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
                        }
                    },
                )
                .key(format!("mission-reader-next-{section_id}")),
            );
    }
    bar.child(
        markdown::copy_button(t("messageItem.actions.copy"), on_copy)
            .key(format!("mission-reader-copy-{section_id}")),
    )
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
        true,
        None,
        |_, href, tx| open_safe_url(href, tx),
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
    )
}

fn body_status_note<S: 'static>(status: BodyStatus, key: BodyKey, scoped: &Scoped<S>) -> El {
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
                        }
                    })
                    .key("mission-reader-body-retry"),
                )
        }
    }
}

fn task_status_label(status: TaskStatus) -> &'static str {
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

fn open_safe_url(href: &str, tx: &mut Tx) {
    let trimmed = href.trim();
    let allowed = trimmed
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://") || p.eq_ignore_ascii_case("mailto:"))
        || trimmed
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
    if allowed {
        let _ = tx.open_url(trimmed);
    }
}
