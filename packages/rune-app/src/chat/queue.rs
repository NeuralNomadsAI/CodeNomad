//! Queued follow-up prompt state, header controls and scoped inbox mutations.
use super::document;
use crate::{
    Phase, State, backend::Backend, content::Part, platform, screen, strings::t, transport::Command,
};
use codenomad_client::{
    Receiver, Sender, bounded,
    inbox::{InboxUnavailable, QueuedPrompt},
    prompt::Delivery,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, TextRole, attachment,
    layout::{self, Layout},
};
use std::rc::{Rc, Weak};

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

#[derive(Default)]
pub(crate) struct Queue {
    backend: Option<Backend>,
    items: Vec<QueuedPrompt>,
    busy: Option<Job>,
    error: Option<&'static str>,
}

struct Job {
    scope: Weak<()>,
    cancel: Sender<()>,
    returned: Receiver<codenomad_client::history::Result<Outcome>>,
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

impl Queue {
    pub(super) fn bind(&mut self, backend: Backend) {
        if !self.backend.as_ref().is_some_and(|old| {
            old.workspace == backend.workspace
                && old.session == backend.session
                && old.client.same_connection(&backend.client)
                && old.session_directory == backend.session_directory
        }) {
            *self = Self {
                backend: Some(backend),
                ..Self::default()
            };
        }
    }

    pub(super) fn suspend(&mut self) {
        if let Some(job) = &mut self.busy {
            job.cancel.close();
            job.scope = Weak::new();
        }
    }

    pub(super) fn offline(&mut self) {
        self.suspend();
    }

    pub(super) fn clear(&mut self) {
        self.suspend();
        self.items.clear();
        self.error = None;
    }

    pub(super) fn set_items(&mut self, items: Vec<QueuedPrompt>) -> bool {
        if self.items == items {
            return false;
        }
        self.items = items;
        true
    }

    pub(super) fn prune_committed(&mut self, committed: &[crate::history::Row]) -> bool {
        let before = self.items.len();
        self.items
            .retain(|item| !committed.iter().any(|row| row.id == item.id));
        self.items.len() != before
    }

    pub(super) fn items(&self) -> &[QueuedPrompt] {
        &self.items
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        self.items.iter().any(|item| item.id == id)
    }

    pub(super) fn has_error(&self) -> bool {
        self.error.is_some()
    }

    pub(crate) fn pending(&self) -> bool {
        self.busy.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fixture_set(&mut self, backend: Option<Backend>, items: Vec<QueuedPrompt>) {
        self.backend = backend;
        self.items = items;
        self.error = None;
    }
}

fn available(s: &State) -> bool {
    matches!(s.phase, Phase::Ready | Phase::Streaming)
        && !s.screen.is_launcher()
        && !s.history_detached
        && !crate::git::placement_unconfirmed(s)
        && crate::workspace::input_ready(s)
        && s.reader.as_ref().is_none_or(|reader| !reader.blocks_send())
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
    if !available(s) || matches!(&intent, Intent::Edit { .. }) && !empty_draft(s) {
        return;
    }
    let owner = &mut s.transcript_display.queue;
    let Some(backend) = owner.backend.clone() else {
        return;
    };
    let (cancel, cancelled) = bounded(1);
    let (done, returned) = bounded(1);
    owner.error = None;
    owner.busy = Some(Job {
        scope: Rc::downgrade(&s.input_scope),
        cancel,
        returned,
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

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(job) = &s.transcript_display.queue.busy else {
        return false;
    };
    let result = match job.returned.try_recv() {
        Ok(result) => Some(result),
        Err(codenomad_client::TryRecvError::Closed) => None,
        Err(codenomad_client::TryRecvError::Empty) => return false,
    };
    let current = job.scope.ptr_eq(&Rc::downgrade(&s.input_scope)) && !s.screen.is_launcher();
    s.transcript_display.queue.busy = None;
    if !current {
        return true;
    }
    if let Some(commands) = &s.commands {
        let _ = commands.try_send(Command::SyncInbox);
    }
    match result {
        Some(Ok(Outcome::UpdatedDelivery { id, delivery })) => {
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
        Some(Ok(Outcome::Edited { id, text })) => {
            s.transcript_display
                .queue
                .items
                .retain(|item| item.id != id);
            s.revision += 1;
            if empty_draft(s) {
                s.draft.replace_text(&text);
                s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
                tx.focus("composer", false);
                crate::workspace::capture(s);
            }
        }
        Some(Ok(Outcome::Removed { id })) => {
            s.transcript_display
                .queue
                .items
                .retain(|item| item.id != id);
            s.revision += 1;
        }
        Some(Err(err)) => {
            s.transcript_display.queue.error = Some(if err.is::<InboxUnavailable>() {
                "session.messageActions.serverUnavailable"
            } else {
                "promptQueue.error.message"
            });
        }
        None => {
            s.transcript_display.queue.error = Some("promptQueue.error.message");
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
                !can_act || !empty_draft(s),
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
            Part::File(file) => Some(super::attachments::file_chip(s, file)),
            _ => None,
        };
        if let Some(body) = body {
            view = view.child(body);
        }
    }
    view
}

pub(in crate::chat) fn error(s: &State) -> Option<El> {
    s.transcript_display.queue.error.map(|error| {
        text(t(error))
            .key("queued-prompt-error")
            .role("alert")
            .wrap()
    })
}
