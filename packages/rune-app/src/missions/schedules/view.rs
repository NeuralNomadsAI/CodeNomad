//! Pure view assembly for recurring Mission schedules, controls and receipts.
use super::{
    Cap, ScheduleGesture as G, ScheduleHoldPhase as P, ScheduleHolds,
    list::SelectionError as SelErr,
};
use crate::{
    missions::Panel,
    shell::status_usage::date,
    strings::{locale, t},
};
use codenomad_client::missions::{LaunchItem, LaunchPolicy, ScheduleAction as A, UnifiedSchedule};
use rune::{El, Tx, col, row, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    document_reader::editor,
    git_panel as theme,
    layout::{self, Layout},
    shell,
};

pub(crate) type ScheduleAct<S> = fn(&mut S, G, &mut Tx);

pub(crate) fn list_section<S: 'static>(
    ui: &Panel,
    holds: &ScheduleHolds,
    act: ScheduleAct<S>,
) -> (El, bool) {
    let filter = ui.filter.text.trim().to_lowercase();
    let all = ui.schedules.visible_rows(holds, ui.schedule_ctx());
    let mut list = col().full_width();
    let mut shown = false;
    for d in &all {
        let sel = ui.schedules.selected.as_deref() == Some(d.id.as_str());
        if !sel && !filter.is_empty() && !d.configuration.title.to_lowercase().contains(&filter) {
            continue;
        }
        shown = true;
        let id = d.id.clone();
        list = list.child(
            shell::session_row(&d.configuration.title, sel, false, move |s, tx| {
                act(s, G::Select(id.clone()), tx)
            })
            .key(format!("mission-schedule-row-{}", d.id))
            .description(row_status(d)),
        );
    }
    if ui.schedules.loading() {
        list = list.child(note("missions.control.loading", "status"));
    } else if ui.schedules.error {
        list = list
            .child(note("missions.scheduleList.readFailed", "status"))
            .child(tbtn(
                "missionsPanel.reader.retry",
                "mission-schedules-retry",
                G::RetryList,
                act,
            ));
    } else if ui.schedules.next.is_some() {
        list = list.child(tbtn(
            "missions.scheduleList.more",
            "mission-schedules-more",
            G::More,
            act,
        ));
    }
    (list, shown || !all.is_empty())
}

pub(crate) fn detail_section<S: 'static>(
    ui: &Panel,
    holds: &ScheduleHolds,
    act: ScheduleAct<S>,
) -> Option<El> {
    let ctx = ui.schedule_ctx();
    let sid = ui.schedules.selected.as_deref()?;
    let hold = ui.schedules.hold_for(holds, ctx, sid);
    let mut reg = col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Xs)
        .key("mission-schedule-detail")
        .role("region");

    if let Some(err) = ui.schedules.selection_error {
        let k = match err {
            SelErr::Pending if hold.is_some_and(|(p, _)| p.is_publication()) => {
                "missions.scheduleList.confirmedRefreshing"
            }
            SelErr::Pending => "missions.scheduleList.uncertain",
            SelErr::Failed => "missions.scheduleList.readFailed",
        };
        let role = if err == SelErr::Failed {
            "alert"
        } else {
            "status"
        };
        reg = reg.child(note(k, role));
        if err == SelErr::Failed {
            reg = reg.child(tbtn(
                "missionsPanel.reader.retry",
                "mission-schedule-retry-selection",
                G::RetrySelection,
                act,
            ));
        }
    }

    let Some(doc) = ui.schedules.selected_document(holds, ctx) else {
        if ui.schedules.selection_error.is_some() {
            return Some(reg.label(t("missionsPanel.overview")));
        }
        return None;
    };
    let pre = ui.schedules.pre_busy(&doc.id);
    let active = pre.or_else(|| hold.and_then(|(p, chk)| chk.then(|| p.action()).flatten()));
    let busy = pre.is_some() || hold.is_some_and(|(_, chk)| chk);
    reg = reg
        .label(&doc.configuration.title)
        .child(
            text(&doc.configuration.title)
                .role("heading")
                .wrap_anywhere(),
        )
        .child(action_bar(ui, doc, hold.is_some(), active, busy, act));
    if let Some(k) = status_key(ui, doc, hold, active, busy) {
        let alert = matches!(
            k,
            "missions.scheduleList.uncertain"
                | "missions.scheduleList.conflict"
                | "missions.scheduleList.readFailed"
                | "missions.scheduleList.capacity"
                | "missions.scheduleList.activationRefused"
                | "missions.scheduleList.runNowRequiresEnabled"
        );
        reg = reg.child(note(k, if alert { "alert" } else { "status" }));
    }
    if let Some(refusal) = ui.schedules.refusal.as_ref() {
        let mut ref_row = layout::action_row();
        if let Some(cfg_id) = refusal.openable_config_id() {
            ref_row = ref_row.child(tbtn(
                "missionsPanel.action.openSchedulingSettings",
                "mission-schedule-open-settings",
                G::OpenConfigFile(cfg_id.to_owned()),
                act,
            ));
        }
        let layer_key = format!(
            "missions.scheduleList.activationRefused.layer.{}",
            refusal.layer
        );
        let layer_label = catalogue::message(locale(), &layer_key).unwrap_or(&refusal.layer);
        let msg_key = if refusal.layer == "environment" {
            "missions.scheduleList.activationRefused.environment"
        } else {
            "missions.scheduleList.activationRefused.document"
        };
        let mut tip = fmt(msg_key, &[("layer", layer_label)]);
        if let Some(path) = refusal.path.as_deref().filter(|p| !p.is_empty()) {
            tip.push('\n');
            tip.push_str(path);
        }
        ref_row = ref_row.child(info_btn(
            t("missions.scheduleList.activationRefused"),
            &tip,
            ui.schedules.refusal_info_open,
            "mission-schedule-refusal-info",
            G::ToggleRefusalInfo,
            act,
        ));
        reg = reg.child(ref_row);
    }

    reg = append_facts(reg, doc);
    reg = append_instructions_and_runs(reg, ui, doc, act);
    Some(append_diagnostics(reg, ui, doc, act))
}

fn action_bar<S: 'static>(
    ui: &Panel,
    doc: &UnifiedSchedule,
    held: bool,
    active: Option<A>,
    busy: bool,
    act: ScheduleAct<S>,
) -> El {
    let en = !ui.editor.is_open();
    let dir = ui.directory.as_deref();
    let prim = [A::Pause, A::Resume, A::Play];
    let primary = prim
        .into_iter()
        .find(|a| active == Some(*a))
        .or_else(|| prim.into_iter().find(|a| doc.available_actions.contains(a)));

    let mut bar = layout::action_row();
    if let Some(a) = primary {
        bar = bar.child(action_btn(
            a,
            !ui.schedules.capable(doc, a, held, en, dir),
            "mission-schedule-primary",
            act,
        ));
    }
    for (a, key) in [
        (A::Stop, "mission-schedule-stop"),
        (A::RunNow, "mission-schedule-run-now"),
        (A::Delete, "mission-schedule-delete"),
    ] {
        bar = bar.child(action_btn(
            a,
            !ui.schedules.capable(doc, a, held, en, dir),
            key,
            act,
        ));
    }
    if doc.configuration.launch.requires_calendar
        && ui.schedules.capability == Some(Cap::Activatable)
        && (doc.available_actions.contains(&A::Play) || doc.available_actions.contains(&A::Resume))
    {
        bar = bar.child(info_btn(
            t("missions.scheduling.title"),
            t("missions.scheduling.capability.activatable"),
            ui.schedules.activatable_info_open,
            "mission-schedule-activatable-info",
            G::ToggleActivatableInfo,
            act,
        ));
    }
    if let Some(p) = &doc.pending_passage {
        bar = bar.child(tbtn(
            "missionsPanel.action.openConversation",
            "mission-schedule-open-conversation",
            G::OpenConversation(p.coordinator_session_id.clone()),
            act,
        ));
    }
    if held {
        let k = "mission-schedule-reconcile";
        bar = bar.child(if busy {
            layout::focusable_disabled_button(t("missions.scheduling.readReceipt")).key(k)
        } else {
            tbtn("missions.scheduling.readReceipt", k, G::Reconcile, act)
        });
    }
    bar
}

fn append_facts(mut reg: El, doc: &UnifiedSchedule) -> El {
    let lp = &doc.configuration.launch;
    let launched = lp.launch_limit.map_or_else(
        || doc.launched_count.to_string(),
        |l| format!("{} / {l}", doc.launched_count),
    );
    reg = reg
        .child(fact_t(
            "missions.scheduling.when",
            &describe_criteria(lp, doc.one_shot_at).join("; "),
        ))
        .child(fact_t(
            "missions.scheduleList.desired",
            t(doc.state.i18n_key()),
        ))
        .child(fact_t(
            "missions.scheduleList.observed",
            t(doc.observation.observed_key()),
        ))
        .child(
            fact_t(next_key(doc), &opt_ts(doc.observation.next_due_at))
                .help(t("missions.scheduleList.lateSlot")),
        );
    if doc.slot_ends_at.is_some() || lp.until.is_some() || lp.end_after_ms.is_some() {
        let mut until = opt_ts(doc.slot_ends_at.or(lp.until));
        if doc.first_played_at.is_none()
            && let Some(ms) = lp.end_after_ms
        {
            let m = (ms / 60_000).to_string();
            until = format!(
                "{until} · {}",
                fmt("missions.scheduleList.endAfter", &[("minutes", &m)])
            );
        }
        reg = reg.child(fact_t("missions.scheduling.until", &until));
    }
    if lp.has_events {
        let ch = match &doc.checks {
            Some(c) => format!(
                "{} · {}",
                c.count,
                fmt(
                    "missions.scheduleList.since",
                    &[("when", &format_ts(c.since))]
                )
            ),
            None => t("missions.scheduleList.unavailable").into(),
        };
        reg = reg.child(fact_t("missions.scheduleList.checks", &ch));
    }
    reg = reg
        .child(fact_t("missions.scheduleList.launched", &launched))
        .child(fact_t(
            "missions.scheduleList.succeeded",
            &doc.successful_count.to_string(),
        ));
    if let Some(reason) = &doc.block_reason {
        let k = match reason.as_str() {
            "deleting" => "missions.scheduling.lock.deleted",
            "failed" | "ended-without-report" => "missions.recurrence.interruptedError",
            _ => "missions.scheduling.lock.uncertain",
        };
        reg = reg.child(theme::note(
            format!(
                "{} · {} ({reason})",
                t("missions.scheduleList.blocked"),
                t(k)
            ),
            "alert",
        ));
    }
    reg
}

fn append_instructions_and_runs<S: 'static>(
    mut reg: El,
    ui: &Panel,
    doc: &UnifiedSchedule,
    act: ScheduleAct<S>,
) -> El {
    let open = ui.schedules.instructions_open.contains(&doc.id);
    reg = reg.child(
        tbtn(
            "missions.control.objective",
            "mission-schedule-instructions-toggle",
            G::ToggleInstructions,
            act,
        )
        .expanded(open),
    );
    if open {
        let mut instr = col()
            .full_width()
            .pad(Space::Xs)
            .separate(Space::Xs)
            .child(text(&doc.configuration.objective).wrap_anywhere());
        if let Some(n) = doc.configuration.notes.as_deref().filter(|n| !n.is_empty()) {
            instr = instr.child(small(n));
        }
        reg = reg.child(instr);
    }
    reg = reg.child(
        text(t("missionsPanel.pastRuns"))
            .text_role(TextRole::Small)
            .role("heading"),
    );
    if doc.history.is_empty() {
        return reg.child(small(t("missionsPanel.schedule.noRuns")));
    }
    for item in doc.history.iter().rev() {
        let out = match (item.reason.as_deref(), item.outcome.as_str()) {
            (Some("not-started"), _) => "missionsPanel.run.not-started",
            (_, "completed") => "missionsPanel.run.completed",
            (_, "stopped") => "missionsPanel.run.stopped",
            _ => "missionsPanel.run.failed",
        };
        let sum = format!("{} · {}", format_ts(item.due_at), t(out));
        let ob = tbtn(
            "missionsPanel.action.openConversation",
            format!("mission-schedule-run-open-{}", item.id),
            G::OpenConversation(item.coordinator_session_id.clone()),
            act,
        );
        reg = reg.child(
            row()
                .full_width()
                .separate(Space::Xs)
                .key(format!("mission-schedule-run-{}", item.id))
                .child(small(sum).remaining())
                .child(ob),
        );
    }
    reg
}

fn split_wakes_copy(wakes_val: &str) -> (String, String) {
    let raw = t("missions.scheduleDiagnostics.wakes");
    match raw.split_once("{count}") {
        Some((head, tail)) => (
            format!("{head}{wakes_val}"),
            tail.trim_start_matches(['.', '。', '।', ' '])
                .trim()
                .to_owned(),
        ),
        None => (
            fmt(
                "missions.scheduleDiagnostics.wakes",
                &[("count", wakes_val)],
            ),
            String::new(),
        ),
    }
}

fn append_diagnostics<S: 'static>(
    mut reg: El,
    ui: &Panel,
    doc: &UnifiedSchedule,
    act: ScheduleAct<S>,
) -> El {
    let open = ui.schedules.diagnostics_open.contains(&doc.id);
    let info_open = ui.schedules.diagnostics_info_open.contains(&doc.id);
    let wakes_val = doc.observation.wake_count.map_or_else(
        || t("missions.scheduleList.unavailable").to_owned(),
        |n| n.to_string(),
    );
    let (wakes_line, wakes_note) = split_wakes_copy(&wakes_val);
    let info_text = [
        wakes_note.as_str(),
        t("missions.scheduleDiagnostics.cost"),
        t("missions.scheduleDiagnostics.retention"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let hdr = layout::action_row()
        .child(
            tbtn(
                "missions.scheduleDiagnostics.title",
                "mission-schedule-diagnostics-toggle",
                G::ToggleDiagnostics,
                act,
            )
            .expanded(open),
        )
        .child(info_btn(
            t("missions.scheduleDiagnostics.title"),
            &info_text,
            info_open,
            "mission-schedule-diagnostics-info",
            G::ToggleDiagnosticsInfo,
            act,
        ));
    reg = reg.child(hdr);
    if !open {
        return reg;
    }
    let cleanup_key = if doc.technical.cleanup_pending {
        "missions.scheduleDiagnostics.cleanupPending"
    } else {
        "missions.scheduleDiagnostics.cleanupClear"
    };
    let mut body = col()
        .full_width()
        .pad(Space::Xs)
        .separate(Space::Xs)
        .inset_surface()
        .key("mission-schedule-diagnostics")
        .role("region")
        .label(t("missions.scheduleDiagnostics.title"))
        .child(small(wakes_line))
        .child(note(cleanup_key, "status"));
    if doc.technical.carriers.is_empty() {
        body = body.child(small(t("missions.scheduleDiagnostics.noCarriers")));
    } else {
        for (idx, carrier) in doc.technical.carriers.iter().enumerate() {
            let role_key = if carrier.role == "reconciliation" {
                "missions.scheduleDiagnostics.role.reconciliation"
            } else {
                "missions.scheduleDiagnostics.role.principal"
            };
            let slot_num = (carrier.slot + 1).to_string();
            let gen_num = carrier.time_generation.to_string();
            let mut summary = format!(
                "{} · {}",
                fmt(role_key, &[("number", &slot_num)]),
                fmt(
                    "missions.scheduleDiagnostics.generation",
                    &[("number", &gen_num)]
                ),
            );
            if carrier.retiring {
                let rk = if carrier.cleanup_pending {
                    "missions.scheduleDiagnostics.cleanupPending"
                } else {
                    "missions.scheduleDiagnostics.retired"
                };
                summary.push_str(" · ");
                summary.push_str(t(rk));
            }
            let cal_id = carrier
                .schedule_id
                .as_deref()
                .unwrap_or(t("missions.scheduleList.none"));
            body = body.child(
                col()
                    .full_width()
                    .separate(Space::Xs)
                    .key(format!("mission-schedule-carrier-{idx}"))
                    .child(small(summary))
                    .child(
                        row()
                            .full_width()
                            .separate(Space::Xs)
                            .child(small(t("missions.scheduleDiagnostics.session")))
                            .child(
                                text(&carrier.session_id)
                                    .text_role(TextRole::Small)
                                    .literal_direction()
                                    .wrap_anywhere()
                                    .remaining(),
                            ),
                    )
                    .child(
                        row()
                            .full_width()
                            .separate(Space::Xs)
                            .child(small(t("missions.scheduleDiagnostics.calendar")))
                            .child(
                                text(cal_id)
                                    .text_role(TextRole::Small)
                                    .literal_direction()
                                    .wrap_anywhere()
                                    .remaining(),
                            ),
                    ),
            );
        }
    }
    reg.child(body)
}

pub(crate) fn confirmation<S: 'static>(holds: &ScheduleHolds, act: ScheduleAct<S>) -> Option<El> {
    let c = holds.confirmation.as_ref()?;
    let prompt = match c.action {
        A::Stop => "missions.scheduleList.confirm.stop",
        A::Delete => "missions.scheduleList.confirm.delete",
        A::RunNow => "missions.scheduleList.confirm.run-now",
        _ => return None,
    };
    Some(editor::confirmation(
        layout::dark(),
        &fmt(prompt, &[("title", &c.title)]),
        t("missions.simple.cancel"),
        action_label(c.action),
        move |s: &mut S, ok, tx: &mut Tx| act(s, G::Confirm(ok), tx),
    ))
}

fn fmt(k: &str, p: &[(&str, &str)]) -> String {
    catalogue::format(locale(), k, p)
}
fn note(k: &str, role: &'static str) -> El {
    theme::note(t(k), role)
}
fn small(s: impl Into<String>) -> El {
    text(s).text_role(TextRole::Small).wrap_anywhere()
}
fn fact_t(lk: &str, v: &str) -> El {
    row()
        .full_width()
        .separate(Space::Xs)
        .child(text(t(lk)).text_role(TextRole::Small))
        .child(small(v).remaining())
}
fn tbtn<S: 'static>(lk: &str, key: impl Into<String>, g: G, act: ScheduleAct<S>) -> El {
    btn(t(lk), key, g, act)
}
fn info_btn<S: 'static>(
    label: &str,
    help: &str,
    open: bool,
    key: &'static str,
    g: G,
    act: ScheduleAct<S>,
) -> El {
    layout::button_tx("ⓘ", false, move |s: &mut S, tx| act(s, g.clone(), tx))
        .key(key)
        .label(label)
        .description(help)
        .help(help)
        .help_open(open)
}
fn btn<S: 'static>(lbl: &str, key: impl Into<String>, g: G, act: ScheduleAct<S>) -> El {
    layout::button_tx(lbl, false, move |s: &mut S, tx| act(s, g.clone(), tx)).key(key.into())
}
fn action_btn<S: 'static>(a: A, dis: bool, key: &'static str, act: ScheduleAct<S>) -> El {
    if dis {
        layout::focusable_disabled_button(action_label(a)).key(key)
    } else {
        btn(action_label(a), key, G::Action(a), act)
    }
}
fn action_label(a: A) -> &'static str {
    t(match a {
        A::Delete => "missionsPanel.picker.delete",
        A::RunNow => "missionsPanel.action.runNow",
        A::Play => "missionsPanel.action.start",
        A::Pause => "missionsPanel.action.pause",
        A::Resume => "missionsPanel.action.resume",
        A::Stop => "missionsPanel.action.stop",
        A::Check => "missionsPanel.action.checkStatus",
        A::Configure => "missionsPanel.picker.edit",
    })
}
fn status_key(
    ui: &Panel,
    doc: &UnifiedSchedule,
    hold: Option<(&P, bool)>,
    active: Option<A>,
    busy: bool,
) -> Option<&'static str> {
    if let Some(a) = active {
        return Some(match a {
            A::Play => "missionsPanel.action.starting",
            A::Resume => "missionsPanel.action.resuming",
            A::RunNow => "missionsPanel.action.runningNow",
            _ => "missions.control.mutation.pending",
        });
    }
    if let Some((ph, _)) = hold {
        return (!busy).then_some(if ph.is_publication() {
            "missions.scheduleList.confirmedRefreshing"
        } else {
            "missions.scheduleList.uncertain"
        });
    }
    if let Some(k) = ui.schedules.feedback_for(&doc.id) {
        return Some(k);
    }
    if doc.configuration.launch.requires_calendar {
        match ui.schedules.capability {
            Some(Cap::Refused) => return Some("missions.scheduleList.activationRefused"),
            Some(Cap::Missing) => return Some("missions.scheduling.capability.missing"),
            _ => {}
        }
    }
    None
}
fn next_key(doc: &UnifiedSchedule) -> &'static str {
    if doc.observation.is_check() {
        "missions.scheduleList.nextCheck"
    } else {
        "missions.scheduleList.nextWake"
    }
}
fn row_status(doc: &UnifiedSchedule) -> String {
    let crit = describe_criteria(&doc.configuration.launch, doc.one_shot_at).join("; ");
    let next = format!(
        "{} · {}",
        t(next_key(doc)),
        opt_ts(doc.observation.next_due_at)
    );
    [t(doc.state.i18n_key()), &crit, &next]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}
pub(crate) fn describe_criteria(policy: &LaunchPolicy, one_shot: Option<u64>) -> Vec<String> {
    let min = t("missions.scheduling.minutes");
    policy
        .connected_items()
        .into_iter()
        .map(|(conn, item)| {
            let line = match item {
                LaunchItem::Now => t("missions.scheduling.source.now").into(),
                LaunchItem::At(at, z) => format!(
                    "{} · {} · {z}",
                    t("missions.scheduling.frequency.at"),
                    format_ts(one_shot.unwrap_or(*at))
                ),
                LaunchItem::In(ms) => format!(
                    "{} · {} {min}",
                    t("missions.scheduling.frequency.in"),
                    ms / 60_000
                ),
                LaunchItem::Every(ms) => format!(
                    "{} · {} {min}",
                    t("missions.scheduling.frequency.every"),
                    ms / 60_000
                ),
                LaunchItem::Cron(e, z) => {
                    format!("{} · {e} · {z}", t("missions.scheduling.shortcut.cron"))
                }
                LaunchItem::Condition(k, lk, d) => {
                    let l = catalogue::message(locale(), lk).unwrap_or(k);
                    if d.is_empty() {
                        l.into()
                    } else {
                        format!("{l} · {d}")
                    }
                }
            };
            conn.map_or(line.clone(), |c| format!("{} · {line}", t(c)))
        })
        .collect()
}
fn opt_ts(ms: Option<u64>) -> String {
    ms.map_or_else(|| t("missions.scheduleList.none").into(), format_ts)
}
fn format_ts(millis: u64) -> String {
    date::short(millis as f64, locale()).unwrap_or_else(|| millis.to_string())
}
