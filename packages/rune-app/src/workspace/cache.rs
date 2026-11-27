use crate::{
    Phase, State, agent,
    transport::{Command, Event},
};
use codenomad_client::{Receiver, Sender};
use rune::edit::TextEdit;

pub(super) struct Cache {
    agent: Option<agent::Ui>,
    files: Option<crate::files::Ui>,
    attachments: crate::chat::attachments::Reader,
    git: crate::git::Binding,
    transcript_display: crate::transcript_state::Display,
    title: String,
    messages: Vec<crate::history::Row>,
    draft: TextEdit,
    composer: crate::composer::Owner,
    incoming: Option<Receiver<Event>>,
    conversation_client_id: Option<String>,
    conversation_stream_connected: bool,
    reader: Option<crate::chat::reader::Reader>,
    commands: Option<Sender<Command>>,
    phase: Phase,
    revision: u64,
    can_older: bool,
    paging: bool,
    error: bool,
    history_detached: bool,
    stream_offline: bool,
    launcher_visible: bool,
    input_scope: std::rc::Rc<()>,
    status_permissions: crate::shell::status_permissions::Permissions,
    status_services: crate::shell::status_services::Services,
    status_usage: crate::shell::status_usage::Panel,
}
impl Cache {
    #[cfg(test)]
    pub(super) fn git_mut(&mut self) -> &mut crate::git::Binding {
        &mut self.git
    }

    pub(super) fn observes_notifications(&self, allow_running: bool) -> bool {
        self.agent
            .as_ref()
            .is_some_and(|agent| agent.online && (allow_running || !agent.running))
    }

    pub(super) fn has_conversation_stream(&self) -> bool {
        self.incoming
            .as_ref()
            .is_some_and(|incoming| !incoming.is_closed())
    }

    pub(super) fn is_sending(&self) -> bool {
        self.composer.pending()
    }

    pub(super) fn unconfirmed_id(&self) -> Option<&str> {
        self.composer.unconfirmed_id()
    }

    pub(super) fn unconfirmed_state(&self) -> Option<&crate::composer::UnconfirmedPrompt> {
        self.composer.unconfirmed_state()
    }

    pub(super) fn restore_unconfirmed(&mut self, pending: crate::composer::UnconfirmedPrompt) {
        if self.composer.unconfirmed_state().is_none() {
            self.composer.restore_unconfirmed(pending);
        }
    }

    pub(super) fn has_confirmed_user_message(&self, id: &str) -> bool {
        self.composer.has_confirmed_prompt(
            &self.messages,
            self.transcript_display.queue.items(),
            id,
        )
    }

    pub(super) fn clear_unconfirmed_matching(&mut self, attempt_id: &str) -> bool {
        self.composer
            .confirm_unconfirmed_matching(&mut self.draft, attempt_id)
    }

    pub(super) fn add_unique_inline_usage(
        &self,
        seen: &mut std::collections::HashSet<usize>,
    ) -> (usize, usize) {
        self.composer
            .add_unique_inline_usage(seen, self.composer.recall.is_some())
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn revoke_pairing(&mut self) {
        self.composer.picker.set_attachments_supported(false);
        if let Some(reader) = &self.reader {
            reader.revoke();
        }
        if let Some(commands) = self.commands.take() {
            commands.close();
        }
        if !matches!(self.phase, Phase::WorkspaceMissing | Phase::RestoreFailed) {
            self.phase = Phase::Failed;
        }
        self.stream_offline = true;
    }

    pub(super) fn has_healthy_conversation_stream(&self) -> bool {
        self.has_conversation_stream() && self.conversation_stream_connected
    }

    pub(super) fn conversation_client_id(&self) -> Option<&str> {
        self.conversation_client_id.as_deref()
    }

    fn is_detached(&self) -> bool {
        self.launcher_visible && self.incoming.is_none()
    }

    pub(super) fn deliver_detached_event(
        &mut self,
        event: &codenomad_client::transport::WorkspaceEvent,
    ) -> bool {
        if !self.is_detached()
            && !matches!(
                event,
                codenomad_client::transport::WorkspaceEvent::Stopped { .. }
            )
        {
            return false;
        }
        if matches!(
            event,
            codenomad_client::transport::WorkspaceEvent::UiPreferencesChanged
        ) {
            if let Some(git) = &mut self.git.owner {
                git.event(event);
                return true;
            }
            return false;
        }
        let Some(target) = super::state::event_workspace_id(event) else {
            return false;
        };
        let mut delivered = false;
        if let Some(git) = &mut self.git.owner
            && git.workspace_id() == target
        {
            if let codenomad_client::transport::WorkspaceEvent::NativeStreamStatus {
                workspace_id,
                connected: true,
            } = event
            {
                git.event(
                    &codenomad_client::transport::WorkspaceEvent::WorktreesChanged {
                        workspace_id: workspace_id.clone(),
                    },
                );
                delivered = true;
            } else if !matches!(
                event,
                codenomad_client::transport::WorkspaceEvent::NativeStreamStatus { .. }
            ) {
                git.event(event);
                delivered = true;
            }
        }
        if let Some(files) = &mut self.files
            && files.workspace_id() == target
        {
            files.event(event.clone());
            delivered = true;
        }
        if self.status_services.workspace_id() == Some(target) {
            self.status_services.event(event);
            delivered = true;
        }
        if matches!(
            event,
            codenomad_client::transport::WorkspaceEvent::Stopped { .. }
        ) && let Some(agent) = &mut self.agent
        {
            delivered |= agent.workspace_stopped(target);
        }
        delivered
    }

    pub(super) fn has_detached_panels(&self) -> bool {
        self.is_detached()
            && (self.git.owner.is_some()
                || self.files.is_some()
                || self.status_services.workspace_id().is_some())
    }

    pub(super) fn collect_detached_workspace_ids(
        &self,
        out: &mut std::collections::HashSet<String>,
    ) {
        if !self.is_detached() {
            return;
        }
        if let Some(git) = &self.git.owner {
            out.insert(git.workspace_id().to_owned());
        }
        if let Some(files) = &self.files {
            out.insert(files.workspace_id().to_owned());
        }
        if let Some(id) = self.status_services.workspace_id() {
            out.insert(id.to_owned());
        }
    }

    pub(super) fn stop_unlisted_detached(
        &mut self,
        live: &std::collections::HashSet<&str>,
    ) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            let id = git.workspace_id();
            if !live.contains(id) {
                let workspace_id = id.to_owned();
                git.event(&codenomad_client::transport::WorkspaceEvent::Stopped {
                    workspace_id,
                    deleted: false,
                    temporary_retained: false,
                });
                changed = true;
            }
        }
        if let Some(files) = &mut self.files {
            let id = files.workspace_id();
            if !live.contains(id) {
                let workspace_id = id.to_owned();
                files.event(codenomad_client::transport::WorkspaceEvent::Stopped {
                    workspace_id,
                    deleted: false,
                    temporary_retained: false,
                });
                changed = true;
            }
        }
        if let Some(id) = self.status_services.workspace_id().map(str::to_owned)
            && !live.contains(id.as_str())
        {
            self.status_services
                .event(&codenomad_client::transport::WorkspaceEvent::Stopped {
                    workspace_id: id,
                    deleted: false,
                    temporary_retained: false,
                });
            changed = true;
        }
        changed
    }

    pub(super) fn reconcile_detached_online(
        &mut self,
        opened_after: &std::collections::HashSet<String>,
        live: Option<&std::collections::HashSet<&str>>,
    ) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            let id = git.workspace_id();
            match live {
                Some(live) if !opened_after.contains(id) && !live.contains(id) => {
                    let workspace_id = id.to_owned();
                    git.event(&codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id,
                        deleted: false,
                        temporary_retained: false,
                    });
                    changed = true;
                }
                Some(_) => {
                    git.online(true);
                    changed = true;
                }
                None if opened_after.contains(id) => {
                    git.online(true);
                    changed = true;
                }
                None => {}
            }
        }
        if let Some(files) = &mut self.files {
            let id = files.workspace_id();
            match live {
                Some(live) if !opened_after.contains(id) && !live.contains(id) => {
                    let workspace_id = id.to_owned();
                    files.event(codenomad_client::transport::WorkspaceEvent::Stopped {
                        workspace_id,
                        deleted: false,
                        temporary_retained: false,
                    });
                    changed = true;
                }
                Some(_) => {
                    files.online(true);
                    changed = true;
                }
                None if opened_after.contains(id) => {
                    files.online(true);
                    changed = true;
                }
                None => {}
            }
        }
        if let Some(id) = self.status_services.workspace_id().map(str::to_owned) {
            match live {
                Some(live)
                    if !opened_after.contains(id.as_str()) && !live.contains(id.as_str()) =>
                {
                    self.status_services.event(
                        &codenomad_client::transport::WorkspaceEvent::Stopped {
                            workspace_id: id,
                            deleted: false,
                            temporary_retained: false,
                        },
                    );
                    changed = true;
                }
                Some(_) => {
                    self.status_services.online(true);
                    changed = true;
                }
                None if opened_after.contains(id.as_str()) => {
                    self.status_services.online(true);
                    changed = true;
                }
                None => {}
            }
        }
        changed
    }

    pub(super) fn set_detached_online(&mut self, online: bool) -> bool {
        if !self.is_detached() {
            return false;
        }
        let mut changed = false;
        if let Some(git) = &mut self.git.owner {
            git.online(online);
            changed = true;
        }
        if let Some(files) = &mut self.files {
            files.online(online);
            changed = true;
        }
        if self.status_services.workspace_id().is_some() {
            self.status_services.online(online);
            changed = true;
        }
        changed
    }

    pub(super) fn history_weight(&self) -> (usize, usize) {
        (
            self.messages.len(),
            crate::history::retained_bytes(&self.messages),
        )
    }
    pub(super) fn rendered_bytes(
        &self,
        seen_outlines: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.transcript_display.retained_bytes(seen_outlines)
    }
    pub(super) fn files_and_git_bytes(
        &self,
        seen_file_drafts: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.files
            .as_ref()
            .map_or(0, |files| files.retained_bytes(seen_file_drafts))
            .saturating_add(self.git.retained_bytes())
    }
    pub(super) fn draft_bytes(&self, seen: &mut std::collections::HashSet<usize>) -> usize {
        self.draft
            .text
            .len()
            .saturating_add(self.composer.draft.retained_bytes(seen))
            .saturating_add(
                self.composer
                    .recall
                    .as_ref()
                    .map_or(0, |recall| recall.retained_bytes(seen)),
            )
            .saturating_add(self.git.draft_bytes())
    }
    pub(super) fn evictable_rendered_bytes(&self, active_outline_ptr: Option<usize>) -> usize {
        self.transcript_display
            .evictable_rendered_bytes(active_outline_ptr)
    }
    pub(super) fn evictable_secondary_bytes(&self, active_outline_ptr: Option<usize>) -> usize {
        let files = self
            .files
            .as_ref()
            .map_or(0, crate::files::Ui::evictable_inactive_bytes);
        let display = if self.history_protected() {
            self.transcript_display.saved_sessions_bytes()
        } else {
            self.transcript_display
                .evictable_rendered_bytes(active_outline_ptr)
        };
        files
            .saturating_add(self.git.retained_bytes())
            .saturating_add(display)
    }
    pub(super) fn evict_secondary_caches(&mut self, active_outline_ptr: Option<usize>) -> usize {
        let mut freed = self
            .files
            .as_mut()
            .map_or(0, crate::files::Ui::evict_inactive_caches);
        freed = freed.saturating_add(self.git.evict_inactive_caches());
        if self.history_protected() {
            freed.saturating_add(self.transcript_display.evict_inactive_sessions())
        } else {
            let evictable = self
                .transcript_display
                .evictable_rendered_bytes(active_outline_ptr);
            self.transcript_display.evict_rendered();
            freed.saturating_add(evictable)
        }
    }
    #[cfg(test)]
    pub(super) fn files_mut(&mut self) -> &mut Option<crate::files::Ui> {
        &mut self.files
    }
    #[cfg(test)]
    pub(super) fn timeline_ref(&self) -> &crate::timeline::Timeline {
        &self.transcript_display.timeline
    }
    pub(super) fn history_protected(&self) -> bool {
        self.phase.running()
            || self.agent.as_ref().is_some_and(|agent| agent.running)
            || self
                .reader
                .as_ref()
                .and_then(crate::chat::reader::Reader::running)
                == Some(true)
            || self.navigation_blocked()
    }
    pub(super) fn evict_history(&mut self) {
        self.messages = Vec::new();
        self.can_older = false;
        self.paging = false;
        self.transcript_display.evict_rendered();
    }
    pub fn navigation_blocked(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        if self.phase == Phase::RestoreFailed {
            return false;
        }
        self.composer.blocks_navigation()
            || self
                .agent
                .as_ref()
                .is_some_and(agent::Ui::navigation_blocked)
    }
    pub(super) fn has_unsaved_form_drafts(&self) -> bool {
        self.agent
            .as_ref()
            .is_some_and(agent::Ui::has_unsaved_form_drafts)
    }
    pub fn status(&self) -> Option<rune_theme_codenomad::tabs::Status> {
        status(&self.phase, self.agent.as_ref())
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn has_wake_lock_eligible_work(&self) -> bool {
        has_wake_lock_eligible_work(&self.phase, self.agent.as_ref())
    }
    pub fn take(s: &mut State) -> Self {
        Self {
            agent: s.agent.take(),
            files: s.files.take(),
            attachments: std::mem::take(&mut s.attachments),
            git: crate::git::Binding::take(&mut s.git),
            transcript_display: std::mem::take(&mut s.transcript_display),
            title: std::mem::take(&mut s.chat_title),
            messages: std::mem::take(&mut s.messages),
            draft: std::mem::replace(&mut s.draft, TextEdit::new("")),
            composer: std::mem::take(&mut s.composer),
            incoming: s.incoming.take(),
            conversation_client_id: s.conversation_client_id.take(),
            conversation_stream_connected: std::mem::take(&mut s.conversation_stream_connected),
            reader: s.reader.take(),
            commands: s.commands.take(),
            phase: std::mem::replace(&mut s.phase, Phase::Ready),
            revision: s.revision,
            can_older: std::mem::take(&mut s.can_older),
            paging: std::mem::take(&mut s.paging),
            error: std::mem::take(&mut s.history_error),
            history_detached: std::mem::take(&mut s.history_detached),
            stream_offline: std::mem::take(&mut s.stream_offline),
            launcher_visible: s.screen.is_launcher(),
            input_scope: s.input_scope.clone(),
            status_permissions: std::mem::take(&mut s.status_permissions),
            status_services: std::mem::take(&mut s.status_services),
            status_usage: std::mem::take(&mut s.status_usage),
        }
    }
    pub fn apply(self, s: &mut State) {
        s.agent = self.agent;
        s.files = self.files;
        s.attachments = self.attachments;
        s.git = self.git;
        s.transcript_display = self.transcript_display;
        crate::chat::ToolDiffPreferences::sync(s);
        s.chat_title = self.title;
        s.messages = self.messages;
        s.draft = self.draft;
        s.composer = self.composer;
        s.incoming = self.incoming;
        s.conversation_client_id = self.conversation_client_id;
        s.conversation_stream_connected = self.conversation_stream_connected;
        s.reader = self.reader;
        s.commands = self.commands;
        s.phase = self.phase;
        s.revision = self.revision;
        s.can_older = self.can_older;
        s.paging = self.paging;
        s.history_error = self.error;
        s.history_detached = self.history_detached;
        s.stream_offline = self.stream_offline;
        if self.launcher_visible {
            s.screen.show_launcher();
        } else {
            s.screen.show_chat();
        }
        s.input_scope = self.input_scope;
        s.status_permissions = self.status_permissions;
        s.status_services = self.status_services;
        s.status_usage = self.status_usage;
    }
}
pub(super) fn status(
    phase: &Phase,
    agent: Option<&agent::Ui>,
) -> Option<rune_theme_codenomad::tabs::Status> {
    use rune_theme_codenomad::tabs::Status;
    if agent.is_some_and(|a| !a.ids().is_empty()) {
        Some(Status::Permission)
    } else if *phase == Phase::Streaming || agent.is_some_and(|a| a.online && a.running) {
        Some(Status::Working)
    } else if *phase == Phase::Failed || phase.reconnecting() {
        Some(Status::Unavailable)
    } else {
        None
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn has_wake_lock_eligible_work(phase: &Phase, agent: Option<&agent::Ui>) -> bool {
    if agent.is_some_and(|a| !a.ids().is_empty()) {
        return false;
    }
    match agent {
        Some(agent) => agent.online && (agent.running || *phase == Phase::Streaming),
        None => *phase == Phase::Streaming,
    }
}
