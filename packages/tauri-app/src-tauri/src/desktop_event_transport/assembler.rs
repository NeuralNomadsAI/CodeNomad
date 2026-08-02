use super::*;

impl PendingBatch {
    pub(super) fn push(&mut self, event: Value, stats: &mut DesktopEventTransportStats) {
        let event_bytes = serialized_value_bytes(&event);
        match classify_event(&event) {
            EventDeliveryPolicy::CoalesceDelta(key) => {
                let Some(scope) = delta_scope(&event) else {
                    self.events.push(PendingEntry::Event(event));
                    self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
                    return;
                };

                let mut replacement_bytes = None;
                if let Some(PendingEntry::Delta {
                    key: existing_key,
                    event: existing_event,
                    ..
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        let old_bytes = serialized_value_bytes(existing_event);
                        if append_delta(existing_event, &event) {
                            replacement_bytes =
                                Some((old_bytes, serialized_value_bytes(existing_event)));
                            stats.delta_coalesces = stats.delta_coalesces.saturating_add(1);
                        }
                    }
                }
                if let Some((old_bytes, new_bytes)) = replacement_bytes {
                    self.replace_bytes(old_bytes, new_bytes);
                    return;
                }

                self.events.push(PendingEntry::Delta {
                    key,
                    scope,
                    event,
                    started_at: Instant::now(),
                });
                self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
            }
            EventDeliveryPolicy::CoalesceStatus(key) => {
                if let Some(PendingEntry::Status {
                    key: existing_key,
                    event: existing_event,
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        let old_bytes = serialized_value_bytes(existing_event);
                        *existing_event = event;
                        self.estimated_bytes = self
                            .estimated_bytes
                            .saturating_sub(old_bytes)
                            .saturating_add(event_bytes);
                        stats.status_coalesces = stats.status_coalesces.saturating_add(1);
                        return;
                    }
                }

                self.events.push(PendingEntry::Status { key, event });
                self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
            }
            EventDeliveryPolicy::CoalesceSnapshot(key) => {
                if let Some(part_scope) = snapshot_superseded_delta_scope(&event) {
                    let mut dropped = 0_u64;
                    while matches!(
                        self.events.last(),
                        Some(PendingEntry::Delta { scope, .. }) if scope == &part_scope
                    ) {
                        if let Some(entry) = self.events.pop() {
                            self.estimated_bytes = self
                                .estimated_bytes
                                .saturating_sub(pending_entry_bytes(&entry));
                        }
                        dropped = dropped.saturating_add(1);
                    }
                    if dropped > 0 {
                        stats.superseded_deltas_dropped =
                            stats.superseded_deltas_dropped.saturating_add(dropped);
                    }
                }

                if let Some(PendingEntry::Snapshot {
                    key: existing_key,
                    event: existing_event,
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        let old_bytes = serialized_value_bytes(existing_event);
                        *existing_event = event;
                        self.estimated_bytes = self
                            .estimated_bytes
                            .saturating_sub(old_bytes)
                            .saturating_add(event_bytes);
                        stats.snapshot_coalesces = stats.snapshot_coalesces.saturating_add(1);
                        return;
                    }
                }

                self.events.push(PendingEntry::Snapshot { key, event });
                self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
            }
            EventDeliveryPolicy::Passthrough => {
                self.events.push(PendingEntry::Event(event));
                self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
            }
        }
    }

    pub(super) fn take_events(&mut self) -> Vec<Value> {
        self.estimated_bytes = 0;
        let pending = std::mem::take(&mut self.events);
        pending
            .into_iter()
            .map(|entry| match entry {
                PendingEntry::Delta { event, .. } => event,
                PendingEntry::Status { event, .. } => event,
                PendingEntry::Snapshot { event, .. } => event,
                PendingEntry::Event(event) => event,
            })
            .collect()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub(super) fn pending_len(&self) -> usize {
        self.events.len()
    }

    pub(super) fn pending_bytes(&self) -> usize {
        self.estimated_bytes
    }

    pub(super) fn should_hold_single_delta(&self, now: Instant) -> bool {
        matches!(
            self.events.as_slice(),
            [PendingEntry::Delta { started_at, .. }]
                if now.duration_since(*started_at)
                    < Duration::from_millis(DELTA_STREAM_WINDOW_MS)
        )
    }

    fn replace_bytes(&mut self, old_bytes: usize, new_bytes: usize) {
        self.estimated_bytes = self
            .estimated_bytes
            .saturating_sub(old_bytes)
            .saturating_add(new_bytes);
    }
}

fn pending_entry_bytes(entry: &PendingEntry) -> usize {
    match entry {
        PendingEntry::Delta { event, .. }
        | PendingEntry::Status { event, .. }
        | PendingEntry::Snapshot { event, .. }
        | PendingEntry::Event(event) => serialized_value_bytes(event),
    }
}
