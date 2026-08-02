use super::*;

impl PendingBatch {
    pub(super) fn push(&mut self, event: Value, stats: &mut DesktopEventTransportStats) {
        match classify_event(&event) {
            EventDeliveryPolicy::CoalesceDelta(key) => {
                let Some(scope) = delta_scope(&event) else {
                    let event_bytes = serialized_value_bytes(&event);
                    self.events.push(PendingEntry::Event(event));
                    self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
                    return;
                };

                let mut appended_bytes = None;
                if let Some(PendingEntry::Delta {
                    key: existing_key,
                    event: existing_event,
                    serialized_bytes,
                    delta_bytes,
                    ..
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        let next_delta = delta_payload(&event);
                        let next_bytes = serialized_string_content_bytes(next_delta);
                        if append_delta(existing_event, next_delta, delta_bytes) {
                            *serialized_bytes = serialized_bytes.saturating_add(next_bytes);
                            appended_bytes = Some(next_bytes);
                            stats.delta_coalesces = stats.delta_coalesces.saturating_add(1);
                        }
                    }
                }
                if let Some(appended_bytes) = appended_bytes {
                    self.estimated_bytes = self.estimated_bytes.saturating_add(appended_bytes);
                    return;
                }

                let event_bytes = serialized_value_bytes(&event);
                let delta_bytes = delta_payload(&event).len();
                self.events.push(PendingEntry::Delta {
                    key,
                    scope,
                    event,
                    serialized_bytes: event_bytes,
                    delta_bytes,
                    started_at: Instant::now(),
                });
                self.estimated_bytes = self.estimated_bytes.saturating_add(event_bytes);
            }
            EventDeliveryPolicy::CoalesceStatus(key) => {
                let event_bytes = serialized_value_bytes(&event);
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
                let event_bytes = serialized_value_bytes(&event);
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
                let event_bytes = serialized_value_bytes(&event);
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
}

fn pending_entry_bytes(entry: &PendingEntry) -> usize {
    match entry {
        PendingEntry::Delta {
            serialized_bytes, ..
        } => *serialized_bytes,
        PendingEntry::Status { event, .. }
        | PendingEntry::Snapshot { event, .. }
        | PendingEntry::Event(event) => serialized_value_bytes(event),
    }
}
