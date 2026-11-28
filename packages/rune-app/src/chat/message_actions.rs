use crate::{Phase, State, backend::Backend, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    message_actions::{PrunePreview, PruneUnavailable},
};
use rune::Tx;
use std::rc::{Rc, Weak};

mod menu;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
pub(super) use menu::{actions, overlays, restore};

#[derive(Default)]
pub(crate) struct Actions {
    backend: Option<Backend>,
    boundary: Option<String>,
    refresh_boundary: bool,
    read: Option<Receiver<codenomad_client::history::Result<Option<String>>>>,
    job: Option<Job>,
    confirmation: Option<(Weak<()>, PrunePreview)>,
    error: Option<&'static str>,
    menu: rune_theme_codenomad::action_menu::State<State>,
    open_menu: Option<String>,
}

struct Job {
    scope: Weak<()>,
    cancel: Sender<()>,
    returned: Receiver<codenomad_client::history::Result<Outcome>>,
    error: &'static str,
    reread: bool,
}

enum Intent {
    Edit { id: String, text: String },
    Restore,
    Fork(String),
    PreviewPrune(String),
    Prune(PrunePreview),
}

enum Outcome {
    Edit { id: String, text: String },
    Restore,
    Fork(String),
    PreviewPrune(PrunePreview),
    Pruned,
}

impl Actions {
    pub(super) fn suspend(&mut self) {
        menu::close(self);
        if let Some(job) = &mut self.job {
            job.cancel.close();
            job.scope = Weak::new();
        }
    }
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
        self.refresh();
    }

    pub(super) fn refresh(&mut self) {
        self.invalidate_boundary();
    }

    pub(super) fn offline(&mut self) {
        self.suspend();
        self.read = None;
        self.refresh_boundary = false;
    }

    pub(super) fn invalidate_boundary(&mut self) {
        self.refresh_boundary = true;
    }

    fn can_restore(&self) -> bool {
        self.boundary.is_some() && !self.refresh_boundary && self.read.is_none()
    }

    pub(super) fn has_restore(&self) -> bool {
        self.boundary.is_some()
    }

    pub(super) fn has_error(&self) -> bool {
        self.error.is_some()
    }

    pub(super) fn visible<'a>(&self, rows: &'a [crate::history::Row]) -> &'a [crate::history::Row] {
        if let Some(boundary) = &self.boundary
            && let Some(first_hidden) = rows.iter().position(|row| row.id >= *boundary)
        {
            &rows[..first_hidden]
        } else {
            rows
        }
    }

    pub(crate) fn pending(&self) -> bool {
        self.job.is_some() || self.confirmation.is_some()
    }

    pub(crate) fn confirmation_open(&self, scope: &Rc<()>) -> bool {
        self.confirmation
            .as_ref()
            .is_some_and(|(owner, _)| owner.ptr_eq(&Rc::downgrade(scope)))
    }

    pub(crate) fn menu_open(&self) -> bool {
        self.open_menu.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fixture_open_menu(&mut self, id: Option<&str>) {
        self.open_menu = id.map(str::to_owned);
    }

    #[cfg(test)]
    pub(crate) fn fixture_confirmation(&mut self, scope: &Rc<()>, preview: Option<PrunePreview>) {
        self.confirmation = preview.map(|preview| (Rc::downgrade(scope), preview));
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_pending(&mut self) {
        let (cancel, _) = bounded(1);
        let (_, returned) = bounded(1);
        self.job = Some(Job {
            scope: Weak::new(),
            cancel,
            returned,
            error: "",
            reread: false,
        });
    }
}

fn available(s: &State) -> bool {
    s.phase == Phase::Ready
        && !s.screen.is_launcher()
        && !s.composer.pending()
        && s.composer.unconfirmed_id().is_none()
        && !crate::git::placement_unconfirmed(s)
        && crate::workspace::input_ready(s)
        && s.reader.as_ref().is_none_or(|reader| !reader.blocks_send())
        && !s.transcript_display.messages.pending()
}

fn empty_draft(s: &State) -> bool {
    s.draft.text.is_empty()
        && s.composer.draft.active_count(&s.draft) == 0
        && !s.composer.attachments_missing
        && !s.composer.device.busy()
}

fn start(s: &mut State, intent: Intent) {
    if !available(s)
        || matches!(&intent, Intent::Edit { .. }) && !empty_draft(s)
        || matches!(&intent, Intent::Fork(_)) && !crate::launcher::can_change_session(s)
    {
        return;
    }
    let owner = &mut s.transcript_display.messages;
    let Some(backend) = owner.backend.clone() else {
        return;
    };
    let (error, reread) = match &intent {
        Intent::Edit { .. } => ("sessionView.alerts.revertFailed.message", true),
        Intent::Restore if owner.can_restore() => ("commands.redoLastMessage.failed.message", true),
        Intent::Fork(_) => ("sessionView.alerts.forkFailed.message", false),
        Intent::PreviewPrune(_) => (
            "messageItem.actions.deleteTechnicalParts.failedMessage",
            false,
        ),
        Intent::Prune(_) => (
            "messageItem.actions.deleteTechnicalParts.failedMessage",
            true,
        ),
        _ => return,
    };
    let (cancel, cancelled) = bounded(1);
    let (done, returned) = bounded(1);
    owner.error = None;
    owner.job = Some(Job {
        scope: Rc::downgrade(&s.input_scope),
        cancel,
        returned,
        error,
        reread,
    });
    let wake = s.wake.clone();
    platform::spawn(async move {
        let result = async {
            if cancelled.is_closed() {
                return Err("message action scope expired".into());
            }
            Ok(match intent {
                Intent::Edit { id, text } => {
                    backend.stage_message_revert(&id).await?;
                    Outcome::Edit { id, text }
                }
                Intent::Restore => {
                    backend.clear_message_revert().await?;
                    Outcome::Restore
                }
                Intent::Fork(id) => {
                    Outcome::Fork(backend.fork_after_message(&id, &cancelled).await?)
                }
                Intent::PreviewPrune(id) => {
                    Outcome::PreviewPrune(backend.preview_message_prune(&id).await?)
                }
                Intent::Prune(preview) => {
                    backend.prune_message(preview).await?;
                    Outcome::Pruned
                }
            })
        }
        .await;
        let _ = done.send(result).await;
        wake();
    });
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = menu::poll(s, tx);
    let owner = &mut s.transcript_display.messages;
    if let Some(job) = &owner.job {
        if let Ok(result) = job.returned.try_recv() {
            let current =
                job.scope.ptr_eq(&Rc::downgrade(&s.input_scope)) && !s.screen.is_launcher();
            let error = job.error;
            let reread = job.reread;
            owner.job = None;
            if reread {
                owner.invalidate_boundary();
                // Keep the last displayed page until its authoritative replacement arrives.
                if current {
                    super::reader::refresh_after_message_action(s);
                }
            }
            if current {
                match result {
                    Ok(Outcome::Edit { id, text }) => {
                        s.transcript_display.messages.boundary = Some(id);
                        s.revision += 1;
                        if empty_draft(s) {
                            s.draft.replace_text(&text);
                            s.composer.picker.changed(&s.draft, &s.reads, &s.wake);
                            tx.focus("composer", false);
                            crate::workspace::capture(s);
                        }
                    }
                    Ok(Outcome::Restore) => {
                        s.transcript_display.messages.boundary = None;
                        s.revision += 1;
                    }
                    Ok(Outcome::Fork(id)) => crate::launcher::choose(s, id, tx),
                    Ok(Outcome::PreviewPrune(preview)) => {
                        s.transcript_display.messages.confirmation =
                            Some((Rc::downgrade(&s.input_scope), preview));
                    }
                    Err(err) => {
                        s.transcript_display.messages.error =
                            Some(if err.is::<PruneUnavailable>() {
                                "session.messageActions.serverUnavailable"
                            } else {
                                error
                            });
                    }
                    _ => (),
                }
            }
            changed = true;
        } else if job.returned.is_closed() {
            owner.job = None;
            changed = true;
        }
    }
    let owner = &mut s.transcript_display.messages;
    if let Some(read) = &owner.read {
        if let Ok(result) = read.try_recv() {
            owner.read = None;
            if let Ok(boundary) = result
                && !owner.refresh_boundary
            {
                owner.boundary = boundary;
                s.revision += 1;
            }
            changed = true;
        } else if read.is_closed() {
            owner.read = None;
        }
    }
    if !s.screen.is_launcher()
        && owner.job.is_none()
        && owner.read.is_none()
        && owner.refresh_boundary
        && let Some(backend) = owner.backend.clone()
    {
        owner.refresh_boundary = false;
        let (done, read) = bounded(1);
        owner.read = Some(read);
        let wake = s.wake.clone();
        platform::spawn(async move {
            let _ = done.send(backend.staged_revert().await).await;
            wake();
        });
    }
    changed
}
