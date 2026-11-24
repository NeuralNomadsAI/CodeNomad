use crate::components::diff;

pub(super) fn parse_patch(patch: &str, path: &str) -> Vec<diff::FileDiff> {
    let mut patch = patch.trim_start();
    if let Some((fence, body)) = patch.split_once('\n')
        && fence.starts_with("```")
        && let Some((body, end)) = body.trim_end().rsplit_once('\n')
        && end.starts_with("```")
    {
        patch = body;
    }
    let mut lines = patch.lines().peekable();
    if lines.peek() == Some(&"*** Begin Patch") {
        lines.next();
        while lines.next_if(|line| line.trim().is_empty()).is_some() {}
    }
    if lines
        .peek()
        .is_some_and(|line| line.starts_with("*** Update File: "))
    {
        let mut unified = String::new();
        let (mut old, mut new) = (1, 1);
        while let Some(line) = lines.next() {
            if let Some(path) = line.strip_prefix("*** Update File: ") {
                let path = path.trim();
                if path.is_empty() {
                    return vec![];
                }
                unified.push_str(&format!(
                    "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
                ));
                (old, new) = (1, 1);
            } else if is_hunk(line) && !line.starts_with("@@ -") {
                // Unnumbered historical hunks have only the shown context and changes.
                let offset = unified.len();
                let (mut removed, mut added) = (0, 0);
                while let Some(body) = lines.next_if(|line| line.starts_with([' ', '+', '-', '\\']))
                {
                    removed += usize::from(body.starts_with([' ', '-']));
                    added += usize::from(body.starts_with([' ', '+']));
                    unified.push_str(body);
                    unified.push('\n');
                }
                let a = old - usize::from(removed == 0);
                let b = new - usize::from(added == 0);
                unified.insert_str(offset, &format!("@@ -{a},{removed} +{b},{added} @@\n"));
                (old, new) = (old + removed, new + added);
            } else if line != "*** End Patch" {
                unified.push_str(line);
                unified.push('\n');
            }
        }
        parse_complete(&unified)
    } else if patch.starts_with("@@ ") && !path.contains(['\r', '\n']) && !path.is_empty() {
        parse_complete(&format!("--- a/{path}\n+++ b/{path}\n{patch}"))
    } else {
        parse_complete(patch)
    }
}

fn parse_complete(patch: &str) -> Vec<diff::FileDiff> {
    let Some(expected) = check_patch(patch) else {
        return vec![];
    };
    let files = diff::parse(patch);
    if files.iter().map(|file| file.hunks.len()).sum::<usize>() == expected {
        files
    } else {
        vec![]
    }
}

/// Keep the original patch when counts disagree or word comparison exceeds the UI budget.
fn check_patch(patch: &str) -> Option<usize> {
    const COMPARE_LIMIT: usize = 2_000_000;
    // Chunked highlighting in the pinned Kit requires the next 128-line boundary to fit.
    const MAX_LINE: u32 = u32::MAX - 127;
    let (mut hunks, mut remaining, mut cost) = (0, None, 0_usize);
    let mut removed = 0_usize;
    let mut added = 0_usize;
    let mut max_span = 0_usize;
    // Myers can visit O((old_len + new_len)^2) states for each paired line.
    let comparisons = |old: usize, new: usize, width: usize| {
        old.min(new)
            .saturating_mul(width.saturating_mul(2).saturating_pow(2))
    };
    let mut lines = patch.lines().peekable();
    while let Some(line) = lines.next() {
        if is_hunk(line)
            || line.starts_with("diff --git ")
            || (remaining == Some([0, 0])
                && line.starts_with("--- ")
                && lines.peek().is_some_and(|next| next.starts_with("+++ ")))
            || !line.starts_with([' ', '+', '-', '\\']) && !line.is_empty()
        {
            if remaining.is_some_and(|counts| counts != [0, 0]) {
                return None;
            }
            remaining = None;
            if is_hunk(line) {
                let (ranges, _) = line.strip_prefix("@@ -")?.split_once(" @@")?;
                let (old, new) = ranges.split_once(" +")?;
                let count = |range: &str| {
                    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
                    let (start, count) = (start.parse::<u32>().ok()?, count.parse::<u32>().ok()?);
                    (start.saturating_add(count) <= MAX_LINE).then_some(count)
                };
                remaining = Some([count(old)?, count(new)?]);
                hunks += 1;
            }
        } else if let Some(counts) = &mut remaining {
            match line.as_bytes().first() {
                Some(b'\\') => continue,
                Some(b'-') => {
                    counts[0] = counts[0].checked_sub(1)?;
                    removed += 1;
                }
                Some(b'+') => {
                    counts[1] = counts[1].checked_sub(1)?;
                    added += 1;
                }
                _ if line.is_empty() && *counts == [0, 0] => {}
                _ => {
                    counts[0] = counts[0].checked_sub(1)?;
                    counts[1] = counts[1].checked_sub(1)?;
                }
            }
            if line.starts_with(['-', '+']) {
                max_span = max_span.max(line.len() - 1);
                continue;
            }
        }
        cost = cost.saturating_add(comparisons(removed, added, max_span));
        if cost > COMPARE_LIMIT {
            return None;
        }
        (removed, added, max_span) = (0, 0, 0);
    }
    cost = cost.saturating_add(comparisons(removed, added, max_span));
    (remaining.is_none_or(|counts| counts == [0, 0]) && cost <= COMPARE_LIMIT).then_some(hunks)
}

pub(in crate::chat) fn is_hunk(line: &str) -> bool {
    line == "@@" || line.starts_with("@@ ")
}
