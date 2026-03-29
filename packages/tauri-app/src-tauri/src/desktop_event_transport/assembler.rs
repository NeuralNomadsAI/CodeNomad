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
                    instance_id: coalesced_instance_id(&event).to_string(),
                    session_id: event_session_id(&event).map(|value| value.to_string()),
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

    pub(super) fn should_hold_single_delta(
        &self,
        now: Instant,
        active_target: Option<&ActiveSessionTarget>,
    ) -> bool {
        matches!(
            self.events.as_slice(),
            [PendingEntry::Delta { started_at, instance_id, session_id, .. }]
                if now.duration_since(*started_at) < Duration::from_millis(
                    if active_target
                        .map(|target| {
                            target.instance_id.as_str() == instance_id.as_str()
                                && target.session_id.as_str() == session_id.as_deref().unwrap_or_default()
                        })
                        .unwrap_or(false)
                    {
                        ACTIVE_STREAM_HOLD_WINDOW_MS
                    } else {
                        DELTA_STREAM_WINDOW_MS
                    }
                )
        )
    }
}

impl ActiveTextAssembler {
    pub(super) fn absorb(&mut self, delta: ActiveTextDelta, now: Instant) -> Vec<Value> {
        let key = format!(
            "{}:{}:{}:{}",
            delta.instance_id, delta.session_id, delta.message_id, delta.part_id
        );

        match self.parts.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut occupied) => {
                let entry = occupied.get_mut();
                if entry.display_pending.is_empty() && entry.store_pending.is_empty() {
                    entry.instance_id = delta.instance_id.clone();
                    entry.session_id = delta.session_id.clone();
                    entry.message_id = delta.message_id.clone();
                    entry.part_id = delta.part_id.clone();
                }

                entry.display_pending.push_str(&delta.delta);
                entry.store_pending.push_str(&delta.delta);
                Self::collect_due_for_part(entry, now)
            }
            std::collections::hash_map::Entry::Vacant(vacant) => {
                let mut entry = ActiveTextPartBuffer::new(delta, now);
                entry.last_display_emit = now
                    .checked_sub(Duration::from_millis(ACTIVE_STREAM_DISPLAY_WINDOW_MS))
                    .unwrap_or(now);
                let emitted = Self::collect_due_for_part(&mut entry, now);
                vacant.insert(entry);
                emitted
            }
        }
    }

    pub(super) fn take_due(&mut self, now: Instant) -> Vec<Value> {
        let mut emitted = Vec::new();
        let mut empty_keys = Vec::new();

        for (key, entry) in self.parts.iter_mut() {
            emitted.extend(Self::collect_due_for_part(entry, now));
            if entry.display_pending.is_empty() && entry.store_pending.is_empty() {
                empty_keys.push(key.clone());
            }
        }

        for key in empty_keys {
            self.parts.remove(&key);
        }

        emitted
    }

    pub(super) fn flush_for_event(&mut self, event: &Value, now: Instant) -> Vec<Value> {
        let instance_id = coalesced_instance_id(event);
        let payload = coalesced_payload_event(event);
        let event_type = payload.get("type").and_then(Value::as_str);

        match event_type {
            Some("message.updated") | Some("message.removed") => {
                let props = payload.get("properties");
                let session_id = event_session_id(event);
                let message_id = props
                    .and_then(|value| {
                        value
                            .get("info")
                            .and_then(|info| info.get("id"))
                            .or_else(|| value.get("messageID"))
                            .or_else(|| value.get("messageId"))
                    })
                    .and_then(Value::as_str);
                if let (Some(session_id), Some(message_id)) = (session_id, message_id) {
                    return self.flush_message(instance_id, session_id, message_id, now);
                }
            }
            Some("message.part.updated") | Some("message.part.removed") => {
                let props = payload.get("properties");
                let session_id = event_session_id(event);
                let message_id = props
                    .and_then(|value| {
                        value
                            .get("part")
                            .and_then(|part| {
                                part.get("messageID").or_else(|| part.get("messageId"))
                            })
                            .or_else(|| value.get("messageID"))
                            .or_else(|| value.get("messageId"))
                    })
                    .and_then(Value::as_str);
                let part_id = props
                    .and_then(|value| {
                        value
                            .get("part")
                            .and_then(|part| part.get("id"))
                            .or_else(|| value.get("partID"))
                            .or_else(|| value.get("partId"))
                    })
                    .and_then(Value::as_str);
                if let (Some(session_id), Some(message_id), Some(part_id)) =
                    (session_id, message_id, part_id)
                {
                    return self.flush_part(instance_id, session_id, message_id, part_id, now);
                }
            }
            _ => {}
        }

        Vec::new()
    }

    pub(super) fn flush_message(
        &mut self,
        instance_id: &str,
        session_id: &str,
        message_id: &str,
        now: Instant,
    ) -> Vec<Value> {
        let keys: Vec<String> = self
            .parts
            .iter()
            .filter(|(_, entry)| {
                entry.instance_id == instance_id
                    && entry.session_id == session_id
                    && entry.message_id == message_id
            })
            .map(|(key, _)| key.clone())
            .collect();

        let mut emitted = Vec::new();
        for key in keys {
            if let Some(mut entry) = self.parts.remove(&key) {
                emitted.extend(Self::flush_all_for_part(&mut entry, now));
            }
        }
        emitted
    }

    pub(super) fn flush_part(
        &mut self,
        instance_id: &str,
        session_id: &str,
        message_id: &str,
        part_id: &str,
        now: Instant,
    ) -> Vec<Value> {
        let key = format!("{}:{}:{}:{}", instance_id, session_id, message_id, part_id);
        if let Some(mut entry) = self.parts.remove(&key) {
            return Self::flush_all_for_part(&mut entry, now);
        }
        Vec::new()
    }

    pub(super) fn flush_store_only_all(&mut self, now: Instant) -> Vec<Value> {
        let mut emitted = Vec::new();
        for entry in self.parts.values_mut() {
            if !entry.store_pending.is_empty() {
                emitted.push(make_message_part_delta_event(entry, &entry.store_pending));
                entry.store_pending.clear();
                entry.last_store_emit = now;
            }
            entry.display_pending.clear();
            entry.last_display_emit = now;
        }
        self.parts.clear();
        emitted
    }

    fn collect_due_for_part(entry: &mut ActiveTextPartBuffer, now: Instant) -> Vec<Value> {
        let mut emitted = Vec::new();

        // Display lane — emit preview chunks frequently (~16ms / 96 chars).
        if !entry.display_pending.is_empty()
            && (now.duration_since(entry.last_display_emit)
                >= Duration::from_millis(ACTIVE_STREAM_DISPLAY_WINDOW_MS)
                || entry.display_pending.len() >= ACTIVE_STREAM_DISPLAY_CHUNK_MAX)
        {
            emitted.push(make_assistant_stream_chunk_event(
                entry,
                &entry.display_pending,
            ));
            entry.display_pending.clear();
            entry.last_display_emit = now;
        }

        // Store lane — emit canonical deltas infrequently (~250ms) to avoid
        // flooding the JS reactive graph with store mutations that
        // trigger expensive re-render cascades during active streaming.
        // Explicit flush triggers (message.updated, message.part.updated,
        // session change, disconnect) still flush immediately via
        // flush_for_event / flush_all_for_part / flush_store_only_all.
        if !entry.store_pending.is_empty()
            && now.duration_since(entry.last_store_emit)
                >= Duration::from_millis(ACTIVE_STREAM_STORE_WINDOW_MS)
        {
            emitted.push(make_message_part_delta_event(entry, &entry.store_pending));
            entry.store_pending.clear();
            entry.last_store_emit = now;
        }

        emitted
    }

    fn flush_all_for_part(entry: &mut ActiveTextPartBuffer, now: Instant) -> Vec<Value> {
        let mut emitted = Vec::new();
        if !entry.display_pending.is_empty() {
            emitted.push(make_assistant_stream_chunk_event(
                entry,
                &entry.display_pending,
            ));
            entry.display_pending.clear();
            entry.last_display_emit = now;
        }
        if !entry.store_pending.is_empty() {
            emitted.push(make_message_part_delta_event(entry, &entry.store_pending));
            entry.store_pending.clear();
            entry.last_store_emit = now;
        }
        emitted
    }
}

impl ActiveTextSnapshotBuffer {
    pub(super) fn buffer(&mut self, snapshot: ActiveTextSnapshot, now: Instant) {
        match self.parts.entry(snapshot.key) {
            std::collections::hash_map::Entry::Occupied(mut occupied) => {
                let entry = occupied.get_mut();
                entry.instance_id = snapshot.instance_id;
                entry.session_id = snapshot.session_id;
                entry.message_id = snapshot.message_id;
                entry.part_id = snapshot.part_id;
                entry.event = snapshot.event;
            }
            std::collections::hash_map::Entry::Vacant(vacant) => {
                vacant.insert(BufferedTextSnapshot {
                    instance_id: snapshot.instance_id,
                    session_id: snapshot.session_id,
                    message_id: snapshot.message_id,
                    part_id: snapshot.part_id,
                    event: snapshot.event,
                    buffered_at: now,
                });
            }
        }
    }

    pub(super) fn take_due(&mut self, now: Instant) -> Vec<Value> {
        let keys: Vec<String> = self
            .parts
            .iter()
            .filter(|(_, entry)| {
                now.duration_since(entry.buffered_at)
                    >= Duration::from_millis(ACTIVE_STREAM_SNAPSHOT_WINDOW_MS)
            })
            .map(|(key, _)| key.clone())
            .collect();

        self.take_entries(keys)
    }

    pub(super) fn flush_for_event(&mut self, event: &Value) -> Vec<Value> {
        let instance_id = coalesced_instance_id(event);
        let payload = coalesced_payload_event(event);
        let event_type = payload.get("type").and_then(Value::as_str);

        match event_type {
            Some("message.updated") | Some("message.removed") => {
                let props = payload.get("properties");
                let session_id = event_session_id(event);
                let message_id = props
                    .and_then(|value| {
                        value
                            .get("info")
                            .and_then(|info| info.get("id"))
                            .or_else(|| value.get("messageID"))
                            .or_else(|| value.get("messageId"))
                    })
                    .and_then(Value::as_str);
                if let (Some(session_id), Some(message_id)) = (session_id, message_id) {
                    return self.flush_message(instance_id, session_id, message_id);
                }
            }
            Some("message.part.removed") => {
                let props = payload.get("properties");
                let session_id = event_session_id(event);
                let message_id = props
                    .and_then(|value| {
                        value
                            .get("part")
                            .and_then(|part| {
                                part.get("messageID").or_else(|| part.get("messageId"))
                            })
                            .or_else(|| value.get("messageID"))
                            .or_else(|| value.get("messageId"))
                    })
                    .and_then(Value::as_str);
                let part_id = props
                    .and_then(|value| {
                        value
                            .get("part")
                            .and_then(|part| part.get("id"))
                            .or_else(|| value.get("partID"))
                            .or_else(|| value.get("partId"))
                    })
                    .and_then(Value::as_str);
                if let (Some(session_id), Some(message_id), Some(part_id)) =
                    (session_id, message_id, part_id)
                {
                    return self.flush_part(instance_id, session_id, message_id, part_id);
                }
            }
            _ => {}
        }

        Vec::new()
    }

    pub(super) fn flush_message(
        &mut self,
        instance_id: &str,
        session_id: &str,
        message_id: &str,
    ) -> Vec<Value> {
        let keys: Vec<String> = self
            .parts
            .iter()
            .filter(|(_, entry)| {
                entry.instance_id == instance_id
                    && entry.session_id == session_id
                    && entry.message_id == message_id
            })
            .map(|(key, _)| key.clone())
            .collect();

        self.take_entries(keys)
    }

    pub(super) fn flush_part(
        &mut self,
        instance_id: &str,
        session_id: &str,
        message_id: &str,
        part_id: &str,
    ) -> Vec<Value> {
        let keys: Vec<String> = self
            .parts
            .iter()
            .filter(|(_, entry)| {
                entry.instance_id == instance_id
                    && entry.session_id == session_id
                    && entry.message_id == message_id
                    && entry.part_id == part_id
            })
            .map(|(key, _)| key.clone())
            .collect();

        self.take_entries(keys)
    }

    pub(super) fn flush_all(&mut self) -> Vec<Value> {
        let keys: Vec<String> = self.parts.keys().cloned().collect();
        self.take_entries(keys)
    }

    fn take_entries(&mut self, keys: Vec<String>) -> Vec<Value> {
        let mut emitted = Vec::new();
        for key in keys {
            if let Some(entry) = self.parts.remove(&key) {
                emitted.push(entry.event);
            }
        }
        emitted
    }
}
