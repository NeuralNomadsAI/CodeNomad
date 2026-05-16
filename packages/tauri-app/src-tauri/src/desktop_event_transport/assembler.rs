use super::*;

impl PendingBatch {
    pub(super) fn push(&mut self, event: Value, stats: &mut DesktopEventTransportStats) {
        match classify_event(&event) {
            EventDeliveryPolicy::CoalesceDelta(key) => {
                let Some(scope) = delta_scope(&event) else {
                    self.events.push(PendingEntry::Event(event));
                    return;
                };

                if let Some(PendingEntry::Delta {
                    key: existing_key,
                    event: existing_event,
                    ..
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        append_delta(existing_event, &event);
                        stats.delta_coalesces = stats.delta_coalesces.saturating_add(1);
                        return;
                    }
                }

                self.events.push(PendingEntry::Delta {
                    key,
                    scope,
                    event,
                    started_at: Instant::now(),
                });
            }
            EventDeliveryPolicy::CoalesceStatus(key) => {
                if let Some(PendingEntry::Status {
                    key: existing_key,
                    event: existing_event,
                }) = self.events.last_mut()
                {
                    if existing_key == &key {
                        *existing_event = event;
                        stats.status_coalesces = stats.status_coalesces.saturating_add(1);
                        return;
                    }
                }

                self.events.push(PendingEntry::Status { key, event });
            }
            EventDeliveryPolicy::CoalesceSnapshot(key) => {
                if let Some(part_scope) = snapshot_superseded_delta_scope(&event) {
                    let mut dropped = 0_u64;
                    while matches!(
                        self.events.last(),
                        Some(PendingEntry::Delta { scope, .. }) if scope == &part_scope
                    ) {
                        self.events.pop();
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
                        *existing_event = event;
                        stats.snapshot_coalesces = stats.snapshot_coalesces.saturating_add(1);
                        return;
                    }
                }

                self.events.push(PendingEntry::Snapshot { key, event });
            }
            EventDeliveryPolicy::Passthrough => {
                self.events.push(PendingEntry::Event(event));
            }
        }
    }

    pub(super) fn take_events(&mut self) -> Vec<Value> {
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

    pub(super) fn should_hold_single_delta(&self, now: Instant) -> bool {
        matches!(
            self.events.as_slice(),
            [PendingEntry::Delta { started_at, .. }]
                if now.duration_since(*started_at)
                    < Duration::from_millis(DELTA_STREAM_WINDOW_MS)
        )
    }
}
