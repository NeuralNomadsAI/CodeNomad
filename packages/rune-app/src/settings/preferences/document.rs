use super::{Backend, Owner, platform};
use crate::settings::notification_routing::{self, Category, Destination};
use codenomad_client::{Receiver, bounded};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Choice {
    Locale,
    Contrast,
    NewConversationPermissions,
    LogLevel,
    NotificationRoute(Category, Destination),
    NotificationsFocused,
    Mode,
    Palette(bool),
}

impl Choice {
    fn put(self, patch: &mut Value, value: &'static str) {
        match self {
            Self::Locale => patch["settings"]["locale"] = json!(value),
            Self::Contrast => patch["settings"]["highContrast"] = json!(value),
            Self::LogLevel => patch["logLevel"] = json!(value),
            Self::NotificationRoute(category, destination) => {
                patch["settings"]["notificationRouting"][category.key()][destination.key()] =
                    json!(value == "true");
            }
            Self::NotificationsFocused => {
                patch["settings"]["osNotificationsAllowWhenVisible"] = json!(value == "true");
            }
            Self::NewConversationPermissions => {
                patch["settings"]["newConversationPermissions"] = json!(value)
            }
            Self::Mode => patch["appearancePreferences"]["mode"] = json!(value),
            Self::Palette(dark) => {
                let mode = if dark { "dark" } else { "light" };
                patch["appearancePreferences"][mode] = json!({
                    "scheme":{"id":value,"appearance":mode,"colors":null},"presetId":null
                });
            }
        }
    }

    fn confirmed(self, value: &'static str, snapshot: &Value) -> bool {
        let appearance = &snapshot["appearancePreferences"];
        match self {
            Self::Locale => snapshot["settings"]["locale"] == value,
            Self::Contrast => snapshot["settings"]["highContrast"] == value,
            Self::LogLevel => snapshot["logLevel"] == value,
            Self::NotificationRoute(category, destination) => {
                snapshot["settings"]["notificationRouting"][category.key()][destination.key()]
                    == (value == "true")
            }
            Self::NotificationsFocused => {
                snapshot["settings"]["osNotificationsAllowWhenVisible"] == (value == "true")
            }
            Self::NewConversationPermissions => {
                snapshot["settings"]["newConversationPermissions"] == value
            }
            Self::Mode => appearance["mode"] == value,
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
}

type Choices = BTreeMap<Choice, &'static str>;

#[derive(Default)]
struct Write {
    requested: Choices,
    pending: BTreeSet<Choice>,
    failed: BTreeSet<Choice>,
    retry: bool,
}

#[derive(Default)]
struct Read {
    queued: bool,
    failed: bool,
    reattach: bool,
}

enum Operation {
    Read { retry: bool },
    Write(Choices),
}

struct Flight {
    operation: Operation,
    reply: Receiver<Option<Value>>,
}

#[derive(Default)]
pub(super) struct Document {
    pub(super) snapshot: Option<Value>,
    read: Read,
    write: Write,
    flight: Option<Flight>,
    barrier: Option<Flight>,
    notification_failure: bool,
}

impl Document {
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
        if let Some(flight) = self.flight.take() {
            match flight.operation {
                Operation::Write(_) => self.barrier = Some(flight),
                Operation::Read { retry } => self.write.retry |= retry,
            }
        }
        self.read.reattach = true;
    }

    pub(super) fn invalidate(&mut self) {
        self.read.queued = true;
    }

    pub(super) fn retry(&mut self) {
        let operation = self.flight.as_ref().map(|flight| &flight.operation);
        if matches!(operation, Some(Operation::Read { retry: true })) {
            return;
        }
        self.write.retry |= self.write.failed.iter().any(|choice| {
            !self.write.pending.contains(choice)
                && !matches!(operation, Some(Operation::Write(sent)) if sent.contains_key(choice))
        });
        if self.read.failed && !self.write.retry {
            self.invalidate();
        }
    }

    pub(super) fn read_failed(&self) -> bool {
        self.read.failed
    }

    pub(super) fn awaiting_initial_read(&self) -> bool {
        self.snapshot.is_none() && !self.read.failed
    }

    pub(super) fn write_failed(&self) -> bool {
        !self.write.failed.is_empty()
    }

    pub(super) fn write_failed_other_than(&self, choice: Choice) -> bool {
        self.write.failed.iter().any(|failed| *failed != choice)
    }

    pub(super) fn stage(&mut self, choice: Choice, value: &'static str) {
        if matches!(
            choice,
            Choice::Contrast
                | Choice::NewConversationPermissions
                | Choice::LogLevel
                | Choice::NotificationRoute(..)
                | Choice::NotificationsFocused
        ) {
            self.write.failed.remove(&choice);
        }
        self.write.requested.insert(choice, value);
        self.write.pending.insert(choice);
    }

    pub(super) fn requested(&self, choice: Choice) -> Option<&'static str> {
        self.write.requested.get(&choice).copied()
    }

    pub(super) fn choice_failed(&self, choice: Choice) -> bool {
        self.write.failed.contains(&choice)
    }

    pub(super) fn unsettled(&self) -> bool {
        self.flight.is_some()
            || self.barrier.is_some()
            || !self.write.pending.is_empty()
            || self.write.retry
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
                || self.write.retry
                || self.read.queued
                || !self.read.failed && !self.write.pending.is_empty())
    }

    fn settle(&mut self, operation: Operation, snapshot: Option<Value>, current: bool) {
        if let Operation::Write(sent) = &operation {
            for (&choice, &value) in sent {
                if !self.write.pending.contains(&choice)
                    && !snapshot
                        .as_ref()
                        .is_some_and(|data| choice.confirmed(value, data))
                {
                    self.write.failed.insert(choice);
                    self.notification_failure |=
                        current && choice != Choice::NewConversationPermissions;
                }
            }
        }
        if current {
            self.read.failed = snapshot.is_none();
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
            if matches!(operation, Operation::Read { retry: true }) {
                self.write.pending.extend(&self.write.failed);
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
            let Some(snapshot) = flight.result() else {
                return false;
            };
            if let Some(flight) = self.barrier.take() {
                self.settle(flight.operation, snapshot, false);
                changed = true;
            }
        }
        if let Some(flight) = &self.flight {
            let Some(snapshot) = flight.result() else {
                return changed;
            };
            if let Some(flight) = self.flight.take() {
                self.settle(flight.operation, snapshot, true);
                changed = true;
            }
        }
        let operation = if self.write.retry {
            self.write.retry = false;
            self.read.reattach = false;
            self.read.queued = false;
            Operation::Read { retry: true }
        } else if std::mem::take(&mut self.read.reattach) {
            self.read.queued = false;
            Operation::Read { retry: false }
        } else if !self.read.failed && !self.write.pending.is_empty() {
            Operation::Write(
                std::mem::take(&mut self.write.pending)
                    .into_iter()
                    .filter_map(|choice| self.requested(choice).map(|value| (choice, value)))
                    .collect(),
            )
        } else if std::mem::take(&mut self.read.queued) {
            Operation::Read { retry: false }
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
            for (&choice, &value) in sent {
                choice.put(&mut patch, value);
            }
            Some(patch)
        } else {
            None
        };
        let (sender, reply) = bounded(1);
        self.flight = Some(Flight { operation, reply });
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let mut snapshot = None;
            if let Some(patch) = patch {
                snapshot = owner.patch(&backend, &patch).await.ok();
            }
            // A lost receipt gets one readback, never an automatic replay.
            if snapshot.is_none() {
                snapshot = owner.read(&backend).await.ok();
            }
            let _ = sender.send(snapshot).await;
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

impl Flight {
    fn result(&self) -> Option<Option<Value>> {
        match self.reply.try_recv() {
            Ok(snapshot) => Some(snapshot),
            Err(_) if self.reply.is_closed() && self.reply.is_empty() => Some(None),
            Err(_) => None,
        }
    }
}
