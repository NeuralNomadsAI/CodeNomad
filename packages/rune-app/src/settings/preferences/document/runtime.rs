use super::{Choice, ChoiceValue, Choices, Document, Flight, Operation, Skip, is_transcript};
use crate::settings::{
    notification_routing,
    preferences::{Backend, Owner, platform},
};
use codenomad_client::{bounded, settings::PatchOutcome};
use serde_json::{Value, json};
#[cfg(test)]
use std::collections::BTreeMap;
use std::{
    collections::BTreeSet,
    sync::{Arc, atomic::Ordering},
};

impl Document {
    fn settle(
        &mut self,
        operation: Operation,
        patched: bool,
        snapshot: Option<Value>,
        current: bool,
        flight_epoch: u64,
        defer_revoked: bool,
    ) {
        // Any GET response (retry read, passive read, or fallback readback after a failed PATCH,
        // including a pre-reattach barrier readback or a read started before a transport outage)
        // predates newer server state and must not confirm writes, clear read errors,
        // publish a stale snapshot, or lose a pending Retry intent.
        let stale_read = !patched
            && (self.read.queued
                || (!current && self.read.reattach)
                || flight_epoch != self.transport_epoch);
        let defer_uncertain = !patched
            && stale_read
            && current
            && self.read.queued
            && (defer_revoked || flight_epoch == self.transport_epoch);
        if let Operation::Write(sent) = &operation {
            for (&choice, value) in sent {
                if defer_uncertain {
                    if is_transcript(choice) {
                        if !self.transcript_superseded(choice) {
                            self.write.requested.insert(choice, value.clone());
                            self.write.uncertain.insert(choice, value.clone());
                        }
                    } else if self.write.requested.get(&choice) == Some(value)
                        && !self.write.pending.contains(&choice)
                    {
                        self.write.uncertain.insert(choice, value.clone());
                    }
                    continue;
                }
                let confirmed = !stale_read
                    && snapshot
                        .as_ref()
                        .is_some_and(|data| choice.confirmed(value, data));
                if is_transcript(choice) {
                    if confirmed {
                        if self.write.requested.get(&choice) == Some(value) {
                            self.write.requested.remove(&choice);
                            self.write.failed.remove(&choice);
                        }
                        if choice == Choice::TranscriptPreset {
                            self.write.post_preset_rows.clear();
                        } else if self.write.failed.contains(&Choice::TranscriptPreset)
                            || self.write.uncertain.contains_key(&Choice::TranscriptPreset)
                        {
                            self.write.post_preset_rows.insert(choice, value.clone());
                        }
                    } else if !self.transcript_superseded(choice) {
                        self.write.requested.insert(choice, value.clone());
                        self.write.failed.insert(choice);
                        self.notification_failure |= current && !choice.has_dedicated_error();
                    }
                } else if self.write.requested.get(&choice) == Some(value)
                    && !self.write.pending.contains(&choice)
                    && !confirmed
                {
                    self.write.failed.insert(choice);
                    self.notification_failure |= current && !choice.has_dedicated_error();
                }
            }
        }
        if stale_read {
            if let Operation::Read { retry } = operation {
                self.write.retry.extend(retry);
            }
            return;
        }
        if current
            && matches!(operation, Operation::Read { .. })
            && !self.write.uncertain.is_empty()
        {
            for (choice, value) in std::mem::take(&mut self.write.uncertain) {
                let confirmed = snapshot
                    .as_ref()
                    .is_some_and(|data| choice.confirmed(&value, data));
                if is_transcript(choice) {
                    if confirmed {
                        if self.write.requested.get(&choice) == Some(&value) {
                            self.write.requested.remove(&choice);
                            self.write.failed.remove(&choice);
                        }
                        if choice == Choice::TranscriptPreset {
                            self.write.post_preset_rows.clear();
                        } else if self.write.failed.contains(&Choice::TranscriptPreset)
                            || self.write.uncertain.contains_key(&Choice::TranscriptPreset)
                        {
                            self.write.post_preset_rows.insert(choice, value);
                        }
                    } else if !self.transcript_superseded(choice) {
                        self.write.requested.insert(choice, value);
                        self.write.failed.insert(choice);
                        self.notification_failure |= !choice.has_dedicated_error();
                    }
                } else if self.write.requested.get(&choice) == Some(&value)
                    && !self.write.pending.contains(&choice)
                {
                    if confirmed {
                        self.write.requested.remove(&choice);
                        self.write.failed.remove(&choice);
                    } else {
                        self.write.failed.insert(choice);
                        self.notification_failure |= !choice.has_dedicated_error();
                    }
                }
            }
        }
        if current {
            self.read.failed = snapshot.is_none();
            // Info has an independent authoritative metadata read after every feed gesture.
            // Settle a refused preflight so that read can proceed; retry needs a new gesture.
            if self.read.failed {
                for choice in [
                    Choice::UpdateFeed,
                    Choice::Environment,
                    Choice::OpenCodeBinary,
                    Choice::OpenCodeBinaries,
                    Choice::PaletteMutation,
                ] {
                    if self.write.pending.remove(&choice) {
                        self.write.failed.insert(choice);
                    }
                }
            }
        }
        if let Some(snapshot) = snapshot {
            self.write.requested.retain(|&choice, value| {
                // A response already in flight can predate a queued gesture, even for the same value.
                let eligible = !self.write.pending.contains(&choice)
                    && match &operation {
                        Operation::Write(sent) => sent.get(&choice) == Some(value),
                        Operation::Read { .. } => self.write.failed.contains(&choice),
                    };
                if eligible && choice.confirmed(value, &snapshot) {
                    self.write.pending.remove(&choice);
                    self.write.failed.remove(&choice);
                    if choice == Choice::TranscriptPreset {
                        self.write.post_preset_rows.clear();
                    } else if matches!(choice, Choice::TranscriptRow(_))
                        && self.write.failed.contains(&Choice::TranscriptPreset)
                    {
                        self.write.post_preset_rows.insert(choice, value.clone());
                    }
                    false
                } else {
                    true
                }
            });
            if let Operation::Read { ref retry } = operation {
                let mut preset_retry = Choices::new();
                let mut row_retry = Choices::new();
                for &choice in retry.intersection(&self.write.failed) {
                    if is_transcript(choice) {
                        if let Some(value) = self.write.requested.get(&choice).cloned() {
                            if choice == Choice::TranscriptPreset {
                                preset_retry.insert(choice, value);
                            } else {
                                row_retry.insert(choice, value);
                            }
                        }
                    } else {
                        self.write.pending.insert(choice);
                    }
                }
                if !preset_retry.is_empty() {
                    for (choice, value) in std::mem::take(&mut self.write.post_preset_rows) {
                        row_retry.entry(choice).or_insert_with(|| {
                            self.write.requested.insert(choice, value.clone());
                            value
                        });
                    }
                }
                if !row_retry.is_empty() {
                    for &choice in row_retry.keys() {
                        self.write.failed.remove(&choice);
                    }
                    self.requeue_transcript_front(row_retry);
                }
                if !preset_retry.is_empty() {
                    for &choice in preset_retry.keys() {
                        self.write.failed.remove(&choice);
                    }
                    self.requeue_transcript_front(preset_retry);
                }
            }
            if current {
                let stale_publish =
                    (!patched && self.read.queued) || flight_epoch != self.transport_epoch;
                if !stale_publish || self.snapshot.is_none() {
                    self.snapshot = Some(snapshot);
                }
                if matches!(operation, Operation::Read { .. })
                    && flight_epoch == self.transport_epoch
                {
                    self.confirmed_epoch = flight_epoch;
                    self.read.recheck = false;
                    if !stale_publish {
                        self.read.fresh_for_write = true;
                    }
                }
            }
        }
    }

    fn requeue_skipped_write(
        &mut self,
        sent: Choices,
        transport_lost: bool,
        prefs_transport_lost: bool,
    ) {
        self.read.fresh_for_write = false;
        if transport_lost {
            self.mark_transport_lost();
            if !prefs_transport_lost {
                self.invalidate();
            }
        } else {
            self.invalidate();
        }
        if sent.keys().any(|choice| is_transcript(*choice)) {
            self.requeue_transcript_front(sent);
        } else {
            for (choice, value) in sent {
                if self.write.requested.get(&choice) == Some(&value) {
                    self.write.pending.insert(choice);
                }
            }
        }
    }

    pub(in crate::settings::preferences) fn poll(
        &mut self,
        backend: &Backend,
        owner: Owner,
        active_client_ids: &[String],
        seen_drops: u64,
        prefs_transport_lost: bool,
        external_write_in_flight: bool,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> (bool, bool) {
        let mut changed = false;
        let mut settled = false;
        if backend.client.transport_drops_sum(active_client_ids) != seen_drops
            || (self.transport_revalidated() && backend.client.attestation_revoked())
        {
            let was_confirmed = self.confirmed_epoch == self.transport_epoch;
            self.mark_transport_lost();
            if was_confirmed {
                changed = true;
            }
        }
        if let Some(flight) = &self.barrier {
            let Some((
                patched,
                _uncertain_transport,
                skipped,
                (read_rev, _read_inv, read_drops, read_gen),
                snapshot,
            )) = flight.result()
            else {
                return (false, false);
            };
            if let Some(flight) = self.barrier.take() {
                if skipped != Skip::None {
                    match flight.operation {
                        Operation::Write(sent) => self.requeue_skipped_write(
                            sent,
                            skipped == Skip::Transport,
                            prefs_transport_lost,
                        ),
                        Operation::Read { retry } => {
                            self.write.retry.extend(retry);
                            self.invalidate();
                        }
                    }
                } else {
                    let flight_client = &flight.client;
                    let revoked = snapshot.is_some()
                        && flight_client.tracks_server_attestation()
                        && (flight_client.drop_generation() != read_gen
                            || flight_client.needs_capability_recheck()
                            || flight_client.has_unattested_stream_drop());
                    if revoked {
                        self.mark_transport_lost();
                        self.invalidate();
                    } else if flight_client.preferences_revision(owner) != read_rev
                        || flight_client.transport_drops_sum(active_client_ids) != read_drops
                    {
                        self.invalidate();
                    }
                    let snapshot = if revoked { None } else { snapshot };
                    let patched = patched && !revoked;
                    self.settle(
                        flight.operation,
                        patched,
                        snapshot,
                        false,
                        flight.transport_epoch,
                        false,
                    );
                }
                changed = true;
                settled = true;
            }
        }
        if let Some(flight) = &self.flight {
            let Some((
                patched,
                uncertain_transport,
                skipped,
                (read_rev, read_inv, read_drops, read_gen),
                snapshot,
            )) = flight.result()
            else {
                return (changed, settled);
            };
            if let Some(flight) = self.flight.take() {
                if skipped != Skip::None {
                    match flight.operation {
                        Operation::Write(sent) => self.requeue_skipped_write(
                            sent,
                            skipped == Skip::Transport,
                            prefs_transport_lost,
                        ),
                        Operation::Read { retry } => {
                            self.write.retry.extend(retry);
                            self.invalidate();
                        }
                    }
                } else {
                    let flight_client = &flight.client;
                    let revoked = snapshot.is_some()
                        && flight_client.tracks_server_attestation()
                        && (flight_client.drop_generation() != read_gen
                            || flight_client.needs_capability_recheck()
                            || flight_client.has_unattested_stream_drop());
                    let rev_changed = flight_client.preferences_revision(owner) != read_rev;
                    let drops_changed =
                        flight_client.transport_drops_sum(active_client_ids) != read_drops;
                    if revoked || uncertain_transport {
                        self.mark_transport_lost();
                        self.invalidate();
                    } else if rev_changed || drops_changed {
                        self.invalidate();
                    } else if !patched
                        && snapshot.is_some()
                        && flight.transport_epoch == self.transport_epoch
                        && self.invalidation_seq.load(Ordering::Acquire) == read_inv
                    {
                        self.read.queued = false;
                    }
                    let defer_revoked = (revoked && patched) || uncertain_transport;
                    let snapshot = if revoked { None } else { snapshot };
                    let patched = patched && !revoked;
                    let fresh_publish = !revoked
                        && !uncertain_transport
                        && !self.read.queued
                        && flight.transport_epoch == self.transport_epoch
                        && !rev_changed
                        && !drops_changed;
                    let has_snapshot = snapshot.is_some();
                    let is_read = matches!(flight.operation, Operation::Read { .. });
                    self.settle(
                        flight.operation,
                        patched,
                        snapshot,
                        true,
                        flight.transport_epoch,
                        defer_revoked,
                    );
                    if has_snapshot && fresh_publish {
                        self.snapshot_rev = read_rev;
                        if is_read {
                            self.read.authoritative_required = false;
                        }
                    }
                }
                changed = true;
                settled = true;
            }
        }
        if external_write_in_flight {
            return (changed, settled);
        }
        let writes_allowed = !self.read.failed && self.confirmed_epoch == self.transport_epoch;
        let atomic = backend.client.supports_atomic_settings_patches();
        if writes_allowed
            && !atomic
            && !backend.client.needs_capability_recheck()
            && self.write.pending.contains(&Choice::Environment)
            && self
                .write
                .requested
                .get(&Choice::Environment)
                .is_some_and(ChoiceValue::needs_atomic_mask)
        {
            self.write.pending.remove(&Choice::Environment);
            self.write.failed.insert(Choice::Environment);
            changed = true;
        }
        let sse_stale = backend.client.preferences_revision(owner) != self.snapshot_rev;
        let binaries_need_fresh = self.write.pending.contains(&Choice::OpenCodeBinaries);
        let palette_needs_fresh = self.needs_fresh_palette_snapshot();
        let needs_fresh_on_stale = !atomic && self.has_stale_sensitive_write();
        let needs_fresh_on_disk = !atomic && self.needs_fresh_snapshot();
        let operation = if !self.write.retry.is_empty() {
            self.read.reattach = false;
            self.read.queued = false;
            Operation::Read {
                retry: std::mem::take(&mut self.write.retry),
            }
        } else if std::mem::take(&mut self.read.reattach)
            || (self.read.authoritative_required && (!self.read.failed || self.read.queued))
            || (writes_allowed
                && ((needs_fresh_on_stale && (self.read.queued || sse_stale))
                    || ((needs_fresh_on_disk || binaries_need_fresh || palette_needs_fresh)
                        && !self.read.fresh_for_write)
                    || ((binaries_need_fresh || palette_needs_fresh)
                        && (self.read.queued || sse_stale))
                    || (!self.write.uncertain.is_empty() && self.read.queued)))
        {
            self.read.queued = false;
            Operation::Read {
                retry: BTreeSet::new(),
            }
        } else if writes_allowed && !self.write.pending.is_empty() {
            self.read.fresh_for_write = false;
            if self.write.pending.contains(&Choice::PaletteMutation)
                && matches!(
                    self.write.requested.get(&Choice::PaletteMutation),
                    Some(ChoiceValue::Palette(mutation))
                        if mutation
                            .reject_before_send(self.snapshot.as_ref().unwrap_or(&Value::Null))
                )
            {
                self.write.pending.remove(&Choice::PaletteMutation);
                self.write.failed.insert(Choice::PaletteMutation);
                changed = true;
                if self.write.pending.is_empty() {
                    return (changed, settled);
                }
            }
            let pending = std::mem::take(&mut self.write.pending);
            Operation::Write(
                pending
                    .into_iter()
                    .filter_map(|choice| {
                        self.write
                            .requested
                            .get(&choice)
                            .cloned()
                            .map(|value| (choice, value))
                    })
                    .collect(),
            )
        } else if writes_allowed && self.next_transcript_ready() {
            if let Some(batch) = self.write.transcript_queue.pop_front() {
                self.read.fresh_for_write = false;
                Operation::Write(batch)
            } else {
                return (changed, settled);
            }
        } else if std::mem::take(&mut self.read.queued) {
            Operation::Read {
                retry: BTreeSet::new(),
            }
        } else {
            return (changed, settled);
        };
        let (patch, write_needs_fresh, atomic_bound) = if let Operation::Write(sent) = &operation {
            let mut patch = json!({});
            let relies_on_atomic = sent.iter().any(|(choice, value)| match (choice, value) {
                (Choice::NotificationRoute(..), _) => true,
                (Choice::TranscriptRow(row), ChoiceValue::Text(mode)) => {
                    row.needs_fresh_snapshot(mode)
                }
                (Choice::Environment, value) => value.needs_atomic_mask(),
                _ => false,
            });
            let binaries_sensitive = sent.contains_key(&Choice::OpenCodeBinaries);
            let palette_sensitive = sent.get(&Choice::PaletteMutation).is_some_and(|value| {
                matches!(
                    value,
                    ChoiceValue::Palette(mutation)
                        if mutation
                            .needs_fresh_snapshot(self.snapshot.as_ref().unwrap_or(&Value::Null))
                )
            });
            let needs_fresh =
                (!atomic && relies_on_atomic) || binaries_sensitive || palette_sensitive;
            if !atomic
                && sent
                    .keys()
                    .any(|choice| matches!(choice, Choice::NotificationRoute(..)))
                && let Some(before) = self.snapshot.as_ref()
                && !before["settings"]["notificationRouting"].is_object()
            {
                patch["settings"]["notificationRouting"] = notification_routing::seed(before);
            }
            for (&choice, value) in sent {
                choice.put(
                    &mut patch,
                    value,
                    self.snapshot.as_ref().unwrap_or(&Value::Null),
                    atomic,
                );
            }
            (Some(patch), needs_fresh, atomic && relies_on_atomic)
        } else {
            (None, false, false)
        };
        let recheck_capabilities = patch.is_none()
            && self.confirmed_epoch != self.transport_epoch
            && (backend.client.needs_capability_recheck()
                || (self.read.recheck && backend.client.tracks_server_attestation()));
        let prepared_atomic = atomic;
        let prepared_gen = backend.client.drop_generation();
        let drop_watch = backend.client.watch_drops(active_client_ids);
        let (sender, reply) = bounded(1);
        let transport_epoch = self.transport_epoch;
        let epoch_guard = Arc::clone(&self.epoch_guard);
        let invalidation_seq = Arc::clone(&self.invalidation_seq);
        let prepared_inv = self.invalidation_seq.load(Ordering::Acquire);
        let snapshot_rev = self.snapshot_rev;
        #[cfg(not(target_arch = "wasm32"))]
        let started_rev = backend.client.preferences_revision(owner);
        self.flight = Some(Flight {
            operation,
            client: backend.client.clone(),
            reply,
            transport_epoch,
            #[cfg(not(target_arch = "wasm32"))]
            started_rev,
            _drop_watch: drop_watch,
        });
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        let active_client_ids = active_client_ids.to_vec();
        #[cfg(test)]
        let pre_patch_gate = if patch.is_some() {
            self.pre_patch_gate.take()
        } else {
            None
        };
        platform::spawn(async move {
            #[cfg(test)]
            if let Some(gate) = pre_patch_gate {
                let _ = gate.recv().await;
            }
            let mut snapshot = None;
            let mut patched = false;
            let mut rejected = false;
            let mut uncertain_transport = false;
            let mut skipped = Skip::None;
            let mut read_rev = backend.client.preferences_revision(owner);
            let mut read_inv = invalidation_seq.load(Ordering::Acquire);
            let mut read_drops = backend.client.transport_drops_sum(&active_client_ids);
            let mut read_gen = backend.client.drop_generation();
            let had_patch = patch.is_some();
            if let Some(patch) = patch {
                let mut pre_patch_ok = epoch_guard.load(Ordering::Acquire) == transport_epoch
                    && read_drops == seen_drops
                    && read_gen == prepared_gen
                    && !backend.client.needs_capability_recheck()
                    && prepared_atomic == backend.client.supports_atomic_settings_patches();
                if pre_patch_ok
                    && backend.client.tracks_server_attestation()
                    && backend.client.has_unattested_stream_drop()
                {
                    if backend.attest_server().await.is_err() {
                        pre_patch_ok = false;
                    } else {
                        read_drops = backend.client.transport_drops_sum(&active_client_ids);
                        read_gen = backend.client.drop_generation();
                        pre_patch_ok = epoch_guard.load(Ordering::Acquire) == transport_epoch
                            && read_drops == seen_drops
                            && read_gen == prepared_gen
                            && !backend.client.needs_capability_recheck()
                            && !backend.client.has_unattested_stream_drop()
                            && prepared_atomic == backend.client.supports_atomic_settings_patches();
                    }
                }
                if !pre_patch_ok {
                    skipped = Skip::Transport;
                } else {
                    read_rev = backend.client.preferences_revision(owner);
                    read_inv = invalidation_seq.load(Ordering::Acquire);
                    if write_needs_fresh && (read_rev != snapshot_rev || read_inv != prepared_inv) {
                        skipped = Skip::Stale;
                    } else {
                        match owner.patch(&backend, &patch, atomic_bound).await {
                            PatchOutcome::Applied(value) => {
                                snapshot = Some(value);
                                patched = true;
                            }
                            PatchOutcome::Rejected => {
                                rejected = true;
                            }
                            PatchOutcome::Uncertain => {}
                        }
                    }
                }
            }
            // A lost receipt gets one readback, never an automatic replay.
            if skipped == Skip::None && !rejected && snapshot.is_none() {
                let transport_changed = epoch_guard.load(Ordering::Acquire) != transport_epoch
                    || backend.client.transport_drops_sum(&active_client_ids) != seen_drops
                    || (had_patch
                        && backend.client.tracks_server_attestation()
                        && (backend.client.drop_generation() != read_gen
                            || backend.client.needs_capability_recheck()));
                if transport_changed {
                    if !had_patch {
                        skipped = Skip::Transport;
                    } else {
                        uncertain_transport = true;
                    }
                } else {
                    let must_attest = recheck_capabilities
                        || backend.client.needs_capability_recheck()
                        || (backend.client.tracks_server_attestation()
                            && backend.client.has_unattested_stream_drop());
                    let attested = !must_attest
                        || (backend.attest_server().await.is_ok()
                            && !backend.client.needs_capability_recheck()
                            && !backend.client.has_unattested_stream_drop());
                    let still_current = epoch_guard.load(Ordering::Acquire) == transport_epoch
                        && backend.client.transport_drops_sum(&active_client_ids) == seen_drops;
                    if attested && still_current {
                        read_rev = backend.client.preferences_revision(owner);
                        read_inv = invalidation_seq.load(Ordering::Acquire);
                        read_drops = backend.client.transport_drops_sum(&active_client_ids);
                        read_gen = backend.client.drop_generation();
                        snapshot = owner.read(&backend).await.ok();
                    } else if attested && !had_patch {
                        skipped = Skip::Transport;
                    } else if had_patch {
                        uncertain_transport = true;
                    }
                }
            }
            let _ = sender
                .send((
                    patched,
                    uncertain_transport,
                    skipped,
                    (read_rev, read_inv, read_drops, read_gen),
                    snapshot,
                ))
                .await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
        (true, settled)
    }
}

#[cfg(test)]
#[test]
fn notification_routes_do_not_read_an_invalidated_document() {
    let mut document = Document {
        snapshot: Some(json!({"settings":{"osNotificationsAllowWhenVisible":true}})),
        ..Document::default()
    };
    assert!(document.confirmed().is_some());
    document.invalidate();
    assert!(document.confirmed().is_none());
}

#[cfg(test)]
#[test]
fn dedicated_error_choices_do_not_emit_generic_save_notification() {
    let unchanged = json!({"settings":{"hotkeyOverrides":{"file-save":[]}}});
    for (choice, value) in [
        (Choice::Contrast, ChoiceValue::Text("on")),
        (
            Choice::NewConversationPermissions,
            ChoiceValue::Text("manual"),
        ),
        (
            Choice::Shortcut("close-instance"),
            ChoiceValue::Shortcut(json!([])),
        ),
        (Choice::ShortcutReset, ChoiceValue::Shortcut(Value::Null)),
        (Choice::UpdateFeed, ChoiceValue::Text("stable")),
    ] {
        let mut document = Document::default();
        document.write.requested.insert(choice, value.clone());
        let sent = BTreeMap::from([(choice, value)]);
        document.settle(
            Operation::Write(sent),
            false,
            Some(unchanged.clone()),
            true,
            0,
            false,
        );
        assert!(document.choice_failed(choice));
        assert!(!document.take_notification_failure());
    }
    let mut document = Document::default();
    let value = ChoiceValue::Text("fr");
    document
        .write
        .requested
        .insert(Choice::Locale, value.clone());
    let sent = BTreeMap::from([(Choice::Locale, value)]);
    document.settle(
        Operation::Write(sent),
        false,
        Some(unchanged),
        true,
        0,
        false,
    );
    assert!(document.choice_failed(Choice::Locale));
    assert!(document.take_notification_failure());

    // A 200 PATCH response revoked before poll() consumes it defers settlement to the follow-up GET.
    let mut document = Document::default();
    let value = ChoiceValue::Text("fr");
    document
        .write
        .requested
        .insert(Choice::Locale, value.clone());
    document.mark_transport_lost();
    document.invalidate();
    let sent = BTreeMap::from([(Choice::Locale, value)]);
    document.settle(Operation::Write(sent), false, None, true, 0, true);
    assert!(!document.choice_failed(Choice::Locale));
    assert!(!document.take_notification_failure());
    document.read.queued = false;
    let epoch = document.transport_epoch;
    document.settle(
        Operation::Read {
            retry: BTreeSet::new(),
        },
        false,
        Some(json!({"settings":{"locale":"fr"}})),
        true,
        epoch,
        false,
    );
    assert!(!document.choice_failed(Choice::Locale));
    assert!(!document.take_notification_failure());
}
