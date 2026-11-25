use super::{
    CLEANUP_DISPLAY_CAP, CleanupIdentity, DELETED_MISSIONS_CAP, Kind, Panel, cleanup_identity,
};
use crate::missions::cleanup::LiveFlag;
use codenomad_client::missions::Cleanup;
use std::collections::{HashSet, VecDeque};

pub(super) fn pending_cleanup_tuple(row: &Cleanup) -> (String, String, String, u64, bool, u64) {
    (
        row.deletion_id.clone(),
        row.mission_id.clone(),
        row.request_id.clone(),
        row.expected_revision,
        row.delete_managed_sessions,
        row.created_at.to_bits(),
    )
}

impl Panel {
    pub(crate) fn carry_same_workspace_from(&mut self, old: &Self) {
        self.remembered_document_pending
            .clone_from(&old.remembered_document_pending);
        self.remembered_document_order
            .clone_from(&old.remembered_document_order);
        self.settled_cleanups.clone_from(&old.settled_cleanups);
        self.settled_cleanup_order
            .clone_from(&old.settled_cleanup_order);
        self.deleted_missions.clone_from(&old.deleted_missions);
        self.deleted_missions_order
            .clone_from(&old.deleted_missions_order);
        self.summaries.clone_from(&old.summaries);
        self.cleanups.clone_from(&old.cleanups);
        self.rebuild_cleanup_indices();
    }

    /// Returns `None` when nothing changed, `Some(Some(delta))` for an incremental
    /// page/row update, or `Some(None)` when a full scan of `self.cleanups` is required.
    pub(in crate::missions) fn prepare_observed_cleanups(
        &mut self,
        owner_gen: u64,
    ) -> Option<Option<Vec<Cleanup>>> {
        let key = (self.cleanups_gen, owner_gen);
        if self.observed_sync == Some(key) {
            return None;
        }
        let owner_changed = self
            .observed_sync
            .is_none_or(|(_, prev_owner)| prev_owner != owner_gen);
        self.observed_sync = Some(key);
        if owner_changed || self.dirty_cleanups_full {
            self.dirty_cleanups.clear();
            self.dirty_cleanups_full = false;
            Some(None)
        } else {
            Some(Some(std::mem::take(&mut self.dirty_cleanups)))
        }
    }

    pub(in crate::missions) fn should_retire_cleanups(
        &self,
        owner_gen: u64,
        covered: bool,
    ) -> bool {
        self.retired_sync != Some((self.cleanups_gen, owner_gen, covered))
    }

    pub(in crate::missions) fn mark_retired_cleanups(&mut self, owner_gen: u64, covered: bool) {
        self.retired_sync = Some((self.cleanups_gen, owner_gen, covered));
    }

    pub(super) fn renew_cleanup_view(&mut self) {
        self.cleanup_view_live.revoke();
        if self.visible && self.online && !self.cleanups_unavailable() {
            self.cleanup_view_live = LiveFlag::new(true);
        }
    }

    pub(in crate::missions) fn has_pending_cleanups(&self) -> bool {
        if !self.pending_cleanup_set.is_empty() {
            return true;
        }
        self.cleanup_meta.is_empty() && self.cleanups.iter().any(Cleanup::is_pending)
    }

    pub(in crate::missions) fn cleanups_rc(&self) -> std::rc::Rc<Vec<Cleanup>> {
        let mut cache = self.cleanups_rc.borrow_mut();
        if let Some((cached_gen, rc)) = cache.as_ref()
            && *cached_gen == self.cleanups_gen
            && rc.len() == self.cleanups.len()
        {
            return std::rc::Rc::clone(rc);
        }
        let rc = std::rc::Rc::new(self.cleanups.clone());
        *cache = Some((self.cleanups_gen, std::rc::Rc::clone(&rc)));
        rc
    }

    pub(super) fn rebuild_cleanup_indices(&mut self) -> bool {
        let prev = std::mem::take(&mut self.pending_cleanup_set);
        self.cleanup_meta.clear();
        self.pending_cleanup_ids.clear();
        for row in &self.cleanups {
            let row_id = (row.mission_id.clone(), row.deletion_id.clone());
            self.cleanup_meta.insert(
                row_id.clone(),
                (
                    row.request_id.clone(),
                    row.expected_revision,
                    row.delete_managed_sessions,
                    row.created_at.to_bits(),
                ),
            );
            if row.is_pending() {
                self.pending_cleanup_set.insert(pending_cleanup_tuple(row));
                self.pending_cleanup_ids.insert(row_id);
            }
        }
        self.dirty_cleanups.clear();
        self.dirty_cleanups_full = true;
        self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
        self.pending_cleanup_set != prev
    }

    pub(super) fn note_dirty_cleanup(&mut self, row: Cleanup) {
        if self.dirty_cleanups_full {
            return;
        }
        if self.dirty_cleanups.len() >= 256 {
            self.dirty_cleanups.clear();
            self.dirty_cleanups_full = true;
        } else {
            self.dirty_cleanups.push(row);
        }
    }

    pub(super) fn remember_deleted_mission(&mut self, mission_id: &str) {
        if self.deleted_missions.contains(mission_id) {
            return;
        }
        while self.deleted_missions.len() >= DELETED_MISSIONS_CAP {
            let Some(evict) = self.deleted_missions_order.pop_front() else {
                break;
            };
            self.deleted_missions.remove(&evict);
        }
        let owned = mission_id.to_owned();
        self.deleted_missions_order.push_back(owned.clone());
        self.deleted_missions.insert(owned);
    }

    fn remember_settled_cleanup(&mut self, receipt: Cleanup) {
        if receipt.is_pending() {
            return;
        }
        let key = cleanup_identity(&receipt);
        if self.settled_cleanups.contains_key(&key) {
            self.settled_cleanups.insert(key, receipt);
            return;
        }
        while self.settled_cleanups.len() >= CLEANUP_DISPLAY_CAP {
            let Some(evict) = self.settled_cleanup_order.pop_front() else {
                break;
            };
            self.settled_cleanups.remove(&evict);
        }
        self.settled_cleanup_order.push_back(key.clone());
        self.settled_cleanups.insert(key, receipt);
    }

    fn remember_document_pending(&mut self, key: CleanupIdentity) {
        self.remember_document_pending_batch(&[(key, Some(true))]);
    }

    pub(super) fn remember_document_pending_batch(
        &mut self,
        updates: &[(CleanupIdentity, Option<bool>)],
    ) {
        let mut to_add: Vec<&CleanupIdentity> = Vec::new();
        for (id, doc_pending) in updates {
            match doc_pending {
                Some(true) => {
                    #[cfg(test)]
                    {
                        self.doc_cache_lookups += 1;
                    }
                    if !self.remembered_document_pending.contains(id) {
                        to_add.push(id);
                    }
                }
                Some(false) => {
                    self.forget_document_pending(id);
                }
                None => {}
            }
        }
        if to_add.is_empty() {
            return;
        }
        // If evictions are needed, partition the queue once in O(N) so absent rows evict before
        // currently displayed rows, then evict each excess entry in O(1).
        if self.remembered_document_pending.len() + to_add.len() > CLEANUP_DISPLAY_CAP {
            let live: HashSet<CleanupIdentity> =
                self.cleanups.iter().map(cleanup_identity).collect();
            let mut absent = VecDeque::with_capacity(self.remembered_document_order.len());
            let mut present = VecDeque::new();
            while let Some(id) = self.remembered_document_order.pop_front() {
                #[cfg(test)]
                {
                    self.doc_cache_lookups += 1;
                }
                if live.contains(&id) {
                    present.push_back(id);
                } else {
                    absent.push_back(id);
                }
            }
            absent.extend(present);
            self.remembered_document_order = absent;
        }
        for id in to_add {
            if self.remembered_document_pending.contains(id) {
                continue;
            }
            while self.remembered_document_pending.len() >= CLEANUP_DISPLAY_CAP {
                let Some(evict) = self.remembered_document_order.pop_front() else {
                    break;
                };
                self.remembered_document_pending.remove(&evict);
            }
            self.remembered_document_order.push_back(id.clone());
            self.remembered_document_pending.insert(id.clone());
        }
    }

    fn forget_document_pending(&mut self, key: &CleanupIdentity) {
        if self.remembered_document_pending.remove(key) {
            self.remembered_document_order.retain(|id| id != key);
        }
    }

    pub(in crate::missions) fn adopt_settled_cleanup(&mut self, mut receipt: Cleanup) {
        self.cancel_lane(Kind::Cleanups);
        let key = cleanup_identity(&receipt);
        match receipt.document_pending {
            Some(false) => {
                self.forget_document_pending(&key);
            }
            Some(true) => {
                self.remember_document_pending(key);
            }
            None => {
                if self.remembered_document_pending.contains(&key)
                    || self.cleanups.iter().any(|row| {
                        cleanup_identity(row) == key && row.document_pending == Some(true)
                    })
                {
                    receipt.document_pending = Some(true);
                    self.remember_document_pending(key);
                }
            }
        }
        let mut pending_changed = false;
        let row_id = (receipt.mission_id.clone(), receipt.deletion_id.clone());
        let new_meta = (
            receipt.request_id.clone(),
            receipt.expected_revision,
            receipt.delete_managed_sessions,
            receipt.created_at.to_bits(),
        );
        if let Some(existing) = self.cleanups.iter_mut().find(|row| {
            row.mission_id == receipt.mission_id && row.deletion_id == receipt.deletion_id
        }) {
            let old_pending = existing
                .is_pending()
                .then(|| pending_cleanup_tuple(existing));
            *existing = receipt.clone();
            let new_pending = existing
                .is_pending()
                .then(|| pending_cleanup_tuple(existing));
            if old_pending != new_pending {
                if let Some(old) = old_pending {
                    pending_changed |= self.pending_cleanup_set.remove(&old);
                }
                if let Some(new) = new_pending {
                    pending_changed |= self.pending_cleanup_set.insert(new);
                    self.pending_cleanup_ids.insert(row_id.clone());
                } else {
                    self.pending_cleanup_ids.remove(&row_id);
                }
            }
            self.cleanup_meta.insert(row_id, new_meta);
        } else {
            self.cleanups.insert(0, receipt.clone());
            self.lanes[Kind::Cleanups as usize].prefix_len = 0;
            self.lanes[Kind::Cleanups as usize].tail_pos.clear();
            self.lanes[Kind::Cleanups as usize].tail_pinned_len = 0;
            self.cleanup_meta.insert(row_id.clone(), new_meta);
            if receipt.is_pending() {
                pending_changed |= self
                    .pending_cleanup_set
                    .insert(pending_cleanup_tuple(&receipt));
                self.pending_cleanup_ids.insert(row_id);
            }
            // Enforce the strict resident cap without ever evicting the newly adopted row at index 0.
            while self.cleanups.len() > CLEANUP_DISPLAY_CAP {
                let tail = &self.cleanups[1..];
                let evict_idx = tail
                    .iter()
                    .rposition(|row| !row.is_pending())
                    .map(|rel| rel + 1)
                    .unwrap_or(1);
                let evicted = self.cleanups.remove(evict_idx);
                let evict_id = (evicted.mission_id.clone(), evicted.deletion_id.clone());
                self.cleanup_meta.remove(&evict_id);
                if evicted.is_pending() {
                    pending_changed |= self
                        .pending_cleanup_set
                        .remove(&pending_cleanup_tuple(&evicted));
                    self.pending_cleanup_ids.remove(&evict_id);
                }
            }
        }
        self.note_dirty_cleanup(receipt.clone());
        self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
        if !receipt.is_pending() {
            self.remember_settled_cleanup(receipt.clone());
            if let Some(token) = self
                .cleanup_tokens
                .remove(&(receipt.mission_id, receipt.deletion_id))
            {
                token.revoke();
            }
        }
        if pending_changed {
            self.renew_cleanup_view();
        }
    }

    pub(in crate::missions) fn mark_cleanup_document_pending(&mut self, key: &CleanupIdentity) {
        let newly_pending = !self.remembered_document_pending.contains(key);
        self.remember_document_pending(key.clone());
        if newly_pending
            && let Some(token) = self.cleanup_tokens.remove(&(key.0.clone(), key.1.clone()))
        {
            token.revoke();
        }
        let mut pending_changed = false;
        let mut updated_rows = Vec::new();
        for row in &mut self.cleanups {
            if cleanup_identity(row) == *key && row.document_pending.is_none() {
                let old_pending = row.is_pending().then(|| pending_cleanup_tuple(row));
                row.document_pending = Some(true);
                let new_pending = row.is_pending().then(|| pending_cleanup_tuple(row));
                if old_pending != new_pending {
                    if let Some(old) = old_pending {
                        pending_changed |= self.pending_cleanup_set.remove(&old);
                    }
                    if let Some(new) = new_pending {
                        pending_changed |= self.pending_cleanup_set.insert(new);
                        self.pending_cleanup_ids
                            .insert((row.mission_id.clone(), row.deletion_id.clone()));
                    }
                }
                updated_rows.push(row.clone());
            }
        }
        if !updated_rows.is_empty() {
            for row in updated_rows {
                self.note_dirty_cleanup(row);
            }
            self.cleanups_gen = self.cleanups_gen.wrapping_add(1);
            if pending_changed {
                self.renew_cleanup_view();
            }
        }
    }

    pub(in crate::missions) fn cleanup_row_live(
        &mut self,
        mission_id: &str,
        deletion_id: &str,
    ) -> LiveFlag {
        let key = (mission_id.to_owned(), deletion_id.to_owned());
        if let Some(token) = self.cleanup_tokens.get(&key) {
            return token.clone();
        }
        if self.cleanup_tokens.len() >= 64 {
            self.cleanup_tokens.retain(|(m, d), token| {
                let alive = self
                    .cleanups
                    .iter()
                    .any(|row| row.is_pending() && row.mission_id == *m && row.deletion_id == *d);
                if !alive {
                    token.revoke();
                }
                alive
            });
            while self.cleanup_tokens.len() >= 64 {
                let Some(evict) = self.cleanup_tokens.keys().next().cloned() else {
                    break;
                };
                if let Some(token) = self.cleanup_tokens.remove(&evict) {
                    token.revoke();
                }
            }
        }
        let token = LiveFlag::new(true);
        self.cleanup_tokens.insert(key, token.clone());
        token
    }

    pub(super) fn revoke_all_cleanup_tokens(&mut self) {
        for (_, token) in self.cleanup_tokens.drain() {
            token.revoke();
        }
    }

    pub(super) fn sync_cleanup_tokens(&mut self, covered: bool) {
        self.cleanup_tokens.retain(|(m, d), token| {
            let key = (m.clone(), d.clone());
            let keep = if self.cleanup_meta.contains_key(&key) {
                self.pending_cleanup_ids.contains(&key)
            } else {
                !covered
            };
            if !keep {
                token.revoke();
            }
            keep
        });
    }
}
