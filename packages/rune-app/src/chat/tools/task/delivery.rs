use super::{child, child_chain, is_task};
use crate::{State, chat::tools::children::split_chain, content::Tool};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::chat::tools) struct HeaderStatus {
    pub status: &'static str,
    pub running: bool,
    pub ended: Option<u64>,
}

#[derive(Clone, Copy)]
pub(in crate::chat::tools) struct Delivery<'a> {
    pub status: HeaderStatus,
    pub body: Option<&'a str>,
    pub body_truncated: bool,
}

#[derive(Clone, Copy)]
struct Launch<'a> {
    pos: usize,
    row_id: &'a str,
    call_id: &'a str,
    at: Option<u64>,
}

#[derive(Clone, Copy)]
struct ReportEntry<'a> {
    pos: usize,
    row_id: &'a str,
    state: &'a str,
    created: u64,
    body: Option<&'a str>,
    body_truncated: bool,
}

fn launch_time(tool: &Tool) -> Option<u64> {
    tool.started.or(tool.message_created).filter(|&at| at > 0)
}

fn message_row_id(message: &str) -> &str {
    message
        .strip_prefix("child:")
        .and_then(|rest| rest.split_once(':'))
        .map_or(message, |(_, id)| id)
}

fn report_at_or_after_launch(report: &ReportEntry<'_>, launch: &Launch<'_>) -> bool {
    match (report.created > 0, launch.at) {
        (true, Some(at)) => {
            report.created > at || (report.created == at && report.pos >= launch.pos)
        }
        _ => report.pos >= launch.pos,
    }
}

fn launch_strictly_after_launch(later: &Launch<'_>, earlier: &Launch<'_>) -> bool {
    match (later.at, earlier.at) {
        (Some(lt), Some(et)) => lt > et || (lt == et && later.pos > earlier.pos),
        _ => later.pos > earlier.pos,
    }
}

fn launch_strictly_after_report(launch: &Launch<'_>, report: &ReportEntry<'_>) -> bool {
    match (launch.at, report.created > 0) {
        (Some(lt), true) => {
            lt > report.created || (lt == report.created && launch.pos > report.pos)
        }
        _ => launch.pos > report.pos,
    }
}

fn report_before_launch(report: &ReportEntry<'_>, launch: &Launch<'_>) -> bool {
    match (report.created > 0, launch.at) {
        (true, Some(lt)) => {
            report.created < lt || (report.created == lt && report.pos < launch.pos)
        }
        _ => report.pos < launch.pos,
    }
}

fn launches_and_reports<'a>(
    s: &'a State,
    message: &str,
    child_id: &str,
) -> (Vec<Launch<'a>>, Vec<ReportEntry<'a>>) {
    use crate::content::Part;
    let mut launches = Vec::new();
    let mut reports = Vec::new();
    if let Some(chain) = child_chain(message) {
        let (parent, owner) = split_chain(chain);
        if let Some(snap) = s.transcript_display.children.snapshot(parent, owner) {
            for (index, (row_id, other)) in snap.steps.iter().enumerate() {
                if is_task(other) && child(other) == child_id {
                    launches.push(Launch {
                        pos: snap.step_ordinals.get(index).copied().unwrap_or(index),
                        row_id: row_id.as_str(),
                        call_id: other.id.as_str(),
                        at: launch_time(other),
                    });
                }
            }
            for report in &snap.reports {
                if report.child == child_id {
                    reports.push(ReportEntry {
                        pos: report.ordinal,
                        row_id: report.row_id.as_str(),
                        state: report.state.as_str(),
                        created: report.created,
                        body: report.body.as_deref(),
                        body_truncated: report.body_truncated,
                    });
                }
            }
        }
        return (launches, reports);
    }
    let mut pos = 0usize;
    for row in &s.messages[s.messages.len().saturating_sub(500)..] {
        for part in &row.parts {
            match part {
                Part::Tool(other) if is_task(other) && child(other) == child_id => {
                    launches.push(Launch {
                        pos,
                        row_id: row.id.as_str(),
                        call_id: other.id.as_str(),
                        at: launch_time(other),
                    });
                }
                Part::SubagentReport(report) if report.child == child_id => {
                    reports.push(ReportEntry {
                        pos,
                        row_id: row.id.as_str(),
                        state: report.state.as_str(),
                        created: report.created,
                        body: Some(report.body.as_str()),
                        body_truncated: false,
                    });
                }
                _ => {}
            }
            pos += 1;
        }
    }
    (launches, reports)
}

pub(in crate::chat::tools) fn delivery<'a>(
    s: &'a State,
    message: &str,
    tool: &Tool,
) -> Option<Delivery<'a>> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let child_id = child(tool);
    if child_id.is_empty() {
        return Some(Delivery {
            status: HeaderStatus {
                status: "toolCall.status.running",
                running: true,
                ended: None,
            },
            body: None,
            body_truncated: false,
        });
    }
    let row_id = message_row_id(message);
    let (launches, reports) = launches_and_reports(s, message, child_id);
    let current = launches
        .iter()
        .copied()
        .find(|launch| launch.row_id == row_id && launch.call_id == tool.id)
        .or_else(|| {
            launch_time(tool).map(|at| Launch {
                pos: 0,
                row_id: "",
                call_id: "",
                at: Some(at),
            })
        });
    let reports_timed = reports.iter().all(|report| report.created > 0);
    let report_order = |report: &ReportEntry<'_>| {
        if reports_timed {
            (report.created, report.pos)
        } else {
            (0, report.pos)
        }
    };
    let chosen_report = current.and_then(|current| {
        let first = reports
            .iter()
            .copied()
            .filter(|report| report_at_or_after_launch(report, &current))
            .min_by_key(|report| (report_order(report), report.row_id))?;
        let boundaries: Vec<Launch<'_>> = launches
            .iter()
            .copied()
            .filter(|launch| {
                launch_strictly_after_launch(launch, &current)
                    && launch_strictly_after_report(launch, &first)
            })
            .collect();
        reports
            .iter()
            .copied()
            .filter(|report| {
                report_at_or_after_launch(report, &current)
                    && boundaries
                        .iter()
                        .all(|boundary| report_before_launch(report, boundary))
            })
            .max_by_key(|report| (report_order(report), report.row_id))
    });
    let latest = current.and_then(|current| {
        reports
            .iter()
            .copied()
            .filter(|report| {
                report_at_or_after_launch(report, &current)
                    && launches
                        .iter()
                        .all(|launch| report_at_or_after_launch(report, launch))
            })
            .max_by_key(|report| (report_order(report), report.row_id))
            .map(|report| (report.created, report.state))
    });
    let status = match latest {
        Some((created, "completed")) => HeaderStatus {
            status: "toolCall.status.completed",
            running: false,
            ended: (created > 0).then_some(created),
        },
        Some((created, "error" | "cancelled")) => HeaderStatus {
            status: "toolCall.status.error",
            running: false,
            ended: (created > 0).then_some(created),
        },
        _ => HeaderStatus {
            status: "toolCall.status.running",
            running: true,
            ended: None,
        },
    };
    Some(Delivery {
        status,
        body: chosen_report.and_then(|report| report.body),
        body_truncated: chosen_report.is_some_and(|report| report.body_truncated),
    })
}

pub(in crate::chat::tools) fn report_body<'a>(
    s: &'a State,
    message: &str,
    tool: &Tool,
) -> Option<&'a str> {
    delivery(s, message, tool).and_then(|d| d.body)
}

pub(in crate::chat::tools) fn output<'a>(tool: &'a Tool, report: Option<&'a str>) -> &'a str {
    if tool.status == "completed" && tool.metadata["status"] == "running" {
        report.unwrap_or("")
    } else {
        &tool.output
    }
}
