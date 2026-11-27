use super::{
    Error, MAX_BYTES, MAX_DRAFT, MAX_DRAFTS, MAX_STRINGS, NO_SESSION_DRAFT_ID, Snapshot, Tab,
    Workspace, draft_id, encode, is_recovered_draft_id, snapshot_budget::choose, snapshot_bytes,
    snapshot_string_units, validate,
};
use crate::composer::draft_storage::SavedParts;
use std::cmp::Reverse;

pub(super) fn encode_for_save(snapshot: &Snapshot) -> Result<(Vec<u8>, bool), Error> {
    if let Ok(bytes) = encode(snapshot) {
        return Ok((bytes, false));
    }
    let mut valid = snapshot.clone();
    for tab in &mut valid.tabs {
        let Tab::Workspace(saved) = tab else { continue };
        saved.project_name = saved
            .project_name
            .as_deref()
            .and_then(super::normalize_project_name);
        let mut shell = saved.clone();
        shell.drafts.clear();
        shell.attachment_drafts.clear();
        shell.attachment_parts.clear();
        if validate(&Snapshot {
            revision: snapshot.revision,
            saved_at: snapshot.saved_at,
            panel_widths: snapshot.panel_widths,
            file_wrap: snapshot.file_wrap,
            tabs: vec![Tab::Workspace(shell)],
            active: Some(0),
        })
        .is_err()
        {
            *tab = Tab::Blank;
            continue;
        }
        saved
            .drafts
            .retain(|id, text| draft_id(id) && text.encode_utf16().nth(MAX_DRAFT).is_none());
        while saved.drafts.len() > MAX_DRAFTS {
            let Some(id) = saved
                .drafts
                .iter()
                .max_by_key(|(id, text)| {
                    (
                        Reverse(cap_priority(saved, id)),
                        text.encode_utf16().count(),
                        id.as_str(),
                    )
                })
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            saved.drafts.remove(&id);
            saved.attachment_drafts.remove(&id);
            saved.attachment_parts.remove(&id);
        }
        saved
            .attachment_drafts
            .extend(saved.attachment_parts.keys().cloned());
        saved.attachment_drafts.retain(|id| draft_id(id));
        saved
            .attachment_parts
            .retain(|id, parts| saved.attachment_drafts.contains(id) && parts.valid());
        while saved.attachment_drafts.len() > MAX_DRAFTS {
            let Some(id) = saved
                .attachment_drafts
                .iter()
                .max_by_key(|id| {
                    let part_len = saved
                        .attachment_parts
                        .get(id.as_str())
                        .and_then(|parts| part_bytes(parts).ok())
                        .unwrap_or(0);
                    (
                        Reverse(cap_priority(saved, id)),
                        !saved.drafts.contains_key(id.as_str()),
                        part_len,
                        id.as_str(),
                    )
                })
                .cloned()
            else {
                break;
            };
            saved.attachment_drafts.remove(&id);
            saved.attachment_parts.remove(&id);
            // Never leave a retained text draft stripped of its attachment marker/parts.
            saved.drafts.remove(&id);
        }
    }
    fit_text(&mut valid)?;
    fit_parts(&mut valid).map(|bytes| (bytes, true))
}

fn cap_priority(saved: &Workspace, id: &str) -> u8 {
    if saved.active_session_id.as_deref() == Some(id) {
        3
    } else if id == NO_SESSION_DRAFT_ID {
        2
    } else if is_recovered_draft_id(id) {
        1
    } else {
        0
    }
}

fn priority(active: bool, saved: &Workspace, id: &str) -> u8 {
    let rank = cap_priority(saved, id);
    if rank == 0 {
        0
    } else if active {
        rank + 3
    } else {
        rank
    }
}

struct TextItem {
    tab: usize,
    id: String,
    priority: u8,
    text_only_units: usize,
    whole_units: usize,
    has_text: bool,
    has_attachment: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MixedAction {
    Keep,
    TextOnly,
    DropWhole,
}

const MAX_DP_CELLS: usize = 2_000_000;

fn select_mixed_tier(
    items: &[TextItem],
    eligible: &[usize],
    excess: usize,
    max_dp_cells: usize,
) -> Option<Vec<MixedAction>> {
    let sum_whole: usize = eligible.iter().map(|&idx| items[idx].whole_units).sum();
    if sum_whole < excess {
        return None;
    }
    let keep_budget = sum_whole - excess;
    let dp_stride = keep_budget + 1;
    if eligible.len().saturating_mul(dp_stride) <= max_dp_cells {
        // Pack (marker_score, text_score): 16 bits per tier for retained attachment markers,
        // and 18 bits per tier for retained text units (MAX_STRINGS < 2^17) to break ties by
        // priority rank when marker score and total retained weight are equal.
        let mut best: Vec<Option<(u128, u128)>> = vec![None; dp_stride];
        best[0] = Some((0, 0));
        let mut choices = vec![0u8; eligible.len() * dp_stride];
        for (row, &item_idx) in eligible.iter().enumerate() {
            let item = &items[item_idx];
            let mixed = item.has_text && item.has_attachment;
            let marker_cost = item.whole_units.saturating_sub(item.text_only_units);
            let full_cost = item.whole_units;
            let marker_bonus = if item.has_attachment {
                1u128 << (usize::from(item.priority.min(7)) * 16)
            } else {
                0u128
            };
            let text_bonus = if item.has_text {
                (u128::try_from(item.text_only_units)
                    .unwrap_or(0)
                    .min((1u128 << 18) - 1))
                    << (usize::from(item.priority.min(6)) * 18)
            } else {
                0u128
            };
            let row_offset = row * dp_stride;
            for w in (0..=keep_budget).rev() {
                let mut current = best[w];
                let mut chosen = 0u8;
                if mixed
                    && marker_cost > 0
                    && w >= marker_cost
                    && let Some((prev_m, prev_t)) = best[w - marker_cost]
                {
                    let candidate = (prev_m.saturating_add(marker_bonus), prev_t);
                    if current.is_none_or(|cur| candidate > cur) {
                        current = Some(candidate);
                        chosen = 1;
                    }
                }
                if full_cost > 0
                    && w >= full_cost
                    && let Some((prev_m, prev_t)) = best[w - full_cost]
                {
                    let candidate = (
                        prev_m.saturating_add(marker_bonus),
                        prev_t.saturating_add(text_bonus),
                    );
                    if current.is_none_or(|cur| candidate > cur) {
                        current = Some(candidate);
                        chosen = 2;
                    }
                }
                best[w] = current;
                choices[row_offset + w] = chosen;
            }
        }
        let mut w = (0..=keep_budget)
            .filter_map(|weight| {
                best[weight].map(|(markers, text_prio)| ((markers, weight, text_prio), weight))
            })
            .max()
            .map(|(_, weight)| weight)
            .unwrap_or(0);
        let mut actions = vec![MixedAction::DropWhole; eligible.len()];
        for (row, &item_idx) in eligible.iter().enumerate().rev() {
            let item = &items[item_idx];
            match choices[row * dp_stride + w] {
                2 => {
                    w -= item.whole_units;
                    actions[row] = MixedAction::Keep;
                }
                1 => {
                    w -= item.whole_units.saturating_sub(item.text_only_units);
                    actions[row] = MixedAction::TextOnly;
                }
                _ => {}
            }
        }
        return Some(actions);
    }

    // Beyond the DP cell limit, preserve the same objective in O(N log N):
    // Phase A maximizes retained attachment markers (mixed and attachment-only alike,
    // highest priority tier first, smallest marker cost first); Phase B restores as much
    // dropped text as fits in any leftover budget.
    let mut actions = vec![MixedAction::DropWhole; eligible.len()];
    let mut remaining = keep_budget;
    let mut marker_rows: Vec<(usize, usize)> = eligible
        .iter()
        .enumerate()
        .filter_map(|(row, &item_idx)| {
            let item = &items[item_idx];
            if !item.has_attachment {
                return None;
            }
            let cost = if item.has_text {
                item.whole_units.saturating_sub(item.text_only_units)
            } else {
                item.whole_units
            };
            Some((row, cost))
        })
        .collect();
    marker_rows.sort_by_key(|&(row, cost)| (Reverse(items[eligible[row]].priority), cost));
    for (row, cost) in marker_rows {
        if cost <= remaining {
            remaining -= cost;
            actions[row] = if items[eligible[row]].has_text {
                MixedAction::TextOnly
            } else {
                MixedAction::Keep
            };
        }
    }
    let mut text_rows: Vec<(u8, usize, usize)> = eligible
        .iter()
        .enumerate()
        .filter_map(|(row, &item_idx)| {
            let item = &items[item_idx];
            if !item.has_text || actions[row] == MixedAction::Keep {
                return None;
            }
            let extra_cost = if actions[row] == MixedAction::TextOnly {
                item.text_only_units
            } else {
                item.whole_units
            };
            (extra_cost > 0 && extra_cost <= remaining).then_some((item.priority, row, extra_cost))
        })
        .collect();
    if remaining > 0 && !text_rows.is_empty() {
        const MAX_LEFTOVER_DP_CELLS: usize = 262_144;
        let stride = remaining + 1;
        if text_rows.len().saturating_mul(stride) <= MAX_LEFTOVER_DP_CELLS {
            text_rows.sort_by_key(|&(prio, _, cost)| (Reverse(prio), Reverse(cost)));
            // Priority ranks are 0..=6 and MAX_STRINGS < 2^17, so 18 bits per tier pack exact
            // lexicographic retained text units per priority tier into one u128.
            let mut best: Vec<Option<u128>> = vec![None; stride];
            best[0] = Some(0);
            let mut take = vec![false; text_rows.len() * stride];
            for (idx, &(prio, _, cost)) in text_rows.iter().enumerate() {
                let tier_bonus = (u128::try_from(cost).unwrap_or(0).min((1u128 << 18) - 1))
                    << (usize::from(prio.min(6)) * 18);
                let row_offset = idx * stride;
                for w in (cost..=remaining).rev() {
                    if let Some(prev) = best[w - cost] {
                        let candidate = prev.saturating_add(tier_bonus);
                        if best[w].is_none_or(|cur| candidate > cur) {
                            best[w] = Some(candidate);
                            take[row_offset + w] = true;
                        }
                    }
                }
            }
            let mut w = (1..=remaining)
                .rev()
                .find(|&weight| best[weight].is_some())
                .unwrap_or(0);
            for (idx, &(_, row, cost)) in text_rows.iter().enumerate().rev() {
                if w >= cost && take[idx * stride + w] {
                    actions[row] = MixedAction::Keep;
                    w -= cost;
                }
            }
        } else {
            text_rows.sort_by_key(|&(prio, _, cost)| (Reverse(cost), Reverse(prio)));
            for (_, row, cost) in text_rows {
                if cost <= remaining {
                    remaining -= cost;
                    actions[row] = MixedAction::Keep;
                }
            }
        }
    }
    Some(actions)
}

fn fit_text(snapshot: &mut Snapshot) -> Result<(), Error> {
    super::drop_excess_project_names(snapshot)?;
    let excess = snapshot_string_units(snapshot)?.saturating_sub(MAX_STRINGS);
    if excess == 0 {
        return Ok(());
    }
    let mut items = Vec::new();
    for (tab, entry) in snapshot.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        let active = snapshot.active == Some(tab);
        for (id, text) in &saved.drafts {
            let id_units = id.encode_utf16().count();
            let text_only_units = id_units + text.encode_utf16().count();
            let has_attachment = saved.attachment_drafts.contains(id);
            items.push(TextItem {
                tab,
                id: id.clone(),
                priority: priority(active, saved, id),
                text_only_units,
                whole_units: if has_attachment {
                    text_only_units + id_units
                } else {
                    text_only_units
                },
                has_text: true,
                has_attachment,
            });
        }
        for id in &saved.attachment_drafts {
            if saved.drafts.contains_key(id) {
                continue;
            }
            let id_units = id.encode_utf16().count();
            items.push(TextItem {
                tab,
                id: id.clone(),
                priority: priority(active, saved, id),
                text_only_units: id_units,
                whole_units: id_units,
                has_text: false,
                has_attachment: true,
            });
        }
    }
    let max_tier = items.iter().map(|item| item.priority).max().unwrap_or(0);
    for tier in 0..=max_tier {
        // First try preserving every attachment marker (mixed and standalone) across all
        // priorities <= `tier` by shedding only text.
        let text_weights: Vec<(u8, usize)> = items
            .iter()
            .map(|item| {
                (
                    item.priority,
                    if item.priority > tier || !item.has_text {
                        0
                    } else {
                        item.text_only_units
                    },
                )
            })
            .collect();
        if let Some(selected) = choose(&text_weights, excess) {
            for index in selected {
                let item = &items[index];
                if let Tab::Workspace(saved) = &mut snapshot.tabs[item.tab] {
                    saved.drafts.remove(&item.id);
                    if let Some(parts) = saved.attachment_parts.get_mut(&item.id) {
                        parts.mark_incomplete();
                    }
                }
            }
            return Ok(());
        }

        // Shedding text and standalone markers at `<= tier` cannot cover `excess`: choose
        // Keep / TextOnly / DropWhole per draft across all `priority <= tier`.
        let eligible: Vec<usize> = items
            .iter()
            .enumerate()
            .filter_map(|(idx, item)| (item.priority <= tier).then_some(idx))
            .collect();
        let Some(actions) = select_mixed_tier(&items, &eligible, excess, MAX_DP_CELLS) else {
            continue;
        };
        for (row, action) in actions.into_iter().enumerate() {
            let item = &items[eligible[row]];
            match action {
                MixedAction::Keep => {}
                MixedAction::TextOnly => {
                    if let Tab::Workspace(saved) = &mut snapshot.tabs[item.tab] {
                        saved.drafts.remove(&item.id);
                        if let Some(parts) = saved.attachment_parts.get_mut(&item.id) {
                            parts.mark_incomplete();
                        }
                    }
                }
                MixedAction::DropWhole => {
                    if let Tab::Workspace(saved) = &mut snapshot.tabs[item.tab] {
                        if item.has_text {
                            saved.drafts.remove(&item.id);
                        }
                        if item.has_attachment {
                            saved.attachment_drafts.remove(&item.id);
                            saved.attachment_parts.remove(&item.id);
                        }
                    }
                }
            }
        }
        return Ok(());
    }
    Err(Error::Limit)
}

fn fit_parts(snapshot: &mut Snapshot) -> Result<Vec<u8>, Error> {
    let mut bytes = snapshot_bytes(snapshot)?;
    if bytes.len() > MAX_BYTES {
        for index in super::project_name_drop_order(snapshot) {
            let changed = match &mut snapshot.tabs[index] {
                Tab::Workspace(saved) => saved.project_name.take().is_some(),
                Tab::Blank => false,
            };
            if changed {
                bytes = snapshot_bytes(snapshot)?;
                if bytes.len() <= MAX_BYTES {
                    return Ok(bytes);
                }
            }
        }
    }
    let excess = bytes.len().saturating_sub(MAX_BYTES);
    if excess == 0 {
        return Ok(bytes);
    }
    let mut payloads = Vec::new();
    for (tab, entry) in snapshot.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        for (id, parts) in &saved.attachment_parts {
            let size = part_bytes(parts)?;
            let mut trimmed = parts.clone();
            let trim = if trimmed.discard_pasted_text() {
                size.saturating_sub(part_bytes(&trimmed)?)
            } else {
                0
            };
            let clear = size.saturating_sub(part_bytes(&SavedParts::missing())?);
            payloads.push((
                tab,
                id.clone(),
                priority(snapshot.active == Some(tab), saved, id),
                trim,
                trimmed,
                clear,
            ));
        }
    }
    let max_tier = payloads.iter().map(|p| p.2).max().unwrap_or(0);
    for tier in 0..=max_tier {
        for only_paste in [true, false] {
            let weights = payloads
                .iter()
                .map(|(_, _, priority, trim, _, clear)| {
                    (
                        *priority,
                        if *priority > tier {
                            0
                        } else if only_paste {
                            *trim
                        } else {
                            *clear
                        },
                    )
                })
                .collect::<Vec<_>>();
            let Some(selected) = choose(&weights, excess) else {
                continue;
            };
            for index in selected {
                let (tab, id, _, _, trimmed, _) = &payloads[index];
                if let Tab::Workspace(saved) = &mut snapshot.tabs[*tab] {
                    saved.attachment_parts.insert(
                        id.clone(),
                        if only_paste {
                            trimmed.clone()
                        } else {
                            SavedParts::missing()
                        },
                    );
                }
            }
            return encode(snapshot);
        }
    }
    Err(Error::Limit)
}

fn part_bytes(parts: &SavedParts) -> Result<usize, Error> {
    serde_json::to_vec(&parts.encode())
        .map(|bytes| bytes.len())
        .map_err(|_| Error::Malformed)
}

#[cfg(test)]
mod tests {
    use super::{MixedAction, TextItem, select_mixed_tier};

    #[test]
    fn mixed_tier_fallback_beyond_dp_limit_maximizes_retained_markers() {
        // 480 mixed drafts (text_only=101, marker=100, whole=201) -> sum_whole = 96_480.
        // With keep_budget = 5_000 (excess = 91_480), the O(N log N) fallback beyond MAX_DP_CELLS
        // sheds text first so all 50 markers fit (instead of keeping only 25 whole bundles).
        let items: Vec<TextItem> = (0..480)
            .map(|i| TextItem {
                tab: i / 24,
                id: format!("ses_bulk_{i:03}"),
                priority: 0,
                text_only_units: 101,
                whole_units: 201,
                has_text: true,
                has_attachment: true,
            })
            .collect();
        let eligible: Vec<usize> = (0..items.len()).collect();
        let actions = select_mixed_tier(&items, &eligible, 91_480, 0).expect("must fit");
        let kept_markers = actions
            .iter()
            .filter(|&&a| matches!(a, MixedAction::TextOnly | MixedAction::Keep))
            .count();
        assert_eq!(kept_markers, 50);

        // R8 Mineur: 300 mixed drafts (marker=100, texts 40, 60, 70 and 200 for the rest) with
        // keep_budget = 10_099 must keep 100 markers AND the 70-unit text (10_070 retained units,
        // not 10_040).
        let leftover_items: Vec<TextItem> = (0..300)
            .map(|i| {
                let text_cost = match i {
                    0 => 40,
                    1 => 60,
                    2 => 70,
                    _ => 200,
                };
                TextItem {
                    tab: i / 24,
                    id: format!("ses_rem_{i:03}"),
                    priority: 0,
                    text_only_units: text_cost,
                    whole_units: 100 + text_cost,
                    has_text: true,
                    has_attachment: true,
                }
            })
            .collect();
        let sum_whole: usize = leftover_items.iter().map(|it| it.whole_units).sum();
        let eligible: Vec<usize> = (0..leftover_items.len()).collect();
        let actions =
            select_mixed_tier(&leftover_items, &eligible, sum_whole - 10_099, 0).expect("must fit");
        let kept_markers = actions
            .iter()
            .filter(|&&a| matches!(a, MixedAction::TextOnly | MixedAction::Keep))
            .count();
        let retained_units: usize = actions
            .iter()
            .enumerate()
            .map(|(i, a)| match a {
                MixedAction::Keep => leftover_items[i].whole_units,
                MixedAction::TextOnly => {
                    leftover_items[i].whole_units - leftover_items[i].text_only_units
                }
                MixedAction::DropWhole => 0,
            })
            .sum();
        assert_eq!(kept_markers, 100);
        assert_eq!(retained_units, 10_070);

        // R9 Moyen: 300 markers of 100 units, keep_budget = 10_099, three rank-1 texts weighing
        // 60, 80, and 12_000, and one rank-0 text weighing 39 -> single-pass leftover DP keeps
        // 100 markers plus BOTH 60 + 39 = 99 (10_099 exact retained units, not 10_080).
        let cross_items: Vec<TextItem> = (0..300)
            .map(|i| {
                let (priority, text_cost) = match i {
                    0 => (1, 60),
                    1 => (1, 80),
                    2 => (1, 12_000),
                    3 => (0, 39),
                    _ => (0, 200),
                };
                TextItem {
                    tab: i / 24,
                    id: format!("ses_cross_{i:03}"),
                    priority,
                    text_only_units: text_cost,
                    whole_units: 100 + text_cost,
                    has_text: true,
                    has_attachment: true,
                }
            })
            .collect();
        let sum_whole: usize = cross_items.iter().map(|it| it.whole_units).sum();
        let eligible: Vec<usize> = (0..cross_items.len()).collect();
        let actions =
            select_mixed_tier(&cross_items, &eligible, sum_whole - 10_099, 0).expect("must fit");
        let kept_markers = actions
            .iter()
            .filter(|&&a| matches!(a, MixedAction::TextOnly | MixedAction::Keep))
            .count();
        let retained_units: usize = actions
            .iter()
            .enumerate()
            .map(|(i, a)| match a {
                MixedAction::Keep => cross_items[i].whole_units,
                MixedAction::TextOnly => {
                    cross_items[i].whole_units - cross_items[i].text_only_units
                }
                MixedAction::DropWhole => 0,
            })
            .sum();
        assert_eq!(kept_markers, 100);
        assert_eq!(retained_units, 10_099);
        assert_eq!(actions[0], MixedAction::Keep);
        assert_eq!(actions[3], MixedAction::Keep);

        // R10 Moyen 3: At equal leftover max weight (99), a priority-1 text of 80 plus an
        // ordinary text of 19 must beat ordinary 61 + 38.
        let tie_items: Vec<TextItem> = (0..300)
            .map(|i| {
                let (priority, text_cost) = match i {
                    0 => (1, 80),
                    1 => (0, 61),
                    2 => (0, 38),
                    3 => (0, 19),
                    _ => (0, 200),
                };
                TextItem {
                    tab: i / 24,
                    id: format!("ses_tie_{i:03}"),
                    priority,
                    text_only_units: text_cost,
                    whole_units: 100 + text_cost,
                    has_text: true,
                    has_attachment: true,
                }
            })
            .collect();
        let sum_whole: usize = tie_items.iter().map(|it| it.whole_units).sum();
        let eligible: Vec<usize> = (0..tie_items.len()).collect();
        let actions =
            select_mixed_tier(&tie_items, &eligible, sum_whole - 10_099, 0).expect("must fit");
        assert_eq!(actions[0], MixedAction::Keep, "priority-1 80 must be kept");
        assert_eq!(
            actions[3],
            MixedAction::Keep,
            "ordinary 19 pairs with 80 to reach 99"
        );
        assert_eq!(actions[1], MixedAction::TextOnly);
        assert_eq!(actions[2], MixedAction::TextOnly);

        // R11 Moyen 2: Main DP (not just fallback) must tie-break equal marker score and equal
        // retained weight by priority rank of retained text.
        // keep_budget = 225: draft 0 (prio 0, 55+60), draft 1 (prio 1, 55+60), draft 2 (prio 1,
        // 55+10_000), draft 3 (prio 0, standalone marker 100) -> keeps all three 55-unit markers
        // plus draft 1's prio-1 60-unit text (not draft 0's prio-0 60-unit text).
        let dp_tie_items = vec![
            TextItem {
                tab: 0,
                id: "ses_p0".into(),
                priority: 0,
                text_only_units: 60,
                whole_units: 115,
                has_text: true,
                has_attachment: true,
            },
            TextItem {
                tab: 0,
                id: "ses_p1".into(),
                priority: 1,
                text_only_units: 60,
                whole_units: 115,
                has_text: true,
                has_attachment: true,
            },
            TextItem {
                tab: 0,
                id: "ses_p1_big".into(),
                priority: 1,
                text_only_units: 10_000,
                whole_units: 10_055,
                has_text: true,
                has_attachment: true,
            },
            TextItem {
                tab: 0,
                id: "ses_p0_att".into(),
                priority: 0,
                text_only_units: 100,
                whole_units: 100,
                has_text: false,
                has_attachment: true,
            },
        ];
        let sum_whole: usize = dp_tie_items.iter().map(|it| it.whole_units).sum();
        let eligible: Vec<usize> = (0..dp_tie_items.len()).collect();
        let actions = select_mixed_tier(
            &dp_tie_items,
            &eligible,
            sum_whole - 225,
            super::MAX_DP_CELLS,
        )
        .expect("must fit");
        assert_eq!(actions[0], MixedAction::TextOnly);
        assert_eq!(
            actions[1],
            MixedAction::Keep,
            "main DP must keep prio-1 text over equal-cost prio-0 text"
        );
        assert_eq!(actions[2], MixedAction::TextOnly);
        assert_eq!(actions[3], MixedAction::DropWhole);
    }
}
