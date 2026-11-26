use super::{
    command_receipts,
    command_receipts::{CommandAttempt, CommandKind},
    draft::Draft,
};
use crate::{
    Message, Phase, State,
    transport::{Command, PromptOutcome},
    workspace,
};
use codenomad_client::prompt::{Delivery, message_id};
use rune::{Tx, edit::TextEdit};

pub struct Owner {
    pub device: super::device::Device,
    pub draft: Draft,
    pub picker: super::picker::Picker,
    pub menu: rune_theme_codenomad::action_menu::State<State>,
    pub shell_mode: bool,
    pub(super) draft_was_empty: std::cell::Cell<bool>,
    pub(super) suppress_bang_change: bool,
    sending: Option<Send>,
    pub send_error: bool,
    unconfirmed: Option<UnconfirmedPrompt>,
    pub command_unconfirmed: Option<UnconfirmedCommand>,
    pub restored: bool,
    pub attachments_missing: bool,
    pub(crate) recall: Option<super::recall::Recall>,
}
impl Default for Owner {
    fn default() -> Self {
        Self {
            device: Default::default(),
            draft: Default::default(),
            picker: Default::default(),
            menu: Default::default(),
            shell_mode: false,
            draft_was_empty: std::cell::Cell::new(true),
            suppress_bang_change: false,
            sending: None,
            send_error: false,
            unconfirmed: None,
            command_unconfirmed: None,
            restored: false,
            attachments_missing: false,
            recall: None,
        }
    }
}
impl Owner {
    pub fn pending(&self) -> bool {
        self.sending.is_some()
    }
    pub fn blocks_navigation(&self) -> bool {
        self.sending.is_some()
    }
    pub(crate) fn editing_locked(&self) -> bool {
        self.sending.as_ref().is_some_and(|send| !send.recallable)
    }
    pub(crate) fn exit_shell_mode(&mut self) {
        if self.shell_mode {
            self.shell_mode = false;
            self.mark_edited();
        }
    }
    pub fn unconfirmed_id(&self) -> Option<&str> {
        self.unconfirmed.as_ref().map(|send| send.id.as_str())
    }
    pub(crate) fn clone_unconfirmed(&self) -> Option<UnconfirmedPrompt> {
        self.unconfirmed.clone()
    }
    pub(crate) fn restore_unconfirmed(&mut self, send: UnconfirmedPrompt) {
        self.unconfirmed = Some(send);
    }
    pub(crate) fn mark_edited(&mut self) {
        if let Some(send) = &mut self.sending {
            send.edited = true;
        }
        if let Some(send) = &mut self.unconfirmed {
            send.edited = true;
        }
    }
    #[cfg(test)]
    pub fn pending_text(&self) -> Option<&str> {
        self.sending.as_ref().map(|send| send.edit.text.as_str())
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct UnconfirmedPrompt {
    id: String,
    text_len: usize,
    text_hash: u64,
    attachments_len: usize,
    attachments_hash: u64,
    edited: bool,
}
impl UnconfirmedPrompt {
    fn from_send(send: &Send) -> Self {
        let (text_len, text_hash) = hash_text(&send.edit.text);
        let (attachments_len, attachments_hash) =
            hash_attachments(&send.edit, &send.draft.attachments);
        Self {
            id: send.id.clone(),
            text_len,
            text_hash,
            attachments_len,
            attachments_hash,
            edited: send.edited,
        }
    }
    fn matches(&self, edit: &TextEdit, attachments: &[super::draft::Attachment]) -> bool {
        (self.text_len, self.text_hash) == hash_text(&edit.text)
            && (self.attachments_len, self.attachments_hash) == hash_attachments(edit, attachments)
    }
}
fn hash_text(text: &str) -> (usize, u64) {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    (text.len(), hasher.finish())
}
fn hash_attachments(edit: &TextEdit, attachments: &[super::draft::Attachment]) -> (usize, u64) {
    use super::draft::Attachment;
    use std::collections::BTreeSet;
    use std::hash::{DefaultHasher, Hash, Hasher};
    let pasted: BTreeSet<_> = super::long_paste::active_tokens(edit)
        .map(|(_, id)| id)
        .collect();
    let mut hasher = DefaultHasher::new();
    let mut count = 0usize;
    for item in attachments {
        match item {
            Attachment::Pasted { id, text } if pasted.contains(id) => {
                count += 1;
                0u8.hash(&mut hasher);
                id.hash(&mut hasher);
                text.hash(&mut hasher);
            }
            Attachment::Pasted { .. } => continue,
            Attachment::Device {
                name,
                mime,
                bytes,
                token,
            } => {
                count += 1;
                1u8.hash(&mut hasher);
                name.hash(&mut hasher);
                mime.hash(&mut hasher);
                bytes.len().hash(&mut hasher);
                bytes.as_ref().hash(&mut hasher);
                token.hash(&mut hasher);
            }
            Attachment::Project {
                name,
                path,
                uri,
                directory,
            } => {
                count += 1;
                2u8.hash(&mut hasher);
                name.hash(&mut hasher);
                path.hash(&mut hasher);
                uri.hash(&mut hasher);
                directory.hash(&mut hasher);
            }
            Attachment::Path(path) => {
                count += 1;
                3u8.hash(&mut hasher);
                path.hash(&mut hasher);
            }
            Attachment::Agent(name) => {
                count += 1;
                4u8.hash(&mut hasher);
                name.hash(&mut hasher);
            }
            Attachment::Skill { id, name } => {
                count += 1;
                5u8.hash(&mut hasher);
                id.hash(&mut hasher);
                name.hash(&mut hasher);
            }
        }
    }
    count.hash(&mut hasher);
    (count, hasher.finish())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UnconfirmedCommand {
    Slash {
        name_len: usize,
        name_hash: u64,
        args_len: usize,
        args_hash: u64,
    },
    Shell {
        command_len: usize,
        command_hash: u64,
    },
}
impl UnconfirmedCommand {
    pub(crate) fn new(name: &str, args: &str) -> Self {
        let (name_len, name_hash) = hash_text(name);
        let (args_len, args_hash) = hash_text(args);
        Self::Slash {
            name_len,
            name_hash,
            args_len,
            args_hash,
        }
    }
    #[cfg(test)]
    pub(crate) fn shell(command: &str) -> Self {
        let (command_len, command_hash) = hash_text(command);
        Self::Shell {
            command_len,
            command_hash,
        }
    }
    fn matches_slash(&self, name: &str, args: &str) -> bool {
        matches!(
            self,
            Self::Slash {
                name_len,
                name_hash,
                args_len,
                args_hash,
            } if (*name_len, *name_hash) == hash_text(name)
                && (*args_len, *args_hash) == hash_text(args)
        )
    }
    fn matches_shell(&self, command: &str) -> bool {
        matches!(
            self,
            Self::Shell {
                command_len,
                command_hash,
            } if (*command_len, *command_hash) == hash_text(command)
        )
    }
}
struct Send {
    id: String,
    edit: TextEdit,
    draft: Draft,
    was_running: bool,
    command: Option<CommandAttempt>,
    edited: bool,
    recallable: bool,
}

fn repeats_uncertain_command(s: &State) -> bool {
    s.composer
        .command_unconfirmed
        .as_ref()
        .is_some_and(|unconfirmed| {
            if s.composer.shell_mode {
                s.composer
                    .draft
                    .resolve_shell(&s.draft)
                    .is_some_and(|command| unconfirmed.matches_shell(&command))
            } else {
                super::picker::command_parts(&s.draft.text).is_some_and(|(candidate, args)| {
                    s.composer
                        .draft
                        .resolve_args(&s.draft, args)
                        .is_some_and(|resolved| unconfirmed.matches_slash(candidate, &resolved))
                })
            }
        })
}

pub(crate) fn command_held(s: &State) -> bool {
    command_receipts::repeats_unconfirmed(s)
        || repeats_uncertain_command(s)
        || s.command_receipts.full()
            && (s.composer.shell_mode
                || s.composer.picker.selected_command(&s.draft.text).is_some())
}

pub fn can_send(s: &State) -> bool {
    let payload_ready = if s.composer.shell_mode {
        s.composer.draft.can_send_shell(&s.draft)
    } else {
        !s.composer.picker.command_pending(&s.draft.text)
            && (s.composer.picker.attachments_supported()
                || !s.composer.draft.requires_attachment_support())
            && s.composer.draft.can_send(&s.draft)
    };
    matches!(s.phase, Phase::Ready | Phase::Streaming)
        && !s
            .screen
            .launcher()
            .is_some_and(crate::launcher::Launcher::blocks_prompt)
        && !s.history_detached
        && !s.status_permissions.settling()
        && !crate::git::placement_unconfirmed(s)
        && s.reader.as_ref().is_none_or(|reader| !reader.blocks_send())
        && s.composer.sending.is_none()
        && !s.transcript_display.messages.pending()
        && !s.composer.picker.open()
        && !s.composer.device.busy()
        && !s.composer.attachments_missing
        && s.composer.unconfirmed.is_none()
        && !command_held(s)
        && !command_receipts::repeats(s)
        && payload_ready
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
    if s.composer.shell_mode {
        let Some(command_text) = s.composer.draft.resolve_shell(&s.draft) else {
            s.composer.send_error = true;
            return;
        };
        let Some(target) = super::recall::command_target(s) else {
            s.composer.send_error = true;
            return;
        };
        let attempt = CommandAttempt {
            target,
            kind: CommandKind::Shell {
                command: command_text.clone(),
            },
        };
        let command = Command::Shell {
            attempt: id.clone(),
            command: command_text.clone(),
        };
        if s.commands
            .as_ref()
            .is_some_and(|pipe| pipe.try_send(command).is_ok())
        {
            s.command_receipts.reserve(id.clone(), attempt.clone());
            let recallable = super::recall::record(s, command_text, true);
            s.composer.sending = Some(Send {
                id,
                edit: s.draft.clone(),
                draft: s.composer.draft.clone(),
                was_running: s.phase == Phase::Streaming,
                command: Some(attempt),
                edited: s.composer.recall.is_some(),
                recallable,
            });
            s.composer.shell_mode = false;
            s.draft.clear();
            s.composer
                .draft
                .attachments
                .retain(|part| !matches!(part, super::draft::Attachment::Pasted { .. }));
            s.composer.draft_was_empty.set(true);
            super::recall::restore(s);
            s.composer.picker.reset();
            renew_editor(s, tx);
            workspace::capture(s);
            s.composer.send_error = false;
        } else {
            s.composer.send_error = true;
        }
        return;
    }
    if let Some((name, text)) = s.composer.picker.selected_command(&s.draft.text) {
        let name = name.to_owned();
        let Some(text) = s.composer.draft.resolve_args(&s.draft, text) else {
            s.composer.send_error = true;
            return;
        };
        let Some(target) = super::recall::command_target(s) else {
            s.composer.send_error = true;
            return;
        };
        let slash = CommandAttempt {
            target,
            kind: CommandKind::Slash {
                name: name.clone(),
                args: text.clone(),
            },
        };
        let command = Command::Slash {
            attempt: id.clone(),
            name: name.clone(),
            text: text.clone(),
        };
        if s.commands
            .as_ref()
            .is_some_and(|pipe| pipe.try_send(command).is_ok())
        {
            let recallable = super::recall::record(s, format!("/{name} {text}"), true);
            s.composer.picker.remember_command(&name);
            s.composer.sending = Some(Send {
                id,
                edit: s.draft.clone(),
                draft: s.composer.draft.clone(),
                was_running: true,
                command: Some(slash),
                edited: s.composer.recall.is_some(),
                recallable,
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
        } else {
            s.composer.send_error = true;
        }
        return;
    }
    let was_running = s.phase == Phase::Streaming;
    let delivery = follow_up_delivery(
        was_running,
        crate::settings::queues_follow_ups(s),
        alternate,
    );
    let queued = delivery == Delivery::Queue;
    let Some((prompt, parts)) = s.composer.draft.prepare(&s.draft, &id, delivery) else {
        s.composer.send_error = true;
        return;
    };
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
    let recallable = super::recall::record(s, body.clone(), false);
    s.composer.sending = Some(Send {
        id: id.clone(),
        edit: s.draft.clone(),
        draft: std::mem::take(&mut s.composer.draft),
        was_running,
        command: None,
        edited: s.composer.recall.is_some(),
        recallable,
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
        s.phase = Phase::Streaming;
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
    if let Some(command) = send.command {
        let is_shell = matches!(command.kind, CommandKind::Shell { .. });
        if matches!(
            outcome,
            PromptOutcome::Rejected | PromptOutcome::Unconfirmed
        ) && may_restore
        {
            super::recall::replace_edit(s, send.edit);
            s.composer.draft = send.draft;
            if is_shell {
                s.composer.shell_mode = true;
            }
            s.composer.restored = true;
        }
        if matches!(outcome, PromptOutcome::Unconfirmed) {
            s.command_receipts.hold(send.id, command);
        }
        s.composer.send_error = matches!(outcome, PromptOutcome::Rejected);
        return;
    }
    if matches!(outcome, PromptOutcome::Unconfirmed) {
        if may_restore && s.composer.draft.attachments.is_empty() {
            super::recall::replace_edit(s, send.edit.clone());
            s.composer.draft = send.draft.clone();
            s.composer.restored = true;
        } else {
            send.edited = true;
        }
        s.composer.unconfirmed = Some(UnconfirmedPrompt::from_send(&send));
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
    if may_restore && s.composer.draft.attachments.is_empty() {
        super::recall::replace_edit(s, send.edit);
        s.composer.draft = send.draft;
        s.composer.restored = true;
    }
    if s.phase == Phase::Streaming && !send.was_running {
        s.phase = Phase::Ready;
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
    let target = super::recall::command_target(s);
    s.command_receipts
        .reconcile_shell(target.as_ref(), &s.messages);
    if s.composer.unconfirmed.as_ref().is_some_and(|send| {
        s.messages
            .iter()
            .any(|row| row.id == send.id && row.role == "user")
    }) && let Some(send) = s.composer.unconfirmed.take()
        && !send.edited
        && s.composer.recall.is_none()
        && send.matches(&s.draft, &s.composer.draft.attachments)
    {
        s.draft.clear();
        s.composer.draft = Draft::default();
        if s.workspace.is_some() {
            workspace::capture(s);
        }
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
}
