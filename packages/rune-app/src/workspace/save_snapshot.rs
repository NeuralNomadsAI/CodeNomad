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
        let mut best: Vec<Option<u128>> = vec![None; dp_stride];
        best[0] = Some(0);
        let mut choices = vec![0u8; eligible.len() * dp_stride];
        for (row, &item_idx) in eligible.iter().enumerate() {
            let item = &items[item_idx];
            let mixed = item.has_text && item.has_attachment;
            let marker_cost = item.whole_units.saturating_sub(item.text_only_units);
            let full_cost = item.whole_units;
            // Priority ranks are 0..=6, so 16 bits per tier pack exact lexicographic marker
            // counts across all priority tiers into one u128.
            let marker_bonus = if item.has_attachment {
                1u128 << (usize::from(item.priority.min(7)) * 16)
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
                    && let Some(prev) = best[w - marker_cost]
                {
                    let candidate = prev.saturating_add(marker_bonus);
                    if current.is_none_or(|cur| candidate > cur) {
                        current = Some(candidate);
                        chosen = 1;
                    }
                }
                if full_cost > 0
                    && w >= full_cost
                    && let Some(prev) = best[w - full_cost]
                {
                    let candidate = prev.saturating_add(marker_bonus);
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
            .filter_map(|weight| best[weight].map(|score| (score, weight)))
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
    let mut text_rows: Vec<(usize, usize)> = eligible
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
            Some((row, extra_cost))
        })
        .collect();
    text_rows.sort_by_key(|&(row, cost)| (Reverse(items[eligible[row]].priority), cost));
    for (row, cost) in text_rows {
        if cost <= remaining {
            remaining -= cost;
            actions[row] = MixedAction::Keep;
        }
    }
    Some(actions)
}

fn fit_text(snapshot: &mut Snapshot) -> Result<(), Error> {
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
    let bytes = snapshot_bytes(snapshot)?;
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
    }
}
