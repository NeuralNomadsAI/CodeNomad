use super::*;

impl Children {
    pub(in crate::chat::tools) fn lease(
        &self,
        parent: Option<&str>,
        id: &str,
        key: &str,
    ) -> Rc<()> {
        let ck = child_key(parent, id);
        self.entries
            .get(&ck)
            .and_then(|entry| entry.cards.get(key))
            .and_then(Weak::upgrade)
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(wck, wkey, _)| *wck == ck && wkey == key)
                    .and_then(|(_, _, lease)| lease.upgrade())
            })
            .unwrap_or_default()
    }

    pub(in crate::chat::tools) fn demand(
        s: &mut State,
        parent: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let wake = s.wake.clone();
        let ck = child_key(parent, id);
        let children = &mut s.transcript_display.children;
        let freed = children.prune();
        if !visible {
            let mut removed = false;
            if let Some(entry) = children.entries.get_mut(&ck) {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(&ck);
                    removed = true;
                }
            }
            if removed {
                children.evict_unwatched_cache(std::slice::from_ref(&ck.1));
            }
            children
                .waiting
                .retain(|(wck, wkey, _)| !(*wck == ck && wkey == key));
            if freed || removed {
                Self::promote_waiting(s);
            }
            return;
        }
        let needs_watch = if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            Some(matches!(
                entry.watch,
                WatchState::Pending
                    | WatchState::Dormant {
                        pending_promote: true,
                        ..
                    }
            ))
        } else {
            None
        };
        if let Some(needs_watch) = needs_watch {
            if needs_watch {
                if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                    children.enqueue_waiting(ck, key, lease);
                } else {
                    Self::start_entry(s, ck, key, lease);
                }
            } else if freed {
                Self::promote_waiting(s);
            }
            return;
        }
        if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
            children.enqueue_waiting(ck, key, lease);
            return;
        }
        Self::start_entry(s, ck, key, lease);
    }

    fn enqueue_waiting(&mut self, ck: ChildKey, key: &str, lease: &Rc<()>) {
        self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
        if let Some(existing) = self
            .waiting
            .iter_mut()
            .find(|(wck, wkey, _)| *wck == ck && wkey == key)
        {
            existing.2 = Rc::downgrade(lease);
        } else if self.waiting.len() < WAITING_LIMIT {
            self.waiting
                .push_back((ck, key.into(), Rc::downgrade(lease)));
        }
    }

    pub(in crate::chat::tools) fn retry(s: &mut State, parent: Option<&str>, id: &str) {
        let ck = child_key(parent, id);
        if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
            entry.load_error = false;
            if let WatchState::Active(watcher) = &entry.watch {
                let _ = watcher.retry.try_send(());
                return;
            }
            entry.watch = WatchState::Pending;
            if let Some((card, lease)) = entry
                .cards
                .iter()
                .find_map(|(k, w)| w.upgrade().map(|l| (k.clone(), l)))
            {
                Self::demand(s, parent, id, &card, &lease, true);
            }
        }
    }

    fn active_watchers(&self) -> usize {
        self.entries
            .values()
            .filter(|e| matches!(e.watch, WatchState::Active(_)))
            .count()
    }

    fn dormant_watch(&self, child: &str, wake: &codenomad_client::Wake) -> WatchState {
        let Some(backend) = self.backend.as_ref() else {
            return WatchState::Pending;
        };
        let Some((dirty, settlement)) = backend.watch_child(child) else {
            return WatchState::Pending;
        };
        let (out, wake_rx) = bounded(2);
        let (cancel, cancelled) = bounded(1);
        let wake = wake.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                while dirty.recv().await.is_ok() {
                    let revoked = settlement.take().revoked;
                    if revoked {
                        if out.send(true).await.is_err() {
                            break;
                        }
                        wake();
                    } else if out.try_send(false).is_ok() {
                        wake();
                    }
                }
            })
            .await;
        });
        WatchState::Dormant {
            _cancel: cancel,
            wake: wake_rx,
            pending_promote: false,
        }
    }

    fn demote_settled(&mut self, wake: &codenomad_client::Wake) -> bool {
        let candidate = self
            .entries
            .iter()
            .find(|(_, e)| matches!(e.watch, WatchState::Active(_)) && e.settled)
            .map(|(k, _)| k.clone());
        let Some(key) = candidate else {
            return false;
        };
        // Register the dormant SSE watch before dropping the active watcher so no wake is missed.
        let dormant = self.dormant_watch(&key.1, wake);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.watch = dormant;
            return true;
        }
        false
    }

    pub(super) fn promote_waiting(s: &mut State) {
        let wake = s.wake.clone();
        loop {
            let next = loop {
                let Some((ck, key, weak)) = s.transcript_display.children.waiting.pop_front()
                else {
                    return;
                };
                if let Some(lease) = weak.upgrade() {
                    break (ck, key, lease);
                }
            };
            let (ck, key, lease) = next;
            let needs_start =
                if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
                    entry.cards.insert(key.clone(), Rc::downgrade(&lease));
                    matches!(
                        entry.watch,
                        WatchState::Pending
                            | WatchState::Dormant {
                                pending_promote: true,
                                ..
                            }
                    )
                } else {
                    true
                };
            if !needs_start {
                continue;
            }
            let children = &mut s.transcript_display.children;
            if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                children
                    .waiting
                    .push_front((ck, key, Rc::downgrade(&lease)));
                return;
            }
            if !Self::start_entry(s, ck, &key, &lease) {
                break;
            }
        }
    }

    pub(crate) fn poll_and_promote(s: &mut State) -> bool {
        let changed = s.transcript_display.children.poll();
        Self::promote_waiting(s);
        changed
    }

    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = self.prune();
        let mut to_requeue: Vec<(ChildKey, String, Weak<()>)> = Vec::new();
        let mut mark_unavailable: Vec<ChildKey> = Vec::new();
        let mut clear_unavailable: Vec<ChildKey> = Vec::new();
        let mut revoked_children: Vec<String> = Vec::new();
        for (ck, entry) in self.entries.iter_mut() {
            match &mut entry.watch {
                WatchState::Active(watcher) => {
                    while let Ok(update) = watcher.result.try_recv() {
                        match update {
                            ChildUpdate::Loaded {
                                snapshot: next,
                                settled,
                                unavailable,
                            } => {
                                if unavailable {
                                    mark_unavailable.push(ck.clone());
                                    revoked_children.push(ck.1.clone());
                                } else {
                                    clear_unavailable.push(ck.clone());
                                }
                                changed |= entry.load_error
                                    || entry.settled != settled
                                    || entry.snapshot != next;
                                entry.load_error = false;
                                entry.settled = settled;
                                entry.snapshot = next;
                            }
                            ChildUpdate::Settled => {
                                changed |= !entry.settled;
                                entry.settled = true;
                            }
                            ChildUpdate::Unverified => {
                                clear_unavailable.push(ck.clone());
                                revoked_children.push(ck.1.clone());
                                changed |= entry.load_error
                                    || entry.settled
                                    || entry.snapshot != Snapshot::default();
                                entry.snapshot = Snapshot::default();
                                entry.load_error = false;
                                entry.settled = false;
                            }
                            ChildUpdate::Failed => {
                                changed |= !entry.load_error;
                                entry.load_error = true;
                            }
                        }
                    }
                }
                WatchState::Dormant {
                    wake,
                    pending_promote,
                    ..
                } => {
                    let mut woke = false;
                    let mut revoked = false;
                    let mut closed = false;
                    loop {
                        match wake.try_recv() {
                            Ok(is_revoked) => {
                                woke = true;
                                revoked |= is_revoked;
                            }
                            Err(error) if error.is_closed() => {
                                closed = true;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    if revoked {
                        clear_unavailable.push(ck.clone());
                        revoked_children.push(ck.1.clone());
                        changed |= entry.load_error || entry.snapshot != Snapshot::default();
                        entry.snapshot = Snapshot::default();
                        entry.load_error = false;
                    }
                    if woke || closed {
                        entry.settled = false;
                        if closed {
                            entry.watch = WatchState::Pending;
                        } else {
                            *pending_promote = true;
                        }
                        if let Some((card, lease)) =
                            entry.cards.iter().find(|(_, w)| w.strong_count() > 0)
                        {
                            to_requeue.push((ck.clone(), card.clone(), lease.clone()));
                        }
                    }
                }
                WatchState::Pending => {}
            }
        }
        for ck in clear_unavailable {
            changed |= self.unavailable.remove(&ck);
        }
        if !revoked_children.is_empty() {
            let cancel_copy = match &self.report_copy {
                ReportCopy::Loading { key, .. }
                | ReportCopy::Ready { key, .. }
                | ReportCopy::Copied { key }
                | ReportCopy::Failed { key } => {
                    revoked_children.iter().any(|id| key.touches_child(id))
                }
                #[cfg(target_arch = "wasm32")]
                ReportCopy::Confirming { key, .. } => {
                    revoked_children.iter().any(|id| key.touches_child(id))
                }
                ReportCopy::Idle => false,
            };
            if cancel_copy {
                self.report_copy = ReportCopy::Idle;
                changed = true;
            }
            let before_expanded = self.expanded_reports.len();
            self.expanded_reports.retain(|(current, text)| {
                let drop = revoked_children.iter().any(|id| current.touches_child(id));
                if drop {
                    self.expanded_report_bytes =
                        self.expanded_report_bytes.saturating_sub(text.len());
                }
                !drop
            });
            changed |= self.expanded_reports.len() != before_expanded;
            if self
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| {
                    revoked_children.iter().any(|id| current.touches_child(id))
                })
            {
                self.loading_report = None;
                changed = true;
            }
            if self
                .failed_report
                .as_ref()
                .is_some_and(|current| revoked_children.iter().any(|id| current.touches_child(id)))
            {
                self.failed_report = None;
                changed = true;
            }
        }
        for ck in mark_unavailable {
            if !self.unavailable.contains(&ck) {
                self.mark_unavailable(ck);
                changed = true;
            }
        }
        if !to_requeue.is_empty() {
            self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
            for (ck, card, lease) in to_requeue {
                if !self.waiting.iter().any(|(wck, _, _)| *wck == ck)
                    && self.waiting.len() < WAITING_LIMIT
                {
                    self.waiting.push_back((ck, card, lease));
                }
            }
        }
        let expand_outcome = match self.loading_report.as_ref() {
            Some((_, revocation, _, _)) if revocation.is_revoked() => {
                self.loading_report = None;
                changed = true;
                None
            }
            Some((_, _, _, rx)) => match rx.try_recv() {
                Ok(body) => Some(body),
                Err(error) if error.is_closed() => Some(None),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(outcome) = expand_outcome
            && let Some((key, revocation, _, _)) = self.loading_report.take()
        {
            let unavailable = self.unavailable.iter().any(|(_, id)| key.touches_child(id));
            if !revocation.is_revoked() && !unavailable {
                match outcome {
                    Some(text) if text.len() <= MAX_EXPANDED_REPORT_BYTES => {
                        while self.expanded_reports.len() >= MAX_EXPANDED_REPORTS
                            || self.expanded_report_bytes.saturating_add(text.len())
                                > MAX_EXPANDED_REPORT_BYTES
                        {
                            if let Some((_, dropped)) = self.expanded_reports.pop_front() {
                                self.expanded_report_bytes =
                                    self.expanded_report_bytes.saturating_sub(dropped.len());
                            } else {
                                break;
                            }
                        }
                        self.expanded_report_bytes =
                            self.expanded_report_bytes.saturating_add(text.len());
                        self.expanded_reports.push_back((key, text));
                    }
                    _ => {
                        self.failed_report = Some(key);
                    }
                }
            }
            changed = true;
        }
        changed
    }

    pub(super) fn evict_unwatched_cache(&mut self, removed_children: &[String]) {
        let unwatched: Vec<&str> = removed_children
            .iter()
            .map(String::as_str)
            .filter(|id| !self.entries.keys().any(|(_, active)| active == *id))
            .collect();
        if unwatched.is_empty() {
            return;
        }
        self.expanded_reports.retain(|(current, text)| {
            let drop = unwatched.iter().any(|id| current.touches_child(id));
            if drop {
                self.expanded_report_bytes = self.expanded_report_bytes.saturating_sub(text.len());
            }
            !drop
        });
        if self
            .loading_report
            .as_ref()
            .is_some_and(|(current, _, _, _)| unwatched.iter().any(|id| current.touches_child(id)))
        {
            self.loading_report = None;
        }
        if self
            .failed_report
            .as_ref()
            .is_some_and(|current| unwatched.iter().any(|id| current.touches_child(id)))
        {
            self.failed_report = None;
        }
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        let before = self.entries.len();
        let mut removed = Vec::new();
        self.entries.retain(|ck, entry| {
            entry.cards.retain(|_, lease| lease.strong_count() > 0);
            let keep = !entry.cards.is_empty();
            if !keep {
                removed.push(ck.1.clone());
            }
            keep
        });
        if !removed.is_empty() {
            self.evict_unwatched_cache(&removed);
        }
        before != self.entries.len()
    }
}
