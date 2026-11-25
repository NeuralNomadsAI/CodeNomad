use super::{
    CLEANUP_DISPLAY_CAP, CleanupIdentity, Kind, Lane, Panel, Read, cleanup_identity,
    cleanups::pending_cleanup_tuple,
};
use crate::missions::cleanup::LiveFlag;
use codenomad_client::missions::{Cleanup, DirectoryPage, DirectoryRows, Window};

impl Panel {
    pub(super) fn accept(&mut self, kind: Kind, read: Read, page: DirectoryPage) -> bool {
        if self
            .project
            .as_ref()
            .is_some_and(|project| project != &page.project_id)
        {
            return false;
        }
        if kind == Kind::Cleanups && self.cleanup_meta.is_empty() && !self.cleanups.is_empty() {
            self.rebuild_cleanup_indices();
        }
        if read == Read::More
            && self.lanes[kind as usize].window.as_ref().is_none_or(|w| {
                page.window.order != w.order
                    || page.window.offset != w.end
                    || page.window.total != w.total
            })
        {
            return false;
        }
        if read.is_refresh()
            && self.lanes[kind as usize].window.as_ref().is_some_and(|w| {
                w.order == page.window.order
                    && w.total == page.window.total
                    && w.end > page.window.end
                    && (read != Read::ManualRefresh
                        || kind != Kind::Cleanups
                        || w.end <= CLEANUP_DISPLAY_CAP as u64)
            })
        {
            return true;
        }
        match (kind, page.rows) {
            (Kind::Summaries, DirectoryRows::Summaries(rows)) => {
                let lane = &mut self.lanes[kind as usize];
                if merge_filtered(
                    &mut self.summaries,
                    lane,
                    read,
                    &page.window,
                    rows,
                    None,
                    |row| (row.id.clone(), None),
                    |row| !self.deleted_missions.contains(&row.id),
                    |_| false,
                )
                .is_none()
                {
                    return false;
                }
                if page.window.end == page.window.total && !self.deleted_missions.is_empty() {
                    let seen = &lane.seen;
                    self.deleted_missions
                        .retain(|id| seen.contains(&(id.clone(), None)));
                    self.deleted_missions_order
                        .retain(|id| self.deleted_missions.contains(id));
                }
                // A page that does not cover the directory cannot prove a selection is gone.
                if page.window.end == page.window.total
                    && self
                        .selected
                        .as_ref()
                        .is_some_and(|id| !self.summaries.iter().any(|row| &row.id == id))
                {
                    self.selection_live.revoke();
                    self.mounted_selection_live.revoke();
                    if self.visible {
                        self.mounted_selection_live = LiveFlag::new(true);
                        if self.online {
                            self.selection_live = LiveFlag::new(true);
                        }
                    }
                    self.selected = None;
                }
            }
            (Kind::Cleanups, DirectoryRows::Cleanups(mut rows)) => {
                for row in &mut rows {
                    let id = cleanup_identity(row);
                    if row.is_pending()
                        && let Some(settled) = self.settled_cleanups.get(&id)
                    {
                        *row = settled.clone();
                        continue;
                    }
                    if row.document_pending.is_none()
                        && self.remembered_document_pending.contains(&id)
                    {
                        row.document_pending = Some(true);
                    }
                }
                let contradictory = rows.iter().any(|row| {
                    self.cleanup_meta
                        .get(&(row.mission_id.clone(), row.deletion_id.clone()))
                        .is_some_and(|(req, rev, del_ses, created_at_bits)| {
                            req != &row.request_id
                                || *rev != row.expected_revision
                                || *del_ses != row.delete_managed_sessions
                                || *created_at_bits != row.created_at.to_bits()
                        })
                });
                let doc_updates: Vec<(CleanupIdentity, Option<bool>)> = rows
                    .iter()
                    .map(|row| (cleanup_identity(row), row.document_pending))
                    .collect();
                let incoming_meta: Vec<((String, String), (String, u64, bool, u64))> = rows
                    .iter()
                    .map(|row| {
                        (
                            (row.mission_id.clone(), row.deletion_id.clone()),
                            (
                                row.request_id.clone(),
                                row.expected_revision,
                                row.delete_managed_sessions,
                                row.created_at.to_bits(),
                            ),
                        )
                    })
                    .collect();
                let incoming_pending: Vec<_> = rows
                    .iter()
                    .filter(|row| row.is_pending())
                    .map(|row| {
                        (
                            (row.mission_id.clone(), row.deletion_id.clone()),
                            pending_cleanup_tuple(row),
                        )
                    })
                    .collect();
                if contradictory {
                    self.cleanup_view_live.revoke();
                    self.revoke_all_cleanup_tokens();
                    return false;
                }
                let lane = &mut self.lanes[kind as usize];
                let had_tail = self.cleanups.len() > lane.prefix_len;
                let incoming_for_observe: Vec<Cleanup> =
                    if read == Read::More && !self.dirty_cleanups_full {
                        rows.clone()
                    } else {
                        Vec::new()
                    };
                let Some(evicted) = merge_filtered(
                    &mut self.cleanups,
                    lane,
                    read,
                    &page.window,
                    rows,
                    Some(CLEANUP_DISPLAY_CAP),
                    |row| (row.mission_id.clone(), Some(row.deletion_id.clone())),
                    |_| true,
                    Cleanup::is_pending,
                ) else {
                    return false;
                };
                let covered = page.window.end == page.window.total;
                self.project = Some(page.project_id);
                lane.window = Some(page.window);
                let pending_changed = if read.is_refresh() || (covered && had_tail) {
                    self.rebuild_cleanup_indices()
                } else {
                    let mut changed = false;
                    for row in evicted {
                        let evict_id = (row.mission_id.clone(), row.deletion_id.clone());
                        self.cleanup_meta.remove(&evict_id);
                        if row.is_pending() {
                            changed |= self
                                .pending_cleanup_set
                                .remove(&pending_cleanup_tuple(&row));
                            self.pending_cleanup_ids.remove(&evict_id);
                        }
                    }
                    for (k, meta) in incoming_meta {
                        self.cleanup_meta.insert(k, meta);
                    }
                    for (row_id, tuple) in incoming_pending {
                        changed |= self.pending_cleanup_set.insert(tuple);
                        self.pending_cleanup_ids.insert(row_id);
                    }
                    for row in incoming_for_observe {
                        self.note_dirty_cleanup(row);
                    }
                    self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
                    changed
                };
                for (id, doc_pending) in &doc_updates {
                    if *doc_pending == Some(true)
                        && !self.remembered_document_pending.contains(id)
                        && let Some(token) =
                            self.cleanup_tokens.remove(&(id.0.clone(), id.1.clone()))
                    {
                        token.revoke();
                    }
                }
                self.remember_document_pending_batch(&doc_updates);
                self.sync_cleanup_tokens(covered);
                if pending_changed {
                    self.renew_cleanup_view();
                }
                return true;
            }
            _ => return false,
        }
        self.project = Some(page.project_id);
        self.lanes[kind as usize].window = Some(page.window);
        true
    }
}

fn push_seen_bounded(lane: &mut Lane, keys: Vec<(String, Option<String>)>, cap: Option<usize>) {
    for k in keys {
        if lane.seen.insert(k.clone()) {
            lane.seen_order.push_back(k);
        }
    }
    if let Some(max_len) = cap {
        while lane.seen.len() > max_len {
            let Some(oldest) = lane.seen_order.pop_front() else {
                break;
            };
            lane.seen.remove(&oldest);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn merge_filtered<T>(
    display: &mut Vec<T>,
    lane: &mut Lane,
    read: Read,
    window: &Window,
    rows: Vec<T>,
    cap: Option<usize>,
    key: impl Fn(&T) -> (String, Option<String>),
    keep: impl Fn(&T) -> bool,
    pin: impl Fn(&T) -> bool,
) -> Option<Vec<T>> {
    if read.is_refresh() {
        lane.seen.clear();
        lane.seen_order.clear();
        lane.tail_pos.clear();
        lane.tail_pinned_len = 0;
        lane.prefix_len = 0;
    } else if rows.iter().any(|row| lane.seen.contains(&key(row))) {
        return None;
    }
    let incoming_keys: Vec<(String, Option<String>)> = rows.iter().map(&key).collect();
    let kept: Vec<T> = rows.into_iter().filter(&keep).collect();
    let mut evicted = Vec::new();

    if read == Read::More && lane.prefix_len > 0 && lane.prefix_len <= display.len() {
        push_seen_bounded(lane, incoming_keys.clone(), cap);
        if window.end == window.total {
            // Final page covers the entire order: drop any remaining old tail in O(1).
            if lane.prefix_len < display.len() {
                evicted.extend(display.drain(lane.prefix_len..));
                lane.tail_pos.clear();
                lane.tail_pinned_len = 0;
            }
        } else if lane.prefix_len < display.len() {
            // Evict colliding tail rows in O(1) each via relative-offset index without scanning the tail,
            // preserving the invariant that pinned tail rows precede unpinned tail rows.
            for k in incoming_keys {
                let Some(rel) = lane.tail_pos.remove(&k) else {
                    continue;
                };
                #[cfg(test)]
                {
                    lane.tail_visits += 1;
                }
                let abs = lane.prefix_len + rel;
                if rel < lane.tail_pinned_len {
                    let last_pinned_rel = lane.tail_pinned_len - 1;
                    if rel != last_pinned_rel {
                        display.swap(abs, lane.prefix_len + last_pinned_rel);
                        let moved_key = key(&display[abs]);
                        lane.tail_pos.insert(moved_key, rel);
                    }
                    let last_pinned_abs = lane.prefix_len + last_pinned_rel;
                    let last_abs = display.len() - 1;
                    if last_pinned_abs != last_abs {
                        display.swap(last_pinned_abs, last_abs);
                        let moved_key = key(&display[last_pinned_abs]);
                        lane.tail_pos.insert(moved_key, last_pinned_rel);
                    }
                    lane.tail_pinned_len -= 1;
                    if let Some(removed) = display.pop() {
                        evicted.push(removed);
                    }
                } else {
                    let last_abs = display.len() - 1;
                    if abs != last_abs {
                        display.swap(abs, last_abs);
                        let moved_key = key(&display[abs]);
                        lane.tail_pos.insert(moved_key, rel);
                    }
                    if let Some(removed) = display.pop() {
                        evicted.push(removed);
                    }
                }
            }
            // Trim excess tail rows from the back (unpinned sit after pinned) in O(page_size).
            if let Some(max_len) = cap {
                let target_len = max_len.saturating_sub(kept.len());
                while display.len() > lane.prefix_len && display.len() > target_len {
                    if let Some(removed) = display.pop() {
                        lane.tail_pos.remove(&key(&removed));
                        lane.tail_pinned_len =
                            lane.tail_pinned_len.min(display.len() - lane.prefix_len);
                        evicted.push(removed);
                    }
                }
            }
        }
        let kept_len = kept.len();
        if lane.prefix_len == display.len() {
            display.extend(kept);
        } else {
            display.splice(lane.prefix_len..lane.prefix_len, kept);
        }
        lane.prefix_len += kept_len;
        // Slide the resident prefix window forward when total rows exceed `cap`.
        if let Some(max_len) = cap
            && display.len() > max_len
        {
            let overflow = display.len() - max_len;
            let drop_prefix = overflow.min(lane.prefix_len);
            evicted.extend(display.drain(..drop_prefix));
            lane.prefix_len -= drop_prefix;
            while display.len() > max_len {
                if let Some(removed) = display.pop() {
                    lane.tail_pos.remove(&key(&removed));
                    lane.tail_pinned_len =
                        lane.tail_pinned_len.min(display.len() - lane.prefix_len);
                    evicted.push(removed);
                }
            }
        }
        return Some(evicted);
    }

    // Slow path (Refresh or after adopt_settled_cleanup reset prefix_len to 0):
    // Keep current-order prefix first, then pinned tail rows, then unpinned tail rows,
    // strictly bounded by `cap` so back-popping on Read::More evicts unpinned rows first.
    let previous = std::mem::take(display);
    let mut prefix_rows = Vec::with_capacity(lane.seen.len().min(previous.len()));
    let mut tail_rows = Vec::new();
    for row in previous {
        if !keep(&row) {
            continue;
        }
        if lane.seen.contains(&key(&row)) {
            prefix_rows.push(row);
        } else {
            tail_rows.push(row);
        }
    }
    push_seen_bounded(lane, incoming_keys, cap);
    display.extend(prefix_rows);
    display.extend(kept);
    if let Some(max_len) = cap
        && display.len() > max_len
    {
        let overflow = display.len() - max_len;
        evicted.extend(display.drain(..overflow));
    }
    lane.prefix_len = display.len();
    lane.tail_pos.clear();
    lane.tail_pinned_len = 0;
    if window.end != window.total && !tail_rows.is_empty() {
        let mut pinned_tail = Vec::new();
        let mut unpinned_tail = Vec::new();
        for row in tail_rows {
            #[cfg(test)]
            {
                lane.tail_visits += 1;
            }
            let k = key(&row);
            if lane.seen.contains(&k) {
                continue;
            }
            if pin(&row) {
                pinned_tail.push((k, row));
            } else {
                unpinned_tail.push((k, row));
            }
        }
        let budget = cap.map_or(usize::MAX, |max_len| max_len.saturating_sub(display.len()));
        let mut remaining = budget;
        for (k, row) in pinned_tail {
            if remaining == 0 {
                evicted.push(row);
                continue;
            }
            remaining -= 1;
            let rel = display.len() - lane.prefix_len;
            lane.tail_pos.insert(k, rel);
            lane.tail_pinned_len += 1;
            display.push(row);
        }
        for (k, row) in unpinned_tail {
            if remaining == 0 {
                evicted.push(row);
                continue;
            }
            remaining -= 1;
            let rel = display.len() - lane.prefix_len;
            lane.tail_pos.insert(k, rel);
            display.push(row);
        }
    }
    Some(evicted)
}
