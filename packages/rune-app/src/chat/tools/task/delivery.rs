use super::super::{Tool, string};
use crate::State;
use std::{collections::HashMap, sync::Arc};

#[derive(Default)]
pub(in crate::chat) struct DeliveryCache {
    fingerprint: u64,
    by_child: HashMap<String, ChildDeliveries>,
}

#[derive(Default)]
struct ChildDeliveries {
    launches: Vec<u64>,
    // Lightweight (created, row_index, part_index) refs; bodies stay owned by `s.messages`.
    reports: Vec<(u64, usize, usize)>,
}

impl DeliveryCache {
    pub(in crate::chat) fn retained_bytes(&self) -> usize {
        self.by_child.iter().fold(0usize, |total, (id, entry)| {
            total
                .saturating_add(id.len())
                .saturating_add(entry.launches.len().saturating_mul(size_of::<u64>()))
                .saturating_add(
                    entry
                        .reports
                        .len()
                        .saturating_mul(size_of::<(u64, usize, usize)>()),
                )
        })
    }

    pub(in crate::chat) fn clear(&mut self) {
        self.fingerprint = 0;
        self.by_child.clear();
    }

    fn refresh(&mut self, revision: u64, rows: &[crate::history::Row]) {
        use crate::content::Part;
        let mut fp = revision.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ (rows.len() as u64);
        for row in rows {
            fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                ^ (Arc::as_ptr(row) as usize as u64)
                ^ ((row.parts.len() as u64) << 1);
            for part in &row.parts {
                match part {
                    Part::Tool(tool) if is_task(tool) => {
                        fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                            ^ (Arc::as_ptr(tool) as usize as u64)
                            ^ launch_at(tool).unwrap_or(0)
                            ^ ((child(tool).len() as u64) << 4)
                            ^ (tool.status.len() as u64);
                    }
                    Part::SubagentReport(report) => {
                        fp = fp.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                            ^ report.created
                            ^ ((report.state.len() as u64) << 8)
                            ^ (report.child.len() as u64);
                    }
                    _ => {}
                }
            }
        }
        let fp = fp.max(1);
        if self.fingerprint == fp {
            return;
        }
        self.fingerprint = fp;
        self.by_child.clear();
        for (row_idx, row) in rows.iter().enumerate() {
            for (part_idx, part) in row.parts.iter().enumerate() {
                match part {
                    Part::Tool(other) if is_task(other) => {
                        let cid = child(other);
                        if !cid.is_empty()
                            && let Some(started) = launch_at(other)
                        {
                            self.by_child
                                .entry(cid.to_owned())
                                .or_default()
                                .launches
                                .push(started);
                        }
                    }
                    Part::SubagentReport(report) => {
                        self.by_child
                            .entry(report.child.clone())
                            .or_default()
                            .reports
                            .push((report.created, row_idx, part_idx));
                    }
                    _ => {}
                }
            }
        }
    }
}

pub(in crate::chat::tools) struct Delivery<'a> {
    pub status: &'static str,
    pub running: bool,
    pub ended: Option<u64>,
    pub report: Option<&'a crate::content::SubagentReport>,
    pub report_location: Option<(&'a str, usize)>,
    pub report_truncated: bool,
}

pub(in crate::chat::tools) fn is_task(tool: &Tool) -> bool {
    matches!(tool.name.as_str(), "task" | "subagent")
}

pub(in crate::chat::tools) fn detail(tool: &Tool) -> String {
    let description = string(&tool.input, &["description"]);
    let agent = string(&tool.input, &["subagent_type", "agent"]);
    if description.is_empty() {
        String::new()
    } else if agent.is_empty() {
        description.chars().take(250).collect()
    } else {
        format!("[{agent}] {description}")
            .chars()
            .take(250)
            .collect()
    }
}

pub(in crate::chat::tools) fn child(tool: &Tool) -> &str {
    string(&tool.metadata, &["sessionId", "sessionID"])
}

pub(in crate::chat::tools) fn parent_child(message: &str) -> Option<&str> {
    message
        .strip_prefix("child:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(parent, _)| parent)
}

fn launch_at(tool: &Tool) -> Option<u64> {
    tool.started.or(tool.message_created)
}

fn resolve_delivery<'a>(
    tool: &Tool,
    launches: &[u64],
    reports: &[(
        u64,
        &'a str,
        usize,
        &'a crate::content::SubagentReport,
        bool,
    )],
) -> Delivery<'a> {
    let report = launch_at(tool).and_then(|from| {
        let mut boundaries: Vec<_> = launches.iter().copied().filter(|at| *at > from).collect();
        boundaries.sort_unstable();
        let first = reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from)
            .map(|(created, _, _, _, _)| *created)
            .min()?;
        let end = boundaries
            .into_iter()
            .find(|next| *next > first)
            .unwrap_or(u64::MAX);
        reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from && *created < end)
            .max_by_key(|(created, id, _, _, _)| (*created, *id))
            .map(|(_, row_id, part_idx, report, truncated)| {
                (*row_id, *part_idx, *report, *truncated)
            })
    });
    let newest = launches.iter().copied().max().or_else(|| launch_at(tool));
    let latest = newest.and_then(|from| {
        reports
            .iter()
            .filter(|(created, _, _, _, _)| *created >= from)
            .max_by_key(|(created, id, _, _, _)| (*created, *id))
            .map(|(created, _, _, report, _)| (*created, report.state.as_str()))
    });
    let (status, running, ended) = match latest {
        Some((created, "completed")) => (
            "toolCall.status.completed",
            false,
            (created > 0).then_some(created),
        ),
        Some((created, "error" | "cancelled")) => (
            "toolCall.status.error",
            false,
            (created > 0).then_some(created),
        ),
        _ => ("toolCall.status.running", true, None),
    };
    let (report, report_location, report_truncated) = match report {
        Some((row_id, part_idx, report, truncated)) => {
            (Some(report), Some((row_id, part_idx)), truncated)
        }
        None => (None, None, false),
    };
    Delivery {
        status,
        running,
        ended,
        report,
        report_location,
        report_truncated,
    }
}

pub(in crate::chat::tools) fn delivery<'a>(
    s: &'a State,
    message: &str,
    tool: &Tool,
    ancestors: &[&str],
) -> Option<Delivery<'a>> {
    if tool.status != "completed" || tool.metadata["status"] != "running" {
        return None;
    }
    let child_id = child(tool);
    if child_id.is_empty() {
        return Some(Delivery {
            status: "toolCall.status.running",
            running: true,
            ended: None,
            report: None,
            report_location: None,
            report_truncated: false,
        });
    }
    if let Some(parent) = parent_child(message) {
        let owner_parent = ancestors.len().checked_sub(2).map(|i| ancestors[i]);
        let launches: Vec<u64> = s
            .transcript_display
            .children
            .steps(owner_parent, parent)
            .iter()
            .filter_map(|(_, other)| {
                (is_task(other) && child(other) == child_id)
                    .then_some(launch_at(other))
                    .flatten()
            })
            .collect();
        let reports: Vec<_> = s
            .transcript_display
            .children
            .reports(owner_parent, parent)
            .iter()
            .filter(|entry| entry.report.child == child_id)
            .map(|entry| {
                (
                    entry.report.created,
                    entry.row_id.as_str(),
                    entry.part_index,
                    entry.report.as_ref(),
                    entry.truncated,
                )
            })
            .collect();
        return Some(resolve_delivery(tool, &launches, &reports));
    }
    let rows = &s.messages[s.messages.len().saturating_sub(500)..];
    let mut cache = s.transcript_display.task_deliveries.borrow_mut();
    cache.refresh(s.revision, rows);
    let Some(entry) = cache.by_child.get(child_id) else {
        return Some(Delivery {
            status: "toolCall.status.running",
            running: true,
            ended: None,
            report: None,
            report_location: None,
            report_truncated: false,
        });
    };
    let reports: Vec<_> = entry
        .reports
        .iter()
        .filter_map(|&(created, row_idx, part_idx)| {
            let row = rows.get(row_idx)?;
            let crate::content::Part::SubagentReport(report) = row.parts.get(part_idx)? else {
                return None;
            };
            Some((created, row.id.as_str(), part_idx, report, false))
        })
        .collect();
    Some(resolve_delivery(tool, &entry.launches, &reports))
}

pub(in crate::chat::tools) fn output<'a>(
    tool: &'a Tool,
    report: Option<&'a crate::content::SubagentReport>,
) -> &'a str {
    if tool.status == "completed" && tool.metadata["status"] == "running" {
        report.map_or("", |report| report.body.as_str())
    } else {
        &tool.output
    }
}
