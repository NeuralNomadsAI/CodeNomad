use super::{Backend, Owner, platform};
use crate::settings::{
    notification_routing::{self, Category, Destination},
    transcript_preset::{self, Row},
};
use codenomad_client::{Receiver, bounded};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

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
    MissionDeleteSessions,
    Mode,
    Palette(bool),
}

impl Choice {
    fn put(self, patch: &mut Value, value: &ChoiceValue, snapshot: &Value) {
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
                secure,
            },
        ) = (self, value)
        {
            patch["environmentVariables"][name] = value.clone().map_or(Value::Null, Value::String);
            if let Some(secure) = secure {
                patch["secureEnvVars"] = json!(secure);
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
            Self::MissionDeleteSessions => {
                patch["settings"]["missionDeleteSessions"] = json!(value == "true");
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
                row.put(&mut patch["settings"], &snapshot["settings"], value)
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
                secure,
            },
        ) = (self, value)
        {
            let saved = &snapshot["environmentVariables"][name];
            return value
                .as_ref()
                .map_or_else(|| saved.is_null(), |value| saved == value)
                && secure
                    .as_ref()
                    .is_none_or(|secure| snapshot["secureEnvVars"] == json!(secure));
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
            Self::MissionDeleteSessions => {
                snapshot["settings"]["missionDeleteSessions"] == (value == "true")
            }
            Self::GeneralBehavior(toggle) => {
                snapshot["settings"][toggle.key()] == toggle.json_value(value == "true")
            }
            Self::NewConversationPermissions => {
                snapshot["settings"]["newConversationPermissions"] == value
            }
            Self::TranscriptPreset => transcript_preset::confirmed(value, &snapshot["settings"]),
            Self::TranscriptRow(row) => row.mode(&snapshot["settings"]) == value,
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
        secure: Option<Vec<String>>,
    },
}

type Choices = BTreeMap<Choice, ChoiceValue>;

#[derive(Default)]
struct Write {
    requested: Choices,
    pending: BTreeSet<Choice>,
    failed: BTreeSet<Choice>,
    retry: BTreeSet<Choice>,
}

#[derive(Default)]
struct Read {
    queued: bool,
    failed: bool,
    reattach: bool,
}

enum Operation {
    Read { retry: BTreeSet<Choice> },
    Write(Choices),
}

enum DocumentReply {
    Snapshot(Value),
    Failed,
    AuthExpired,
}

struct Flight {
    operation: Operation,
    reply: Receiver<DocumentReply>,
    backend: Backend,
}

#[derive(Default)]
pub(super) struct Document {
    pub(super) snapshot: Option<Value>,
    read: Read,
    write: Write,
    flight: Option<Flight>,
    barrier: Option<Flight>,
    notification_failure: bool,
    auth_expired: Option<Backend>,
}

impl Document {
    pub(super) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
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
            *self = Self::default();
            return;
        }
        self.auth_expired = None;
        if let Some(flight) = self.flight.take() {
            match flight.operation {
                Operation::Write(_) => self.barrier = Some(flight),
                Operation::Read { retry } => self.write.retry.extend(retry),
            }
        }
        self.read.reattach = true;
    }

    pub(super) fn invalidate(&mut self) {
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

    pub(super) fn read_failed(&self) -> bool {
        self.read.failed
    }

    pub(super) fn choice_retrying(&self, choice: Choice) -> bool {
        self.write.retry.contains(&choice)
            || matches!(
                self.flight.as_ref().map(|flight| &flight.operation),
                Some(Operation::Read { retry }) if retry.contains(&choice)
            )
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
        secure: Option<Vec<String>>,
    ) {
        self.stage_value(
            Choice::Environment,
            ChoiceValue::Environment {
                name,
                value,
                secure,
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

    fn stage_value(&mut self, choice: Choice, value: ChoiceValue) {
        let obsolete = |prior: &Choice| match choice {
            Choice::TranscriptPreset => matches!(prior, Choice::TranscriptRow(_)),
            Choice::TranscriptRow(_) => {
                *prior == Choice::TranscriptPreset && self.write.failed.contains(prior)
            }
            _ => false,
        };
        self.write.requested.retain(|prior, _| !obsolete(prior));
        self.write
            .pending
            .retain(|prior| self.write.requested.contains_key(prior));
        self.write
            .failed
            .retain(|prior| self.write.requested.contains_key(prior));
        if matches!(
            choice,
            Choice::Contrast
                | Choice::GeneralBehavior(_)
                | Choice::NewConversationPermissions
                | Choice::TranscriptPreset
                | Choice::TranscriptRow(_)
                | Choice::LogLevel
                | Choice::UpdateFeed
                | Choice::Advanced(_)
                | Choice::Environment
                | Choice::NotificationRoute(..)
                | Choice::NotificationsFocused
                | Choice::MissionDeleteSessions
                | Choice::Shortcut(_)
                | Choice::ShortcutReset
        ) {
            self.write.failed.remove(&choice);
        }
        self.write.requested.insert(choice, value);
        self.write.pending.insert(choice);
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
            || in_flight(&self.flight)
            || in_flight(&self.barrier)
    }

    pub(super) fn unsettled(&self) -> bool {
        self.flight.is_some()
            || self.barrier.is_some()
            || !self.write.pending.is_empty()
            || !self.write.retry.is_empty()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_unconfirmed(&self) -> bool {
        !self.write.requested.is_empty()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn prepare_drain(&mut self) {
        if self.read.failed && !self.write.pending.is_empty() && self.flight.is_none() {
            self.invalidate();
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn draining(&self) -> bool {
        self.has_unconfirmed()
            && (self.flight.is_some()
                || !self.write.retry.is_empty()
                || self.read.queued
                || !self.read.failed && !self.write.pending.is_empty())
    }

    fn settle(&mut self, operation: Operation, snapshot: Option<Value>, current: bool) {
        if let Operation::Write(sent) = &operation {
            for (&choice, value) in sent {
                if self.write.requested.get(&choice) == Some(value)
                    && !self.write.pending.contains(&choice)
                    && !snapshot
                        .as_ref()
                        .is_some_and(|data| choice.confirmed(value, data))
                {
                    if choice == Choice::TranscriptPreset
                        && self
                            .write
                            .pending
                            .iter()
                            .any(|prior| matches!(prior, Choice::TranscriptRow(_)))
                    {
                        self.write.requested.remove(&choice);
                    } else {
                        self.write.failed.insert(choice);
                        self.notification_failure |= current && !choice.has_dedicated_error();
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
                    false
                } else {
                    true
                }
            });
            if let Operation::Read { retry } = operation {
                self.write
                    .pending
                    .extend(retry.intersection(&self.write.failed));
            }
            if current {
                self.snapshot = Some(snapshot);
            }
        }
    }

    pub(super) fn poll(
        &mut self,
        backend: &Backend,
        owner: Owner,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        let mut changed = false;
        if let Some(flight) = &self.barrier {
            let Some(reply) = flight.result() else {
                return false;
            };
            if let Some(flight) = self.barrier.take() {
                let snapshot = match reply {
                    DocumentReply::Snapshot(v) => Some(v),
                    DocumentReply::Failed => None,
                    DocumentReply::AuthExpired => {
                        if flight.backend.client.same_connection(&backend.client) {
                            self.auth_expired = Some(flight.backend);
                        }
                        None
                    }
                };
                self.settle(flight.operation, snapshot, false);
                changed = true;
            }
        }
        if let Some(flight) = &self.flight {
            let Some(reply) = flight.result() else {
                return changed;
            };
            if let Some(flight) = self.flight.take() {
                let snapshot = match reply {
                    DocumentReply::Snapshot(v) => Some(v),
                    DocumentReply::Failed => None,
                    DocumentReply::AuthExpired => {
                        if flight.backend.client.same_connection(&backend.client) {
                            self.auth_expired = Some(flight.backend);
                        }
                        None
                    }
                };
                self.settle(flight.operation, snapshot, true);
                changed = true;
            }
        }
        if self.auth_expired.is_some() {
            return changed;
        }
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
        } else if !self.read.failed && !self.write.pending.is_empty() {
            // A preset is one authoritative write. Build following per-row edits from its receipt.
            let preset = self.write.pending.contains(&Choice::TranscriptPreset);
            let mut pending = std::mem::take(&mut self.write.pending);
            if preset {
                self.write.pending.extend(
                    pending.extract_if(.., |choice| matches!(choice, Choice::TranscriptRow(_))),
                );
            }
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
        } else if std::mem::take(&mut self.read.queued) {
            Operation::Read {
                retry: BTreeSet::new(),
            }
        } else {
            return changed;
        };
        let patch = if let Operation::Write(sent) = &operation {
            let mut patch = json!({});
            if sent
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
                );
            }
            Some(patch)
        } else {
            None
        };
        let (sender, reply) = bounded(1);
        self.flight = Some(Flight {
            operation,
            reply,
            backend: backend.clone(),
        });
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let mut reply = DocumentReply::Failed;
            if let Some(patch) = patch {
                match owner.patch(&backend, &patch).await {
                    Ok(snapshot) => reply = DocumentReply::Snapshot(snapshot),
                    Err(error) if error.is::<codenomad_client::settings::SettingsAuthExpired>() => {
                        reply = DocumentReply::AuthExpired;
                    }
                    Err(_) => {}
                }
            }
            // A lost receipt gets one readback, never an automatic replay or post-401 readback.
            if matches!(reply, DocumentReply::Failed) {
                match owner.read(&backend).await {
                    Ok(snapshot) => reply = DocumentReply::Snapshot(snapshot),
                    Err(error) if error.is::<codenomad_client::settings::SettingsAuthExpired>() => {
                        reply = DocumentReply::AuthExpired;
                    }
                    Err(_) => {}
                }
            }
            let _ = sender.send(reply).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
        true
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
        document.settle(Operation::Write(sent), Some(unchanged.clone()), true);
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
    document.settle(Operation::Write(sent), Some(unchanged), true);
    assert!(document.choice_failed(Choice::Locale));
    assert!(document.take_notification_failure());
}

impl Flight {
    fn result(&self) -> Option<DocumentReply> {
        match self.reply.try_recv() {
            Ok(reply) => Some(reply),
            Err(_) if self.reply.is_closed() && self.reply.is_empty() => {
                Some(DocumentReply::Failed)
            }
            Err(_) => None,
        }
    }
}
