use super::{Backend, Owner, platform};
use crate::settings::{
    notification_routing::{self, Category, Destination},
    transcript_preset::{self, Row},
};
use codenomad_client::{
    Receiver, bounded,
    http::{ClientDropWatch, Http},
    settings::PatchOutcome,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Choice {
    Locale,
    Contrast,
    Shortcut(&'static str),
    ShortcutReset,
    GeneralBehavior(crate::settings::preferences::behavior::GeneralToggle),
    NewConversationPermissions,
    TranscriptPreset,
    TranscriptRow(Row),
    LogLevel,
    UpdateFeed,
    Advanced(crate::settings::advanced::Toggle),
    Environment,
    NotificationRoute(Category, Destination),
    NotificationsFocused,
    Mode,
    Palette(bool),
}

fn env_key_eq(a: &str, b: &str) -> bool {
    if a.is_ascii() && b.is_ascii() {
        a.eq_ignore_ascii_case(b)
    } else {
        a.to_uppercase() == b.to_uppercase()
    }
}

fn env_has_case_sibling(snapshot: &Value, name: &str) -> bool {
    snapshot["environmentVariables"]
        .as_object()
        .into_iter()
        .flatten()
        .any(|(k, v)| !v.is_null() && k != name && env_key_eq(k, name))
}

pub(in crate::settings) fn env_var_is_masked(snapshot: &Value, name: &str) -> bool {
    snapshot["secureEnvVars"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|key| env_key_eq(key, name))
}

impl Choice {
    fn put(self, patch: &mut Value, value: &ChoiceValue, snapshot: &Value, atomic: bool) {
        if self == Self::ShortcutReset {
            patch["settings"]["hotkeyOverrides"] = Value::Null;
            return;
        }
        if let Self::Shortcut(id) = self {
            if let ChoiceValue::Shortcut(binding) = value {
                patch["settings"]["hotkeyOverrides"][id] = binding.clone();
            }
            return;
        }
        if let (
            Self::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secret,
            },
        ) = (self, value)
        {
            patch["environmentVariables"][name] = value.clone().map_or(Value::Null, Value::String);
            let want_masked = match (value.is_some(), *secret) {
                (false, _) => Some(false),
                (true, Some(masked)) => Some(masked),
                (true, None) => None,
            };
            if let Some(want_masked) = want_masked
                && atomic
            {
                patch["secureEnvVarsMask"][name] = json!(want_masked);
            }
            return;
        }
        let ChoiceValue::Text(value) = *value else {
            return;
        };
        match self {
            Self::Locale => patch["settings"]["locale"] = json!(value),
            Self::Contrast => patch["settings"]["highContrast"] = json!(value),
            Self::LogLevel => patch["logLevel"] = json!(value),
            Self::UpdateFeed => patch["updateFeed"] = json!(value),
            Self::Advanced(choice) => patch["settings"][choice.key()] = json!(value == "true"),
            Self::NotificationRoute(category, destination) => {
                patch["settings"]["notificationRouting"][category.key()][destination.key()] =
                    json!(value == "true");
            }
            Self::NotificationsFocused => {
                patch["settings"]["osNotificationsAllowWhenVisible"] = json!(value == "true");
            }
            Self::GeneralBehavior(toggle) => {
                patch["settings"][toggle.key()] = toggle.json_value(value == "true");
            }
            Self::NewConversationPermissions => {
                patch["settings"]["newConversationPermissions"] = json!(value)
            }
            Self::TranscriptPreset => {
                if let Value::Object(fields) = transcript_preset::patch(value) {
                    for (key, value) in fields {
                        patch["settings"][key] = value;
                    }
                }
            }
            Self::TranscriptRow(row) => {
                row.put(&mut patch["settings"], &snapshot["settings"], value, atomic)
            }
            Self::Mode => patch["appearancePreferences"]["mode"] = json!(value),
            Self::Shortcut(_) | Self::ShortcutReset | Self::Environment => (),
            Self::Palette(dark) => {
                let mode = if dark { "dark" } else { "light" };
                patch["appearancePreferences"][mode] = json!({
                    "scheme":{"id":value,"appearance":mode,"colors":null},"presetId":null
                });
            }
        }
    }

    fn confirmed(self, value: &ChoiceValue, snapshot: &Value) -> bool {
        if self == Self::ShortcutReset {
            let overrides = &snapshot["settings"]["hotkeyOverrides"];
            return overrides.is_null() || overrides.as_object().is_some_and(|map| map.is_empty());
        }
        if let Self::Shortcut(id) = self {
            return matches!(value, ChoiceValue::Shortcut(binding)
                if &snapshot["settings"]["hotkeyOverrides"][id] == binding);
        }
        if let (
            Self::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secret,
            },
        ) = (self, value)
        {
            let saved = &snapshot["environmentVariables"][name];
            if value.is_none() && env_has_case_sibling(snapshot, name) {
                return saved.is_null();
            }
            let value_ok = value
                .as_ref()
                .map_or_else(|| saved.is_null(), |value| saved == value);
            let mask_ok = match (value.is_some(), *secret) {
                (false, _) => !env_var_is_masked(snapshot, name),
                (true, Some(masked)) => env_var_is_masked(snapshot, name) == masked,
                (true, None) => true,
            };
            return value_ok && mask_ok;
        }
        let ChoiceValue::Text(value) = *value else {
            return false;
        };
        let appearance = &snapshot["appearancePreferences"];
        match self {
            Self::Locale => snapshot["settings"]["locale"] == value,
            Self::Contrast => snapshot["settings"]["highContrast"] == value,
            Self::LogLevel => snapshot["logLevel"] == value,
            Self::UpdateFeed => snapshot["updateFeed"] == value,
            Self::Advanced(choice) => snapshot["settings"][choice.key()] == (value == "true"),
            Self::NotificationRoute(category, destination) => {
                snapshot["settings"]["notificationRouting"][category.key()][destination.key()]
                    == (value == "true")
            }
            Self::NotificationsFocused => {
                snapshot["settings"]["osNotificationsAllowWhenVisible"] == (value == "true")
            }
            Self::GeneralBehavior(toggle) => {
                snapshot["settings"][toggle.key()] == toggle.json_value(value == "true")
            }
            Self::NewConversationPermissions => {
                snapshot["settings"]["newConversationPermissions"] == value
            }
            Self::TranscriptPreset => transcript_preset::confirmed(value, &snapshot["settings"]),
            Self::TranscriptRow(row) => row.confirmed(value, &snapshot["settings"]),
            Self::Mode => appearance["mode"] == value,
            Self::Shortcut(_) | Self::ShortcutReset | Self::Environment => false,
            Self::Palette(dark) => {
                let mode = if dark { "dark" } else { "light" };
                let slot = &appearance[mode];
                slot["scheme"]["id"] == value
                    && slot["scheme"]["appearance"] == mode
                    // A newly created object can preserve explicit nulls in the merge.
                    && slot["scheme"]["colors"].is_null()
                    && slot["presetId"].is_null()
            }
        }
    }

    fn has_dedicated_error(self) -> bool {
        matches!(
            self,
            Self::Contrast
                | Self::NewConversationPermissions
                | Self::Shortcut(_)
                | Self::ShortcutReset
                | Self::UpdateFeed
        )
    }
}

#[derive(Clone, PartialEq)]
enum ChoiceValue {
    Text(&'static str),
    Shortcut(Value),
    Environment {
        name: String,
        value: Option<String>,
        secret: Option<bool>,
    },
}

impl ChoiceValue {
    fn needs_atomic_mask(&self) -> bool {
        matches!(
            self,
            Self::Environment { value, secret, .. } if value.is_none() || secret.is_some()
        )
    }
}

type Choices = BTreeMap<Choice, ChoiceValue>;

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

fn is_transcript(choice: Choice) -> bool {
    matches!(choice, Choice::TranscriptPreset | Choice::TranscriptRow(_))
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

    pub(super) fn environment_pending(&self) -> bool {
        self.write.requested.contains_key(&Choice::Environment)
            && !self.choice_failed(Choice::Environment)
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
        ) {
            self.write.failed.remove(&choice);
        }
        if matches!(choice, Choice::NotificationRoute(..)) {
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
            ChoiceValue::Shortcut(_) | ChoiceValue::Environment { .. } => None,
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
                for choice in [Choice::UpdateFeed, Choice::Environment] {
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

    pub(super) fn poll(
        &mut self,
        backend: &Backend,
        owner: Owner,
        active_client_ids: &[String],
        seen_drops: u64,
        prefs_transport_lost: bool,
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
                        && !rev_changed;
                    let has_snapshot = snapshot.is_some();
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
                    }
                }
                changed = true;
                settled = true;
            }
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
        let needs_fresh_on_stale = !atomic && self.has_stale_sensitive_write();
        let needs_fresh_on_disk = !atomic && self.needs_fresh_snapshot();
        let operation = if !self.write.retry.is_empty() {
            self.read.reattach = false;
            self.read.queued = false;
            Operation::Read {
                retry: std::mem::take(&mut self.write.retry),
            }
        } else if std::mem::take(&mut self.read.reattach) {
            self.read.queued = false;
            Operation::Read {
                retry: BTreeSet::new(),
            }
        } else if writes_allowed
            && ((needs_fresh_on_stale && (self.read.queued || sse_stale))
                || (needs_fresh_on_disk && !self.read.fresh_for_write)
                || (!self.write.uncertain.is_empty() && self.read.queued))
        {
            self.read.queued = false;
            Operation::Read {
                retry: BTreeSet::new(),
            }
        } else if writes_allowed && !self.write.pending.is_empty() {
            self.read.fresh_for_write = false;
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
            let needs_fresh = !atomic && relies_on_atomic;
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
