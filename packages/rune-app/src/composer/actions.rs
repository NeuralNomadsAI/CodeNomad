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
    optimistic_ids: Vec<String>,
    unconfirmed: Option<UnconfirmedPrompt>,
    pub restored: bool,
    pub attachments_missing: bool,
    pub(crate) recall: Option<super::recall::Recall>,
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
    pub fn unconfirmed_id(&self) -> Option<&str> {
        self.unconfirmed.as_ref().map(|send| send.id.as_str())
    }
    pub(crate) fn unconfirmed_state(&self) -> Option<&UnconfirmedPrompt> {
        self.unconfirmed.as_ref()
    }
    pub(crate) fn clone_unconfirmed(&self) -> Option<UnconfirmedPrompt> {
        self.unconfirmed.clone()
    }
    pub(crate) fn add_unique_inline_usage(
        &self,
        seen: &mut std::collections::HashSet<usize>,
        include_draft: bool,
    ) -> (usize, usize) {
        let mut files = 0usize;
        let mut bytes = 0usize;
        let mut add = |draft: &Draft| {
            let (f, b) = draft.add_unique_inline_usage(seen);
            files = files.saturating_add(f);
            bytes = bytes.saturating_add(b);
        };
        if include_draft {
            add(&self.draft);
        }
        if let Some(recall) = &self.recall {
            add(recall.draft());
        }
        if let Some(send) = &self.sending {
            add(&send.draft);
        }
        (files, bytes)
    }
    #[cfg(test)]
    pub(crate) fn optimistic_id(&self) -> Option<&str> {
        self.optimistic_ids.last().map(String::as_str)
    }
    pub(crate) fn is_optimistic(&self, id: &str) -> bool {
        self.optimistic_ids.iter().any(|item| item == id)
    }
    pub(crate) fn record_optimistic(&mut self, id: String) {
        if !self.is_optimistic(&id) {
            if self.optimistic_ids.len() >= codenomad_client::inbox::MAX_ITEMS {
                self.optimistic_ids.remove(0);
            }
            self.optimistic_ids.push(id);
        }
    }
    pub(crate) fn replace_optimistic(&mut self, old: &str, new: String) {
        if let Some(slot) = self.optimistic_ids.iter_mut().find(|item| *item == old) {
            *slot = new;
        }
    }
    pub(crate) fn clear_optimistic(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            self.optimistic_ids.retain(|item| item != id);
        } else {
            self.optimistic_ids.clear();
        }
    }
    pub(crate) fn has_confirmed_user_message(
        &self,
        messages: &[crate::history::Row],
        id: &str,
    ) -> bool {
        !self.is_optimistic(id)
            && messages
                .iter()
                .any(|row| row.id == id && row.role == "user")
    }
    pub(crate) fn has_confirmed_prompt(
        &self,
        messages: &[crate::history::Row],
        queued: &[codenomad_client::inbox::QueuedPrompt],
        id: &str,
    ) -> bool {
        self.has_confirmed_user_message(messages, id) || queued.iter().any(|item| item.id == id)
    }
    pub(crate) fn restore_unconfirmed(&mut self, pending: UnconfirmedPrompt) {
        self.unconfirmed = Some(pending);
    }
    pub(crate) fn confirm_unconfirmed_matching(
        &mut self,
        draft_edit: &mut TextEdit,
        attempt_id: &str,
    ) -> bool {
        if self.unconfirmed_id() != Some(attempt_id) {
            return false;
        }
        let Some(send) = self.unconfirmed.take() else {
            return false;
        };
        self.send_error = false;
        self.announce_send_error = false;
        self.announce_unconfirmed = false;
        if let Some(recall) = &mut self.recall {
            if send.matches_live(recall.edit(), recall.draft(), false) {
                recall.clear_draft();
                return true;
            }
            return false;
        }
        if send.matches_live(draft_edit, &self.draft, self.attachments_missing) {
            draft_edit.clear();
            self.draft = Draft::default();
            self.attachments_missing = false;
            return true;
        }
        false
    }
    pub(crate) fn mark_edited(&mut self) {
        if let Some(send) = &mut self.sending {
            send.clear_retained();
        }
        if let Some(send) = &mut self.unconfirmed {
            send.mark_edited();
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
    saved_parts_fingerprint: Option<(usize, u64)>,
    had_device_attachments: bool,
    edited: bool,
}
impl UnconfirmedPrompt {
    fn from_send(send: &PendingSend) -> Self {
        let (text_len, text_hash) = hash_text(&send.edit.text);
        let (attachments_len, attachments_hash) =
            hash_attachments(&send.edit, &send.draft.attachments);
        let saved_parts_fingerprint =
            super::draft_storage::SavedParts::capture(&send.draft, false, &send.edit)
                .map(|parts| parts.fingerprint());
        Self {
            id: send.id.clone(),
            text_len,
            text_hash,
            attachments_len,
            attachments_hash,
            saved_parts_fingerprint,
            had_device_attachments: send.draft.inline_usage().0 > 0,
            edited: send.edited,
        }
    }
    pub(crate) fn locked(id: String) -> Self {
        Self {
            id,
            text_len: 0,
            text_hash: 0,
            attachments_len: 0,
            attachments_hash: 0,
            saved_parts_fingerprint: None,
            had_device_attachments: false,
            edited: true,
        }
    }
    #[cfg(test)]
    pub(crate) fn fixture_unedited_text(id: String, text: &str) -> Self {
        let (text_len, text_hash) = hash_text(text);
        let edit = TextEdit::new(text);
        let draft = super::draft::Draft::default();
        let (attachments_len, attachments_hash) = hash_attachments(&edit, &draft.attachments);
        Self {
            id,
            text_len,
            text_hash,
            attachments_len,
            attachments_hash,
            saved_parts_fingerprint: None,
            had_device_attachments: false,
            edited: false,
        }
    }
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn is_edited(&self) -> bool {
        self.edited
    }
    pub(crate) fn mark_edited(&mut self) {
        self.edited = true;
    }
    pub(crate) fn matches_live(&self, edit: &TextEdit, draft: &Draft, missing: bool) -> bool {
        if self.edited || (self.text_len, self.text_hash) != hash_text(&edit.text) {
            return false;
        }
        if (self.attachments_len, self.attachments_hash)
            == hash_attachments(edit, &draft.attachments)
        {
            return true;
        }
        // After closing and reopening a tab, inline device bytes are dropped while non-device
        // references and literal spans are restored from SavedParts.
        self.had_device_attachments
            && draft.inline_usage().0 == 0
            && super::draft_storage::SavedParts::capture(draft, true, edit)
                .map(|parts| parts.fingerprint())
                == self.saved_parts_fingerprint
            && (missing || self.saved_parts_fingerprint.is_some())
    }
    pub(crate) fn matches_saved(
        &self,
        text: Option<&str>,
        parts: Option<&super::draft_storage::SavedParts>,
        has_attachment_draft: bool,
    ) -> bool {
        if self.edited {
            return false;
        }
        let text = text.unwrap_or("");
        if (self.text_len, self.text_hash) != hash_text(text) {
            return false;
        }
        if has_attachment_draft != self.saved_parts_fingerprint.is_some() {
            return false;
        }
        parts.map(super::draft_storage::SavedParts::fingerprint) == self.saved_parts_fingerprint
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
struct PendingSend {
    id: String,
    edit: TextEdit,
    draft: Draft,
    was_running: bool,
    slash: Option<CommandAttempt>,
    edited: bool,
    recallable: bool,
    received: bool,
}
impl PendingSend {
    fn clear_retained(&mut self) {
        self.edited = true;
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
    let stream_disconnected =
        s.stream_offline && matches!(s.phase, Phase::StreamDisconnected { .. });
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
            .is_none_or(|reader| !reader.blocks_send_while(s.stream_offline))
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
        if !s.command_receipts.reserve(id.clone()) {
            refuse_send(s, tx);
            return;
        }
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
                received: false,
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
            s.command_receipts.release_in_flight(&id);
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
        received: false,
    });
    s.draft.clear();
    super::recall::restore(s);
    s.composer.picker.reset();
    renew_editor(s, tx);
    if !queued {
        s.composer.record_optimistic(id.clone());
        if let Some(reader) = &mut s.reader {
            reader.clear_sync_undo();
        }
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
    let Some(send) = s.composer.sending.take() else {
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
        if send.received
            || s.composer.has_confirmed_prompt(
                &s.messages,
                s.transcript_display.queue.items(),
                attempted,
            )
        {
            s.composer.clear_optimistic(Some(attempted));
            s.composer.send_error = false;
            s.composer.announce_send_error = false;
            s.composer.announce_unconfirmed = false;
            if s.workspace.is_some() {
                workspace::confirm_unconfirmed(s, attempted);
                workspace::capture(s);
            }
            return;
        }
        let unconfirmed = if may_restore && s.composer.draft.attachments.is_empty() {
            let unconfirmed = UnconfirmedPrompt::from_send(&send);
            super::recall::replace_edit(s, send.edit);
            s.composer.draft = send.draft;
            unconfirmed
        } else {
            UnconfirmedPrompt::locked(send.id)
        };
        s.composer.unconfirmed = Some(unconfirmed);
        s.composer.restored = true;
        s.composer.announce_unconfirmed = true;
        workspace::note_unconfirmed(s, attempted);
        return;
    }
    let row = s.messages.iter().position(|row| row.id == attempted);
    if row.is_some()
        && let Some(reader) = &mut s.reader
    {
        reader.clear_sync_undo();
    }
    if let PromptOutcome::Confirmed(confirmed) = outcome {
        s.composer.send_error = false;
        s.composer.announce_send_error = false;
        if confirmed != attempted {
            crate::chat::reader::settle_bookmark(s, attempted, Some(&confirmed));
        }
        if let Some(index) = row {
            if confirmed != attempted && s.messages.iter().any(|row| row.id == confirmed) {
                s.composer.clear_optimistic(Some(attempted));
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
                row.id = confirmed.clone();
                if s.composer.is_optimistic(attempted) {
                    s.composer.replace_optimistic(attempted, confirmed);
                }
            }
        } else {
            s.composer.clear_optimistic(Some(attempted));
        }
        return;
    }
    s.composer.clear_optimistic(Some(attempted));
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

pub(crate) fn confirm_unconfirmed_id(s: &mut State, attempt_id: &str) -> bool {
    if let Some(send) = s.composer.sending.as_mut()
        && send.id == attempt_id
    {
        send.received = true;
    }
    let had_local = s.composer.unconfirmed_id() == Some(attempt_id);
    if had_local {
        s.composer
            .confirm_unconfirmed_matching(&mut s.draft, attempt_id);
    }
    let had_workspace = s.workspace.is_some() && (had_local || workspace::has_unconfirmed(s));
    if had_workspace {
        workspace::confirm_unconfirmed(s, attempt_id);
        workspace::capture(s);
    }
    had_local || had_workspace
}

pub fn reconcile(s: &mut State) {
    let Some(attempt_id) = s
        .composer
        .unconfirmed
        .as_ref()
        .filter(|send| {
            s.composer.has_confirmed_prompt(
                &s.messages,
                s.transcript_display.queue.items(),
                &send.id,
            )
        })
        .map(|send| send.id.clone())
    else {
        return;
    };
    confirm_unconfirmed_id(s, &attempt_id);
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
        let row = rt.state.messages[0].clone();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.draft.text, "attempt");
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        // Retaining the local optimistic row must NOT self-confirm the unconfirmed attempt.
        reconcile(&mut rt.state);
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
        // Installing an authoritative native page clears optimistic_id and releases the lock.
        crate::chat::reader::install_page(
            &mut rt.state,
            crate::history::Page {
                rows: vec![row],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            None,
        );
        assert!(rt.state.composer.unconfirmed.is_none());
        assert!(!rt.state.composer.announce_unconfirmed);
        assert_eq!(rt.state.draft.text, "new draft");
    }

    #[test]
    fn scroll_rollback_after_trimmed_sync_never_confirms_unconfirmed_optimistic_prompt() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.commands = Some(sender);
        s.messages = (0..4)
            .map(|i| {
                Message {
                    id: format!("auth-{i}"),
                    role: "assistant".into(),
                    body: format!("history {i}"),
                    completed: true,
                    usage: None,
                    parts: vec![],
                }
                .into()
            })
            .collect();
        s.draft = TextEdit::new("attempt");
        let (reader, lane) = crate::chat::reader::Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (640.0, 480.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert_eq!(rt.state.composer.optimistic_id(), Some(id.as_str()));
        assert_eq!(rt.state.draft.text, "attempt");

        // Suspend + resume so ReaderSync enters the resuming path, then deliver a trimmed
        // authoritative page that omits both older history and the unconfirmed optimistic prompt.
        rt.update(|s, tx| {
            crate::chat::reader::suspend(s);
            crate::chat::reader::resume(s, tx);
        });
        let kept_rows: Vec<_> = rt.state.messages[2..4].to_vec();
        let generation = rt.state.reader.as_ref().unwrap().generation();
        lane.events
            .try_send((
                generation,
                0,
                crate::transport::Event::ReaderSync {
                    page: crate::history::Page {
                        rows: kept_rows,
                        older: Some("cursor-older".into()),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert_eq!(rt.state.composer.optimistic_id(), None);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));

        // A manual scroll rollback must restore only authoritative rows and keep the prompt locked.
        rt.update(|s, tx| {
            assert!(crate::chat::reader::undo_sync_for_manual_scroll(s, 0, tx));
        });
        assert!(!rt.state.messages.iter().any(|row| row.id == id));
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert_eq!(rt.state.draft.text, "attempt");
        assert!(!can_send(&rt.state));
    }

    #[test]
    fn scroll_rollback_preserves_online_phase_and_reader_send_barrier() {
        let (sender, _receiver) = codenomad_client::bounded(2);
        let (out, incoming) = codenomad_client::bounded(8);
        let mut s = crate::init();
        s.phase = Phase::StreamDisconnected { running: false };
        s.stream_offline = true;
        s.commands = Some(sender);
        s.incoming = Some(incoming);
        s.messages = (0..4)
            .map(|i| {
                Message {
                    id: format!("row-{i}"),
                    role: "assistant".into(),
                    body: format!("message {i}"),
                    completed: true,
                    usage: None,
                    parts: vec![],
                }
                .into()
            })
            .collect();
        s.draft = TextEdit::new("send after reconnect");
        let (reader, lane) = crate::chat::reader::Reader::open();
        s.reader = Some(reader);
        let mut rt = Runtime::new(s, crate::view, (640.0, 480.0), Env::new(false, 1.0));

        rt.update(|s, tx| {
            crate::chat::reader::suspend(s);
            crate::chat::reader::resume(s, tx);
        });
        let trimmed: Vec<_> = rt.state.messages[2..4].to_vec();
        let generation = rt.state.reader.as_ref().unwrap().generation();
        lane.events
            .try_send((
                generation,
                0,
                crate::transport::Event::ReaderSync {
                    page: crate::history::Page {
                        rows: trimmed.clone(),
                        older: Some("cursor-older".into()),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 1,
                },
            ))
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(rt.state.phase == Phase::Ready);
        assert!(!rt.state.stream_offline);

        // Rolling back the trimmed sync re-arms resume_pending, so sending must remain blocked
        // rather than reviving Phase::StreamDisconnected to bypass the online reader barrier.
        rt.update(|s, tx| {
            assert!(crate::chat::reader::undo_sync_for_manual_scroll(s, 0, tx));
        });
        assert!(rt.state.phase == Phase::Ready);
        assert!(!rt.state.stream_offline);
        assert!(!can_send(&rt.state));

        // Dropping SSE after rollback enters StreamDisconnected (offline send exception applies
        // because the reader is already installed), then AgentHint(true) announces reconnect and
        // must end the offline exception before the replacement ReaderSync clears resume_pending.
        out.try_send(crate::transport::Event::ConnectionLost)
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(matches!(
            rt.state.phase,
            Phase::StreamDisconnected { running: false }
        ));
        assert!(rt.state.stream_offline);
        assert!(can_send(&rt.state));

        // A host SSE preferences invalidation or host SSE reopen before upstream status arrives
        // must not revoke the reader's offline send exception while upstream is still down.
        out.try_send(crate::transport::Event::Preferences(
            codenomad_client::settings::Owner::Config,
        ))
        .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(rt.state.conversation_stream_connected);
        assert!(can_send(&rt.state));

        out.try_send(crate::transport::Event::AgentHint(true))
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(rt.state.stream_offline);
        assert!(rt.state.conversation_stream_connected);
        assert!(rt.state.reader.as_ref().unwrap().is_resuming());
        assert!(can_send(&rt.state));
        // Even if agent status HTTP read promotes phase to Ready while upstream SSE is still
        // down, the armed reader offline_send exception keeps Send eligible (paging stays gated).
        rt.state.phase = Phase::Ready;
        rt.state.can_older = true;
        assert!(can_send(&rt.state));
        assert!(!crate::chat::reader::older(&mut rt.state));

        // Once upstream reports ready, end the offline send exception while keeping
        // resume_pending armed until the replacement ReaderSync installs.
        out.try_send(crate::transport::Event::UpstreamReady)
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(rt.state.stream_offline);
        assert!(rt.state.reader.as_ref().unwrap().is_resuming());
        assert!(rt.state.reader.as_ref().unwrap().blocks_send());
        assert!(!can_send(&rt.state));
        assert!(!crate::chat::reader::older(&mut rt.state));

        let generation = rt.state.reader.as_ref().unwrap().generation();
        lane.events
            .try_send((
                generation,
                0,
                crate::transport::Event::ReaderSync {
                    page: crate::history::Page {
                        rows: trimmed,
                        older: Some("cursor-older".into()),
                        newer: None,
                        running: false,
                        user_file_references: false,
                    },
                    version: 2,
                },
            ))
            .unwrap();
        assert!(crate::chat::events::poll_chat_for_window(
            &mut rt.state,
            64,
            false,
            0.0,
        ));
        assert!(rt.state.phase == Phase::Ready);
        assert!(!rt.state.stream_offline);
        assert!(!rt.state.reader.as_ref().unwrap().is_resuming());
        assert!(can_send(&rt.state));
    }

    #[test]
    fn direct_mode_keeps_send_eligible_across_reconnect_hint_before_sync() {
        let (sender, _receiver) = codenomad_client::bounded(2);
        let (out, incoming) = codenomad_client::bounded(4);
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.commands = Some(sender);
        s.incoming = Some(incoming);
        s.draft = TextEdit::new("direct send across hint");
        assert!(s.reader.is_none());

        out.try_send(crate::transport::Event::ConnectionLost)
            .unwrap();
        assert!(crate::chat::events::poll_chat(&mut s, 16));
        assert!(matches!(
            s.phase,
            Phase::StreamDisconnected { running: false }
        ));
        assert!(s.stream_offline);
        assert!(!s.conversation_stream_connected);
        assert!(can_send(&s));

        out.try_send(crate::transport::Event::AgentHint(true))
            .unwrap();
        assert!(crate::chat::events::poll_chat(&mut s, 16));
        assert!(matches!(
            s.phase,
            Phase::StreamDisconnected { running: false }
        ));
        assert!(s.stream_offline);
        assert!(s.conversation_stream_connected);
        assert!(can_send(&s));
    }

    #[test]
    fn unconfirmed_lock_persists_across_session_reopen_and_announces_uncertainty() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let mut second = first.clone();
        second.session = "ses-2".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
            temporary: false,
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
        let mut seen = std::collections::HashSet::new();
        assert_eq!(
            rt.state.composer.add_unique_inline_usage(&mut seen, true),
            (1, 4096),
            "restored shared Arc attachment bytes must be counted once across draft and unconfirmed lock"
        );
        // Adding a second distinct device attachment counts both unique Arc allocations once.
        let mut with_extra = rt.state.composer.draft.clone();
        with_extra.attachments.push(Attachment::Device {
            name: "extra.png".into(),
            mime: "image/png".into(),
            bytes: std::sync::Arc::from(vec![9u8; 2048]),
            token: None,
        });
        let saved_draft = std::mem::replace(&mut rt.state.composer.draft, with_extra);
        let mut seen_with_extra = std::collections::HashSet::new();
        assert_eq!(
            rt.state
                .composer
                .add_unique_inline_usage(&mut seen_with_extra, true),
            (2, 4096 + 2048),
            "adding a new file to a restored draft must not double-count restored Arc bytes"
        );
        rt.state.composer.draft = saved_draft;
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
        let mut reopened_seen = std::collections::HashSet::new();
        assert_eq!(
            rt.state
                .composer
                .add_unique_inline_usage(&mut reopened_seen, true),
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
        assert!(
            rt.state.draft.text.is_empty(),
            "confirming a reopened unconfirmed attempt must clear its untouched restored draft"
        );
        workspace::bound(&mut rt.state, &second);
        let after_confirm = workspace::bound(&mut rt.state, &first);
        assert!(
            after_confirm.is_empty(),
            "confirmed draft must not resurrect after switching sessions"
        );
        assert!(rt.state.composer.unconfirmed_id().is_none());
    }

    #[test]
    fn unconfirmed_lock_blocks_sibling_tab_and_clears_globally_on_reconcile() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
            temporary: false,
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
        // Keep the optimistic row in Tab A: Unconfirmed must NOT self-confirm on its own local echo.
        let native_row = rt
            .state
            .messages
            .iter()
            .find(|row| row.id == id)
            .unwrap()
            .clone();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert_eq!(rt.state.draft.text, "tab A attempt");
        assert!(rt.state.composer.announce_unconfirmed);
        assert!(!can_send(&rt.state));
        // Origin Tab A browses Recall while holding the restored unconfirmed draft and an error flag.
        rt.state.composer.send_error = true;
        rt.state.composer.announce_send_error = true;
        rt.update(|s, tx| {
            assert!(crate::composer::recall::step(s, true, true, tx));
        });
        assert!(rt.state.composer.recall.is_some());
        // Switching to already-open sibling Tab B must block sending while Tab A is still open.
        rt.update(|s, tx| workspace::select(s, &tab_b, tx));
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        assert!(!can_send(&rt.state));
        // Native sync in sibling Tab B reconciles globally, clearing Tab A's Recall saved draft and error flags.
        crate::chat::reader::install_page(
            &mut rt.state,
            crate::history::Page {
                rows: vec![native_row],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            None,
        );
        assert!(rt.state.composer.unconfirmed_id().is_none());
        assert!(!rt.state.composer.announce_unconfirmed);
        assert_eq!(rt.state.draft.text, "tab B draft");
        // Returning to Tab A must show cleared lock, cleared errors, and cleared Recall saved draft.
        rt.update(|s, tx| workspace::select(s, &tab_a, tx));
        assert!(rt.state.composer.unconfirmed_id().is_none());
        assert!(!rt.state.composer.send_error);
        assert!(!rt.state.composer.announce_send_error);
        assert!(!rt.state.composer.announce_unconfirmed);
        crate::composer::recall::restore(&mut rt.state);
        assert!(rt.state.draft.text.is_empty());
        // Closing sibling Tab B afterwards must not reintroduce the reconciled lock.
        rt.update(|s, tx| workspace::close(s, &tab_b, tx));
        assert!(rt.state.composer.unconfirmed_id().is_none());
        assert!(!workspace::has_unconfirmed(&rt.state));
        rt.state.draft = TextEdit::new("next");
        assert!(can_send(&rt.state));
    }

    #[test]
    fn direct_mode_enforces_window_device_attachment_budget_with_prompt_history() {
        let mut s = crate::init();
        assert!(s.workspace.is_none());
        // Record 60 MiB of distinct inline device files in direct-mode prompt_history.
        for index in 0..12 {
            s.draft = TextEdit::new(format!("history-{index}"));
            s.composer.draft.attachments.clear();
            s.composer.draft.attachments.push(Attachment::Device {
                name: format!("h-{index}.bin"),
                mime: "application/octet-stream".into(),
                bytes: std::sync::Arc::from(vec![index as u8; 5 * 1024 * 1024]),
                token: None,
            });
            assert!(crate::composer::recall::record(
                &mut s,
                format!("history-{index}"),
                false
            ));
        }
        s.draft.clear();
        s.composer.draft.attachments.clear();
        // Adding a new 5 MiB distinct device file pushes total to 65 MiB (> 64 MiB budget).
        s.composer.draft.attachments.push(Attachment::Device {
            name: "over-limit.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: std::sync::Arc::from(vec![99u8; 5 * 1024 * 1024]),
            token: None,
        });
        assert!(
            !workspace::attachment_draft_admissible(&s),
            "direct mode must enforce the 64 MiB window device attachment budget including prompt_history"
        );
    }

    #[test]
    fn recall_zero_byte_files_count_toward_window_device_file_limit() {
        let mut s = crate::init();
        assert!(s.workspace.is_none());
        let files_per_entry = 8usize;
        let entries = workspace::MAX_WINDOW_DEVICE_FILES / files_per_entry;
        assert_eq!(
            entries * files_per_entry,
            workspace::MAX_WINDOW_DEVICE_FILES
        );
        for index in 0..entries {
            s.draft = TextEdit::new(format!("zero-{index}"));
            s.composer.draft.attachments.clear();
            for file in 0..files_per_entry {
                s.composer.draft.attachments.push(Attachment::Device {
                    name: format!("empty-{index}-{file}.txt"),
                    mime: "text/plain".into(),
                    bytes: std::sync::Arc::from(Vec::<u8>::new()),
                    token: None,
                });
            }
            assert!(crate::composer::recall::record(
                &mut s,
                format!("zero-{index}"),
                false
            ));
        }
        s.draft.clear();
        s.composer.draft.attachments.clear();
        s.composer.draft.attachments.push(Attachment::Device {
            name: "over-file-limit.txt".into(),
            mime: "text/plain".into(),
            bytes: std::sync::Arc::from(Vec::<u8>::new()),
            token: None,
        });
        assert!(
            !workspace::attachment_draft_admissible(&s),
            "distinct zero-byte files in Recall must count toward MAX_WINDOW_DEVICE_FILES"
        );
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

    #[test]
    fn closed_tab_reconcile_matches_attachments_and_forgets_recall_bytes() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
            temporary: false,
        };
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        workspace::opened(&mut s, &project);
        workspace::bound(&mut s, &first);
        s.phase = Phase::Ready;
        s.commands = Some(sender.clone());
        s.composer.picker.set_attachments_supported(true);
        // Send an attachment-only prompt (empty text + skill + device file) -> Unconfirmed.
        s.composer.draft.attachments.push(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
        s.composer.draft.attachments.push(Attachment::Device {
            name: "big.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: std::sync::Arc::from(vec![3u8; 4 * 1024 * 1024]),
            token: None,
        });
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        let row = rt.state.messages.pop().unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        // Closing the tab must release Recall's 4 MiB device bytes for that tab.
        let tab_key = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        rt.update(|s, tx| workspace::close(s, &tab_key, tx));
        let mut seen = std::collections::HashSet::new();
        assert_eq!(
            rt.state.prompt_history.unique_inline_usage(&mut seen),
            (0, 0),
            "closing a tab must drop Recall inline bytes belonging to that tab"
        );
        // Reopen the project and session: attachment-only draft is restored (with Skill kept),
        // and confirming the native message clears the restored Skill attachment too.
        workspace::opened(&mut rt.state, &project);
        let reopened_text = workspace::bound(&mut rt.state, &first);
        rt.state.draft = TextEdit::new(reopened_text);
        assert!(rt.state.draft.text.is_empty());
        assert_eq!(rt.state.composer.draft.attachments.len(), 1);
        assert_eq!(rt.state.composer.unconfirmed_id(), Some(id.as_str()));
        crate::chat::reader::install_page(
            &mut rt.state,
            crate::history::Page {
                rows: vec![row],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            None,
        );
        assert!(rt.state.composer.unconfirmed_id().is_none());
        assert!(
            rt.state.composer.draft.attachments.is_empty(),
            "confirming an attachment-only unconfirmed send must clear its restored attachments"
        );
        assert!(!rt.state.composer.attachments_missing);
    }

    #[test]
    fn closed_tab_reconcile_preserves_independent_draft_with_different_attachments() {
        let (sender, receiver) = codenomad_client::bounded(2);
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        let mut ui = workspace::Ui::new();
        ui.fixture_ready();
        s.workspace = Some(ui);
        let mut first = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        first.workspace = "ws".into();
        first.session = "ses-1".into();
        let project = crate::catalog::Project {
            id: "ws".into(),
            path: "/tmp/ws".into(),
            temporary: false,
        };
        s.screen.launcher_mut().unwrap().project = Some(project.clone());
        workspace::opened(&mut s, &project);
        workspace::bound(&mut s, &first);
        s.phase = Phase::Ready;
        s.commands = Some(sender.clone());
        s.composer.picker.set_attachments_supported(true);
        // Tab A has text "same" + Skill("alpha"), closes and enters ui.closed.
        s.draft = TextEdit::new("same");
        s.composer.draft.attachments.push(Attachment::Skill {
            id: "alpha".into(),
            name: "Alpha".into(),
        });
        let mut rt = Runtime::new(s, crate::view, (600.0, 600.0), Env::new(false, 1.0));
        let tab_a = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
        rt.update(|s, tx| workspace::new_tab(s, tx));
        workspace::opened(&mut rt.state, &project);
        workspace::bound(&mut rt.state, &first);
        rt.state.phase = Phase::Ready;
        rt.state.commands = Some(sender.clone());
        rt.state.composer.picker.set_attachments_supported(true);
        // Close Tab A so its draft ("same" + Skill("alpha")) sits in ui.closed.
        rt.update(|s, tx| workspace::close(s, &tab_a, tx));
        // Tab B sends text "same" with NO attachments -> Unconfirmed, then confirmed.
        rt.state.draft = TextEdit::new("same");
        rt.update(|s, tx| send(s, tx, false));
        let Command::Prompt(prompt) = receiver.try_recv().unwrap() else {
            panic!("expected prompt")
        };
        let id = prompt.id.unwrap();
        let row = rt.state.messages.pop().unwrap();
        acknowledge(&mut rt.state, &id, PromptOutcome::Unconfirmed);
        crate::chat::reader::install_page(
            &mut rt.state,
            crate::history::Page {
                rows: vec![row],
                older: None,
                newer: None,
                running: false,
                user_file_references: false,
            },
            None,
        );
        assert!(rt.state.composer.unconfirmed_id().is_none());
        // Reopening a fresh tab must still see Tab A's distinct draft ("same" + Skill("alpha")) intact.
        rt.update(|s, tx| workspace::new_tab(s, tx));
        workspace::opened(&mut rt.state, &project);
        let text = workspace::bound(&mut rt.state, &first);
        assert_eq!(text, "same");
        assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    }
}
