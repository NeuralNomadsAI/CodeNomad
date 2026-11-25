use super::{
    super::{
        detail::Snapshot,
        directory::{Panel, title},
        view::status,
    },
    ReaderTarget, current_task_report, overview_progress,
    sections::{
        body_status_note, json_list_section, local_section, remote_section, task_status_label,
    },
    task_history_reports,
};
use crate::{
    components::window_close_button,
    strings::{locale, t},
};
use codenomad_client::missions::{
    BriefingDoc, BriefingItem, ContentSelector, Report, ReportOutcome, Task,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout, dark},
};
use std::collections::HashSet;

type PanelOwner<S> = fn(&mut S) -> Option<&mut Panel>;

pub(super) struct Scoped<S> {
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
    pub(super) fn get<'a>(&self, state: &'a mut S) -> Option<&'a mut Panel> {
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
    let close_btn = window_close_button::scoped_close_button(
        &panel.reader.close,
        "mission-reader-close",
        dark(),
        Some(t("missions.control.reader.close")),
        move |s: &mut S| close_owner.get(s).map(|p| &mut p.reader.close),
        move |s: &mut S, tx| on_close(s, tx),
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
                } else if panel.detail.busy()
                    || (!panel.detail.failed
                        && snapshot.tasks.len() < snapshot.header.tasks.page.total
                        && !panel.detail.lookup_settled(task_id, task_key))
                {
                    content = content.child(theme::note(t("missions.control.loading"), "status"));
                } else if panel.detail.failed {
                    let retry_owner = scoped.clone();
                    content = content
                        .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
                        .child(
                            layout::button(
                                t("missionsPanel.reader.retry"),
                                false,
                                move |s: &mut S| {
                                    if let Some(p) = retry_owner.get(s) {
                                        p.detail.retry();
                                    }
                                },
                            )
                            .key("mission-reader-detail-retry"),
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
            body = body.child(body_status_note(view.status, key, "briefing", scoped));
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
    } else {
        let (recorded, blockers) = overview_progress(snapshot);
        if !recorded.is_empty() {
            body = body.child(progress_section(
                panel,
                snapshot,
                project_id,
                mission_id,
                scoped,
                "recorded",
                "missions.tracking.recorded",
                &recorded,
            ));
        }
        if !blockers.is_empty() {
            body = body.child(progress_section(
                panel,
                snapshot,
                project_id,
                mission_id,
                scoped,
                "obstacles",
                "missions.tracking.obstacles",
                &blockers,
            ));
        }
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

#[allow(clippy::too_many_arguments)]
fn progress_section<S: 'static>(
    panel: &Panel,
    snapshot: &Snapshot,
    project_id: &str,
    mission_id: &str,
    scoped: &Scoped<S>,
    name: &str,
    label_key: &str,
    entries: &[(&Task, &Report)],
) -> El {
    let mut parts = Vec::new();
    let mut task_keys = Vec::new();
    for (task, report) in entries {
        let title = if task.title.is_empty() {
            task.key.as_str()
        } else {
            task.title.as_str()
        };
        let selector = ContentSelector::report(report.id.clone(), "summary");
        let summary = panel
            .reader
            .body_view(project_id, mission_id, &selector)
            .body
            .map(|b| b.text.as_str())
            .or_else(|| report.excerpt())
            .unwrap_or_default();
        parts.push(if summary.is_empty() {
            title.to_owned()
        } else {
            format!("{title}\n\n{summary}")
        });
        task_keys.push(task.key.as_str());
    }
    let joined = parts.join("\n\n");
    let mut section = local_section(
        panel,
        scoped,
        &format!("progress-{name}"),
        label_key,
        &joined,
        false,
    );
    if let Some(links) = task_links_row(
        snapshot,
        mission_id,
        scoped,
        &format!("progress-{name}"),
        &task_keys,
    ) {
        section = section.child(links);
    }
    section
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
    let keys: Vec<&str> = items
        .iter()
        .flat_map(|item| item.task_keys.iter().map(String::as_str))
        .collect();
    if let Some(links) = task_links_row(
        snapshot,
        mission_id,
        scoped,
        &format!("briefing-{name}"),
        &keys,
    ) {
        section = section.child(links);
    }
    Some(section)
}

fn task_links_row<S: 'static>(
    snapshot: &Snapshot,
    mission_id: &str,
    scoped: &Scoped<S>,
    prefix: &str,
    keys: &[&str],
) -> Option<El> {
    let has_offpage = snapshot.tasks.len() < snapshot.header.tasks.page.total;
    let mut seen = HashSet::new();
    let mut buttons = Vec::new();
    for &key in keys {
        if !seen.insert(key) {
            continue;
        }
        let target = snapshot.tasks.find_by_key(key);
        if target.is_none() && !has_offpage {
            continue;
        }
        let label = target
            .map(|task| {
                if task.title.is_empty() {
                    task.key.as_str()
                } else {
                    task.title.as_str()
                }
            })
            .unwrap_or(key);
        let mid = mission_id.to_owned();
        let tid = target.map(|t| t.id.clone()).unwrap_or_default();
        let tkey = key.to_owned();
        let owner = scoped.clone();
        buttons.push(
            layout::button_tx(label, false, move |s: &mut S, tx: &mut Tx| {
                if let Some(p) = owner.get(s) {
                    p.reader.open_task(mid.clone(), tid.clone(), tkey.clone());
                    tx.focus("mission-reader-close", tx.focus_visible());
                }
            })
            .key(format!("mission-reader-{prefix}-{key}")),
        );
    }
    if buttons.is_empty() {
        return None;
    }
    let mut row = layout::action_row();
    for btn in buttons {
        row = row.child(btn);
    }
    Some(row)
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
    let has_offpage = snapshot.tasks.len() < snapshot.header.tasks.page.total;
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
            let tid = target.map(|t| t.id.clone()).unwrap_or_default();
            let tkey = dep_key.clone();
            let disabled = target.is_none() && !has_offpage;
            deps = deps.child(
                layout::button_tx(&label, disabled, move |s: &mut S, tx: &mut Tx| {
                    if let Some(p) = owner.get(s) {
                        p.reader.open_task(mid.clone(), tid.clone(), tkey.clone());
                        tx.focus("mission-reader-close", tx.focus_visible());
                    }
                })
                .key(format!("mission-reader-dep-{dep_key}")),
            );
        }
        body = body.child(deps);
    }

    if let Some(report) = current_task_report(snapshot, task) {
        body = render_report(
            body, panel, scoped, project_id, mission_id, report, "report", true,
        );
    }

    let history = task_history_reports(snapshot, task);
    for report in history {
        let disc_id = format!("history-report-{}", report.id);
        let open = panel.reader.is_disclosure_open(&disc_id);
        let kind_label = t(if report.is_late() {
            "missions.control.report.late"
        } else {
            "missions.progress.previousAttempt"
        });
        let label = match report.excerpt().filter(|s| !s.is_empty()) {
            Some(excerpt) => format!("{kind_label} · {excerpt}"),
            None => kind_label.to_owned(),
        };
        let toggle_owner = scoped.clone();
        let toggle_id = disc_id.clone();
        let mut block = col().full_width().separate(Space::Xs).child(
            layout::button(&label, false, move |s: &mut S| {
                if let Some(p) = toggle_owner.get(s) {
                    p.reader.toggle_disclosure(&toggle_id);
                }
            })
            .expanded(open)
            .key(format!("mission-reader-toggle-{disc_id}")),
        );
        if open {
            block = render_report(
                block,
                panel,
                scoped,
                project_id,
                mission_id,
                report,
                &format!("history-{}", report.id),
                false,
            );
        }
        body = body.child(block);
    }

    if task.body("brief").is_some() {
        let open = panel.reader.is_disclosure_open("task-brief");
        let toggle_owner = scoped.clone();
        let mut block = col().full_width().separate(Space::Xs).child(
            layout::button(t("missions.control.brief"), false, move |s: &mut S| {
                if let Some(p) = toggle_owner.get(s) {
                    p.reader.toggle_disclosure("task-brief");
                }
            })
            .expanded(open)
            .key("mission-reader-toggle-task-brief"),
        );
        if open {
            block = block.child(remote_section(
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
        body = body.child(block);
    }
    body
}

#[allow(clippy::too_many_arguments)]
fn render_report<S: 'static>(
    mut body: El,
    panel: &Panel,
    scoped: &Scoped<S>,
    project_id: &str,
    mission_id: &str,
    report: &Report,
    prefix: &str,
    allow_artifact: bool,
) -> El {
    let outcome = t(match report.outcome {
        ReportOutcome::Completed => "missions.control.report.outcome.completed",
        ReportOutcome::Blocked => "missions.control.report.outcome.blocked",
        ReportOutcome::Failed => "missions.control.report.outcome.failed",
    });
    body = body.child(text(outcome).text_role(TextRole::Small));
    if report.is_late() {
        body = body.child(text(t("missions.control.report.late")).text_role(TextRole::Small));
    }
    let summary_section = format!("{prefix}-summary");
    if report.body("summary").is_some_and(|b| b.characters > 0) {
        body = body.child(remote_section(
            panel,
            scoped,
            &summary_section,
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
            &summary_section,
            "missions.control.summary",
            excerpt,
            false,
        ));
    }
    if report.body("next").is_some_and(|b| b.characters > 0) {
        body = body.child(json_list_section(
            panel,
            scoped,
            &format!("{prefix}-next"),
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
            &format!("{prefix}-evidence"),
            "missions.control.report.evidence",
            project_id,
            mission_id,
            ContentSelector::report(report.id.clone(), "evidence"),
        ));
    }
    if allow_artifact && report.body("artifact").is_some_and(|b| b.characters > 0) {
        let open = panel.reader.is_disclosure_open("report-artifact");
        let toggle_owner = scoped.clone();
        let mut block = col().full_width().separate(Space::Xs).child(
            layout::button(t("missions.control.artifact"), false, move |s: &mut S| {
                if let Some(p) = toggle_owner.get(s) {
                    p.reader.toggle_disclosure("report-artifact");
                }
            })
            .expanded(open)
            .key("mission-reader-toggle-report-artifact"),
        );
        if open {
            block = block.child(remote_section(
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
        body = body.child(block);
    }
    body
}
