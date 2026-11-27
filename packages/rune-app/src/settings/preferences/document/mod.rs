mod choice;
mod runtime;

pub(super) use choice::Choice;
use choice::{ChoiceValue, Choices, is_transcript};
pub(in crate::settings) use choice::{
    OpenCodeBinariesOp, OpenCodeBinaryEntry, env_var_is_masked, normalize_opencode_binary,
    parse_opencode_binaries,
};

use crate::settings::transcript_preset::{self, Row};
use codenomad_client::{
    Receiver,
    http::{ClientDropWatch, Http},
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Default)]
struct Write {
    requested: Choices,
    pending: BTreeSet<Choice>,
    transcript_queue: VecDeque<Choices>,
    post_preset_rows: Choices,
    uncertain: Choices,
    failed: BTreeSet<Choice>,
    retry: BTreeSet<Choice>,
}

#[derive(Default)]
struct Read {
    queued: bool,
    failed: bool,
    reattach: bool,
    recheck: bool,
    fresh_for_write: bool,
}

enum Operation {
    Read { retry: BTreeSet<Choice> },
    Write(Choices),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Skip {
    None,
    Transport,
    Stale,
}

type FlightOutcome = (bool, bool, Skip, (u64, u64, u64, u64), Option<Value>);

struct Flight {
    operation: Operation,
    client: Http,
    reply: Receiver<FlightOutcome>,
    transport_epoch: u64,
    #[cfg(not(target_arch = "wasm32"))]
    started_rev: u64,
    _drop_watch: ClientDropWatch,
}

#[derive(Default)]
pub(super) struct Document {
    pub(super) snapshot: Option<Value>,
    read: Read,
    write: Write,
    flight: Option<Flight>,
    barrier: Option<Flight>,
    notification_failure: bool,
    transport_epoch: u64,
    epoch_guard: Arc<AtomicU64>,
    invalidation_seq: Arc<AtomicU64>,
    publish_seq: u64,
    confirmed_epoch: u64,
    snapshot_rev: u64,
    #[cfg(test)]
    pre_patch_gate: Option<Receiver<()>>,
}

impl Document {
    #[cfg(test)]
    pub(super) fn set_pre_patch_gate(&mut self, gate: Receiver<()>) {
        self.pre_patch_gate = Some(gate);
    }

    pub(super) fn mark_transport_lost(&mut self) {
        self.transport_epoch += 1;
        self.read.recheck = true;
        self.epoch_guard
            .store(self.transport_epoch, Ordering::Release);
    }

    pub(super) fn transport_revalidated(&self) -> bool {
        self.snapshot.is_some() && !self.read.failed && self.confirmed_epoch == self.transport_epoch
    }

    pub(super) fn retry_revalidation(&mut self, force: bool) {
        let reading_current = self.flight.as_ref().is_some_and(|flight| {
            matches!(flight.operation, Operation::Read { .. })
                && flight.transport_epoch == self.transport_epoch
        });
        if (force || !self.transport_revalidated())
            && self.write.retry.is_empty()
            && !reading_current
        {
            self.invalidate();
        }
    }
    pub(super) fn take_notification_failure(&mut self) -> bool {
        std::mem::take(&mut self.notification_failure)
    }
    pub(super) fn refreshing(&self) -> bool {
        self.read.queued || self.read.reattach || self.flight.is_some() || self.barrier.is_some()
    }

    pub(super) fn confirmed(&self) -> Option<&Value> {
        if self.read.queued
            || self.read.reattach
            || self.read.failed
            || self.flight.is_some()
            || self.barrier.is_some()
        {
            return None;
        }
        self.snapshot.as_ref()
    }

    pub(super) fn rebind(&mut self, same_address: bool) {
        if !same_address {
            self.epoch_guard.fetch_add(1, Ordering::Release);
            *self = Self::default();
            return;
        }
        if let Some(flight) = self.flight.take() {
            match flight.operation {
                Operation::Write(_) => self.barrier = Some(flight),
                Operation::Read { retry } => self.write.retry.extend(retry),
            }
        }
        self.read.reattach = true;
        self.mark_transport_lost();
        self.read.recheck = false;
    }

    pub(super) fn invalidate(&mut self) {
        self.read.queued = true;
        self.invalidation_seq.fetch_add(1, Ordering::Release);
    }

    pub(super) fn invalidate_from_sse(&mut self) {
        self.read.queued = true;
    }

    pub(super) fn retry(&mut self, accepts: impl Fn(Choice) -> bool) {
        let operation = self.flight.as_ref().map(|flight| &flight.operation);
        self.write
            .retry
            .extend(self.write.failed.iter().copied().filter(|choice| {
            accepts(*choice)
                && !self.write.pending.contains(choice)
                && !matches!(operation, Some(Operation::Write(sent)) if sent.contains_key(choice))
                && !matches!(operation, Some(Operation::Read { retry }) if retry.contains(choice))
        }));
        if self.read.failed
            && self.write.retry.is_empty()
            && !matches!(operation, Some(Operation::Read { .. }))
        {
            self.invalidate();
        }
    }

    #[cfg(test)]
    pub(super) fn set_read_failed(&mut self, failed: bool) {
        self.read.failed = failed;
    }

    pub(super) fn read_failed(&self) -> bool {
        self.read.failed
    }

    pub(super) fn invalidation_seq(&self) -> u64 {
        self.invalidation_seq.load(Ordering::Acquire)
    }

    pub(super) fn invalidation_seq_guard(&self) -> (Arc<AtomicU64>, u64) {
        (
            self.invalidation_seq.clone(),
            self.invalidation_seq.load(Ordering::Acquire),
        )
    }

    pub(super) fn publish_seq(&self) -> u64 {
        self.publish_seq
    }

    pub(super) fn write_authority(&self) -> (Arc<AtomicU64>, u64) {
        (self.epoch_guard.clone(), self.transport_epoch)
    }

    pub(super) fn apply_external_snapshot(
        &mut self,
        snapshot: Value,
        expected_seq: Option<u64>,
        expected_publish_seq: Option<u64>,
    ) -> bool {
        if self.read.reattach
            || self.read.queued
            || self.flight.is_some()
            || expected_seq.is_some_and(|seq| seq != self.invalidation_seq.load(Ordering::Acquire))
            || expected_publish_seq.is_some_and(|seq| seq != self.publish_seq)
        {
            self.invalidate();
            return false;
        }
        self.snapshot = Some(snapshot);
        self.read.failed = false;
        self.invalidation_seq.fetch_add(1, Ordering::Release);
        self.publish_seq = self.publish_seq.wrapping_add(1);
        true
    }

    pub(super) fn awaiting_initial_read(&self) -> bool {
        self.snapshot.is_none() && !self.read.failed
    }

    #[cfg(test)]
    pub(super) fn write_failed(&self) -> bool {
        !self.write.failed.is_empty()
    }

    pub(super) fn any_failure(&self, accepts: impl Fn(Choice) -> bool) -> bool {
        self.write.failed.iter().copied().any(accepts)
    }

    #[cfg(test)]
    pub(super) fn write_failed_other_than(&self, choice: Choice) -> bool {
        self.write.failed.iter().any(|failed| *failed != choice)
    }

    pub(super) fn stage(&mut self, choice: Choice, value: &'static str) {
        self.stage_value(choice, ChoiceValue::Text(value));
    }

    pub(super) fn stage_shortcut(&mut self, id: &'static str, binding: Value) {
        self.stage_value(Choice::Shortcut(id), ChoiceValue::Shortcut(binding));
    }

    pub(super) fn stage_environment(
        &mut self,
        name: String,
        value: Option<String>,
        secret: Option<bool>,
    ) {
        self.stage_value(
            Choice::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secret,
            },
        );
    }

    pub(super) fn stage_palette_mutation(
        &mut self,
        mutation: crate::settings::palettes::PaletteMutation,
    ) {
        if matches!(
            mutation.op,
            crate::settings::palettes::PaletteOp::SetMode { .. }
        ) {
            self.write.requested.remove(&Choice::Mode);
            self.write.pending.remove(&Choice::Mode);
            self.write.failed.remove(&Choice::Mode);
            self.write.retry.remove(&Choice::Mode);
        } else if let Some(dark) = mutation.target_dark() {
            self.write.requested.remove(&Choice::Palette(dark));
            self.write.pending.remove(&Choice::Palette(dark));
            self.write.failed.remove(&Choice::Palette(dark));
            self.write.retry.remove(&Choice::Palette(dark));
        } else {
            for dark in [false, true] {
                self.write.requested.remove(&Choice::Palette(dark));
                self.write.pending.remove(&Choice::Palette(dark));
                self.write.failed.remove(&Choice::Palette(dark));
                self.write.retry.remove(&Choice::Palette(dark));
            }
        }
        if mutation.needs_fresh_snapshot(self.snapshot.as_ref().unwrap_or(&Value::Null)) {
            self.read.fresh_for_write = false;
        }
        self.stage_value(
            Choice::PaletteMutation,
            ChoiceValue::Palette(Box::new(mutation)),
        );
    }

    pub(super) fn clear_palette_mutation(&mut self) {
        self.write.requested.remove(&Choice::PaletteMutation);
        self.write.pending.remove(&Choice::PaletteMutation);
        self.write.failed.remove(&Choice::PaletteMutation);
        self.write.retry.remove(&Choice::PaletteMutation);
        self.write.uncertain.remove(&Choice::PaletteMutation);
    }

    pub(super) fn settle_palette_mutation_on_auth_expired(&mut self) {
        let had_unsent = self.write.pending.remove(&Choice::PaletteMutation)
            | self.write.retry.remove(&Choice::PaletteMutation);
        let had_sent = self
            .write
            .uncertain
            .remove(&Choice::PaletteMutation)
            .is_some()
            || self.flight.as_ref().is_some_and(|flight| {
                matches!(&flight.operation, Operation::Write(sent) if sent.contains_key(&Choice::PaletteMutation))
            })
            || self.barrier.as_ref().is_some_and(|flight| {
                matches!(&flight.operation, Operation::Write(sent) if sent.contains_key(&Choice::PaletteMutation))
            });
        let had_requested = self
            .write
            .requested
            .remove(&Choice::PaletteMutation)
            .is_some();
        if had_unsent || had_sent || had_requested {
            self.write.failed.insert(Choice::PaletteMutation);
        }
    }

    pub(super) fn palette_mutation_pending(&self) -> bool {
        (self.write.requested.contains_key(&Choice::PaletteMutation)
            || self.write.pending.contains(&Choice::PaletteMutation)
            || self.write.uncertain.contains_key(&Choice::PaletteMutation))
            && !self.choice_failed(Choice::PaletteMutation)
    }

    pub(super) fn palette_mutation_failed(&self) -> bool {
        self.choice_failed(Choice::PaletteMutation)
    }

    pub(super) fn environment_pending(&self) -> bool {
        self.write.requested.contains_key(&Choice::Environment)
            && !self.choice_failed(Choice::Environment)
    }

    pub(super) fn stage_opencode_binary(&mut self, path: String) {
        self.stage_value(Choice::OpenCodeBinary, ChoiceValue::OpenCodeBinary(path));
    }

    pub(super) fn clear_failed_opencode_binary(&mut self, path: &str) {
        if self.write.failed.contains(&Choice::OpenCodeBinary)
            && !self.choice_pending(Choice::OpenCodeBinary)
            && self.write.requested.get(&Choice::OpenCodeBinary)
                == Some(&ChoiceValue::OpenCodeBinary(path.to_owned()))
        {
            self.write.failed.remove(&Choice::OpenCodeBinary);
            self.write.requested.remove(&Choice::OpenCodeBinary);
        }
    }

    pub(super) fn stage_opencode_binaries(&mut self, op: OpenCodeBinariesOp) {
        self.stage_value(Choice::OpenCodeBinaries, ChoiceValue::OpenCodeBinaries(op));
    }

    pub(super) fn transport_epoch(&self) -> u64 {
        self.transport_epoch
    }

    pub(super) fn reset_shortcuts(&mut self) {
        if !self.shortcuts_pending() {
            self.write
                .requested
                .retain(|k, _| !matches!(k, Choice::Shortcut(_)));
            self.write
                .failed
                .retain(|k| !matches!(k, Choice::Shortcut(_)));
            self.stage_value(Choice::ShortcutReset, ChoiceValue::Shortcut(Value::Null));
        }
    }

    pub(super) fn shortcuts_pending(&self) -> bool {
        self.write.requested.keys().any(|choice| {
            matches!(choice, Choice::Shortcut(_) | Choice::ShortcutReset)
                && !self.choice_failed(*choice)
        })
    }

    pub(super) fn resetting_shortcuts(&self) -> bool {
        self.write.requested.contains_key(&Choice::ShortcutReset)
    }

    pub(super) fn stage_transcript_batch(
        &mut self,
        batch: impl IntoIterator<Item = (Choice, &'static str)>,
    ) -> bool {
        let batch: Choices = batch
            .into_iter()
            .map(|(choice, value)| (choice, ChoiceValue::Text(value)))
            .collect();
        let duplicate_in_flight = self.write.transcript_queue.is_empty()
            && batch.contains_key(&Choice::TranscriptPreset)
            && matches!(
                self.flight.as_ref().map(|f| &f.operation),
                Some(Operation::Write(sent)) if sent == &batch
            );
        if batch.is_empty()
            || duplicate_in_flight
            || self.write.transcript_queue.back() == Some(&batch)
        {
            return false;
        }
        if batch.contains_key(&Choice::TranscriptPreset) {
            // Preserve earlier unsent row edits ahead of the new preset (matching Solid's FIFO
            // order so a 503 on the preset never silently drops them), while coalescing any
            // unsent preset and collapsing earlier row batches into one leading batch.
            let mut leading_rows = Choices::new();
            for queued in self.write.transcript_queue.drain(..) {
                if !queued.contains_key(&Choice::TranscriptPreset) {
                    leading_rows.extend(queued);
                }
            }
            if !leading_rows.is_empty() {
                self.write.transcript_queue.push_back(leading_rows);
            }
            self.write.post_preset_rows.clear();
            self.write.failed.retain(|c| !is_transcript(*c));
            self.write.retry.retain(|c| !is_transcript(*c));
            self.write.uncertain.retain(|c, _| !is_transcript(*c));
            self.write.requested.retain(|c, _| !is_transcript(*c));
            self.write.transcript_queue.push_back(batch);
        } else {
            for (choice, value) in &batch {
                self.write.failed.remove(choice);
                self.write.retry.remove(choice);
                self.write.requested.remove(choice);
                self.write.post_preset_rows.remove(choice);
                if let (Choice::TranscriptRow(row), ChoiceValue::Text(mode)) = (*choice, value)
                    && row.needs_fresh_snapshot(mode)
                {
                    self.read.fresh_for_write = false;
                }
            }
            if let Some(back) = self.write.transcript_queue.back_mut()
                && !back.contains_key(&Choice::TranscriptPreset)
            {
                back.extend(batch);
            } else {
                self.write.transcript_queue.push_back(batch);
            }
        }
        true
    }

    fn requeue_transcript_front(&mut self, batch: Choices) {
        if batch.is_empty() {
            return;
        }
        if batch.contains_key(&Choice::TranscriptPreset) {
            if self
                .write
                .transcript_queue
                .front()
                .is_some_and(|front| front.contains_key(&Choice::TranscriptPreset))
            {
                return;
            }
            self.write.transcript_queue.push_front(batch);
        } else if let Some(front) = self.write.transcript_queue.front_mut()
            && !front.contains_key(&Choice::TranscriptPreset)
        {
            for (choice, value) in batch {
                front.entry(choice).or_insert(value);
            }
        } else {
            self.write.transcript_queue.push_front(batch);
        }
    }

    fn stage_value(&mut self, choice: Choice, value: ChoiceValue) {
        if is_transcript(choice) {
            if let ChoiceValue::Text(value) = value {
                self.stage_transcript_batch([(choice, value)]);
            }
            return;
        }
        if matches!(
            choice,
            Choice::Contrast
                | Choice::GeneralBehavior(_)
                | Choice::NewConversationPermissions
                | Choice::LogLevel
                | Choice::UpdateFeed
                | Choice::Advanced(_)
                | Choice::Environment
                | Choice::NotificationRoute(..)
                | Choice::NotificationsFocused
                | Choice::Shortcut(_)
                | Choice::ShortcutReset
                | Choice::OpenCodeBinary
                | Choice::OpenCodeBinaries
                | Choice::PaletteMutation
        ) {
            self.write.failed.remove(&choice);
        }
        if matches!(
            choice,
            Choice::NotificationRoute(..) | Choice::OpenCodeBinaries
        ) {
            self.read.fresh_for_write = false;
        }
        if self.confirmed_epoch != self.transport_epoch && !self.refreshing() {
            self.invalidate();
        }
        self.write.requested.insert(choice, value);
        self.write.pending.insert(choice);
    }

    pub(super) fn pending_transcript_preset(
        &self,
        saved_base: &'static str,
    ) -> Option<(&'static str, &'static str, Option<&'static str>)> {
        let mut preset = None;
        let mut base = saved_base;
        let mut usage_exp = None;
        let mut apply = |choices: &Choices| {
            if let Some(ChoiceValue::Text(name)) = choices.get(&Choice::TranscriptPreset) {
                preset = Some(*name);
                base = *name;
                usage_exp = Some(transcript_preset::usage_default(name));
            }
            if choices
                .keys()
                .any(|choice| matches!(choice, Choice::TranscriptRow(_)))
            {
                preset = Some("custom");
                if choices.keys().any(|choice| {
                    matches!(choice, Choice::TranscriptRow(Row::Thinking | Row::Tool(_)))
                }) {
                    base = "custom";
                }
                if let Some(ChoiceValue::Text(mode)) =
                    choices.get(&Choice::TranscriptRow(Row::Usage))
                    && *mode != "hidden"
                {
                    usage_exp = Some(*mode);
                }
            }
        };
        for flight in [&self.barrier, &self.flight] {
            if let Some(Operation::Write(sent)) = flight.as_ref().map(|f| &f.operation) {
                apply(sent);
            }
        }
        for batch in &self.write.transcript_queue {
            apply(batch);
        }
        preset.map(|name| (name, base, usage_exp))
    }

    pub(super) fn pending_transcript_mode(&self, row: Row) -> Option<&'static str> {
        let mut resolved = None;
        let mut apply = |choices: &Choices| {
            if let Some(ChoiceValue::Text(preset)) = choices.get(&Choice::TranscriptPreset) {
                resolved = Some(row.preset_mode(preset));
            }
            if let Some(ChoiceValue::Text(mode)) = choices.get(&Choice::TranscriptRow(row)) {
                resolved = Some(*mode);
            }
        };
        for flight in [&self.barrier, &self.flight] {
            if let Some(Operation::Write(sent)) = flight.as_ref().map(|f| &f.operation) {
                apply(sent);
            }
        }
        for batch in &self.write.transcript_queue {
            apply(batch);
        }
        resolved
    }

    fn next_transcript_ready(&self) -> bool {
        !self.write.transcript_queue.is_empty()
    }

    fn transcript_superseded(&self, choice: Choice) -> bool {
        self.write.transcript_queue.iter().any(|batch| {
            batch.contains_key(&Choice::TranscriptPreset) || batch.contains_key(&choice)
        })
    }

    pub(super) fn requested(&self, choice: Choice) -> Option<&'static str> {
        match self.write.requested.get(&choice)? {
            ChoiceValue::Text(value) => Some(*value),
            ChoiceValue::Shortcut(_)
            | ChoiceValue::Palette(_)
            | ChoiceValue::Environment { .. }
            | ChoiceValue::OpenCodeBinary(_)
            | ChoiceValue::OpenCodeBinaries(_) => None,
        }
    }

    pub(super) fn choice_failed(&self, choice: Choice) -> bool {
        self.write.failed.contains(&choice)
    }

    pub(super) fn choice_pending(&self, choice: Choice) -> bool {
        let in_flight = |flight: &Option<Flight>| match flight.as_ref().map(|f| &f.operation) {
            Some(Operation::Write(sent)) => sent.contains_key(&choice),
            Some(Operation::Read { retry }) => retry.contains(&choice),
            None => false,
        };
        self.write.pending.contains(&choice)
            || self.write.retry.contains(&choice)
            || self.write.uncertain.contains_key(&choice)
            || self
                .write
                .transcript_queue
                .iter()
                .any(|batch| batch.contains_key(&choice))
            || in_flight(&self.flight)
            || in_flight(&self.barrier)
    }

    pub(super) fn unsettled(&self) -> bool {
        self.flight.is_some()
            || self.barrier.is_some()
            || !self.write.pending.is_empty()
            || self.next_transcript_ready()
            || !self.write.retry.is_empty()
            || (self.read.queued && !self.write.requested.is_empty())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn flight_has_write(flight: &Option<Flight>) -> bool {
        matches!(
            flight.as_ref().map(|f| &f.operation),
            Some(Operation::Write(sent)) if !sent.is_empty()
        )
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        !self.write.requested.is_empty()
            || !self.write.transcript_queue.is_empty()
            || Self::flight_has_write(&self.flight)
            || Self::flight_has_write(&self.barrier)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn prepare_drain(
        &mut self,
        current_rev: Option<u64>,
        retry_failed: bool,
        atomic: bool,
    ) {
        let reading_rev = self.flight.as_ref().and_then(|flight| {
            (matches!(flight.operation, Operation::Read { .. })
                && flight.transport_epoch == self.transport_epoch)
                .then_some(flight.started_rev)
        });
        let needs_revalidation = (retry_failed && self.read.failed)
            || (retry_failed && !atomic && self.has_stale_sensitive_write())
            || (!self.read.failed
                && self.confirmed_epoch != self.transport_epoch
                && reading_rev.is_none());
        if needs_revalidation && self.has_unconfirmed() {
            self.invalidate();
        }
        if let Some(rev) = current_rev
            && self.has_unconfirmed()
            && rev != self.snapshot_rev
            && reading_rev != Some(rev)
        {
            self.invalidate();
        }
    }

    pub(super) fn needs_fresh_palette_snapshot(&self) -> bool {
        self.write.pending.contains(&Choice::PaletteMutation)
            && matches!(
                self.write.requested.get(&Choice::PaletteMutation),
                Some(ChoiceValue::Palette(mutation))
                    if mutation.needs_fresh_snapshot(self.snapshot.as_ref().unwrap_or(&Value::Null))
            )
    }

    fn has_stale_sensitive_write(&self) -> bool {
        self.write
            .pending
            .iter()
            .any(|choice| matches!(choice, Choice::NotificationRoute(..)))
            || self.next_transcript_ready()
                && self.write.transcript_queue.front().is_some_and(|batch| {
                    batch.iter().any(|(choice, value)| match (choice, value) {
                        (Choice::TranscriptRow(row), ChoiceValue::Text(mode)) => {
                            row.needs_fresh_snapshot(mode)
                        }
                        _ => false,
                    })
                })
    }

    fn needs_fresh_snapshot(&self) -> bool {
        (self
            .write
            .pending
            .iter()
            .any(|choice| matches!(choice, Choice::NotificationRoute(..)))
            && !self
                .snapshot
                .as_ref()
                .is_some_and(|doc| doc["settings"]["notificationRouting"].is_object()))
            || self.next_transcript_ready()
                && self.write.transcript_queue.front().is_some_and(|batch| {
                    batch.iter().any(|(choice, value)| match (choice, value) {
                        (Choice::TranscriptRow(row), ChoiceValue::Text(mode)) => {
                            row.needs_fresh_snapshot(mode)
                        }
                        _ => false,
                    })
                })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn draining(&self) -> bool {
        let writes_allowed = !self.read.failed && self.confirmed_epoch == self.transport_epoch;
        self.has_unconfirmed()
            && (self.flight.is_some()
                || self.barrier.is_some()
                || !self.write.retry.is_empty()
                || self.read.queued
                || writes_allowed
                    && (!self.write.pending.is_empty() || self.next_transcript_ready()))
    }
}

impl Flight {
    fn result(&self) -> Option<FlightOutcome> {
        match self.reply.try_recv() {
            Ok(outcome) => Some(outcome),
            Err(_) if self.reply.is_closed() && self.reply.is_empty() => {
                Some((false, false, Skip::None, (0, 0, 0, 0), None))
            }
            Err(_) => None,
        }
    }
}
