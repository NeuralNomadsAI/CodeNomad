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
    let all_timed = launches.iter().all(|launch| launch.at.is_some())
        && reports.iter().all(|report| report.created > 0)
        && current.is_none_or(|launch| launch.at.is_some());
    let launch_key = |launch: &Launch<'_>| {
        if all_timed {
            (launch.at.unwrap_or(0), launch.pos)
        } else {
            (0, launch.pos)
        }
    };
    let report_key = |report: &ReportEntry<'_>| {
        if all_timed {
            (report.created, report.pos)
        } else {
            (0, report.pos)
        }
    };
    let body = current.and_then(|current| {
        let cur_key = launch_key(&current);
        let mut later: Vec<_> = launches
            .iter()
            .map(launch_key)
            .filter(|&key| key > cur_key)
            .collect();
        later.sort_unstable();
        let first = reports
            .iter()
            .copied()
            .filter(|report| report_key(report) >= cur_key)
            .min_by_key(|report| (report_key(report), report.row_id))?;
        let first_key = report_key(&first);
        let boundary = later.into_iter().find(|&key| key > first_key);
        reports
            .iter()
            .copied()
            .filter(|report| {
                let key = report_key(report);
                key >= cur_key && boundary.is_none_or(|end| key < end)
            })
            .max_by_key(|report| (report_key(report), report.row_id))
            .and_then(|report| report.body)
    });
    let latest = current.and_then(|current| {
        let cur_key = launch_key(&current);
        let newest = launches
            .iter()
            .map(launch_key)
            .max()
            .map_or(cur_key, |max| max.max(cur_key));
        reports
            .iter()
            .copied()
            .filter(|report| report_key(report) >= newest)
            .max_by_key(|report| (report_key(report), report.row_id))
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
    Some(Delivery { status, body })
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
