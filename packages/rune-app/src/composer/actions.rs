use super::draft::Draft;
use crate::{
    Message, Phase, State,
    transport::{Command, PromptOutcome},
    workspace,
};
use codenomad_client::prompt::{Delivery, message_id};
use rune::{Tx, edit::TextEdit};

#[derive(Default)]
pub struct Owner {
    pub draft: Draft,
    pub picker: super::picker::Picker,
    sending: Option<Send>,
    pub send_error: bool,
    pub unconfirmed: Option<String>,
    pub command_unconfirmed: bool,
    pub restored: bool,
}
struct Send {
    id: String,
    edit: TextEdit,
    draft: Draft,
    was_running: bool,
    slash: bool,
}

pub fn can_send(s: &State) -> bool {
    matches!(s.phase, Phase::Ready | Phase::Streaming)
        && !s.history_detached
        && s.composer.sending.is_none()
        && !s.composer.picker.open()
        && !s.composer.picker.command_pending(&s.draft.text)
        && s.composer.unconfirmed.is_none()
        && s.composer.draft.can_send(&s.draft)
        && s.commands.as_ref().is_some_and(|tx| !tx.is_closed())
        && s.agent.as_ref().is_none_or(|a| !a.blocked())
}

pub fn send(s: &mut State, tx: &mut Tx, alternate: bool) {
    if !can_send(s) {
        return;
    }
    let Ok(id) = message_id() else {
        s.composer.send_error = true;
        return;
    };
    if let Some((name, text)) = s.composer.picker.selected_command(&s.draft.text) {
        let command = Command::Slash {
            attempt: id.clone(),
            name: name.into(),
            text: s.composer.draft.resolve_text(text),
        };
        if s.commands
            .as_ref()
            .is_some_and(|pipe| pipe.try_send(command).is_ok())
        {
            s.composer.sending = Some(Send {
                id,
                edit: s.draft.clone(),
                draft: Draft::default(),
                was_running: true,
                slash: true,
            });
            s.composer.send_error = false;
            s.composer.command_unconfirmed = false;
            s.draft.clear();
            s.composer.picker.reset();
            workspace::draft_changed(s, tx);
        } else {
            s.composer.send_error = true;
        }
        return;
    }
    let was_running = s.phase == Phase::Streaming;
    let delivery = if was_running && alternate {
        Delivery::Queue
    } else {
        Delivery::Steer
    };
    let queued = delivery == Delivery::Queue;
    let (prompt, parts) = s.composer.draft.prepare(&s.draft.text, &id, delivery);
    let body = prompt.text.clone();
    if !s
        .commands
        .as_ref()
        .is_some_and(|pipe| pipe.try_send(Command::Prompt(prompt)).is_ok())
    {
        s.composer.send_error = true;
        return;
    }
    s.composer.send_error = false;
    s.composer.sending = Some(Send {
        id: id.clone(),
        edit: s.draft.clone(),
        draft: std::mem::take(&mut s.composer.draft),
        was_running,
        slash: false,
    });
    s.draft.clear();
    s.composer.picker.reset();
    if !queued {
        s.messages.push(
            Message {
                completed: true,
                id,
                role: "user".into(),
                body,
                parts,
            }
            .into(),
        );
        s.revision += 1;
        s.phase = Phase::Streaming;
    }
    workspace::draft_changed(s, tx);
}

pub fn acknowledge(s: &mut State, attempted: &str, outcome: PromptOutcome) {
    if !s
        .composer
        .sending
        .as_ref()
        .is_some_and(|send| send.id == attempted)
    {
        return;
    }
    let Some(send) = s.composer.sending.take() else {
        return;
    };
    if matches!(outcome, PromptOutcome::Unconfirmed) {
        if send.slash {
            s.composer.command_unconfirmed = true;
        } else {
            s.composer.unconfirmed = Some(send.id);
        }
        return;
    }
    let row = s.messages.iter().position(|row| row.id == attempted);
    if let PromptOutcome::Confirmed(confirmed) = outcome {
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
    if let Some(index) = row {
        s.messages.remove(index);
    }
    s.composer.send_error = true;
    if s.draft.text.is_empty() && (send.slash || s.composer.draft.attachments.is_empty()) {
        s.draft = send.edit;
        if !send.slash {
            s.composer.draft = send.draft;
        }
        s.composer.restored = true;
    }
    if s.phase == Phase::Streaming && !send.was_running {
        s.phase = Phase::Ready;
    }
}

pub fn reconcile(s: &mut State) {
    if s.composer
        .unconfirmed
        .as_ref()
        .is_some_and(|id| s.messages.iter().any(|row| &row.id == id))
    {
        s.composer.unconfirmed = None;
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
        assert!(rt.state.draft.text.is_empty());
        assert_eq!(rt.state.composer.unconfirmed.as_deref(), Some(id.as_str()));
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
}
