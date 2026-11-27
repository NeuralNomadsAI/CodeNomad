//! Queued follow-up prompt state, header controls and scoped inbox mutations.
use super::document;
use crate::{
    Phase, State, backend::Backend, content::Part, platform, screen, strings::t, transport::Command,
};
use codenomad_client::{
    Receiver, Sender, bounded,
    inbox::{FenceState, InboxDelta, InboxFence, InboxUnavailable, QueuedPrompt},
    prompt::Delivery,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, attachment,
    layout::{self, Layout},
};

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[derive(Default)]
pub(crate) struct Queue {
    backend: Option<Backend>,
    items: Vec<QueuedPrompt>,
    stale: bool,
    busy: Option<Job>,
    saved_edit: Option<String>,
    error: Option<&'static str>,
    announce_error: Option<&'static str>,
    mutation_epoch: u64,
    pending_sync: Option<u64>,
    deferred_snapshot: Option<(Vec<QueuedPrompt>, InboxFence)>,
}

struct Job {
    owner: Backend,
    cancel: Sender<()>,
    returned: Receiver<codenomad_client::history::Result<Outcome>>,
    suspended: bool,
}

enum Intent {
    UpdateDelivery { id: String, delivery: Delivery },
    Edit { id: String, text: String },
    Remove { id: String },
}

enum Outcome {
    UpdatedDelivery { id: String, delivery: Delivery },
    Edited { id: String, text: String },
    Removed { id: String },
}

fn same_conversation(a: &Backend, b: &Backend) -> bool {
    a.workspace == b.workspace
        && a.session == b.session
        && a.client.same_connection(&b.client)
        && a.session_directory == b.session_directory
}

impl Queue {
    pub(super) fn bind(&mut self, backend: Backend) {
        if !self
            .backend
            .as_ref()
            .is_some_and(|old| same_conversation(old, &backend))
        {
            if let Some(job) = self.busy.take() {
                job.cancel.close();
            }
            *self = Self {
                backend: Some(backend),
                ..Self::default()
            };
        } else {
            self.backend = Some(backend);
            self.stale = true;
            self.mutation_epoch = 0;
            self.pending_sync = None;
            self.deferred_snapshot = None;
        }
    }

    pub(super) fn suspend(&mut self) {
        self.stale = true;
        self.deferred_snapshot = None;
        if let Some(job) = self.busy.as_mut() {
            job.suspended = true;
        }
    }

    pub(super) fn offline(&mut self) {
        self.stale = true;
        self.deferred_snapshot = None;
        if let Some(job) = self.busy.as_mut() {
            job.suspended = true;
        }
    }

    pub(super) fn clear(&mut self) {
        if let Some(job) = self.busy.take() {
            job.cancel.close();
        }
        self.items.clear();
        self.stale = false;
        self.saved_edit = None;
        self.error = None;
        self.announce_error = None;
        self.mutation_epoch = 0;
        self.pending_sync = None;
        self.deferred_snapshot = None;
    }

    pub(super) fn set_items(&mut self, items: Vec<QueuedPrompt>) -> bool {
        let was_stale = std::mem::replace(&mut self.stale, false);
        let cleared_read_error = self.error == Some("promptQueue.error.message");
        if cleared_read_error {
            self.error = None;
        }
        if self.items == items && !was_stale && !cleared_read_error {
            return false;
        }
        self.items = items;
        true
    }

    pub(super) fn preview_delta(&self, delta: &InboxDelta) -> Option<Vec<QueuedPrompt>> {
        let mut next = self.items.clone();
        match delta {
            InboxDelta::Upsert(item) => {
                if let Some(existing) = next.iter_mut().find(|row| row.id == item.id) {
                    if existing == item {
                        return None;
                    }
                    *existing = item.clone();
                } else if next.len() < codenomad_client::inbox::MAX_ITEMS {
                    next.push(item.clone());
                } else {
                    return None;
                }
            }
            InboxDelta::Delivery { id, delivery } => {
                let existing = next.iter_mut().find(|row| row.id == *id)?;
                if existing.delivery == *delivery {
                    return None;
                }
                existing.delivery = *delivery;
            }
            InboxDelta::Removed(id) => {
                let before = next.len();
                next.retain(|row| row.id != *id);
                if next.len() == before {
                    return None;
                }
            }
        }
        Some(next)
    }

    pub(super) fn apply_preview(&mut self, items: Vec<QueuedPrompt>) {
        self.items = items;
    }

    pub(super) fn failed(&mut self) {
        self.stale = true;
        self.deferred_snapshot = None;
        self.error = Some("promptQueue.error.message");
        self.announce_error = Some("promptQueue.error.message");
    }

    fn advance_mutation_epoch(&mut self) -> u64 {
        self.mutation_epoch = self.mutation_epoch.saturating_add(1);
        self.pending_sync = Some(self.mutation_epoch);
        if self
            .deferred_snapshot
            .as_ref()
            .is_some_and(|(_, fence)| fence.sync_epoch() < self.mutation_epoch)
        {
            self.deferred_snapshot = None;
        }
        self.mutation_epoch
    }

    pub(super) fn prune_committed(&mut self, committed: &[crate::history::Row]) -> bool {
        let before = self.items.len();
        self.items
            .retain(|item| !committed.iter().any(|row| row.id == item.id));
        self.items.len() != before
    }

    pub(crate) fn items(&self) -> &[QueuedPrompt] {
        &self.items
    }

    pub(super) fn has_error(&self) -> bool {
        self.error.is_some()
    }

    pub(super) fn has_saved_edit(&self) -> bool {
        self.saved_edit.is_some()
    }

    pub(crate) fn pending(&self) -> bool {
        self.busy.is_some()
    }

    #[cfg(test)]
    pub(crate) fn is_stale(&self) -> bool {
        self.stale
    }

    #[cfg(test)]
    pub(crate) fn saved_edit(&self) -> Option<&str> {
        self.saved_edit.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn fixture_set(&mut self, backend: Option<Backend>, items: Vec<QueuedPrompt>) {
        self.backend = backend;
        self.items = items;
        self.stale = false;
        self.saved_edit = None;
        self.error = None;
        self.announce_error = None;
        self.mutation_epoch = 0;
        self.pending_sync = None;
        self.deferred_snapshot = None;
    }
}

fn available(s: &State) -> bool {
    matches!(s.phase, Phase::Ready | Phase::Streaming)
        && !s.screen.is_launcher()
        && !s.history_detached
        && !crate::git::placement_unconfirmed(s)
        && crate::workspace::input_ready(s)
        && s.reader.as_ref().is_none_or(|reader| !reader.blocks_send())
        && !s.transcript_display.queue.stale
        && !s.transcript_display.queue.pending()
        && s.transcript_display.queue.backend.is_some()
}

fn empty_draft(s: &State) -> bool {
    s.draft.text.is_empty()
        && s.composer.draft.active_count(&s.draft) == 0
        && !s.composer.attachments_missing
        && !s.composer.device.busy()
}

fn start(s: &mut State, intent: Intent) {
    if !available(s) {
        return;
    }
    if let Intent::Edit { id, .. } = &intent
        && (!empty_draft(s)
            || s.transcript_display.queue.has_saved_edit()
            || !s
                .transcript_display
                .queue
                .items
                .iter()
                .any(|item| &item.id == id && item.editable))
    {
        return;
    }
    let owner = &mut s.transcript_display.queue;
    let Some(backend) = owner.backend.clone() else {
        return;
    };
    let (cancel, cancelled) = bounded(1);
    let (done, returned) = bounded(1);
    owner.error = None;
    owner.announce_error = None;
    owner.busy = Some(Job {
        owner: backend.clone(),
        cancel,
        returned,
        suspended: false,
    });
    let wake = s.wake.clone();
    platform::spawn(async move {
        let result = async {
            if cancelled.is_closed() {
                return Err("queued prompt scope expired".into());
            }
            Ok(match intent {
                Intent::UpdateDelivery { id, delivery } => {
                    backend.update_queued_prompt_delivery(&id, delivery).await?;
                    Outcome::UpdatedDelivery { id, delivery }
                }
                Intent::Edit { id, text } => {
                    backend.cancel_queued_prompt(&id).await?;
                    Outcome::Edited { id, text }
                }
                Intent::Remove { id } => {
                    backend.cancel_queued_prompt(&id).await?;
                    Outcome::Removed { id }
                }
            })
        }
        .await;
        let _ = done.send(result).await;
        wake();
    });
}

fn restore_draft(s: &mut State, text: &str, tx: &mut Tx) {
    s.draft.replace_text(text);
    s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
    tx.focus("composer", false);
    crate::workspace::capture(s);
}

fn request_sync(s: &mut State, epoch: u64, tx: &mut Tx) {
    let Some(commands) = &s.commands else {
        s.transcript_display.queue.pending_sync = None;
        return;
    };
    match commands.try_send(Command::SyncInbox(epoch)) {
        Ok(()) => s.transcript_display.queue.pending_sync = None,
        Err(err) if err.is_full() => {
            s.transcript_display.queue.pending_sync = Some(
                s.transcript_display
                    .queue
                    .pending_sync
                    .map_or(epoch, |prior| prior.max(epoch)),
            );
            tx.wake_after(std::time::Duration::from_millis(16));
        }
        Err(_) => {
            s.transcript_display.queue.pending_sync = None;
        }
    }
}

pub(super) fn receive_authoritative(
    s: &mut State,
    mut items: Vec<QueuedPrompt>,
    fence: Option<InboxFence>,
) -> bool {
    if let Some(fence) = fence {
        if fence.sync_epoch() < s.transcript_display.queue.mutation_epoch {
            return false;
        }
        match fence.check() {
            FenceState::Invalid => return false,
            FenceState::Deferred => {
                s.transcript_display.queue.deferred_snapshot = Some((items, fence));
                return false;
            }
            FenceState::Valid => {}
        }
    } else if s.transcript_display.queue.mutation_epoch > 0 {
        return false;
    }
    s.transcript_display.queue.deferred_snapshot = None;
    let replaced: Vec<String> = items
        .iter()
        .filter(|item| s.composer.is_optimistic(&item.id))
        .map(|item| item.id.clone())
        .collect();
    for opt in replaced {
        s.composer.clear_optimistic(Some(&opt));
        if let Some(index) = s.messages.iter().position(|row| row.id == opt) {
            s.messages.remove(index);
        }
    }
    items.retain(|item| {
        !s.messages
            .iter()
            .any(|row| row.id == item.id && !s.composer.is_optimistic(&row.id))
    });
    super::reader::preserve_anchor_on_inbox_change(s, &items);
    super::reader::reconcile_queued_bookmark(s, &items);
    let changed = s.transcript_display.queue.set_items(items);
    crate::composer::reconcile(s);
    changed
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = false;
    if let Some(epoch) = s.transcript_display.queue.pending_sync {
        request_sync(s, epoch, tx);
    }
    if let Some((items, fence)) = s.transcript_display.queue.deferred_snapshot.take()
        && receive_authoritative(s, items, Some(fence))
    {
        changed = true;
    }
    if let Some(error) = s.transcript_display.queue.announce_error.take() {
        layout::announce_alert(tx, t(error));
        changed = true;
    }
    let Some(job) = &s.transcript_display.queue.busy else {
        return changed;
    };
    let result = match job.returned.try_recv() {
        Ok(result) => Some(result),
        Err(codenomad_client::TryRecvError::Closed) => None,
        Err(codenomad_client::TryRecvError::Empty) => return changed,
    };
    let job_suspended = job.suspended;
    let same_session = s
        .transcript_display
        .queue
        .backend
        .as_ref()
        .is_some_and(|current| same_conversation(&job.owner, current));
    s.transcript_display.queue.busy = None;
    if !same_session {
        return true;
    }
    match result {
        Some(Ok(outcome)) => {
            // Advance the publication fence before applying the local mutation so already-queued
            // older snapshots cannot undo the settled change or resurrect a canceled row.
            let epoch = s.transcript_display.queue.advance_mutation_epoch();
            request_sync(s, epoch, tx);
            match outcome {
                Outcome::UpdatedDelivery { id, delivery } => {
                    crate::composer::confirm_unconfirmed_id(s, &id);
                    if let Some(item) = s
                        .transcript_display
                        .queue
                        .items
                        .iter_mut()
                        .find(|item| item.id == id)
                    {
                        item.delivery = delivery;
                    }
                    s.revision += 1;
                }
                Outcome::Edited { id, text } => {
                    crate::composer::confirm_unconfirmed_id(s, &id);
                    s.transcript_display
                        .queue
                        .items
                        .retain(|item| item.id != id);
                    s.revision += 1;
                    if !job_suspended && !s.screen.is_launcher() && empty_draft(s) {
                        s.transcript_display.queue.saved_edit = None;
                        restore_draft(s, &text, tx);
                    } else {
                        s.transcript_display.queue.saved_edit = Some(text);
                    }
                }
                Outcome::Removed { id } => {
                    crate::composer::confirm_unconfirmed_id(s, &id);
                    s.transcript_display
                        .queue
                        .items
                        .retain(|item| item.id != id);
                    s.revision += 1;
                }
            }
        }
        Some(Err(err)) => {
            let epoch = s.transcript_display.queue.mutation_epoch;
            request_sync(s, epoch, tx);
            let key = if err.is::<InboxUnavailable>() {
                "session.messageActions.serverUnavailable"
            } else {
                "promptQueue.error.message"
            };
            s.transcript_display.queue.error = Some(key);
            layout::announce_alert(tx, t(key));
        }
        None => {
            let epoch = s.transcript_display.queue.mutation_epoch;
            request_sync(s, epoch, tx);
            s.transcript_display.queue.error = Some("promptQueue.error.message");
            layout::announce_alert(tx, t("promptQueue.error.message"));
        }
    }
    true
}

pub(super) fn message(s: &State, item: &QueuedPrompt) -> El {
    let can_act = available(s);
    let id = item.id.clone();
    let next_delivery = match item.delivery {
        Delivery::Queue => Delivery::Steer,
        Delivery::Steer => Delivery::Queue,
    };
    let delivery_label = t(match item.delivery {
        Delivery::Queue => "promptQueue.actions.steer",
        Delivery::Steer => "promptQueue.actions.queue",
    });
    let header = layout::action_row()
        .child(text(t("messageItem.speaker.you")).text_role(TextRole::Label))
        .children((item.delivery == Delivery::Queue).then(|| {
            attachment::status_badge(t("messageItem.status.queued"))
                .key(format!("queued-badge-{id}"))
        }))
        .child(
            layout::button_tx(
                delivery_label,
                !can_act,
                screen::action_tx(&s.input_scope, {
                    let id = id.clone();
                    move |s, _| {
                        start(
                            s,
                            Intent::UpdateDelivery {
                                id: id.clone(),
                                delivery: next_delivery,
                            },
                        );
                    }
                }),
            )
            .key(format!("queued-delivery-{id}")),
        )
        .child(
            layout::button_tx(
                t("promptQueue.actions.edit"),
                !can_act
                    || !item.editable
                    || !empty_draft(s)
                    || s.transcript_display.queue.has_saved_edit(),
                screen::action_tx(&s.input_scope, {
                    let id = id.clone();
                    let text = item.text.clone();
                    move |s, _| {
                        start(
                            s,
                            Intent::Edit {
                                id: id.clone(),
                                text: text.clone(),
                            },
                        );
                    }
                }),
            )
            .key(format!("queued-edit-{id}")),
        )
        .child(
            layout::button_tx(
                t("promptQueue.actions.remove"),
                !can_act,
                screen::action_tx(&s.input_scope, {
                    let id = id.clone();
                    move |s, _| start(s, Intent::Remove { id: id.clone() })
                }),
            )
            .key(format!("queued-remove-{id}")),
        );
    let mut view = col()
        .key(item.id.clone())
        .full_width()
        .pad(Space::Lg)
        .separate(Space::Sm)
        .child(header);
    if !item.text.is_empty() {
        let key = format!("body-{}", item.id);
        let text_claimed = std::cell::Cell::new(false);
        view = view.child(super::reading::passage(
            s,
            document::prose_claimed(
                s,
                &item.id,
                key.clone(),
                &item.text,
                false,
                None,
                Some(&text_claimed),
            ),
            &item.id,
            key,
            None,
            None,
        ));
    }
    for part in &item.parts {
        let body = match part {
            Part::Skill(skill) => Some(super::attachments::skill_chip(skill)),
            Part::File(file) => Some(super::attachments::file_chip_static(s, file)),
            _ => None,
        };
        if let Some(body) = body {
            view = view.child(body);
        }
    }
    view
}

pub(in crate::chat) fn recovery(s: &State) -> Option<El> {
    let saved = s.transcript_display.queue.saved_edit.as_ref()?;
    let copy_text = saved.clone();
    Some(
        layout::action_row()
            .key("queued-edit-recovery")
            .child(
                layout::button_tx(
                    t("promptQueue.actions.edit"),
                    !empty_draft(s),
                    screen::action_tx(&s.input_scope, |s, tx| {
                        if !empty_draft(s) {
                            return;
                        }
                        if let Some(text) = s.transcript_display.queue.saved_edit.take() {
                            restore_draft(s, &text, tx);
                        }
                    }),
                )
                .key("queued-edit-restore"),
            )
            .child(
                layout::button_tx(
                    t("messageItem.actions.copy"),
                    false,
                    screen::action_tx(&s.input_scope, move |_, tx| {
                        tx.copy(copy_text.clone());
                    }),
                )
                .key("queued-edit-copy"),
            )
            .child(
                layout::button(
                    t("promptQueue.actions.cancelEdit"),
                    false,
                    screen::action(&s.input_scope, |s| {
                        s.transcript_display.queue.saved_edit = None;
                    }),
                )
                .key("queued-edit-discard"),
            ),
    )
}

pub(in crate::chat) fn error(s: &State) -> Option<El> {
    s.transcript_display.queue.error.map(|error| {
        text(t(error))
            .key("queued-prompt-error")
            .role("alert")
            .wrap()
    })
}
