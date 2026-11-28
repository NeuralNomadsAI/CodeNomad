//! Auto-creates a session when submitting from a project without an active session.
use super::draft::Draft;
use crate::{Phase, State, workspace};
use rune::{Tx, edit::TextEdit};

enum Stage {
    Creating,
    AwaitingReady { session_id: String },
}

pub(crate) struct AutoSession {
    stage: Stage,
    tab_key: Option<String>,
    project_id: String,
    ticket: u64,
    edit: TextEdit,
    draft: Draft,
    shell_mode: bool,
    alternate: bool,
}

fn current_tab_key(s: &State) -> Option<String> {
    s.workspace.as_ref().map(|ui| ui.active_key().to_owned())
}

fn current_project_id(s: &State) -> Option<&str> {
    s.screen
        .launcher()
        .and_then(|l| l.project.as_ref())
        .map(|p| p.id.as_str())
}

pub(crate) fn can_send_no_session(s: &State) -> bool {
    if !s.no_session_composer_active() || s.pending_auto_session.is_some() {
        return false;
    }
    let Some(l) = s.screen.launcher() else {
        return false;
    };
    if l.connection.is_none()
        || l.project.is_none()
        || l.pending
        || l.creation_uncertain
        || l.authentication_required
        || !crate::launcher::can_change_session(s)
        || crate::git::placement_unconfirmed(s)
    {
        return false;
    }
    if s.composer.picker.open() || s.composer.device.busy() || s.composer.attachments_missing {
        return false;
    }
    if s.composer.shell_mode {
        s.composer.draft.can_send_shell(&s.draft)
    } else {
        !s.composer.picker.command_pending(&s.draft.text) && s.composer.draft.can_send(&s.draft)
    }
}

pub(crate) fn start(s: &mut State, tx: &mut Tx, alternate: bool) {
    if s.pending_auto_session.is_some() {
        return;
    }
    if !can_send_no_session(s) {
        let has_payload = if s.composer.shell_mode {
            s.composer.draft.can_send_shell(&s.draft)
        } else {
            s.composer.draft.can_send(&s.draft)
        };
        if has_payload {
            super::actions::refuse_send(s, tx);
        }
        return;
    }
    let Some(project_id) = current_project_id(s).map(str::to_owned) else {
        super::actions::refuse_send(s, tx);
        return;
    };
    s.composer.no_session_bound = true;
    workspace::capture(s);
    let edit = s.draft.clone();
    let draft = s.composer.draft.clone();
    let shell_mode = s.composer.shell_mode;
    let tab_key = current_tab_key(s);
    crate::launcher::create_blank(s);
    if !s.screen.launcher().is_some_and(|l| l.pending) {
        super::actions::refuse_send(s, tx);
        return;
    }
    s.composer.send_error = false;
    s.composer.announce_send_error = false;
    s.pending_auto_session = Some(Box::new(AutoSession {
        stage: Stage::Creating,
        tab_key,
        project_id,
        ticket: s.notifications.navigation_ticket(),
        edit,
        draft,
        shell_mode,
        alternate,
    }));
}

pub(crate) fn cancel(s: &mut State) {
    s.pending_auto_session = None;
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(pending) = s.pending_auto_session.as_ref() else {
        return false;
    };
    let same_context = current_tab_key(s) == pending.tab_key
        && current_project_id(s) == Some(pending.project_id.as_str())
        && s.notifications.navigation_ticket() == pending.ticket;
    if !same_context {
        s.pending_auto_session = None;
        return true;
    }
    match &pending.stage {
        Stage::Creating => {
            if !s.screen.is_launcher() {
                let session_id = workspace::active_session(s).unwrap_or_default().to_owned();
                let mut pending = s.pending_auto_session.take().unwrap();
                if s.draft.text.is_empty() && s.composer.draft.attachments.is_empty() {
                    s.draft = pending.edit.clone();
                    s.composer.draft = pending.draft.clone();
                    workspace::capture(s);
                }
                if pending.shell_mode {
                    s.composer.shell_mode = true;
                }
                pending.stage = Stage::AwaitingReady { session_id };
                s.pending_auto_session = Some(pending);
                let _ = settle_ready(s, tx);
                return true;
            }
            if s.screen.launcher().is_some_and(|l| l.pending) {
                return false;
            }
            // Session creation failed or could not bind: keep the no-session draft intact and surface an error.
            let pending = s.pending_auto_session.take().unwrap();
            if s.draft.text.is_empty() && s.composer.draft.attachments.is_empty() {
                s.draft = pending.edit;
                s.composer.draft = pending.draft;
                s.composer.shell_mode = pending.shell_mode;
            }
            s.composer.no_session_bound = true;
            workspace::capture(s);
            super::actions::refuse_send(s, tx);
            true
        }
        Stage::AwaitingReady { .. } => settle_ready(s, tx),
    }
}

fn settle_ready(s: &mut State, tx: &mut Tx) -> bool {
    let Some(pending) = s.pending_auto_session.as_ref() else {
        return false;
    };
    let Stage::AwaitingReady { session_id } = &pending.stage else {
        return false;
    };
    if s.screen.is_launcher()
        || (!session_id.is_empty() && workspace::active_session(s) != Some(session_id.as_str()))
    {
        s.pending_auto_session = None;
        super::actions::refuse_send(s, tx);
        return true;
    }
    let failed = s.phase == Phase::Failed || {
        #[cfg(target_arch = "wasm32")]
        {
            matches!(s.phase, Phase::WorkspaceMissing | Phase::RestoreFailed)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            false
        }
    };
    if failed {
        s.pending_auto_session = None;
        super::actions::refuse_send(s, tx);
        return true;
    }
    let stream_disconnected =
        s.stream_offline && matches!(s.phase, Phase::StreamDisconnected { .. });
    let phase_ready = stream_disconnected || matches!(s.phase, Phase::Ready | Phase::Streaming);
    if !phase_ready {
        return false;
    }
    let waiting_on_transient = s.commands.as_ref().is_none_or(|pipe| pipe.is_closed())
        || s.screen
            .launcher()
            .is_some_and(crate::launcher::Launcher::blocks_prompt)
        || s.status_permissions.settling()
        || crate::git::placement_unconfirmed(s)
        || s.reader
            .as_ref()
            .is_some_and(|reader| reader.blocks_send_while(s.stream_offline))
        || s.agent
            .as_ref()
            .is_some_and(|a| a.blocks_prompt(stream_disconnected));
    if waiting_on_transient {
        return false;
    }
    if !s.composer.shell_mode
        && super::picker::command_parts(&s.draft.text).is_some()
        && s.composer.picker.backend().is_some()
        && !s.composer.picker.commands_settled()
    {
        s.composer.picker.refresh_commands(&s.reads, &s.wake);
        return false;
    }
    let pending = s.pending_auto_session.take().unwrap();
    if super::actions::can_send(s) {
        super::actions::send(s, tx, pending.alternate);
    } else {
        super::actions::refuse_send(s, tx);
    }
    true
}
