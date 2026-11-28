use super::*;

pub(super) fn snapshot_with_frozen(
    page: crate::history::Page,
    frozen_ends: &HashMap<(Option<String>, String), u64>,
) -> Snapshot {
    let mut snap = snapshot(page);
    for ((msg, call), &ts) in frozen_ends {
        let target = if let Some(msg) = msg.as_deref() {
            snap.steps
                .iter_mut()
                .find(|(row_id, tool)| row_id == msg && tool.id == *call)
        } else {
            snap.steps
                .iter_mut()
                .rev()
                .find(|(_, tool)| tool.id == *call)
        };
        if let Some((_, tool)) = target
            && matches!(tool.status.as_str(), "streaming" | "running")
            && tool.ended.is_none()
            && tool.started.is_none_or(|start| start <= ts)
        {
            Arc::make_mut(tool).ended = Some(ts);
        }
    }
    snap
}

pub(super) fn child_tool_settled(
    rows: &[crate::history::Row],
    message: Option<&str>,
    call: &str,
) -> bool {
    let tool = if let Some(msg) = message {
        rows.iter().find(|row| row.id == msg).and_then(|row| {
            row.parts.iter().find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
        })
    } else {
        rows.iter()
            .rev()
            .flat_map(|row| row.parts.iter().rev())
            .find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
    };
    tool.is_some_and(|tool| !matches!(tool.status.as_str(), "pending" | "streaming" | "running"))
}

pub(super) fn snapshot(page: crate::history::Page) -> Snapshot {
    let raw_tools: Vec<_> = page
        .rows
        .iter()
        .rev()
        .flat_map(|row| {
            row.parts.iter().rev().filter_map(move |part| match part {
                Part::Tool(tool) => Some((row, tool)),
                _ => None,
            })
        })
        .collect();
    let mut steps_truncated = raw_tools.len() > STEP_LIMIT;
    let mut raw_iter = raw_tools.into_iter();
    let kept_tools: Vec<_> = raw_iter.by_ref().take(STEP_LIMIT).collect();
    let total_tool_bytes: usize = kept_tools
        .iter()
        .map(|(_, tool)| tool.retained_bytes())
        .sum();
    let mut truncated_tools = HashSet::new();
    let mut truncated_tool_images_vec: Vec<(
        Box<str>,
        Box<str>,
        crate::chat::document::ToolImageShadows,
    )> = Vec::new();
    let mut dropped_tool_images_vec: Vec<crate::chat::document::ToolImageShadows> = Vec::new();
    let mut truncated_image_bytes = 0usize;
    let mut truncated_tool_images_overflow = false;
    let mut tools: Steps = if total_tool_bytes <= STEP_BYTES {
        kept_tools
            .into_iter()
            .map(|(row, tool)| (row.id.clone(), tool.clone()))
            .collect()
    } else {
        steps_truncated = true;
        // Shortest-first water-filling keeps smaller steps intact beside an oversized step.
        let mut order: Vec<usize> = (0..kept_tools.len()).collect();
        order.sort_by_key(|&i| kept_tools[i].1.retained_bytes());
        let mut caps = vec![0usize; kept_tools.len()];
        let mut rem = STEP_BYTES;
        for (pos, &idx) in order.iter().enumerate() {
            let share = rem / (order.len() - pos);
            let size = kept_tools[idx].1.retained_bytes();
            let take = size.min(share);
            caps[idx] = take;
            rem -= take;
        }
        kept_tools
            .into_iter()
            .enumerate()
            .map(|(idx, (row, tool))| {
                let cap = caps[idx];
                let bounded = if tool.retained_bytes() <= cap {
                    tool.clone()
                } else {
                    let newly_truncated = truncated_tools.insert((row.id.clone(), tool.id.clone()));
                    if newly_truncated && !truncated_tool_images_overflow {
                        let shadows = crate::chat::document::tool_image_paths(tool);
                        if !shadows.is_empty() {
                            let too_long = shadows
                                .iter()
                                .flat_map(|group| group.iter())
                                .any(|p| p.len() > MAX_TRUNCATED_IMAGE_PATH_BYTES);
                            let bytes = truncated_image_entry_bytes(&row.id, &tool.id, &shadows);
                            if too_long
                                || truncated_image_bytes.saturating_add(bytes)
                                    > MAX_TRUNCATED_IMAGE_SNAPSHOT_BYTES
                            {
                                truncated_tool_images_overflow = true;
                                truncated_tool_images_vec.clear();
                            } else {
                                truncated_image_bytes += bytes;
                                truncated_tool_images_vec.push((
                                    row.id.as_str().into(),
                                    tool.id.as_str().into(),
                                    shadows,
                                ));
                            }
                        }
                    }
                    Arc::new(tool.with_budget(cap))
                };
                (row.id.clone(), bounded)
            })
            .collect()
    };
    if !truncated_tool_images_overflow {
        for (_, tool) in raw_iter {
            let shadows = crate::chat::document::tool_image_paths(tool);
            if shadows.is_empty() {
                continue;
            }
            let too_long = shadows
                .iter()
                .flat_map(|group| group.iter())
                .any(|p| p.len() > MAX_TRUNCATED_IMAGE_PATH_BYTES);
            let bytes = dropped_image_entry_bytes(&shadows);
            if too_long
                || truncated_image_bytes.saturating_add(bytes) > MAX_TRUNCATED_IMAGE_SNAPSHOT_BYTES
            {
                truncated_tool_images_overflow = true;
                truncated_tool_images_vec.clear();
                dropped_tool_images_vec.clear();
                break;
            }
            truncated_image_bytes += bytes;
            dropped_tool_images_vec.push(shadows);
        }
    }
    truncated_tool_images_vec.sort_unstable_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    let truncated_tool_images = truncated_tool_images_vec.into_boxed_slice();
    let dropped_tool_images = dropped_tool_images_vec.into_boxed_slice();
    tools.reverse();
    let raw_reports: Vec<_> =
        page.rows
            .iter()
            .rev()
            .flat_map(|row| {
                row.parts.iter().enumerate().rev().filter_map(
                    move |(part_index, part)| match part {
                        Part::SubagentReport(report) => Some((row, part_index, report)),
                        _ => None,
                    },
                )
            })
            .take(STEP_LIMIT)
            .collect();
    // Shortest-first water-filling keeps short older reports intact even beside giant ones.
    let mut order: Vec<usize> = (0..raw_reports.len()).collect();
    order.sort_by_key(|&i| raw_reports[i].2.body.len());
    let mut caps = vec![0usize; raw_reports.len()];
    let mut report_bytes = STEP_BYTES;
    for (pos, &idx) in order.iter().enumerate() {
        let share = report_bytes / (order.len() - pos);
        let len = raw_reports[idx].2.body.len();
        let take = len.min(share);
        caps[idx] = take;
        report_bytes -= take;
    }
    let mut reports: Reports = raw_reports
        .into_iter()
        .enumerate()
        .map(|(idx, (row, part_index, report))| {
            let cap = caps[idx];
            let (body, truncated) = if report.body.len() <= cap {
                (report.body.clone(), false)
            } else {
                let end = report.body.floor_char_boundary(cap);
                (report.body[..end].to_owned(), true)
            };
            ChildReport {
                row_id: row.id.clone(),
                part_index,
                report: Arc::new(SubagentReport {
                    child: report.child.clone(),
                    state: report.state.clone(),
                    body,
                    created: report.created,
                }),
                truncated,
            }
        })
        .collect();
    reports.reverse();
    Snapshot {
        steps: tools,
        steps_truncated,
        steps_incomplete: steps_truncated || page.older.is_some(),
        older_pages: page.older.is_some(),
        truncated_tools,
        truncated_tool_images,
        dropped_tool_images,
        truncated_tool_images_overflow,
        reports,
    }
}

pub(super) fn same_synthetic_report(a: &crate::history::Row, b: &crate::history::Row) -> bool {
    if a.role != "synthetic" || b.role != "synthetic" {
        return false;
    }
    fn report(row: &crate::history::Row) -> Option<&SubagentReport> {
        row.parts.iter().find_map(|part| match part {
            Part::SubagentReport(r) => Some(r),
            _ => None,
        })
    }
    match (report(a), report(b)) {
        (Some(ra), Some(rb)) => ra.child == rb.child && ra.state == rb.state && ra.body == rb.body,
        _ => false,
    }
}
