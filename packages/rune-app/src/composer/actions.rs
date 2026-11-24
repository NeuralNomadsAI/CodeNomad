use super::{command_receipts, command_receipts::CommandAttempt, draft::Draft};
use crate::{
    Message, Phase, State,
    transport::{Command, PromptOutcome},
    workspace,
};
use codenomad_client::prompt::{Delivery, message_id};
use rune::{Tx, edit::TextEdit};

#[derive(Default)]
pub struct Owner {
    pub device: super::device::Device,
    pub draft: Draft,
    pub picker: super::picker::Picker,
    pub menu: rune_theme_codenomad::action_menu::State<State>,
    sending: Option<PendingSend>,
    pub send_error: bool,
    pub(crate) announce_send_error: bool,
    pub(crate) announce_unconfirmed: bool,
    unconfirmed: Option<PendingSend>,
    pub restored: bool,
    pub attachments_missing: bool,
    pub(crate) recall: Option<super::recall::Recall>,
}
impl Owner {
    pub fn pending(&self) -> bool {
        self.sending.is_some()
    }
    pub(crate) fn editing_locked(&self) -> bool {
        self.sending.as_ref().is_some_and(|send| !send.recallable)
    }
    pub fn unconfirmed_id(&self) -> Option<&str> {
        self.unconfirmed.as_ref().map(|send| send.id.as_str())
    }
    pub(crate) fn unconfirmed_state(&self) -> Option<&PendingSend> {
        self.unconfirmed.as_ref()
    }
    pub(crate) fn sending_state(&self) -> Option<&PendingSend> {
        self.sending.as_ref()
    }
    pub(crate) fn recall_inline_usage(&self) -> (usize, usize) {
        self.recall
            .as_ref()
            .map_or((0, 0), super::recall::Recall::inline_usage)
    }
    pub(crate) fn restore_unconfirmed(&mut self, pending: PendingSend) {
        self.unconfirmed = Some(pending);
    }
    pub(crate) fn clear_unconfirmed_matching(&mut self, attempt_id: &str) {
        if self.unconfirmed_id() == Some(attempt_id) {
            self.unconfirmed = None;
        }
    }
    pub(crate) fn mark_edited(&mut self) {
        if let Some(send) = &mut self.sending {
            send.clear_retained();
        }
        if let Some(send) = &mut self.unconfirmed {
            send.clear_retained();
        }
    }
    #[cfg(test)]
    pub fn pending_text(&self) -> Option<&str> {
        self.sending.as_ref().map(|send| send.edit.text.as_str())
    }
}
#[derive(Clone)]
pub(crate) struct PendingSend {
    id: String,
    edit: TextEdit,
    draft: Draft,
    was_running: bool,
    slash: Option<CommandAttempt>,
    edited: bool,
    recallable: bool,
    restored_to_draft: bool,
}
impl PendingSend {
    pub(crate) fn locked(id: String) -> Self {
        Self {
            id,
            edit: TextEdit::default(),
            draft: Draft::default(),
            was_running: false,
            slash: None,
            edited: true,
            recallable: false,
            restored_to_draft: false,
        }
    }
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn inline_usage(&self) -> (usize, usize) {
        self.draft.inline_usage()
    }
    pub(crate) fn unique_inline_usage(&self, active_draft: &Draft) -> (usize, usize) {
        if !self.restored_to_draft {
            return self.draft.inline_usage();
        }
        let mut matched = vec![false; active_draft.attachments.len()];
        self.draft
            .attachments
            .iter()
            .fold((0, 0), |(count, total), item| match item {
                crate::composer::draft::Attachment::Device { bytes, .. } => {
                    if let Some(pos) = active_draft
                        .attachments
                        .iter()
                        .enumerate()
                        .find_map(|(i, active)| (!matched[i] && active == item).then_some(i))
                    {
                        matched[pos] = true;
                        (count, total)
                    } else {
                        (count + 1, total + bytes.len())
                    }
                }
                _ => (count, total),
            })
    }
    pub(crate) fn clear_retained(&mut self) {
        self.edited = true;
        self.restored_to_draft = false;
        self.edit = TextEdit::default();
        self.draft = Draft::default();
    }
}

pub(crate) fn command_held(s: &State) -> bool {
    command_receipts::repeats(s)
        || s.command_receipts.full() && s.composer.picker.selected_command(&s.draft.text).is_some()
}

pub fn can_send(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return false;
    }
    let stream_disconnected = matches!(s.phase, Phase::StreamDisconnected { .. });
    (stream_disconnected || matches!(s.phase, Phase::Ready | Phase::Streaming))
        && !s
            .screen
            .launcher()
            .is_some_and(crate::launcher::Launcher::blocks_prompt)
        && !s.history_detached
        && !s.status_permissions.settling()
        && !crate::git::placement_unconfirmed(s)
        && s.reader
            .as_ref()
            .is_none_or(|reader| !reader.blocks_send_while(stream_disconnected))
        && s.composer.sending.is_none()
        && !s.transcript_display.messages.pending()
        && !s.composer.picker.open()
        && !s.composer.device.busy()
        && !s.composer.picker.command_pending(&s.draft.text)
        && !s.composer.attachments_missing
        && (s.composer.picker.attachments_supported()
            || !s.composer.draft.requires_attachment_support())
        && s.composer.unconfirmed.is_none()
        && !workspace::has_unconfirmed(s)
        && !command_held(s)
        && s.composer.draft.can_send(&s.draft)
        && s.commands.as_ref().is_some_and(|tx| !tx.is_closed())
        && s.agent
            .as_ref()
            .is_none_or(|a| !a.blocks_prompt(stream_disconnected))
}

pub(crate) fn refuse_send(s: &mut State, tx: &mut Tx) {
    s.composer.send_error = true;
    s.composer.announce_send_error = false;
    crate::strings::with_locale(crate::settings::app_locale(s), || {
        rune_theme_codenomad::layout::announce_alert(
            tx,
            crate::strings::t("promptInput.send.errorTitle"),
        );
    });
}

pub(crate) fn send_button(s: &mut State, tx: &mut Tx) {
    if can_send(s) {
        send(s, tx, false);
    } else {
        // An enabled control can deliver its click after the frame's poll revoked admission.
        refuse_send(s, tx);
    }
}

pub fn send(s: &mut State, tx: &mut Tx, alternate: bool) {
    if !can_send(s) {
        if s.composer.draft.can_send(&s.draft) {
            refuse_send(s, tx);
        }
        return;
    }
    let Ok(id) = message_id() else {
        refuse_send(s, tx);
        return;
    };
    if let Some((name, text)) = s.composer.picker.selected_command(&s.draft.text) {
        let Some(text) = s.composer.draft.resolve_args(&s.draft, text) else {
            refuse_send(s, tx);
            return;
        };
        let Some(target) = super::recall::command_target(s) else {
            refuse_send(s, tx);
            return;
        };
        let slash = CommandAttempt {
            target,
            name: name.to_owned(),
            args: text,
        };
        let command = Command::Slash {
            attempt: id.clone(),
            name: slash.name.clone(),
            text: slash.args.clone(),
        };
        if s.commands
            .as_ref()
            .is_some_and(|pipe| pipe.try_send(command).is_ok())
        {
            let recallable =
                super::recall::record(s, format!("/{} {}", slash.name, slash.args), true);
            s.composer.picker.remember_command(&slash.name);
            s.composer.sending = Some(PendingSend {
                id,
                edit: s.draft.clone(),
                draft: s.composer.draft.clone(),
                was_running: true,
                slash: Some(slash),
                edited: s.composer.recall.is_some(),
                recallable,
                restored_to_draft: false,
            });
            s.draft.clear();
            s.composer
                .draft
                .attachments
                .retain(|part| !matches!(part, super::draft::Attachment::Pasted { .. }));
            super::recall::restore(s);
            s.composer.picker.reset();
            renew_editor(s, tx);
            workspace::capture(s);
            s.composer.send_error = false;
            s.composer.announce_send_error = false;
        } else {
            refuse_send(s, tx);
        }
        return;
    }
    let was_running = s.phase.running();
    let delivery = follow_up_delivery(
        was_running,
        crate::settings::queues_follow_ups(s),
        alternate,
    );
    let queued = delivery == Delivery::Queue;
    let Some((prompt, parts)) = s.composer.draft.prepare(&s.draft, &id, delivery) else {
        refuse_send(s, tx);
        return;
    };
    let body = prompt.text.clone();
    if !s
        .commands
        .as_ref()
        .is_some_and(|pipe| pipe.try_send(Command::Prompt(prompt)).is_ok())
    {
        refuse_send(s, tx);
        return;
    }
    s.composer.send_error = false;
    s.composer.announce_send_error = false;
    let recallable = super::recall::record(s, body.clone(), false);
    s.composer.sending = Some(PendingSend {
        id: id.clone(),
        edit: s.draft.clone(),
        draft: std::mem::take(&mut s.composer.draft),
        was_running,
        slash: None,
        edited: s.composer.recall.is_some(),
        recallable,
        restored_to_draft: false,
    });
    s.draft.clear();
    super::recall::restore(s);
    s.composer.picker.reset();
    renew_editor(s, tx);
    if !queued {
        s.messages.push(
            Message {
                completed: true,
                id,
                role: "user".into(),
                body,
                usage: None,
                parts,
            }
            .into(),
        );
        s.revision += 1;
        s.phase = optimistic_phase(&s.phase, true);
    }
    workspace::capture(s);
}

fn follow_up_delivery(running: bool, prefer_queue: bool, alternate: bool) -> Delivery {
    if running && (prefer_queue != alternate) {
        Delivery::Queue
    } else {
        Delivery::Steer
    }
}

fn optimistic_phase(phase: &Phase, running: bool) -> Phase {
    if matches!(phase, Phase::StreamDisconnected { .. }) {
        Phase::StreamDisconnected { running }
    } else if running {
        Phase::Streaming
    } else {
        Phase::Ready
    }
}

#[test]
fn alternate_inverts_the_confirmed_follow_up_only_while_running() {
    for (preferred, alternate, expected) in [
        (false, false, Delivery::Steer),
        (false, true, Delivery::Queue),
        (true, false, Delivery::Queue),
        (true, true, Delivery::Steer),
    ] {
        assert_eq!(follow_up_delivery(true, preferred, alternate), expected);
        assert_eq!(
            follow_up_delivery(false, preferred, alternate),
            Delivery::Steer
        );
    }
}

pub fn acknowledge(s: &mut State, attempted: &str, outcome: PromptOutcome) {
    // A late exact receipt can settle its own hold even after the composer moved on.
    s.command_receipts.settle(attempted, &outcome);
    if !s
        .composer
        .sending
        .as_ref()
        .is_some_and(|send| send.id == attempted)
    {
        return;
    }
    let Some(mut send) = s.composer.sending.take() else {
        return;
    };
    let may_restore = !send.edited
        && s.composer.recall.is_none()
        && s.draft.text.is_empty()
        && !s.composer.device.busy();
    if let Some(slash) = send.slash {
        if matches!(
            outcome,
            PromptOutcome::Rejected | PromptOutcome::Unconfirmed
        ) && may_restore
        {
            super::recall::replace_edit(s, send.edit);
            s.composer.draft = send.draft;
            s.composer.restored = true;
        }
        if matches!(outcome, PromptOutcome::Unconfirmed) {
            s.command_receipts.hold(send.id, slash);
            s.composer.announce_unconfirmed = true;
        }
        let rejected = matches!(outcome, PromptOutcome::Rejected);
        s.composer.send_error = rejected;
        if rejected {
            s.composer.announce_send_error = true;
        }
        return;
    }
    if matches!(outcome, PromptOutcome::Unconfirmed) {
        if may_restore && s.composer.draft.attachments.is_empty() {
            super::recall::replace_edit(s, send.edit.clone());
            s.composer.draft = send.draft.clone();
            send.restored_to_draft = true;
        } else {
            send.clear_retained();
        }
        s.composer.unconfirmed = Some(send);
        s.composer.restored = true;
        s.composer.announce_unconfirmed = true;
        workspace::note_unconfirmed(s, attempted);
        return;
    }
    let row = s.messages.iter().position(|row| row.id == attempted);
    if let PromptOutcome::Confirmed(confirmed) = outcome {
        if confirmed != attempted {
            crate::chat::reader::settle_bookmark(s, attempted, Some(&confirmed));
        }
        if let Some(index) = row {
            if confirmed != attempted && s.messages.iter().any(|row| row.id == confirmed) {
                s.messages.remove(index);
            } else {
                let row = std::sync::Arc::make_mut(&mut s.messages[index]);
                for part in &mut row.parts {
                    let id = match part {
                        crate::content::Part::Skill(skill) => &mut skill.id,
                        crate::content::Part::File(file) => &mut file.id,
                        _ => continue,
                    };
                    if let Some(suffix) = id.strip_prefix(attempted) {
                        *id = format!("{confirmed}{suffix}");
                    }
                }
                row.id = confirmed;
            }
        }
        return;
    }
    crate::chat::reader::settle_bookmark(s, attempted, None);
    if let Some(index) = row {
        s.messages.remove(index);
    }
    s.composer.send_error = true;
    s.composer.announce_send_error = true;
    if may_restore && s.composer.draft.attachments.is_empty() {
        super::recall::replace_edit(s, send.edit);
        s.composer.draft = send.draft;
        s.composer.restored = true;
    }
    if s.phase.running() && !send.was_running {
        s.phase = optimistic_phase(&s.phase, false);
    }
}

pub fn settle_pending(s: &mut State, outcome: PromptOutcome) {
    if let Some(id) = s.composer.sending.as_ref().map(|send| send.id.clone()) {
        acknowledge(s, &id, outcome);
        if s.workspace.is_some() && std::mem::take(&mut s.composer.restored) {
            workspace::capture(s);
        }
    }
}

pub fn reconcile(s: &mut State) {
    let confirmed = s.composer.unconfirmed.as_ref().is_some_and(|send| {
        s.messages
            .iter()
            .any(|row| row.id == send.id && row.role == "user")
    });
    if !confirmed {
        return;
    }
    let Some(send) = s.composer.unconfirmed.take() else {
        return;
    };
    if !send.edited
        && s.composer.recall.is_none()
        && s.draft.text == send.edit.text
        && s.composer.draft.attachments == send.draft.attachments
    {
        s.draft.clear();
        s.composer.draft = Draft::default();
    }
    if s.workspace.is_some() {
        workspace::confirm_unconfirmed(s, &send.id);
        workspace::capture(s);
    }
}

fn renew_editor(_s: &mut State, _tx: &mut Tx) {
    #[cfg(target_arch = "wasm32")]
    {
        _s.rotate_composer_input();
        if _s.draft.focused {
            _tx.focus_when_shown("composer", false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer::draft::Attachment;
    use rune::{Env, Runtime};

    #[test]
    fn sends_attachment_only_and_sets_the_confirmed_identity() {
        let (sender, receiver) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.composer.picker.set_attachments_supported(true);
        s.commands = Some(sender);
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        assert_eq!(prompt.text, "");
        assert_eq!(prompt.skills[0].id, "review");
        assert!(rt.state.composer.draft.attachments.is_empty());
        let id = prompt.id.unwrap();
        assert_eq!(rt.state.messages[0].id, id);
        acknowledge(
            &mut rt.state,
            "foreign",
            PromptOutcome::Confirmed("other".into()),
        );
        assert_eq!(rt.state.messages[0].id, id);
        acknowledge(
            &mut rt.state,
            &id,
            PromptOutcome::Confirmed("confirmed".into()),
        );
        assert_eq!(rt.state.messages[0].id, "confirmed");
        assert!(
            matches!(&rt.state.messages[0].parts[0], crate::content::Part::Skill(skill) if skill.id == "confirmed-skill-0")
        );
    }

    #[test]
    fn queue_has_no_echo_and_a_failed_send_preserves_newer_text() {
        let (sender, receiver) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = Phase::Streaming;
        s.commands = Some(sender);
        s.draft = TextEdit::new("Original");
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, true));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        assert_eq!(prompt.delivery, Some(Delivery::Queue));
        assert_eq!(prompt.resume, Some(false));
        assert!(rt.state.messages.is_empty());
        rt.state.draft = TextEdit::new("Newer");
        let id = prompt.id.unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Rejected);
        assert_eq!(rt.state.draft.text, "Newer");
        assert!(rt.state.composer.send_error);

        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        assert_eq!(prompt.delivery, Some(Delivery::Steer));
        assert_eq!(rt.state.messages.len(), 1);
        acknowledge(&mut rt.state, &prompt.id.unwrap(), PromptOutcome::Rejected);
        assert_eq!(rt.state.draft.text, "Newer");
        assert!(rt.state.messages.is_empty());
    }

    #[test]
    fn missing_receipt_cannot_replay_and_only_original_native_id_releases_it() {
        let (sender, receiver) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.commands = Some(sender);
        s.draft = TextEdit::new("attempt");
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        let row = rt.state.messages.pop().unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.draft.text, "attempt");
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        rt.state.draft = TextEdit::new("new draft");
        rt.state.messages.push(
            Message {
                id: "other".into(),
                ..row.as_ref().clone()
            }
            .into(),
        );
        reconcile(&mut rt.state);
        rt.update(|s, tx| send(s, tx, false));
        assert!(receiver.try_recv().is_err());
        rt.state.messages.push(row);
        reconcile(&mut rt.state);
        assert!(rt.state.composer.unconfirmed.is_none());
        assert_eq!(rt.state.draft.text, "new draft");
    }

    #[test]
    fn unconfirmed_lock_persists_across_session_reopen_and_announces_uncertainty() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.set_ready_for_test();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let mut second = first.clone();
        second.session = "ses-2".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
        };
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        workspace::opened(&mut s, &project);
        workspace::bound(&mut s, &first);
        s.phase = Phase::Ready;
        s.commands = Some(sender.clone());
        s.composer.picker.set_attachments_supported(true);
        s.composer.draft.attachments.push(Attachment::Device {
            name: "clip.png".into(),
            mime: "image/png".into(),
            bytes: std::sync::Arc::from(vec![7u8; 4096]),
            token: None,
        });
        s.draft = TextEdit::new("attempt");
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        let row = rt.state.messages.pop().unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert!(rt.state.composer.announce_unconfirmed);
        assert!(rt.state.composer.restored);
        assert_eq!(
            rt.state
                .composer
                .unconfirmed_state()
                .unwrap()
                .unique_inline_usage(&rt.state.composer.draft),
            (0, 0),
            "restored shared attachment bytes must not be double-counted against the window budget"
        );
        // Adding another device attachment to the restored draft still must not double-count the restored copy.
        let mut with_extra = rt.state.composer.draft.clone();
        with_extra.attachments.push(Attachment::Device {
            name: "extra.png".into(),
            mime: "image/png".into(),
            bytes: std::sync::Arc::from(vec![9u8; 2048]),
            token: None,
        });
        assert_eq!(
            rt.state
                .composer
                .unconfirmed_state()
                .unwrap()
                .unique_inline_usage(&with_extra),
            (0, 0),
            "adding a new file to a restored draft must not double-count restored bytes"
        );
        workspace::capture(&mut rt.state);
        workspace::bound(&mut rt.state, &second);
        assert!(rt.state.composer.unconfirmed_id().is_none());
        let restored_draft = workspace::bound(&mut rt.state, &first);
        rt.state.draft = TextEdit::new(restored_draft);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert!(!can_send(&rt.state));
        // Closing the tab and reopening the project preserves the unconfirmed lock without retaining bytes.
        let tab_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        rt.update(|s, tx| workspace::close(s, &tab_key, tx));
        assert_ne!(
            rt.state.workspace.as_ref().unwrap().active_key(),
            tab_key.as_str(),
            "closing the active tab must replace it with a fresh tab"
        );
        workspace::opened(&mut rt.state, &project);
        let reopened_draft = workspace::bound(&mut rt.state, &first);
        rt.state.draft = TextEdit::new(reopened_draft);
        rt.state.composer.attachments_missing = false;
        rt.state.phase = Phase::Ready;
        rt.state.commands = Some(sender.clone());
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert_eq!(
            rt.state
                .composer
                .unconfirmed_state()
                .unwrap()
                .inline_usage(),
            (0, 0),
            "closing a tab must drop retained inline attachment bytes from the lock"
        );
        assert!(
            !rt.state.composer.attachments_missing,
            "reopen assertion must isolate the unconfirmed lock rather than missing attachments"
        );
        assert!(
            !can_send(&rt.state),
            "reopened session must remain blocked by the unconfirmed lock even with live commands"
        );
        // Anchor installation reconciles the unconfirmed send just like Sync and pagination.
        crate::chat::reader::install_anchor(
            &mut rt.state,
            crate::history::Page {
                rows: vec![row],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
        );
        assert!(rt.state.composer.unconfirmed_id().is_none());
        workspace::bound(&mut rt.state, &second);
        workspace::bound(&mut rt.state, &first);
        assert!(rt.state.composer.unconfirmed_id().is_none());
    }

    #[test]
    fn unconfirmed_lock_blocks_sibling_tab_and_clears_globally_on_reconcile() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.set_ready_for_test();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
        };
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        workspace::opened(&mut s, &project);
        workspace::bound(&mut s, &first);
        s.phase = Phase::Ready;
        s.commands = Some(sender.clone());
        s.draft = TextEdit::new("tab A attempt");
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        let tab_a = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        // Open sibling Tab B on the exact same project and session.
        rt.update(|s, tx| workspace::new_tab(s, tx));
        let tab_b = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        workspace::opened(&mut rt.state, &project);
        workspace::bound(&mut rt.state, &first);
        rt.state.phase = Phase::Ready;
        rt.state.commands = Some(sender.clone());
        rt.state.draft = TextEdit::new("tab B draft");
        // Switch back to Tab A and send -> Unconfirmed.
        rt.update(|s, tx| workspace::select(s, &tab_a, tx));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        let row = rt.state.messages.pop().unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        // Switching to already-open sibling Tab B must block sending while Tab A is still open.
        rt.update(|s, tx| workspace::select(s, &tab_b, tx));
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert!(!can_send(&rt.state));
        // Reconciling in Tab A must clear the lock globally, including Tab B's cache.
        rt.update(|s, tx| workspace::select(s, &tab_a, tx));
        rt.state.messages.push(row);
        reconcile(&mut rt.state);
        assert!(rt.state.composer.unconfirmed_id().is_none());
        // Closing sibling Tab B afterwards must not reintroduce the reconciled lock.
        rt.update(|s, tx| workspace::close(s, &tab_b, tx));
        assert!(rt.state.composer.unconfirmed_id().is_none());
        assert!(!workspace::has_unconfirmed(&rt.state));
        assert!(can_send(&rt.state));
    }

    #[test]
    fn oldest_is_blocked_while_stream_is_offline_in_detached_history() {
        let (sender, receiver) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.history_detached = true;
        s.stream_offline = true;
        s.can_older = true;
        s.commands = Some(sender);
        s.messages.push(
            Message {
                completed: true,
                id: "m1".into(),
                role: "user".into(),
                body: "hello".into(),
                usage: None,
                parts: vec![],
            }
            .into(),
        );
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| crate::chat::reader::oldest(s, tx));
        assert!(receiver.try_recv().is_err());
    }
}
