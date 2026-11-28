//! Programmed Missions ("calendars") state and async controller owned by `missions::Panel`.
//! Consumes `codenomad_client::missions::{calendars, launch, model}` for post-#1791 schedules,
//! pre-first-launch matching (#1803), and repeated-passage history (#1802).
mod editor;
mod editor_view;
mod summary;
mod view;

use crate::platform::{
    self,
    reads::{self, Reads},
};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{CalendarAction, CalendarOutcome, CalendarSaveRequest, CalendarView},
};
use editor::{CalendarEditor, unsupported_error_key};

pub(crate) use view::{delete_confirmation, view};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpKind {
    Read,
    Mutate,
}

struct Completion {
    kind: OpKind,
    serial: u64,
    outcome: Result<CalendarOutcome>,
}

pub(crate) struct Calendars {
    out: Sender<Completion>,
    incoming: Receiver<Completion>,
    serial: u64,
    active_read: Option<(u64, Sender<()>)>,
    active_mutation: Option<u64>,
    owed_refresh: bool,
    pub(super) entries: Vec<CalendarView>,
    pub(super) selected: Option<String>,
    pub(super) loaded: bool,
    pub(super) failed: bool,
    pub(super) unavailable: bool,
    pub(super) feedback: Option<&'static str>,
    pub(super) delete_confirm: Option<String>,
    pub(super) editor: Option<CalendarEditor>,
    auth_expired: Option<Backend>,
}

impl Default for Calendars {
    fn default() -> Self {
        let (out, incoming) = bounded(4);
        Self {
            out,
            incoming,
            serial: 0,
            active_read: None,
            active_mutation: None,
            owed_refresh: false,
            entries: Vec::new(),
            selected: None,
            loaded: false,
            failed: false,
            unavailable: false,
            feedback: None,
            delete_confirm: None,
            editor: None,
            auth_expired: None,
        }
    }
}

impl Calendars {
    pub(crate) fn is_composing(&self) -> bool {
        self.editor
            .as_ref()
            .is_some_and(CalendarEditor::is_composing)
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        self.entries.len().saturating_mul(512)
    }

    pub(crate) fn busy_read(&self) -> bool {
        self.active_read.is_some()
    }

    pub(crate) fn busy_mutation(&self) -> bool {
        self.active_mutation.is_some()
    }

    pub(crate) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }

    pub(crate) fn owns_conversation(&self, session_id: &str) -> bool {
        self.entries
            .iter()
            .any(|calendar| calendar.coordinator_session_id() == Some(session_id))
    }

    pub(crate) fn pending_delete(&self) -> Option<(&str, &str)> {
        let id = self.delete_confirm.as_deref()?;
        let calendar = self.entries.iter().find(|entry| entry.id == id)?;
        Some((calendar.id.as_str(), calendar.title.as_str()))
    }

    pub(crate) fn cancel(&mut self) {
        self.cancel_reads();
        self.delete_confirm = None;
    }

    pub(crate) fn on_reconnect(&mut self) {
        // Retire in-flight reads without dismissing an open delete confirmation modal.
        self.cancel_reads();
    }

    fn cancel_reads(&mut self) {
        if let Some((_, cancel)) = self.active_read.take() {
            cancel.close();
        }
        self.owed_refresh = false;
    }

    pub(crate) fn reset_for_rebind(&mut self) {
        self.cancel();
        self.active_mutation = None;
    }

    pub(crate) fn refresh(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        if self.active_mutation.is_some() || self.active_read.is_some() {
            self.owed_refresh = true;
            return;
        }
        self.start_read(backend, reads, wake);
    }

    pub(crate) fn retry_refresh(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        // Keep `failed` set until a fresh read succeeds so the retry control remains stable and disabled while retrying.
        self.refresh(backend, reads, wake);
    }

    fn start_read(&mut self, backend: &Backend, reads: &Reads, wake: &Wake) {
        self.serial = self.serial.wrapping_add(1);
        let serial = self.serial;
        let (cancel, cancelled) = bounded(1);
        self.active_read = Some((serial, cancel));
        let backend = backend.clone();
        let reads = reads.clone();
        let out = self.out.clone();
        let wake = wake.clone();
        platform::spawn(async move {
            let outcome = async {
                let _permit = reads.background(&cancelled).await?;
                reads::cancellable(&cancelled, backend.mission_calendars(None)).await
            }
            .await;
            if let Some(outcome) = outcome
                && out
                    .send(Completion {
                        kind: OpKind::Read,
                        serial,
                        outcome,
                    })
                    .await
                    .is_ok()
            {
                wake();
            }
        });
    }

    /// Returns `(ui_changed, mutated_successfully)` so `Panel::poll` can also
    /// refresh one-time `summaries` when a calendar `PUT`/delete updates the
    /// prepared Mission line (#1803).
    pub(crate) fn poll(
        &mut self,
        visible: bool,
        backend: &Backend,
        reads: &Reads,
        wake: &Wake,
    ) -> (bool, bool) {
        let mut changed = false;
        let mut mutated = false;
        while let Ok(done) = self.incoming.try_recv() {
            match done.kind {
                OpKind::Read => {
                    if self
                        .active_read
                        .as_ref()
                        .is_none_or(|(serial, _)| *serial != done.serial)
                    {
                        continue;
                    }
                    self.active_read = None;
                    changed = true;
                    let owed = std::mem::take(&mut self.owed_refresh);
                    self.apply_outcome(OpKind::Read, done.outcome, backend);
                    if owed
                        && visible
                        && self.active_mutation.is_none()
                        && self.auth_expired.is_none()
                    {
                        self.start_read(backend, reads, wake);
                    }
                }
                OpKind::Mutate => {
                    if self.active_mutation != Some(done.serial) {
                        continue;
                    }
                    self.active_mutation = None;
                    if let Some((_, cancel)) = self.active_read.take() {
                        cancel.close();
                    }
                    changed = true;
                    let owed = std::mem::take(&mut self.owed_refresh);
                    let needs_resync = matches!(
                        done.outcome,
                        Ok(CalendarOutcome::Missing | CalendarOutcome::Unavailable) | Err(_)
                    );
                    if matches!(done.outcome, Ok(CalendarOutcome::Ok(_))) {
                        mutated = true;
                    }
                    self.apply_outcome(OpKind::Mutate, done.outcome, backend);
                    if (owed || needs_resync) && visible && self.auth_expired.is_none() {
                        self.start_read(backend, reads, wake);
                    }
                }
            }
        }
        (changed, mutated)
    }

    fn apply_outcome(&mut self, kind: OpKind, outcome: Result<CalendarOutcome>, backend: &Backend) {
        match outcome {
            Ok(CalendarOutcome::Ok(list)) => {
                self.entries = list;
                self.loaded = true;
                self.failed = false;
                self.unavailable = false;
                if kind == OpKind::Mutate {
                    self.feedback = None;
                    self.editor = None;
                    self.delete_confirm = None;
                }
                if self
                    .selected
                    .as_deref()
                    .is_some_and(|id| !self.entries.iter().any(|item| item.id == id))
                {
                    self.selected = None;
                    self.editor = None;
                    self.delete_confirm = None;
                }
            }
            Ok(CalendarOutcome::AuthExpired) => {
                self.auth_expired = Some(backend.clone());
                self.delete_confirm = None;
                self.owed_refresh = false;
            }
            Ok(CalendarOutcome::Unavailable) => {
                self.unavailable = true;
                self.failed = false;
                if kind == OpKind::Mutate {
                    self.feedback = Some("missions.recurrence.unavailable");
                }
            }
            Ok(CalendarOutcome::Unsupported(reason)) => {
                self.feedback = Some(unsupported_error_key(reason));
            }
            Ok(CalendarOutcome::InvalidInput) => {
                self.feedback = Some("missions.control.mutation.error");
            }
            Ok(CalendarOutcome::Missing) => {
                self.feedback = Some("missions.scheduleList.conflict");
                self.delete_confirm = None;
                self.editor = None;
            }
            Err(_) => {
                if kind == OpKind::Read {
                    if self.loaded {
                        self.failed = true;
                    } else {
                        // Older servers without `/missions/calendars` or transient initial errors
                        // keep the empty section hidden without permanently blocking later passive recovery.
                        self.unavailable = true;
                    }
                } else {
                    self.feedback = Some("missions.control.mutation.error");
                }
            }
        }
    }

    pub(crate) fn select(&mut self, id: &str) {
        if self.selected.as_deref() == Some(id) {
            self.selected = None;
        } else if self.entries.iter().any(|entry| entry.id == id) {
            self.selected = Some(id.to_owned());
        }
        self.editor = None;
        self.delete_confirm = None;
        self.feedback = None;
    }

    pub(crate) fn selected_view(&self) -> Option<&CalendarView> {
        let id = self.selected.as_deref()?;
        self.entries.iter().find(|entry| entry.id == id)
    }

    pub(crate) fn toggle_pause(&mut self, id: &str, backend: &Backend, wake: &Wake) {
        if self.busy_mutation() {
            return;
        }
        let Some(calendar) = self.entries.iter().find(|entry| entry.id == id) else {
            return;
        };
        let action = if calendar.paused {
            CalendarAction::Resume
        } else {
            CalendarAction::Pause
        };
        self.spawn_mutation(backend, wake, MutationOp::Control(id.to_owned(), action));
    }

    pub(crate) fn request_delete(&mut self, id: &str) {
        if !self.busy_mutation() && self.entries.iter().any(|entry| entry.id == id) {
            self.delete_confirm = Some(id.to_owned());
            self.feedback = None;
        }
    }

    pub(crate) fn confirm_delete(&mut self, accept: bool, backend: &Backend, wake: &Wake) {
        let Some(id) = self.delete_confirm.take() else {
            return;
        };
        if !accept || self.busy_mutation() {
            return;
        }
        self.spawn_mutation(backend, wake, MutationOp::Delete(id));
    }

    pub(crate) fn open_editor(&mut self, id: &str) {
        if self.busy_mutation() {
            return;
        }
        if let Some(view) = self.entries.iter().find(|entry| entry.id == id) {
            self.selected = Some(view.id.clone());
            self.editor = Some(CalendarEditor::from_view(view));
            self.delete_confirm = None;
            self.feedback = None;
        }
    }

    pub(crate) fn close_editor(&mut self) {
        self.editor = None;
    }

    pub(crate) fn save_editor(&mut self, backend: &Backend, wake: &Wake) {
        if self.busy_mutation() {
            return;
        }
        let Some(editor) = self.editor.as_mut() else {
            return;
        };
        let id = editor.calendar_id.clone();
        let Ok(request) = editor.build_request() else {
            return;
        };
        self.spawn_mutation(backend, wake, MutationOp::Save(id, Box::new(request)));
    }

    fn spawn_mutation(&mut self, backend: &Backend, wake: &Wake, op: MutationOp) {
        // Cancel any in-flight GET so an older snapshot cannot overwrite this mutation's result.
        if let Some((_, cancel)) = self.active_read.take() {
            cancel.close();
        }
        self.owed_refresh = false;
        self.serial = self.serial.wrapping_add(1);
        let serial = self.serial;
        self.active_mutation = Some(serial);
        self.feedback = None;
        let backend = backend.clone();
        let out = self.out.clone();
        let wake = wake.clone();
        platform::spawn(async move {
            let outcome = match op {
                MutationOp::Control(id, action) => {
                    backend.control_mission_calendar(&id, action, None).await
                }
                MutationOp::Delete(id) => backend.delete_mission_calendar(&id, None).await,
                MutationOp::Save(id, request) => backend.save_mission_calendar(&id, &request).await,
            };
            if out
                .send(Completion {
                    kind: OpKind::Mutate,
                    serial,
                    outcome,
                })
                .await
                .is_ok()
            {
                wake();
            }
        });
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_entries(&mut self, entries: Vec<CalendarView>) {
        self.entries = entries;
        self.loaded = true;
        self.failed = false;
        self.unavailable = false;
    }
}

enum MutationOp {
    Control(String, CalendarAction),
    Delete(String),
    Save(String, Box<CalendarSaveRequest>),
}

#[cfg(test)]
mod tests;
